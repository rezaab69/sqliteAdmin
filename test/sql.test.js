import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitStatements, parseCreateTable, renameInCreate, retargetIndex, firstKeyword, tokenize,
} from '../public/js/shared/sql.js';

test('tokenize reproduces the input exactly', () => {
  const sql = "SELECT \"a\"\"b\", x'00ff', 1.5e3 -- hi\n/* c */ FROM [t] WHERE y = 'it''s' AND z ->> '$.k';";
  assert.equal(tokenize(sql).map((t) => t.text).join(''), sql);
});

test('splitStatements respects strings, comments and trigger bodies', () => {
  const sql = `
    INSERT INTO t VALUES ('a;b'); -- comment; here
    /* block; comment */ SELECT 1;
    CREATE TRIGGER tr AFTER INSERT ON t BEGIN
      UPDATE t SET x = CASE WHEN 1 THEN 2 ELSE 3 END;
      DELETE FROM u;
    END;
    SELECT 2`;
  const parts = splitStatements(sql);
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "INSERT INTO t VALUES ('a;b')");
  assert.ok(parts[1].endsWith('SELECT 1'));
  assert.match(parts[2], /^CREATE TRIGGER tr[\s\S]*DELETE FROM u;\s*END$/);
  assert.equal(parts[3], 'SELECT 2');
});

test('splitStatements ignores empty statements', () => {
  assert.deepEqual(splitStatements(';;  ;\n-- only a comment\n'), []);
});

test('firstKeyword skips comments', () => {
  assert.equal(firstKeyword('-- x\n  /* y */ update t set a = 1'), 'UPDATE');
});

test('parseCreateTable extracts columns, constraints and options', () => {
  const m = parseCreateTable(`CREATE TABLE "orders" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('a', 'b')),
    total DECIMAL(10, 2) DEFAULT -1.5,
    code TEXT UNIQUE COLLATE NOCASE,
    doubled INT GENERATED ALWAYS AS (total * 2) STORED,
    CONSTRAINT one UNIQUE (customer_id, status),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  ) WITHOUT ROWID, STRICT`);
  assert.equal(m.columns.length, 6);
  assert.deepEqual(m.columns[0], { name: 'id', type: 'INTEGER', pk: true, autoincrement: true, notnull: false, unique: false, default: '', extra: '' });
  assert.equal(m.columns[1].notnull, true);
  assert.equal(m.columns[1].extra, 'REFERENCES customers(id) ON DELETE SET NULL');
  assert.equal(m.columns[2].default, "'pending'");
  assert.equal(m.columns[2].extra, "CHECK (status IN ('a', 'b'))");
  assert.equal(m.columns[3].type, 'DECIMAL(10, 2)');
  assert.equal(m.columns[3].default, '-1.5');
  assert.equal(m.columns[4].unique, true);
  assert.equal(m.columns[4].extra, 'COLLATE NOCASE');
  assert.equal(m.columns[5].extra, 'GENERATED ALWAYS AS (total * 2) STORED');
  assert.equal(m.constraints.length, 2);
  assert.equal(m.withoutRowid, true);
  assert.equal(m.strict, true);
});

test('parseCreateTable returns null for CREATE TABLE ... AS SELECT', () => {
  assert.equal(parseCreateTable('CREATE TABLE x AS SELECT * FROM y'), null);
});

test('renameInCreate and retargetIndex replace object names', () => {
  assert.equal(renameInCreate('CREATE TABLE IF NOT EXISTS main."old" (a)', 'new one'), 'CREATE TABLE IF NOT EXISTS "new one" (a)');
  assert.equal(retargetIndex('CREATE UNIQUE INDEX ix ON t (a)', 'ix2', 't2'), 'CREATE UNIQUE INDEX "ix2" ON "t2" (a)');
});
