// API handlers. JSON handlers receive the parsed request body and return a JSON-serialisable result.
// Raw handlers receive the full request context and write the response themselves. They run in a worker
// thread (see worker.js), where `res` collects the response into a file that the HTTP server then sends.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  qi, splitStatements, firstKeyword, parseCreateTable, renameInCreate, retargetIndex, findCreateName,
} from '../public/js/shared/sql.js';
import { sizeWithSideFiles } from './dbmanager.js';
import {
  fail, encodeValue, decodeValue, literal, inlineParams, parseCsv, csvField, jsonValue, sniffMime,
} from './util.js';

const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH']);
const DDL = new Set(['CREATE', 'DROP', 'ALTER']);
const FILTER_OPS = new Set(['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'GLOB', 'NOT GLOB', 'REGEXP',
  'NOT REGEXP', 'IN', 'NOT IN', 'BETWEEN', 'NOT BETWEEN', 'IS NULL', 'IS NOT NULL', 'IS EMPTY', 'IS NOT EMPTY',
  'CONTAINS', 'STARTS WITH', 'ENDS WITH']);

const now = () => process.hrtime.bigint();
const msSince = (start) => Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const commentLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

function prep(db, sql) {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt;
}

/** Run fn inside a transaction (or a savepoint when one is already open). */
function tx(db, fn) {
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT sqla_tx' : 'BEGIN');
  try {
    const result = fn();
    db.exec(nested ? 'RELEASE sqla_tx' : 'COMMIT');
    return result;
  } catch (e) {
    try { db.exec(nested ? 'ROLLBACK TO sqla_tx; RELEASE sqla_tx' : 'ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Schema helpers

function objectInfo(db, name) {
  if (typeof name !== 'string' || !name) fail('Table name is required');
  const row = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE AND type IN ('table','view')",
  ).get(name) || (name.toLowerCase() === 'sqlite_schema' || name.toLowerCase() === 'sqlite_master'
    ? { type: 'table', name: 'sqlite_schema', tbl_name: 'sqlite_schema', sql: null } : null);
  if (!row) fail(`Table or view "${name}" not found`, 404);
  return row;
}

function tableList(db) {
  const map = new Map();
  for (const r of db.prepare("SELECT name, type, ncol, wr, strict FROM pragma_table_list WHERE schema = 'main'").all()) {
    map.set(r.name, r);
  }
  return map;
}

function columnsOf(db, table) {
  return db.prepare('SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)').all(table)
    .map((c) => ({ ...c, notnull: !!c.notnull }));
}

function keyInfo(db, obj, cols) {
  if (obj.type !== 'table') return { kind: 'none', cols: [] };
  const tl = tableList(db).get(obj.name);
  if (!tl || !tl.wr) {
    const names = new Set(cols.map((c) => c.name.toLowerCase()));
    const alias = ['rowid', '_rowid_', 'oid'].find((a) => !names.has(a));
    if (alias) {
      try {
        db.prepare(`SELECT ${alias} FROM ${qi(obj.name)} LIMIT 0`);
        return { kind: 'rowid', alias, cols: [alias] };
      } catch { /* e.g. some virtual tables */ }
    }
  }
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (pk.length) return { kind: 'pk', cols: pk };
  return { kind: 'none', cols: [] };
}

function keyWhere(key, vals) {
  if (key.kind === 'none') fail('This object has no rowid or primary key, so rows cannot be addressed individually.');
  if (!Array.isArray(vals) || vals.length !== key.cols.length) fail('Invalid row key');
  const parts = key.kind === 'rowid' ? [`${key.alias} = ?`] : key.cols.map((c) => `${qi(c)} = ?`);
  return { sql: parts.join(' AND '), params: vals.map(decodeValue) };
}

function foreignKeys(db, table) {
  const groups = new Map();
  for (const r of db.prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table)) {
    if (!groups.has(r.id)) {
      groups.set(r.id, { id: r.id, table: r.table, from: [], to: [], onUpdate: r.on_update, onDelete: r.on_delete, match: r.match });
    }
    const g = groups.get(r.id);
    g.from.push(r.from);
    g.to.push(r.to);
  }
  const fks = [...groups.values()];
  // Resolve implicit references to the parent's primary key.
  for (const fk of fks) {
    if (fk.to.some((t) => t === null)) {
      try {
        const pk = columnsOf(db, fk.table).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        fk.to = fk.to.map((t, i) => t ?? pk[i] ?? 'rowid');
      } catch { /* parent table missing */ }
    }
  }
  return fks;
}

function singleColumnFkMap(db, obj) {
  if (obj.type !== 'table') return {};
  const map = {};
  for (const fk of foreignKeys(db, obj.name)) {
    if (fk.from.length === 1) map[fk.from[0]] = { table: fk.table, column: fk.to[0] };
  }
  return map;
}

let dbstatAvailable = null;
function objectSizes(db) {
  if (dbstatAvailable === false) return null;
  try {
    const map = new Map();
    for (const r of db.prepare('SELECT name, SUM(pgsize) AS size FROM dbstat GROUP BY name').all()) map.set(r.name, r.size);
    dbstatAvailable = true;
    return map;
  } catch {
    dbstatAvailable = false;
    return null;
  }
}

function pragmaValue(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : null;
}

function uniqueName(db, base) {
  let name = base;
  for (let i = 2; db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ? COLLATE NOCASE').get(name); i++) name = `${base}_${i}`;
  return name;
}

const escLike = (s) => String(s ?? '').replace(/[\\%_]/g, (c) => '\\' + c);

function coerce(v) {
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v) return decodeValue(Number(v));
  return decodeValue(v);
}

function buildWhere(cols, filters, search, searchMode = 'contains') {
  const names = new Set(cols.map((c) => c.name));
  const clauses = [];
  const params = [];
  for (const f of filters || []) {
    const op = String(f.op || '=').toUpperCase();
    if (!FILTER_OPS.has(op)) fail(`Unsupported operator: ${f.op}`);
    if (!names.has(f.col)) fail(`Unknown column: ${f.col}`);
    const c = qi(f.col);
    switch (op) {
      case 'IS NULL':
      case 'IS NOT NULL':
        clauses.push(`${c} ${op}`);
        break;
      case 'IS EMPTY':
        clauses.push(`${c} = ''`);
        break;
      case 'IS NOT EMPTY':
        clauses.push(`(${c} <> '' AND ${c} IS NOT NULL)`);
        break;
      case 'IN':
      case 'NOT IN': {
        const vals = Array.isArray(f.value) ? f.value
          : String(f.value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
        if (!vals.length) fail(`${op} requires at least one value`);
        clauses.push(`${c} ${op} (${vals.map(() => '?').join(', ')})`);
        params.push(...vals.map(coerce));
        break;
      }
      case 'BETWEEN':
      case 'NOT BETWEEN':
        clauses.push(`${c} ${op} ? AND ?`);
        params.push(coerce(f.value), coerce(f.value2));
        break;
      case 'CONTAINS':
        clauses.push(`${c} LIKE ? ESCAPE '\\'`);
        params.push(`%${escLike(f.value)}%`);
        break;
      case 'STARTS WITH':
        clauses.push(`${c} LIKE ? ESCAPE '\\'`);
        params.push(`${escLike(f.value)}%`);
        break;
      case 'ENDS WITH':
        clauses.push(`${c} LIKE ? ESCAPE '\\'`);
        params.push(`%${escLike(f.value)}`);
        break;
      case 'LIKE': case 'NOT LIKE': case 'GLOB': case 'NOT GLOB': case 'REGEXP': case 'NOT REGEXP':
        clauses.push(`${c} ${op} ?`);
        params.push(String(f.value ?? ''));
        break;
      default:
        if (f.value === null) clauses.push(`${c} ${op === '=' ? 'IS' : 'IS NOT'} NULL`);
        else {
          clauses.push(`${c} ${op} ?`);
          params.push(coerce(f.value));
        }
    }
  }
  if (search !== undefined && search !== null && search !== '') {
    const searchable = cols.filter((c) => c.hidden !== 1);
    const parts = [];
    for (const col of searchable) {
      if (searchMode === 'exact') { parts.push(`${qi(col.name)} = ?`); params.push(coerce(search)); }
      else if (searchMode === 'regexp') { parts.push(`CAST(${qi(col.name)} AS TEXT) REGEXP ?`); params.push(String(search)); }
      else { parts.push(`CAST(${qi(col.name)} AS TEXT) LIKE ? ESCAPE '\\'`); params.push(`%${escLike(search)}%`); }
    }
    if (parts.length) clauses.push('(' + parts.join(' OR ') + ')');
  }
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

function buildOrder(cols, sort) {
  const names = new Set(cols.map((c) => c.name));
  const parts = (sort || [])
    .filter((s) => s && names.has(s.col))
    .map((s) => `${qi(s.col)} ${String(s.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`);
  return parts.length ? ' ORDER BY ' + parts.join(', ') : '';
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Buffered writer for streamed downloads. */
function download(res, filename, contentType) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(filename),
    'Cache-Control': 'no-store',
  });
  const chunks = [];
  let size = 0;
  return {
    write(s) {
      chunks.push(s);
      size += s.length;
      if (size > 1 << 20) {
        res.write(chunks.join(''));
        chunks.length = 0;
        size = 0;
      }
    },
    end() {
      res.end(chunks.join(''));
    },
  };
}

function baseName(dbName) {
  return dbName.replace(/\.[^.]+$/, '');
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// ---------------------------------------------------------------------------------------------
// Export writers

function dumpTableData(db, table, w, rowsPerInsert, where = '', params = []) {
  const cols = columnsOf(db, table).filter((c) => c.hidden === 0);
  if (!cols.length) return 0;
  const colList = cols.map((c) => qi(c.name)).join(', ');
  const stmt = prep(db, `SELECT ${colList} FROM ${qi(table)}${where}`);
  stmt.setReturnArrays(true);
  const head = `INSERT INTO ${qi(table)} (${colList}) VALUES`;
  let batch = [];
  let count = 0;
  for (const row of stmt.iterate(...params)) {
    batch.push('(' + row.map(literal).join(', ') + ')');
    count++;
    if (batch.length >= rowsPerInsert) {
      w(rowsPerInsert === 1 ? `${head} ${batch[0]};\n` : `${head}\n  ${batch.join(',\n  ')};\n`);
      batch = [];
    }
  }
  if (batch.length) w(rowsPerInsert === 1 ? `${head} ${batch[0]};\n` : `${head}\n  ${batch.join(',\n  ')};\n`);
  return count;
}

function dumpSql(db, w, dbName, opts) {
  const selected = Array.isArray(opts.tables) && opts.tables.length ? new Set(opts.tables) : null;
  const want = (name) => !selected || selected.has(name);
  const structure = opts.structure !== false;
  const data = opts.data !== false;
  const rowsPerInsert = clampInt(opts.rowsPerInsert, 1, 10000, 100);
  const version = db.prepare('SELECT sqlite_version() AS v').get().v;
  w(`-- SQLite Admin SQL dump\n-- Database: ${commentLine(dbName)}\n-- Generated: ${new Date().toISOString()}\n-- SQLite version: ${commentLine(version)}\n\n`);
  w('PRAGMA foreign_keys = OFF;\n');
  if (opts.transaction !== false) w('BEGIN TRANSACTION;\n');
  w('\n');
  const objs = prep(db, 'SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid').all();
  const tl = tableList(db);
  const tables = objs.filter((o) => o.type === 'table' && !o.name.startsWith('sqlite_')
    && tl.get(o.name)?.type !== 'shadow' && want(o.name));
  for (const t of tables) {
    w(`--\n-- Table: ${commentLine(t.name)}\n--\n`);
    if (structure) {
      if (opts.dropIfExists) w(`DROP TABLE IF EXISTS ${qi(t.name)};\n`);
      w(`${opts.ifNotExists ? t.sql.replace(/^CREATE\s+(VIRTUAL\s+)?TABLE\s+/i, (m) => m + 'IF NOT EXISTS ') : t.sql};\n`);
    }
    if (data) dumpTableData(db, t.name, w, rowsPerInsert);
    w('\n');
  }
  if (data && tl.has('sqlite_sequence')) {
    const seqs = prep(db, 'SELECT name, seq FROM sqlite_sequence').all().filter((s) => want(s.name));
    if (seqs.length) {
      w('-- Autoincrement counters\n');
      for (const s of seqs) {
        w(`DELETE FROM sqlite_sequence WHERE name = ${literal(s.name)};\n`);
        w(`INSERT INTO sqlite_sequence (name, seq) VALUES (${literal(s.name)}, ${literal(s.seq)});\n`);
      }
      w('\n');
    }
  }
  if (structure) {
    const tableNames = new Set(tables.map((t) => t.name));
    const extra = objs.filter((o) => (o.type === 'index' || o.type === 'trigger') && tableNames.has(o.tbl_name))
      .concat(objs.filter((o) => o.type === 'view' && want(o.name)));
    if (extra.length) w('-- Indexes, triggers and views\n');
    for (const o of extra) {
      if (opts.dropIfExists) w(`DROP ${o.type.toUpperCase()} IF EXISTS ${qi(o.name)};\n`);
      w(`${o.sql};\n`);
    }
  }
  if (opts.transaction !== false) w('\nCOMMIT;\n');
}

function exportRows(db, stmt, params, format, w, opts, name) {
  stmt.setReturnArrays(true);
  const cols = stmt.columns().map((c) => c.name);
  if (format === 'csv' || format === 'tsv') {
    const delim = format === 'tsv' ? '\t' : (opts.delimiter || ',');
    const nullText = opts.nullText ?? '';
    const eol = opts.crlf ? '\r\n' : '\n';
    if (opts.bom) w('\ufeff');
    if (opts.header !== false) w(cols.map((c) => csvField(c, delim, '')).join(delim) + eol);
    for (const row of stmt.iterate(...params)) w(row.map((v) => csvField(v, delim, nullText)).join(delim) + eol);
  } else if (format === 'json') {
    w('[');
    let first = true;
    for (const row of stmt.iterate(...params)) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = jsonValue(row[i]); });
      w((first ? '\n  ' : ',\n  ') + JSON.stringify(obj));
      first = false;
    }
    w(first ? ']\n' : '\n]\n');
  } else if (format === 'sql') {
    const head = `INSERT INTO ${qi(name)} (${cols.map(qi).join(', ')}) VALUES`;
    for (const row of stmt.iterate(...params)) w(`${head} (${row.map(literal).join(', ')});\n`);
  } else if (format === 'markdown') {
    const cell = (v) => (v === null ? 'NULL' : v instanceof Uint8Array ? `BLOB(${v.length})` : String(v))
      .replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    w(`| ${cols.map(cell).join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n`);
    for (const row of stmt.iterate(...params)) w(`| ${row.map(cell).join(' | ')} |\n`);
  } else {
    fail(`Unsupported export format: ${format}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Import helpers

function inferType(values) {
  let sawValue = false;
  let allInt = true;
  let allNum = true;
  for (const v of values) {
    if (v === null || v === '') continue;
    sawValue = true;
    if (typeof v === 'bigint') continue;
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) allInt = false;
      continue;
    }
    if (typeof v !== 'string') { allInt = false; allNum = false; break; }
    if (!/^-?\d{1,18}$/.test(v)) allInt = false;
    if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) { allNum = false; break; }
  }
  if (!sawValue) return 'TEXT';
  if (allInt) return 'INTEGER';
  if (allNum) return 'REAL';
  return 'TEXT';
}

function dedupeNames(names) {
  const seen = new Map();
  return names.map((n, i) => {
    let name = String(n ?? '').trim() || `column${i + 1}`;
    const key = name.toLowerCase();
    if (seen.has(key)) {
      const next = seen.get(key) + 1;
      seen.set(key, next);
      name = `${name}_${next}`;
    } else seen.set(key, 1);
    return name;
  });
}

function insertRowsInto(db, { table, create, headers, rows, mode }) {
  let createSql = null;
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE").get(table);
  let targetCols;
  if (create) {
    if (exists) fail(`Table "${table}" already exists. Choose another name or import into the existing table.`);
    const types = headers.map((_, i) => inferType(rows.slice(0, 5000).map((r) => r[i] ?? null)));
    createSql = `CREATE TABLE ${qi(table)} (\n  ${headers.map((h, i) => `${qi(h)} ${types[i]}`).join(',\n  ')}\n)`;
    targetCols = headers;
  } else {
    if (!exists) fail(`Table "${table}" does not exist`);
    const cols = columnsOf(db, table).filter((c) => c.hidden === 0).map((c) => c.name);
    const byLower = new Map(cols.map((c) => [c.toLowerCase(), c]));
    if (headers) {
      targetCols = headers.map((h) => byLower.get(String(h).toLowerCase()));
      const missing = headers.filter((_, i) => !targetCols[i]);
      if (missing.length) fail(`Columns not found in "${table}": ${missing.join(', ')}`);
    } else {
      const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
      if (width > cols.length) fail(`The data has ${width} columns but "${table}" only has ${cols.length}`);
      targetCols = cols.slice(0, width);
    }
  }
  return tx(db, () => {
    if (createSql) db.exec(createSql);
    if (mode === 'replace' && !create) db.exec(`DELETE FROM ${qi(table)}`);
    const stmt = db.prepare(`INSERT INTO ${qi(table)} (${targetCols.map(qi).join(', ')}) VALUES (${targetCols.map(() => '?').join(', ')})`);
    let n = 0;
    for (const row of rows) {
      const vals = targetCols.map((_, i) => row[i] ?? null);
      try {
        stmt.run(...vals);
      } catch (e) {
        e.message = `Row ${n + 1}: ${e.message}`;
        throw e;
      }
      n++;
    }
    return { inserted: n, table, sql: createSql };
  });
}

function readValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------------------------

const PRAGMAS = [
  { name: 'journal_mode', options: ['delete', 'truncate', 'persist', 'memory', 'wal', 'off'], help: 'How the rollback journal is stored. WAL allows readers and a writer to work at the same time.' },
  { name: 'synchronous', options: ['0', '1', '2', '3'], labels: ['OFF', 'NORMAL', 'FULL', 'EXTRA'], scope: 'connection', help: 'How aggressively SQLite syncs data to disk.' },
  { name: 'foreign_keys', bool: true, scope: 'connection', help: 'Enforce foreign key constraints on this connection.' },
  { name: 'user_version', int: true, help: 'Free integer stored in the database header, often used for schema versions.' },
  { name: 'application_id', int: true, help: 'Integer that identifies the application owning this file.' },
  { name: 'auto_vacuum', options: ['0', '1', '2'], labels: ['NONE', 'FULL', 'INCREMENTAL'], help: 'Changing this on an existing database requires VACUUM.' },
  { name: 'page_size', options: ['512', '1024', '2048', '4096', '8192', '16384', '32768', '65536'], help: 'Takes effect after VACUUM (not possible in WAL mode).' },
  { name: 'cache_size', int: true, scope: 'connection', help: 'Pages (positive) or KiB (negative) of page cache.' },
  { name: 'busy_timeout', int: true, scope: 'connection', help: 'Milliseconds to wait for a lock.' },
  { name: 'secure_delete', bool: true, scope: 'connection', help: 'Overwrite deleted content with zeros.' },
  { name: 'temp_store', options: ['0', '1', '2'], labels: ['DEFAULT', 'FILE', 'MEMORY'], scope: 'connection', help: 'Where temporary tables and indices are stored.' },
  { name: 'recursive_triggers', bool: true, scope: 'connection', help: 'Allow triggers to fire recursively.' },
  { name: 'wal_autocheckpoint', int: true, scope: 'connection', help: 'WAL auto-checkpoint threshold in pages.' },
  { name: 'page_count', readOnly: true },
  { name: 'freelist_count', readOnly: true },
  { name: 'encoding', readOnly: true },
  { name: 'schema_version', readOnly: true },
  { name: 'data_version', readOnly: true },
  { name: 'max_page_count', readOnly: true },
];

// ---------------------------------------------------------------------------------------------

export function createApi(mgr) {
  const getDb = (name) => mgr.get(name);

  const json = {
    databases() {
      return mgr.list().map((d) => {
        try {
          const db = getDb(d.name);
          const counts = db.prepare(
            "SELECT sum(type = 'table' AND name NOT LIKE 'sqlite_%') AS tables, sum(type = 'view') AS views FROM sqlite_schema",
          ).get();
          return { ...d, tables: counts.tables || 0, views: counts.views || 0, journal: pragmaValue(db, 'journal_mode') };
        } catch (e) {
          return { ...d, error: e.message };
        }
      });
    },

    createDatabase({ name, location }) {
      return { name: mgr.create(name, location) };
    },

    /** Move a temporary database into the signed-in user's account. */
    saveDatabase({ db }) {
      return { name: mgr.move(db, 'saved') };
    },

    usage() {
      return {
        locations: mgr.locations.map((l) => ({ id: l.id, used: mgr.usage(l.id), quota: l.quota })),
        databases: mgr.list().length,
        maxDatabases: mgr.maxDatabases,
      };
    },

    deleteDatabase({ db }) {
      mgr.remove(db);
      return { ok: true };
    },

    renameDatabase({ db, newName }) {
      return { name: mgr.rename(db, newName) };
    },

    copyDatabase({ db, newName }) {
      mgr.assertWritable();
      const { path: src, location } = mgr.resolve(db);
      const target = mgr.newName(newName, location);
      mgr.assertSpace(target.location, sizeWithSideFiles(src));
      const conn = getDb(db);
      mgr.trusted(() => conn.exec(`VACUUM INTO ${literal(target.path)}`));
      try {
        mgr.enforceQuota(target.name, null);
      } catch (e) {
        fs.rmSync(target.path, { force: true });
        throw e;
      }
      return { name: target.name };
    },

    overview({ db: dbName }) {
      const db = getDb(dbName);
      const tl = tableList(db);
      const sizes = objectSizes(db);
      const objs = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table','view') ORDER BY name COLLATE NOCASE").all();
      const idxCount = new Map();
      for (const r of db.prepare("SELECT tbl_name, count(*) AS n FROM sqlite_schema WHERE type = 'index' GROUP BY tbl_name").all()) idxCount.set(r.tbl_name, r.n);
      const objects = objs.map((o) => {
        const info = tl.get(o.name) || {};
        let rows = null;
        let error;
        if (o.type === 'table') {
          try { rows = Number(prep(db, `SELECT count(*) AS n FROM ${qi(o.name)}`).get().n); } catch (e) { error = e.message; }
        }
        let size = null;
        if (sizes) {
          size = sizes.get(o.name) || 0;
          for (const idx of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ?").all(o.name)) size += sizes.get(idx.name) || 0;
        }
        return {
          name: o.name, type: info.type === 'virtual' ? 'virtual' : info.type === 'shadow' ? 'shadow' : o.type,
          columns: info.ncol, withoutRowid: !!info.wr, strict: !!info.strict, rows, size, indexes: idxCount.get(o.name) || 0,
          system: o.name.startsWith('sqlite_'), error,
        };
      });
      const file = mgr.resolve(dbName);
      const st = fs.statSync(file.path);
      return {
        objects,
        info: {
          // Don't reveal server paths to the public.
          file: mgr.secure ? dbName : file.path, location: file.location, fileSize: st.size, modified: st.mtime.toISOString(),
          sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
          pageSize: pragmaValue(db, 'page_size'), pageCount: pragmaValue(db, 'page_count'),
          freelist: pragmaValue(db, 'freelist_count'), journalMode: pragmaValue(db, 'journal_mode'),
          encoding: pragmaValue(db, 'encoding'), userVersion: pragmaValue(db, 'user_version'),
          autoVacuum: pragmaValue(db, 'auto_vacuum'), foreignKeys: pragmaValue(db, 'foreign_keys'),
          indexes: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index'").get().n,
          triggers: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger'").get().n,
          inTransaction: db.isTransaction, readOnly: mgr.readOnly, external: mgr.external.has(dbName),
        },
      };
    },

    schema({ db: dbName }) {
      const db = getDb(dbName);
      const tl = tableList(db);
      const objs = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name COLLATE NOCASE').all();
      const tables = [];
      for (const o of objs.filter((x) => x.type === 'table' || x.type === 'view')) {
        const info = tl.get(o.name) || {};
        let columns = [];
        let fks = [];
        try {
          columns = columnsOf(db, o.name).filter((c) => c.hidden !== 1)
            .map((c) => ({ name: c.name, type: c.type, pk: c.pk, notnull: c.notnull }));
          if (o.type === 'table') fks = foreignKeys(db, o.name).map(({ table, from, to }) => ({ table, from, to }));
        } catch { /* broken view */ }
        tables.push({
          name: o.name, type: info.type === 'virtual' || info.type === 'shadow' ? info.type : o.type,
          system: o.name.startsWith('sqlite_'), columns, fks,
        });
      }
      return {
        tables,
        indexes: objs.filter((o) => o.type === 'index').map((o) => ({ name: o.name, table: o.tbl_name, auto: !o.sql })),
        triggers: objs.filter((o) => o.type === 'trigger').map((o) => ({ name: o.name, table: o.tbl_name })),
        inTransaction: db.isTransaction,
      };
    },

    structure({ db: dbName, table }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      const cols = columnsOf(db, obj.name);
      const info = tableList(db).get(obj.name) || {};
      const indexes = obj.type !== 'table' ? [] : db.prepare('SELECT * FROM pragma_index_list(?)').all(obj.name).map((ix) => {
        const parts = db.prepare('SELECT seqno, cid, name, "desc", coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno').all(ix.name);
        const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(ix.name);
        return {
          name: ix.name, unique: !!ix.unique, origin: ix.origin, partial: !!ix.partial, sql: row?.sql || null,
          columns: parts.map((p) => ({ name: p.cid === -2 ? '<expression>' : p.cid === -1 ? 'rowid' : p.name, desc: !!p.desc, coll: p.coll })),
        };
      });
      const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY name").all(obj.name);
      let rowCount = null;
      if (obj.type === 'table') {
        try { rowCount = Number(prep(db, `SELECT count(*) AS n FROM ${qi(obj.name)}`).get().n); } catch { /* ignore */ }
      }
      const sizes = objectSizes(db);
      const key = keyInfo(db, obj, cols);
      const referencedBy = [];
      for (const t of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
        try {
          for (const fk of foreignKeys(db, t.name)) {
            if (fk.table.toLowerCase() === obj.name.toLowerCase()) referencedBy.push({ table: t.name, from: fk.from, to: fk.to, onDelete: fk.onDelete, onUpdate: fk.onUpdate });
          }
        } catch { /* ignore */ }
      }
      return {
        name: obj.name, type: info.type === 'virtual' ? 'virtual' : obj.type, sql: obj.sql,
        columns: cols, indexes, triggers, rowCount,
        foreignKeys: obj.type === 'table' ? foreignKeys(db, obj.name) : [],
        referencedBy,
        withoutRowid: !!info.wr, strict: !!info.strict,
        autoincrement: !!obj.sql && /\bAUTOINCREMENT\b/i.test(obj.sql),
        key: { kind: key.kind, cols: key.cols },
        size: sizes ? (sizes.get(obj.name) || 0) : null,
        model: obj.type === 'table' && obj.sql && info.type !== 'virtual' ? parseCreateTable(obj.sql) : null,
      };
    },

    browse({ db: dbName, table, page = 1, pageSize = 50, sort = [], filters = [], search = '', searchMode }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      const cols = columnsOf(db, obj.name);
      const key = keyInfo(db, obj, cols);
      const { where, params } = buildWhere(cols, filters, search, searchMode);
      const from = qi(obj.name);
      const start = now();
      const total = Number(prep(db, `SELECT count(*) AS n FROM ${from}${where}`).get(...params).n);
      pageSize = clampInt(pageSize, 1, 5000, 50);
      const pages = Math.max(1, Math.ceil(total / pageSize));
      page = clampInt(page, 1, pages, 1);
      const offset = (page - 1) * pageSize;
      const order = buildOrder(cols, sort);
      const keySel = key.kind === 'rowid' ? `${key.alias} AS "__k0", `
        : key.kind === 'pk' ? key.cols.map((c, i) => `${qi(c)} AS "__k${i}", `).join('') : '';
      const stmt = prep(db, `SELECT ${keySel}* FROM ${from}${where}${order} LIMIT ? OFFSET ?`);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...params, pageSize, offset);
      const nk = key.cols.length;
      const colByName = new Map(cols.map((c) => [c.name, c]));
      return {
        table: obj.name,
        type: obj.type,
        columns: stmt.columns().slice(nk).map((m) => {
          const c = colByName.get(m.name);
          return { name: m.name, type: c ? c.type : (m.type || ''), pk: c ? c.pk : 0, notnull: c ? c.notnull : false, hidden: c ? c.hidden : 0 };
        }),
        rows: rows.map((r) => ({ k: r.slice(0, nk).map((v) => encodeValue(v, true)), v: r.slice(nk).map((v) => encodeValue(v)) })),
        total, page, pageSize,
        key: { kind: key.kind, cols: key.cols },
        editable: key.kind !== 'none' && !mgr.readOnly && obj.type === 'table',
        fks: singleColumnFkMap(db, obj),
        sql: inlineParams(`SELECT * FROM ${from}${where}${order} LIMIT ${pageSize} OFFSET ${offset}`, params),
        time: msSince(start),
      };
    },

    getRow({ db: dbName, table, key: keyVals }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      const cols = columnsOf(db, obj.name);
      const key = keyInfo(db, obj, cols);
      const kw = keyWhere(key, keyVals);
      const stmt = prep(db, `SELECT * FROM ${qi(obj.name)} WHERE ${kw.sql}`);
      const row = stmt.get(...kw.params);
      if (!row) fail('Row not found — it may have been deleted.', 404);
      const values = {};
      for (const [k, v] of Object.entries(row)) values[k] = encodeValue(v);
      return { values };
    },

    insertRow({ db: dbName, table, values }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      const names = new Set(columnsOf(db, obj.name).map((c) => c.name));
      const colSql = [];
      const valSql = [];
      const params = [];
      for (const [name, v] of Object.entries(values || {})) {
        if (!names.has(name)) fail(`Unknown column: ${name}`);
        if (v && typeof v === 'object' && v.$default) continue;
        colSql.push(qi(name));
        if (v && typeof v === 'object' && typeof v.$raw === 'string') valSql.push(`(${v.$raw})`);
        else { valSql.push('?'); params.push(decodeValue(v)); }
      }
      const sql = colSql.length
        ? `INSERT INTO ${qi(obj.name)} (${colSql.join(', ')}) VALUES (${valSql.join(', ')})`
        : `INSERT INTO ${qi(obj.name)} DEFAULT VALUES`;
      const r = prep(db, sql).run(...params);
      mgr.enforceQuota(dbName, db);
      return { changes: Number(r.changes), lastInsertRowid: encodeValue(r.lastInsertRowid), sql: inlineParams(sql, params) };
    },

    updateRow({ db: dbName, table, key: keyVals, values }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      const cols = columnsOf(db, obj.name);
      const names = new Set(cols.map((c) => c.name));
      const key = keyInfo(db, obj, cols);
      const kw = keyWhere(key, keyVals);
      const sets = [];
      const params = [];
      for (const [name, v] of Object.entries(values || {})) {
        if (!names.has(name)) fail(`Unknown column: ${name}`);
        if (v && typeof v === 'object' && v.$default) fail('DEFAULT cannot be used in an update');
        if (v && typeof v === 'object' && typeof v.$raw === 'string') sets.push(`${qi(name)} = (${v.$raw})`);
        else { sets.push(`${qi(name)} = ?`); params.push(decodeValue(v)); }
      }
      if (!sets.length) fail('Nothing to update');
      const sql = `UPDATE ${qi(obj.name)} SET ${sets.join(', ')} WHERE ${kw.sql}`;
      const r = prep(db, sql).run(...params, ...kw.params);
      mgr.enforceQuota(dbName, db);
      if (Number(r.changes) === 0) fail('No row was updated — it may have been changed or deleted. Refresh and try again.', 409);
      return { changes: Number(r.changes), sql: inlineParams(sql, [...params, ...kw.params]) };
    },

    deleteRows({ db: dbName, table, keys }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      const key = keyInfo(db, obj, columnsOf(db, obj.name));
      if (!Array.isArray(keys) || !keys.length) fail('No rows selected');
      let changes = 0;
      let lastSql = '';
      tx(db, () => {
        for (const k of keys) {
          const kw = keyWhere(key, k);
          const sql = `DELETE FROM ${qi(obj.name)} WHERE ${kw.sql}`;
          changes += Number(prep(db, sql).run(...kw.params).changes);
          lastSql = inlineParams(sql, kw.params);
        }
      });
      return { changes, sql: keys.length === 1 ? lastSql : `${keys.length} DELETE statements` };
    },

    query({ db: dbName, sql, maxRows = 1000 }) {
      if (typeof sql !== 'string') fail('SQL is required');
      const statements = splitStatements(sql);
      if (!statements.length) fail('There is no SQL statement to execute');
      const limit = clampInt(maxRows, 1, 100000, 1000);
      const db = getDb(dbName);
      const wasTx = db.isTransaction;
      const results = [];
      let schemaChanged = false;
      const started = now();
      for (const text of statements) {
        const start = now();
        const kw = firstKeyword(text);
        try {
          const stmt = prep(db, text);
          const meta = stmt.columns();
          if (meta.length) {
            stmt.setReturnArrays(true);
            const rows = [];
            let truncated = false;
            for (const r of stmt.iterate()) {
              if (rows.length >= limit) { truncated = true; break; }
              rows.push(r.map((v) => encodeValue(v)));
            }
            mgr.enforceQuota(dbName, db);
            results.push({
              sql: text, time: msSince(start), rows, truncated,
              columns: meta.map((c) => ({ name: c.name, type: c.type, table: c.table, column: c.column })),
            });
          } else {
            const r = stmt.run();
            mgr.enforceQuota(dbName, db);
            const res = { sql: text, time: msSince(start) };
            if (DML.has(kw)) res.changes = Number(r.changes);
            if (kw === 'INSERT' || kw === 'REPLACE') res.lastInsertRowid = encodeValue(r.lastInsertRowid);
            results.push(res);
          }
          if (DDL.has(kw) || kw === 'VACUUM') schemaChanged = true;
        } catch (e) {
          results.push({ sql: text, error: mgr.errorMessage(e), time: msSince(start) });
          let rolledBack = false;
          if (!wasTx && db.isTransaction) {
            try { db.exec('ROLLBACK'); rolledBack = true; } catch { /* ignore */ }
          }
          return {
            results, failed: true, rolledBack, schemaChanged, time: msSince(started),
            skipped: statements.length - results.length, inTransaction: db.isTransaction,
          };
        }
      }
      return { results, schemaChanged, time: msSince(started), inTransaction: db.isTransaction };
    },

    transaction({ db: dbName, action }) {
      const db = getDb(dbName);
      if (!db.isTransaction) return { inTransaction: false };
      db.exec(action === 'commit' ? 'COMMIT' : 'ROLLBACK');
      return { inTransaction: db.isTransaction };
    },

    rebuildTable({ db: dbName, table, createSql, mapping }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      if (obj.type !== 'table') fail('Only tables can be rebuilt');
      if (typeof createSql !== 'string' || splitStatements(createSql).length !== 1) fail('Provide exactly one CREATE TABLE statement');
      createSql = splitStatements(createSql)[0];
      const loc = findCreateName(createSql);
      if (!loc || !/^\s*CREATE\s+TABLE\b/i.test(createSql)) fail('Expected a CREATE TABLE statement');
      if (db.isTransaction) fail('Commit or roll back the open transaction first');
      const finalName = loc.name;
      const tmp = uniqueName(db, `sqla_new_${obj.name}`);
      const tmpSql = renameInCreate(createSql, tmp);
      const oldCols = new Set(columnsOf(db, obj.name).filter((c) => c.hidden !== 1).map((c) => c.name));
      const deps = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type").all(obj.name);
      const fkOn = pragmaValue(db, 'foreign_keys');
      const warnings = [];
      const steps = [];
      const run = (sql) => { db.exec(sql); steps.push(sql); };
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('PRAGMA legacy_alter_table = ON');
        tx(db, () => {
          run(tmpSql);
          const newCols = columnsOf(db, tmp).filter((c) => c.hidden === 0).map((c) => c.name);
          const pairs = (Array.isArray(mapping) ? mapping : newCols.map((n) => ({ to: n, from: n })))
            .filter((m) => m && m.from && newCols.includes(m.to) && oldCols.has(m.from));
          if (pairs.length) {
            run(`INSERT INTO ${qi(tmp)} (${pairs.map((p) => qi(p.to)).join(', ')}) SELECT ${pairs.map((p) => qi(p.from)).join(', ')} FROM ${qi(obj.name)}`);
          }
          run(`DROP TABLE ${qi(obj.name)}`);
          run(`ALTER TABLE ${qi(tmp)} RENAME TO ${qi(obj.name)}`);
          for (const d of deps) {
            try { run(d.sql); } catch (e) { warnings.push(`Could not recreate ${d.type} "${d.name}": ${e.message}`); }
          }
          db.exec('PRAGMA legacy_alter_table = OFF');
          if (finalName !== obj.name) run(`ALTER TABLE ${qi(obj.name)} RENAME TO ${qi(finalName)}`);
          if (fkOn) {
            const bad = db.prepare('PRAGMA foreign_key_check').all()
              .filter((v) => [finalName.toLowerCase(), obj.name.toLowerCase()].includes(String(v.table).toLowerCase())
                || [finalName.toLowerCase(), obj.name.toLowerCase()].includes(String(v.parent).toLowerCase()));
            if (bad.length) throw new Error(`The new definition violates foreign key constraints (${bad.length} row(s), e.g. table "${bad[0].table}" rowid ${bad[0].rowid}). No changes were made.`);
          }
        });
      } finally {
        try { db.exec('PRAGMA legacy_alter_table = OFF'); } catch { /* ignore */ }
        if (fkOn) db.exec('PRAGMA foreign_keys = ON');
      }
      return { table: finalName, sql: steps.join(';\n') + ';', warnings };
    },

    copyTable({ db: dbName, table, newName, withData = true, withIndexes = true }) {
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      if (obj.type !== 'table' || !obj.sql) fail('Only regular tables can be copied');
      if (!newName) fail('New table name is required');
      const steps = [];
      tx(db, () => {
        const createSql = renameInCreate(obj.sql, newName);
        db.exec(createSql);
        steps.push(createSql);
        if (withData) {
          const cols = columnsOf(db, obj.name).filter((c) => c.hidden === 0).map((c) => qi(c.name)).join(', ');
          const sql = `INSERT INTO ${qi(newName)} (${cols}) SELECT ${cols} FROM ${qi(obj.name)}`;
          db.exec(sql);
          steps.push(sql);
        }
        if (withIndexes) {
          for (const ix of db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(obj.name)) {
            const base = ix.name.toLowerCase().includes(obj.name.toLowerCase())
              ? ix.name.replace(new RegExp(obj.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), newName)
              : `${newName}_${ix.name}`;
            const sql = retargetIndex(ix.sql, uniqueName(db, base), newName);
            db.exec(sql);
            steps.push(sql);
          }
        }
      });
      return { table: newName, sql: steps.join(';\n') + ';' };
    },

    searchDatabase({ db: dbName, term, mode = 'contains', tables }) {
      if (term === undefined || term === null || term === '') fail('Enter something to search for');
      const db = getDb(dbName);
      const tl = tableList(db);
      const wanted = Array.isArray(tables) && tables.length ? new Set(tables) : null;
      const results = [];
      const start = now();
      for (const o of db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') ORDER BY name COLLATE NOCASE").all()) {
        if (o.name.startsWith('sqlite_') || tl.get(o.name)?.type === 'shadow') continue;
        if (wanted && !wanted.has(o.name)) continue;
        try {
          const cols = columnsOf(db, o.name);
          const { where, params } = buildWhere(cols, [], term, mode);
          if (!where) continue;
          const count = Number(prep(db, `SELECT count(*) AS n FROM ${qi(o.name)}${where}`).get(...params).n);
          if (count > 0) {
            const matched = [];
            for (const c of cols.filter((x) => x.hidden !== 1)) {
              const one = buildWhere([c], [], term, mode);
              if (prep(db, `SELECT 1 FROM ${qi(o.name)}${one.where} LIMIT 1`).get(...one.params)) matched.push(c.name);
            }
            results.push({ table: o.name, type: o.type, count, columns: matched });
          }
        } catch (e) {
          results.push({ table: o.name, type: o.type, error: e.message });
        }
      }
      return { results, time: msSince(start) };
    },

    pragmas({ db: dbName }) {
      const db = getDb(dbName);
      return {
        pragmas: PRAGMAS.map((p) => {
          let value = null;
          try { value = pragmaValue(db, p.name); } catch { /* unsupported */ }
          return { ...p, value: typeof value === 'bigint' ? Number(value) : value };
        }),
      };
    },

    setPragma({ db: dbName, name, value }) {
      const def = PRAGMAS.find((p) => p.name === name);
      if (!def || def.readOnly) fail('This pragma cannot be changed here');
      const v = String(value ?? '').trim().toLowerCase();
      if (def.bool && !['0', '1', 'on', 'off', 'true', 'false'].includes(v)) fail('Expected ON or OFF');
      if (def.int && !/^-?\d+$/.test(v)) fail('Expected an integer');
      if (def.options && !def.options.includes(v)) fail(`Expected one of: ${def.options.join(', ')}`);
      const db = getDb(dbName);
      const sql = `PRAGMA ${name} = ${v}`;
      db.exec(sql);
      return { sql, value: pragmaValue(db, name) };
    },
  };

  // -------------------------------------------------------------------------------------------
  // Raw handlers (streams, uploads, binary downloads)

  const raw = {
    async export({ body, res }) {
      const { db: dbName, table, sql, format = 'sql', options = {} } = body;
      const db = getDb(dbName);
      const ext = { sql: 'sql', csv: 'csv', tsv: 'tsv', json: 'json', markdown: 'md' }[format];
      if (!ext) fail(`Unsupported export format: ${format}`);
      const types = { sql: 'application/sql', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', md: 'text/markdown' };

      if (sql) {
        const stmts = splitStatements(sql);
        if (stmts.length !== 1) fail('Export requires exactly one SELECT statement');
        const stmt = prep(db, stmts[0]);
        if (!stmt.columns().length) fail('The statement does not return rows');
        const w = download(res, `query-${stamp()}.${ext}`, `${types[ext]}; charset=utf-8`);
        exportRows(db, stmt, [], format, w.write, options, options.tableName || 'query_result');
        w.end();
        return;
      }

      if (table) {
        const obj = objectInfo(db, table);
        const cols = columnsOf(db, obj.name);
        const { where, params } = buildWhere(cols, options.filters, options.search, options.searchMode);
        const order = buildOrder(cols, options.sort);
        const w = download(res, `${obj.name}.${ext}`, `${types[ext]}; charset=utf-8`);
        if (format === 'sql') {
          const version = db.prepare('SELECT sqlite_version() AS v').get().v;
          w.write(`-- SQLite Admin SQL dump\n-- Database: ${commentLine(dbName)}\n-- Table: ${commentLine(obj.name)}\n-- Generated: ${new Date().toISOString()}\n-- SQLite version: ${commentLine(version)}\n\n`);
          if (options.transaction !== false) w.write('BEGIN TRANSACTION;\n\n');
          if (options.structure !== false && obj.sql) {
            if (options.dropIfExists) w.write(`DROP ${obj.type.toUpperCase()} IF EXISTS ${qi(obj.name)};\n`);
            w.write(`${obj.sql};\n\n`);
          }
          if (options.data !== false && obj.type === 'table') {
            dumpTableData(db, obj.name, w.write, clampInt(options.rowsPerInsert, 1, 10000, 100), where + order, params);
          }
          if (options.structure !== false) {
            const deps = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(obj.name);
            if (deps.length) w.write('\n');
            for (const d of deps) w.write(`${d.sql};\n`);
          }
          if (options.transaction !== false) w.write('\nCOMMIT;\n');
        } else {
          const visible = cols.filter((c) => c.hidden !== 1).map((c) => qi(c.name)).join(', ');
          exportRows(db, prep(db, `SELECT ${visible} FROM ${qi(obj.name)}${where}${order}`), params, format, w.write, options, obj.name);
        }
        w.end();
        return;
      }

      if (format === 'sql') {
        const w = download(res, `${baseName(dbName)}-${stamp()}.sql`, 'application/sql; charset=utf-8');
        dumpSql(db, w.write, dbName, options);
        w.end();
        return;
      }
      if (format === 'json') {
        const selected = Array.isArray(options.tables) && options.tables.length ? options.tables
          : db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
        const w = download(res, `${baseName(dbName)}-${stamp()}.json`, 'application/json; charset=utf-8');
        w.write('{');
        selected.forEach((name, i) => {
          const obj = objectInfo(db, name);
          const cols = columnsOf(db, obj.name).filter((c) => c.hidden !== 1).map((c) => qi(c.name)).join(', ');
          w.write(`${i ? ',' : ''}\n${JSON.stringify(obj.name)}: `);
          exportRows(db, prep(db, `SELECT ${cols} FROM ${qi(obj.name)}`), [], 'json', w.write, options, obj.name);
        });
        w.write('}\n');
        w.end();
        return;
      }
      fail('CSV export works on a single table. Choose a table or use SQL/JSON format.');
    },

    async import({ query, text, file }) {
      try {
        if (text === undefined && file) text = fs.readFileSync(file, 'utf8');
        const dbName = query.get('db');
        const format = query.get('format') || 'sql';
        const db = getDb(dbName);
        const start = now();
        if (format === 'sql') {
          const statements = splitStatements(text);
          if (!statements.length) fail('The file does not contain any SQL statements');
          const wrap = query.get('transaction') !== '0';
          const disableFk = query.get('disableFk') !== '0';
          const fkBefore = pragmaValue(db, 'foreign_keys');
          const wasTx = db.isTransaction;
          let executed = 0;
          let skipped = 0;
          if (disableFk && !wasTx) db.exec('PRAGMA foreign_keys = OFF');
          try {
            if (wrap && !wasTx) db.exec('BEGIN');
            statements.forEach((s, i) => {
              if (wrap && /^(BEGIN|COMMIT|END)(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?$/i.test(s)) { skipped++; return; }
              if (disableFk && /^PRAGMA\s+foreign_keys\b/i.test(s)) { skipped++; return; }
              try {
                db.exec(s);
                mgr.enforceQuota(dbName, db);
              } catch (e) {
                const snippet = s.length > 300 ? s.slice(0, 300) + '…' : s;
                throw Object.assign(new Error(`Statement ${i + 1} failed: ${mgr.errorMessage(e)}\n\n${snippet}`), { status: 400 });
              }
              executed++;
            });
            if (wrap && !wasTx) db.exec('COMMIT');
          } catch (e) {
            if (!wasTx && db.isTransaction) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
            throw e;
          } finally {
            if (disableFk && !wasTx) db.exec(`PRAGMA foreign_keys = ${fkBefore ? 'ON' : 'OFF'}`);
          }
          let fkViolations = 0;
          if (fkBefore) fkViolations = db.prepare('PRAGMA foreign_key_check').all().length;
          return { executed, skipped, fkViolations, time: msSince(start), schemaChanged: true };
        }

        const table = String(query.get('table') || '').trim();
        if (!table) fail('Target table name is required');
        const create = query.get('create') === '1';
        const mode = query.get('mode') || 'append';
        let headers;
        let rows;
        if (format === 'csv') {
          const delimiter = query.get('delimiter') === '\\t' ? '\t' : (query.get('delimiter') || ',');
          const all = parseCsv(text, delimiter);
          if (!all.length) fail('The file contains no rows');
          const hasHeader = query.get('header') !== '0';
          const width = all.reduce((m, r) => Math.max(m, r.length), 0);
          headers = hasHeader ? dedupeNames(all.shift()) : null;
          if (create && !headers) headers = Array.from({ length: width }, (_, i) => `column${i + 1}`);
          const emptyNull = query.get('emptyNull') !== '0';
          rows = emptyNull ? all.map((r) => r.map((v) => (v === '' ? null : v))) : all;
        } else if (format === 'json') {
          let data;
          try { data = JSON.parse(text); } catch (e) { fail(`Invalid JSON: ${e.message}`); }
          if (!Array.isArray(data)) {
            const arrays = data && typeof data === 'object' ? Object.values(data).filter(Array.isArray) : [];
            if (arrays.length === 1) data = arrays[0];
            else fail('Expected a JSON array of objects');
          }
          const keys = [];
          const seen = new Set();
          for (const item of data) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Every JSON array element must be an object');
            for (const k of Object.keys(item)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
          }
          headers = keys;
          rows = data.map((item) => keys.map((k) => readValue(item[k])));
        } else {
          fail(`Unsupported import format: ${format}`);
        }
        const result = insertRowsInto(db, { table, create, headers, rows, mode });
        mgr.enforceQuota(dbName, db);
        return { ...result, time: msSince(start), schemaChanged: create };
      } finally {
        if (file) fs.rmSync(file, { force: true });
      }
    },

    /** `file` is the uploaded file, already received by the HTTP server into mgr.tmpDir. */
    async uploadDatabase({ query, file }) {
      try {
        mgr.assertWritable();
        const target = mgr.newName(query.get('name'), query.get('location') || undefined);
        const size = fs.statSync(file).size;
        mgr.assertSpace(target.location, size);
        const fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        if (size > 0 && head.toString('latin1') !== 'SQLite format 3\0') fail('The uploaded file is not an SQLite 3 database');
        const probe = mgr.open(file, { readOnly: true });
        try { probe.prepare('SELECT count(*) FROM sqlite_schema').get(); } finally { probe.close(); }
        fs.renameSync(file, target.path);
        return { name: target.name, location: target.location };
      } finally {
        // Also the empty -wal/-shm files that opening a WAL-mode upload creates.
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
      }
    },

    async downloadDatabase({ body, res }) {
      const { db: dbName } = body;
      const src = mgr.resolve(dbName).path;
      const tmp = path.join(mgr.tmpDir, `download-${crypto.randomBytes(6).toString('hex')}.db`);
      // A VACUUM INTO copy is consistent and includes committed WAL content; fall back to a plain file copy.
      try {
        const conn = getDb(dbName);
        mgr.trusted(() => conn.exec(`VACUUM INTO ${literal(tmp)}`));
      } catch {
        fs.copyFileSync(src, tmp);
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-sqlite3',
        'Content-Disposition': contentDisposition(dbName),
        'Cache-Control': 'no-store',
      });
      res.sendFile(tmp, { remove: true });
    },

    async blob({ body, res }) {
      const { db: dbName, table, key: keyVals, column } = body;
      const db = getDb(dbName);
      const obj = objectInfo(db, table);
      const cols = columnsOf(db, obj.name);
      if (!cols.some((c) => c.name === column)) fail(`Unknown column: ${column}`);
      const kw = keyWhere(keyInfo(db, obj, cols), keyVals);
      const row = prep(db, `SELECT ${qi(column)} AS v FROM ${qi(obj.name)} WHERE ${kw.sql}`).get(...kw.params);
      if (!row) fail('Row not found', 404);
      let data = row.v;
      if (data === null) fail('The value is NULL');
      if (!(data instanceof Uint8Array)) data = Buffer.from(String(data), 'utf8');
      const buf = Buffer.from(data);
      const mime = sniffMime(buf);
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/zip': 'zip', 'application/gzip': 'gz', 'application/x-sqlite3': 'db', 'image/bmp': 'bmp' }[mime] || 'bin';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buf.length,
        'Content-Disposition': contentDisposition(`${obj.name}-${column}.${ext}`),
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    },
  };

  return { json, raw };
}
