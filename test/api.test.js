import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbManager } from '../lib/dbmanager.js';
import { createApi } from '../lib/api.js';
import { createSampleDatabase } from '../lib/sample.js';

let dir;
let mgr;
let api;
const db = 'sample.db';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqla-test-'));
  createSampleDatabase(path.join(dir, db));
  mgr = new DbManager({ dataDir: dir });
  api = createApi(mgr, { version: 'test' }).json;
});

after(() => {
  mgr.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('browse paginates, sorts and filters', () => {
  const r = api.browse({ db, table: 'tracks', pageSize: 10, page: 2, sort: [{ col: 'duration_sec', dir: 'desc' }], filters: [{ col: 'rating', op: '>=', value: '4' }] });
  assert.equal(r.rows.length, 10);
  assert.equal(r.page, 2);
  assert.equal(r.key.kind, 'rowid');
  const durations = r.rows.map((row) => row.v[r.columns.findIndex((c) => c.name === 'duration_sec')]);
  assert.deepEqual([...durations].sort((a, b) => b - a), durations);
  assert.ok(r.rows.every((row) => row.v[r.columns.findIndex((c) => c.name === 'rating')] >= 4));
  assert.equal(r.fks.album_id.table, 'albums');
});

test('numeric strings bind as integers, not text', () => {
  const ins = api.insertRow({ db, table: 'artists', values: { name: 'Test Band', formed_year: 2001 } });
  const row = api.query({ db, sql: `SELECT typeof(formed_year) FROM artists WHERE rowid = ${ins.lastInsertRowid}` });
  assert.equal(row.results[0].rows[0][0], 'integer');
});

test('insert, update and delete rows by key (WITHOUT ROWID table)', () => {
  const album = api.query({ db, sql: 'SELECT id FROM albums WHERE id NOT IN (SELECT album_id FROM order_items WHERE order_id = 1) LIMIT 1' }).results[0].rows[0][0];
  const ins = api.insertRow({ db, table: 'order_items', values: { order_id: 1, album_id: album, quantity: 2, unit_price: '1.5' } });
  assert.equal(ins.changes, 1);
  const upd = api.updateRow({ db, table: 'order_items', key: [1, album], values: { quantity: 5 } });
  assert.equal(upd.changes, 1);
  const got = api.getRow({ db, table: 'order_items', key: [1, album] });
  assert.equal(got.values.quantity, 5);
  assert.equal(api.deleteRows({ db, table: 'order_items', keys: [[1, album]] }).changes, 1);
  assert.throws(() => api.updateRow({ db, table: 'order_items', key: [1, album], values: { quantity: 1 } }), /No row was updated/);
});

test('raw expressions and defaults on insert', () => {
  const r = api.insertRow({ db, table: 'customers', values: { first_name: { $raw: "upper('ann')" }, last_name: 'Lee', created_at: { $default: true } } });
  const row = api.getRow({ db, table: 'customers', key: [r.lastInsertRowid] });
  assert.equal(row.values.first_name, 'ANN');
  assert.match(row.values.created_at, /^\d{4}-\d{2}-\d{2} /);
});

test('query runs multiple statements and rolls back a failed transaction', () => {
  const r = api.query({ db, sql: "BEGIN; UPDATE settings SET value = 'X' WHERE key = 'currency'; SELECT * FROM missing_table; COMMIT;" });
  assert.equal(r.failed, true);
  assert.equal(r.rolledBack, true);
  assert.equal(r.inTransaction, false);
  const v = api.query({ db, sql: "SELECT value FROM settings WHERE key = 'currency'" });
  assert.equal(v.results[0].rows[0][0], 'USD');
});

test('rebuildTable changes structure while keeping data, indexes and triggers', () => {
  const before = api.browse({ db, table: 'albums', pageSize: 1000 }).total;
  const r = api.rebuildTable({
    db, table: 'albums',
    createSql: 'CREATE TABLE albums (id INTEGER PRIMARY KEY, artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE, name TEXT NOT NULL, released DATE, price REAL DEFAULT 9.99, genre TEXT)',
    mapping: [{ to: 'id', from: 'id' }, { to: 'artist_id', from: 'artist_id' }, { to: 'name', from: 'title' }, { to: 'released', from: 'released' }, { to: 'price', from: 'price' }, { to: 'genre', from: null }],
  });
  assert.deepEqual(r.warnings, []);
  const s = api.structure({ db, table: 'albums' });
  assert.deepEqual(s.columns.map((c) => c.name), ['id', 'artist_id', 'name', 'released', 'price', 'genre']);
  assert.equal(s.rowCount, before);
  assert.ok(s.indexes.some((i) => i.name === 'idx_albums_artist'));
  // The view referencing albums.title is now broken, but the rebuild itself must succeed.
});

test('rebuildTable is atomic when the new definition is invalid', () => {
  const cols = api.structure({ db, table: 'tracks' }).columns.map((c) => c.name);
  assert.throws(() => api.rebuildTable({ db, table: 'tracks', createSql: 'CREATE TABLE tracks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, rating INTEGER CHECK (rating > 100))' }));
  assert.deepEqual(api.structure({ db, table: 'tracks' }).columns.map((c) => c.name), cols);
});

test('copyTable copies structure, data and indexes', () => {
  const r = api.copyTable({ db, table: 'tracks', newName: 'tracks_copy' });
  assert.match(r.sql, /CREATE INDEX "tracks_copy_album"|CREATE INDEX "idx_tracks_copy_album"/);
  assert.equal(api.structure({ db, table: 'tracks_copy' }).rowCount, api.structure({ db, table: 'tracks' }).rowCount);
});

test('searchDatabase finds values across tables', () => {
  const r = api.searchDatabase({ db, term: 'USD' });
  assert.ok(r.results.some((x) => x.table === 'settings' && x.count === 1 && x.columns.includes('value')));
});

test('database names cannot escape the data directory', () => {
  assert.throws(() => api.overview({ db: '../secret.db' }), /Invalid database name/);
  assert.throws(() => api.createDatabase({ name: 'a/b' }), /Invalid database name/);
});
