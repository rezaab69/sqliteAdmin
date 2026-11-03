// SQL helpers shared by the server (Node) and the browser client.
// No DOM or Node-specific APIs may be used in this file.

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const TWO_CHAR_OPS = new Set(['||', '<=', '>=', '!=', '<>', '==', '<<', '>>', '->']);

/** Quote an SQL identifier. */
export function qi(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Remove identifier quoting ("x", `x`, [x]). */
export function unquoteIdent(text) {
  const c = text[0];
  if (c === '"' || c === '`') return text.slice(1, -1).split(c + c).join(c);
  if (c === '[') return text.slice(1, -1);
  if (c === "'") return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function scanQuoted(sql, i, q) {
  i++;
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/**
 * Tokenize SQL text. Every character of the input belongs to exactly one token,
 * so joining token texts reproduces the input.
 * Token types: ws, comment, string, ident, blob, number, word, param, punct.
 */
export function tokenize(sql) {
  const tokens = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const start = i;
    let type;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      while (i < n && /\s/.test(sql[i])) i++;
      type = 'ws';
    } else if (c === '-' && sql[i + 1] === '-') {
      i = sql.indexOf('\n', i);
      if (i < 0) i = n;
      type = 'comment';
    } else if (c === '/' && sql[i + 1] === '*') {
      i = sql.indexOf('*/', i + 2);
      i = i < 0 ? n : i + 2;
      type = 'comment';
    } else if (c === "'") {
      i = scanQuoted(sql, i, "'");
      type = 'string';
    } else if (c === '"' || c === '`') {
      i = scanQuoted(sql, i, c);
      type = 'ident';
    } else if (c === '[') {
      i = sql.indexOf(']', i + 1);
      i = i < 0 ? n : i + 1;
      type = 'ident';
    } else if ((c === 'x' || c === 'X') && sql[i + 1] === "'") {
      i = scanQuoted(sql, i + 1, "'");
      type = 'blob';
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F_]/.test(sql[i])) i++;
      } else {
        while (i < n && /[0-9_.]/.test(sql[i])) i++;
        if (/[eE]/.test(sql[i] || '') && /[-+0-9]/.test(sql[i + 1] || '')) {
          i += 2;
          while (i < n && /[0-9]/.test(sql[i])) i++;
        }
      }
      type = 'number';
    } else if (WORD_START.test(c)) {
      while (i < n && WORD_CHAR.test(sql[i])) i++;
      type = 'word';
    } else if (c === '?') {
      i++;
      while (i < n && /[0-9]/.test(sql[i])) i++;
      type = 'param';
    } else if ((c === ':' || c === '@' || c === '$') && WORD_START.test(sql[i + 1] || '')) {
      i++;
      while (i < n && WORD_CHAR.test(sql[i])) i++;
      type = 'param';
    } else {
      if (sql.startsWith('->>', i)) i += 3;
      else if (TWO_CHAR_OPS.has(sql.substr(i, 2))) i += 2;
      else i++;
      type = 'punct';
    }
    tokens.push({ type, text: sql.slice(start, i), start, end: i });
  }
  return tokens;
}

export const isSignificant = (t) => t.type !== 'ws' && t.type !== 'comment';

/**
 * Split a script into individual statements (without trailing semicolons).
 * Handles strings, comments and CREATE TRIGGER ... BEGIN ... END bodies
 * the same way sqlite3_complete() does.
 */
export function splitStatements(sql) {
  const out = [];
  let start = null;
  let head = [];
  let isTrigger = false;
  let sinceSemi = [];
  for (const t of tokenize(sql)) {
    if (!isSignificant(t)) continue;
    if (start === null) {
      if (t.text === ';') continue;
      start = t.start;
      head = [];
      isTrigger = false;
      sinceSemi = [];
    }
    if (t.text === ';') {
      const endsTrigger = sinceSemi.length === 1 && /^end$/i.test(sinceSemi[0].text);
      if (isTrigger && !endsTrigger) { sinceSemi = []; continue; }
      out.push(sql.slice(start, t.start).trim());
      start = null;
      continue;
    }
    sinceSemi.push(t);
    if (head.length < 3) {
      head.push(t.text.toUpperCase());
      if (head[0] === 'CREATE' && (head[1] === 'TRIGGER' ||
          ((head[1] === 'TEMP' || head[1] === 'TEMPORARY') && head[2] === 'TRIGGER'))) {
        isTrigger = true;
      }
    }
  }
  if (start !== null) {
    const rest = sql.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

/** First keyword of a statement, upper-cased (skips leading comments). */
export function firstKeyword(sql) {
  for (const t of tokenize(sql)) {
    if (!isSignificant(t)) continue;
    return t.type === 'word' ? t.text.toUpperCase() : '';
  }
  return '';
}

const COL_STOP = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT',
  'COLLATE', 'REFERENCES', 'GENERATED', 'AS']);
const TABLE_CONSTRAINT_START = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

const isWord = (t, w) => t && t.type === 'word' && t.text.toUpperCase() === w;

function parseColumnDef(sql, d) {
  const col = {
    name: unquoteIdent(d[0].text), type: '', pk: false, autoincrement: false,
    notnull: false, unique: false, default: '', extra: '',
  };
  let k = 1;
  let depth = 0;
  while (k < d.length) {
    const t = d[k];
    if (depth === 0 && t.type === 'word' && COL_STOP.has(t.text.toUpperCase())) break;
    if (t.text === '(') depth++;
    else if (t.text === ')') depth--;
    k++;
  }
  if (k > 1) col.type = sql.slice(d[1].start, d[k - 1].end);

  const extras = [];
  while (k < d.length) {
    const uStart = k;
    if (isWord(d[k], 'CONSTRAINT')) k += 2;
    k++;
    depth = 0;
    while (k < d.length) {
      const t = d[k];
      if (depth === 0 && t.type === 'word') {
        const u = t.text.toUpperCase();
        const prev = d[k - 1].text.toUpperCase();
        let stop = false;
        if (u === 'NOT') stop = isWord(d[k + 1], 'NULL');
        else if (u === 'NULL') stop = !['SET', 'NOT', 'DEFAULT'].includes(prev);
        else if (u === 'DEFAULT') stop = prev !== 'SET';
        else if (u === 'AS') stop = prev !== 'ALWAYS';
        else stop = COL_STOP.has(u);
        if (stop) break;
      }
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
      k++;
    }
    const last = d[Math.min(k, d.length) - 1];
    const raw = sql.slice(d[uStart].start, last.end);
    const norm = raw.replace(/\s+/g, ' ').trim().toUpperCase();
    if (norm === 'NOT NULL') col.notnull = true;
    else if (norm === 'NULL') { /* nullable is the default */ }
    else if (norm === 'PRIMARY KEY') col.pk = true;
    else if (norm === 'PRIMARY KEY AUTOINCREMENT') { col.pk = true; col.autoincrement = true; }
    else if (norm === 'UNIQUE') col.unique = true;
    else if (/^DEFAULT\b/.test(norm)) col.default = raw.replace(/^DEFAULT\s*/i, '');
    else extras.push(raw);
  }
  col.extra = extras.join(' ');
  return col;
}

/**
 * Parse a CREATE TABLE statement into a designer model:
 * { columns: [{name,type,pk,autoincrement,notnull,unique,default,extra}], constraints: [raw], withoutRowid, strict }
 * Returns null when the statement cannot be represented (e.g. CREATE TABLE ... AS SELECT).
 */
export function parseCreateTable(sql) {
  const toks = tokenize(sql).filter(isSignificant);
  const open = toks.findIndex((t) => t.text === '(');
  if (open < 0) return null;
  for (let k = 0; k < open; k++) if (isWord(toks[k], 'AS')) return null;
  let depth = 0;
  const defs = [];
  let cur = [];
  let j = open + 1;
  for (; j < toks.length; j++) {
    const t = toks[j];
    if (t.text === '(') depth++;
    else if (t.text === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (t.text === ',' && depth === 0) { defs.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) defs.push(cur);
  const tail = toks.slice(j + 1).map((t) => t.text.toUpperCase()).join(' ');
  const columns = [];
  const constraints = [];
  for (const d of defs) {
    if (!d.length) continue;
    const raw = sql.slice(d[0].start, d[d.length - 1].end);
    if (d[0].type === 'word' && TABLE_CONSTRAINT_START.has(d[0].text.toUpperCase())) constraints.push(raw);
    else columns.push(parseColumnDef(sql, d));
  }
  return {
    columns,
    constraints,
    withoutRowid: /\bWITHOUT ROWID\b/.test(tail),
    strict: /\bSTRICT\b/.test(tail),
  };
}

/**
 * Locate the object-name token in a CREATE statement
 * (CREATE [TEMP] [UNIQUE] [VIRTUAL] TABLE|INDEX|VIEW|TRIGGER [IF NOT EXISTS] [schema.]name).
 */
export function findCreateName(sql) {
  const toks = tokenize(sql).filter(isSignificant);
  let k = 0;
  if (!isWord(toks[k], 'CREATE')) return null;
  k++;
  while (toks[k] && ['TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL'].includes(toks[k].text.toUpperCase())) k++;
  if (!toks[k] || !['TABLE', 'INDEX', 'VIEW', 'TRIGGER'].includes(toks[k].text.toUpperCase())) return null;
  k++;
  if (isWord(toks[k], 'IF') && isWord(toks[k + 1], 'NOT') && isWord(toks[k + 2], 'EXISTS')) k += 3;
  const first = toks[k];
  if (!first) return null;
  let last = first;
  if (toks[k + 1] && toks[k + 1].text === '.' && toks[k + 2]) last = toks[k + 2];
  return { start: first.start, end: last.end, name: unquoteIdent(last.text), afterIndex: k + (last === first ? 1 : 3), toks };
}

/** Replace the object name in a CREATE statement. */
export function renameInCreate(sql, newName) {
  const loc = findCreateName(sql);
  if (!loc) throw new Error('Unable to locate object name in CREATE statement');
  return sql.slice(0, loc.start) + qi(newName) + sql.slice(loc.end);
}

/** For CREATE INDEX statements: replace both the index name and the table after ON. */
export function retargetIndex(sql, newIndexName, newTable) {
  const loc = findCreateName(sql);
  if (!loc) throw new Error('Unable to parse CREATE INDEX statement');
  const toks = loc.toks;
  const k = loc.afterIndex;
  if (!isWord(toks[k], 'ON') || !toks[k + 1]) throw new Error('Unable to parse CREATE INDEX statement');
  const tbl = toks[k + 1];
  return sql.slice(0, loc.start) + qi(newIndexName) + sql.slice(loc.end, tbl.start) + qi(newTable) + sql.slice(tbl.end);
}

export const KEYWORDS = new Set(('ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT ' +
  'BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS ' +
  'CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH ' +
  'DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FALSE FILTER FIRST ' +
  'FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED ' +
  'INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED ' +
  'NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA ' +
  'PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT ' +
  'RETURNING RIGHT ROLLBACK ROW ROWID ROWS SAVEPOINT SELECT SET STORED STRICT TABLE TEMP TEMPORARY THEN TIES TO ' +
  'TRANSACTION TRIGGER TRUE UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW ' +
  'WITH WITHOUT').split(' '));

export const FUNCTIONS = new Set(('abs changes char coalesce concat concat_ws format glob hex ifnull iif instr ' +
  'last_insert_rowid length like likelihood likely lower ltrim max min nullif octet_length printf quote random ' +
  'randomblob replace round rtrim sign soundex sqlite_source_id sqlite_version substr substring total_changes trim ' +
  'typeof unhex unicode unlikely upper zeroblob date time datetime julianday unixepoch strftime timediff avg count ' +
  'group_concat string_agg sum total row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value ' +
  'last_value nth_value json json_array json_array_length json_extract json_insert json_object json_patch ' +
  'json_remove json_replace json_set json_type json_valid json_quote json_group_array json_group_object json_each ' +
  'json_tree jsonb acos asin atan atan2 ceil ceiling cos cosh degrees exp floor ln log log10 log2 mod pi pow power ' +
  'radians sin sinh sqrt tan tanh trunc regexp').split(' '));

export const TYPES = new Set(('INTEGER INT TINYINT SMALLINT MEDIUMINT BIGINT TEXT REAL BLOB NUMERIC VARCHAR CHAR ' +
  'NCHAR NVARCHAR CLOB BOOLEAN DATE DATETIME TIMESTAMP FLOAT DOUBLE DECIMAL ANY JSON').split(' '));
