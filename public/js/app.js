// Shared client state, routing helpers and a tiny event bus.
import { api } from './api.js';
import { store, toast, confirmDialog } from './util.js';

export const state = {
  status: null,
  databases: [],
  schema: null,
  schemaDb: null,
  route: null,
  tx: {},
};

const listeners = {};
export function on(evt, fn) {
  (listeners[evt] ||= []).push(fn);
}
export function emit(evt, data) {
  for (const fn of listeners[evt] || []) fn(data);
}

// ---------------------------------------------------------------------------------------------
// Routing: #/                       -> server (databases)
//          #/status                 -> server info
//          #/db/<db>[/<tab>]        -> database level
//          #/db/<db>/t/<table>[/<tab>][?q=<json>]

export function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const params = Object.fromEntries(new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : ''));
  const parts = path.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts[0] === 'db' && parts[1]) {
    if (parts[2] === 't' && parts[3]) return { db: parts[1], table: parts[3], tab: parts[4] || 'browse', params };
    return { db: parts[1], tab: parts[2] || 'structure', params };
  }
  return { tab: parts[0] || 'databases', params };
}

export function href({ db, table, tab, params } = {}) {
  let p = '#/';
  if (db) {
    p += `db/${encodeURIComponent(db)}`;
    if (table) p += `/t/${encodeURIComponent(table)}`;
    if (tab) p += `/${tab}`;
  } else if (tab && tab !== 'databases') {
    p += tab;
  }
  const clean = params ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')) : {};
  if (Object.keys(clean).length) p += '?' + new URLSearchParams(clean);
  return p;
}

export function go(route, { replace = false } = {}) {
  const target = href(route);
  if (replace) {
    history.replaceState(null, '', target);
    emit('navigate');
  } else if (location.hash === target) {
    emit('navigate');
  } else {
    location.hash = target;
  }
}

export function browseHref(db, table, q) {
  return href({ db, table, tab: 'browse', params: q ? { q: JSON.stringify(q) } : undefined });
}

// ---------------------------------------------------------------------------------------------
// Data caches

export async function loadDatabases() {
  state.databases = await api('databases');
  emit('databases');
  return state.databases;
}

export async function loadSchema(db, force = false) {
  if (!force && state.schemaDb === db && state.schema) return state.schema;
  const schema = await api('schema', { db });
  state.schema = schema;
  state.schemaDb = db;
  setTx(db, schema.inTransaction);
  emit('schema', db);
  return schema;
}

/** Call after any statement that may have changed the schema. */
export async function schemaChanged(db) {
  try {
    await loadSchema(db, true);
  } catch { /* the view will show its own error */ }
}

export function setTx(db, open) {
  const was = !!state.tx[db];
  state.tx[db] = !!open;
  if (was !== !!open) emit('tx', db);
}

export function findTable(name) {
  if (!state.schema) return null;
  return state.schema.tables.find((t) => t.name === name) || state.schema.tables.find((t) => t.name.toLowerCase() === String(name).toLowerCase()) || null;
}

export const isReadOnly = () => !!(state.status && state.status.readOnly);

// Public mode: visitors work in private temporary storage; signed-in users can also save to their account.
export const isPublic = () => !!(state.status && state.status.public);
export const currentUser = () => (state.status && state.status.user) || null;
export const LOCATION_LABELS = { temp: 'Temporary', saved: 'Saved' };

/** A short human description of a duration in ms, e.g. "24 hours" or "30 days". */
export function fmtDuration(ms) {
  const hours = Math.round(ms / 3600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

// ---------------------------------------------------------------------------------------------
// Running SQL from views

/** Execute SQL; throws with `.sql` set to the failing statement. Refreshes the schema after DDL. */
export async function execSql(db, sql, { successMessage, maxRows } = {}) {
  const r = await api('query', { db, sql, maxRows });
  setTx(db, r.inTransaction);
  if (r.schemaChanged) await schemaChanged(db);
  if (r.failed) {
    const last = r.results[r.results.length - 1];
    const err = new Error(last.error + (r.rolledBack ? '\n(The transaction was rolled back.)' : ''));
    err.sql = last.sql;
    throw err;
  }
  if (successMessage) toast(successMessage, 'success', { sql });
  return r;
}

/** Ask for confirmation (showing the SQL), then execute it. Returns the result or null. */
export async function confirmRun(db, sql, { title = 'Run this SQL?', message = '', okLabel = 'Run', danger = false, successMessage } = {}) {
  const ok = await confirmDialog({ title, message, sql, okLabel, danger });
  if (!ok) return null;
  try {
    return await execSql(db, sql, { successMessage });
  } catch (e) {
    toast(e.message, 'error', { sql: e.sql });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Query history and saved queries (per database, stored in the browser)

export function addHistory(db, sql) {
  const key = `history:${db}`;
  const list = store.get(key, []).filter((h) => h.sql !== sql);
  list.unshift({ sql, at: new Date().toISOString() });
  store.set(key, list.slice(0, 100));
}

export const getHistory = (db) => store.get(`history:${db}`, []);
export const clearHistory = (db) => store.set(`history:${db}`, []);
export const getSaved = (db) => store.get(`saved:${db}`, []);
export function saveQuery(db, name, sql) {
  const list = getSaved(db).filter((q) => q.name !== name);
  list.unshift({ name, sql, at: new Date().toISOString() });
  store.set(`saved:${db}`, list);
}
export function deleteSaved(db, name) {
  store.set(`saved:${db}`, getSaved(db).filter((q) => q.name !== name));
}
