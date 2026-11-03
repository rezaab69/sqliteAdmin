// Keeps track of the database files the panel can manage and their open connections.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, constants as SQLITE } from 'node:sqlite';
import { fail } from './util.js';

export const DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db3', '.s3db', '.sl3'];
const NAME_RE = /^[\w\-. ()]+$/u;
const SIDE_FILES = ['-wal', '-shm', '-journal'];
// PRAGMAs that act on the whole process or the file system. In secure mode user SQL may not run them.
const BLOCKED_PRAGMAS = new Set(['hard_heap_limit', 'soft_heap_limit', 'temp_store_directory', 'data_store_directory', 'writable_schema']);
const SQLITE_FULL = 13;

export const hasDbExtension = (name) => DB_EXTENSIONS.includes(path.extname(name).toLowerCase());

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** Size of a database file together with its WAL/SHM/journal files. */
function sizeWithSideFiles(p) {
  let size = 0;
  for (const suffix of ['', ...SIDE_FILES]) {
    try { size += fs.statSync(p + suffix).size; } catch { /* missing */ }
  }
  return size;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

export class DbManager {
  /**
   * @param {object} o
   * @param {string} [o.dataDir] Directory holding databases (shorthand for a single location).
   * @param {{id: string, dir: string, quota?: number}[]} [o.locations] Directories holding databases. New
   *   databases go to the first one unless another is named. `quota` caps a location's total size in bytes.
   * @param {boolean} [o.secure] Stop user SQL from reaching the file system (ATTACH, VACUUM INTO) or changing
   *   process-wide settings, for servers open to untrusted users.
   * @param {number} [o.maxDatabases] Maximum number of databases across all locations (0 = unlimited).
   * @param {number} [o.minFreeBytes] Refuse to add data when the disk has less free space than this.
   * @param {string} [o.tmpDir] Directory for temporary files (downloads, uploads).
   */
  constructor({
    dataDir, locations, extraFiles = [], readOnly = false, secure = false, maxDatabases = 0, minFreeBytes = 0, tmpDir,
  }) {
    this.locations = (locations || [{ id: 'data', dir: dataDir }]).map((l) => ({ quota: 0, ...l, dir: path.resolve(l.dir) }));
    this.dataDir = this.locations[0].dir;
    this.tmpDir = path.resolve(tmpDir || os.tmpdir());
    this.readOnly = readOnly;
    this.secure = secure;
    this.maxDatabases = maxDatabases;
    this.minFreeBytes = minFreeBytes;
    this.trustedDepth = 0;
    this.external = new Map();
    this.conns = new Map();
    for (const dir of [...this.locations.map((l) => l.dir), this.tmpDir]) fs.mkdirSync(dir, { recursive: true });
    for (const file of extraFiles) {
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new Error(`Database file not found: ${abs}`);
      let name = path.basename(abs);
      for (let i = 2; this.external.has(name); i++) name = `${path.basename(abs)} (${i})`;
      this.external.set(name, abs);
    }
  }

  list() {
    const out = [];
    for (const loc of this.locations) {
      for (const entry of readDir(loc.dir)) {
        if (!entry.isFile() || !hasDbExtension(entry.name)) continue;
        out.push(this.describe(entry.name, path.join(loc.dir, entry.name), false, loc.id));
      }
    }
    for (const [name, p] of this.external) {
      if (fs.existsSync(p)) out.push(this.describe(name, p, true));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  describe(name, p, external, location) {
    const st = fs.statSync(p);
    return { name, size: st.size, mtime: st.mtime.toISOString(), external, location, path: external ? p : undefined };
  }

  validateName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name) || name.startsWith('.') || name.includes('..')) {
      fail('Invalid database name. Use letters, digits, spaces, dots, dashes and underscores.');
    }
    if (!hasDbExtension(name)) fail(`Database file name must end with one of: ${DB_EXTENSIONS.join(', ')}`);
  }

  location(id) {
    if (!id) return this.locations[0];
    const loc = this.locations.find((l) => l.id === id);
    if (!loc) fail(`Unknown storage location: ${id}`);
    return loc;
  }

  /** Find a managed (non-external) database file by name. */
  findLocal(name) {
    for (const loc of this.locations) {
      const p = path.join(loc.dir, name);
      if (fs.existsSync(p)) return { loc, path: p };
    }
    return null;
  }

  /** Turn user input into a valid, not-yet-existing file name in a location. */
  newName(name, locationId, { counts = true } = {}) {
    const loc = this.location(locationId);
    name = String(name || '').trim();
    if (!name) fail('Database name is required');
    if (!hasDbExtension(name)) name += '.db';
    this.validateName(name);
    if (this.findLocal(name) || this.external.has(name)) fail(`A database named "${name}" already exists`, 409);
    if (counts && this.maxDatabases && this.list().length >= this.maxDatabases) {
      fail(`You can have at most ${this.maxDatabases} databases. Delete one to make room.`, 403);
    }
    return { name, path: path.join(loc.dir, name), location: loc.id };
  }

  resolve(name) {
    if (typeof name !== 'string' || !name) fail('Database name is required');
    if (this.external.has(name)) return { path: this.external.get(name), external: true };
    this.validateName(name);
    const found = this.findLocal(name);
    if (!found) fail(`Database "${name}" not found`, 404);
    return { path: found.path, external: false, location: found.loc.id };
  }

  get(name) {
    let db = this.conns.get(name);
    if (!db || !db.isOpen) {
      db = this.open(this.resolve(name).path);
      this.conns.set(name, db);
    }
    this.applyQuota(name, db);
    return db;
  }

  open(file, { readOnly = this.readOnly } = {}) {
    const db = new DatabaseSync(file, this.secure ? { readOnly, defensive: true } : { readOnly });
    db.exec('PRAGMA busy_timeout = 5000');
    if (this.secure) {
      db.exec('PRAGMA trusted_schema = OFF');
      db.setAuthorizer((action, arg1, arg2) => this.authorize(action, arg1, arg2));
    }
    let lastPattern = null;
    let lastRegex = null;
    db.function('regexp', { deterministic: true }, (pattern, value) => {
      if (pattern === null || value === null) return null;
      if (pattern !== lastPattern) {
        lastRegex = new RegExp(String(pattern), 'u');
        lastPattern = pattern;
      }
      return lastRegex.test(String(value)) ? 1 : 0;
    });
    return db;
  }

  authorize(action, arg1, arg2) {
    if (this.trustedDepth) return SQLITE.SQLITE_OK;
    if (action === SQLITE.SQLITE_ATTACH) return SQLITE.SQLITE_DENY;
    if (action === SQLITE.SQLITE_PRAGMA) {
      const name = String(arg1).toLowerCase();
      if (BLOCKED_PRAGMAS.has(name)) return SQLITE.SQLITE_DENY;
      // Reading the limit is fine; raising it would bypass the storage quota.
      if (name === 'max_page_count' && arg2 !== null) return SQLITE.SQLITE_DENY;
    }
    return SQLITE.SQLITE_OK;
  }

  /** Run fn with the secure-mode restrictions lifted, for the panel's own statements (e.g. VACUUM INTO). */
  trusted(fn) {
    this.trustedDepth++;
    try {
      return fn();
    } finally {
      this.trustedDepth--;
    }
  }

  /** Total size of the files in a location. */
  usage(locationId) {
    const loc = this.location(locationId);
    let size = 0;
    for (const entry of readDir(loc.dir)) {
      if (!entry.isFile()) continue;
      try { size += fs.statSync(path.join(loc.dir, entry.name)).size; } catch { /* removed meanwhile */ }
    }
    return size;
  }

  /** Stop a database from growing beyond what is left of its location's quota. */
  applyQuota(name, db) {
    if (this.external.has(name) || this.readOnly) return;
    const found = this.findLocal(name);
    if (!found || !found.loc.quota) return;
    const others = this.usage(found.loc.id) - sizeWithSideFiles(found.path);
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    // SQLite never lowers the limit below the current page count, so a full database just can't grow.
    const pages = Math.max(1, Math.floor((found.loc.quota - others) / pageSize));
    this.trusted(() => db.exec(`PRAGMA max_page_count = ${pages}`));
  }

  /** Fail unless `bytes` more can be stored in a location (quota and free disk space). */
  assertSpace(locationId, bytes) {
    const loc = this.location(locationId);
    if (loc.quota) {
      const used = this.usage(loc.id);
      if (used + bytes > loc.quota) {
        fail(`Not enough storage space: this needs ${mb(bytes)} and ${mb(Math.max(0, loc.quota - used))} of your ${mb(loc.quota)} quota is free.`, 413);
      }
    }
    if (this.minFreeBytes) {
      const st = fs.statfsSync(loc.dir);
      if (st.bavail * st.bsize < this.minFreeBytes + bytes) fail('The server is low on storage space. Please try again later.', 507);
    }
  }

  /** A clearer message for errors caused by this server's limits. */
  errorMessage(e) {
    const message = e && e.message ? e.message : String(e);
    if (e && (e.errcode & 0xff) === SQLITE_FULL && this.locations.some((l) => l.quota)) {
      return 'Storage quota exceeded: the database cannot grow any further. Delete rows, tables or databases (then VACUUM) to free space.';
    }
    if (this.secure && /not authorized|authorization denied/i.test(message)) {
      return `${message}. ATTACH, VACUUM INTO and PRAGMAs that affect the server are disabled on this site.`;
    }
    return message;
  }

  close(name) {
    const db = this.conns.get(name);
    if (!db) return;
    try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    this.conns.delete(name);
  }

  closeAll() {
    for (const name of [...this.conns.keys()]) this.close(name);
  }

  assertWritable() {
    if (this.readOnly) fail('The server is running in read-only mode', 403);
  }

  assertManaged(name) {
    if (this.external.has(name)) fail('Databases added with --db cannot be renamed or deleted from the panel', 403);
  }

  create(name, locationId) {
    this.assertWritable();
    const target = this.newName(name, locationId);
    this.assertSpace(target.location, 8192);
    const db = new DatabaseSync(target.path);
    db.exec('PRAGMA user_version = 0; CREATE TABLE __init(x); DROP TABLE __init;');
    db.close();
    return target.name;
  }

  remove(name) {
    this.assertWritable();
    this.assertManaged(name);
    const { path: p } = this.resolve(name);
    this.close(name);
    for (const suffix of ['', ...SIDE_FILES]) {
      if (fs.existsSync(p + suffix)) fs.unlinkSync(p + suffix);
    }
  }

  rename(name, newName) {
    this.assertWritable();
    this.assertManaged(name);
    const { path: p, location } = this.resolve(name);
    const target = this.newName(newName, location, { counts: false });
    this.close(name);
    fs.renameSync(p, target.path);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(p + suffix)) fs.renameSync(p + suffix, target.path + suffix);
    }
    return target.name;
  }

  /** Move a database to another location (e.g. from temporary storage into a user's account). */
  move(name, locationId) {
    this.assertWritable();
    this.assertManaged(name);
    const { path: p, location } = this.resolve(name);
    const to = this.location(locationId);
    if (location === to.id) fail('The database is already stored there');
    this.close(name);
    this.assertSpace(to.id, sizeWithSideFiles(p));
    const target = path.join(to.dir, name);
    for (const suffix of ['', ...SIDE_FILES]) {
      if (fs.existsSync(p + suffix)) moveFile(p + suffix, target + suffix);
    }
    return name;
  }
}
