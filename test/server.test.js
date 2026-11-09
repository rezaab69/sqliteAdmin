// End-to-end tests of the HTTP server in public (multi-user) and local mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/server.js';
import { createSampleDatabase } from '../lib/sample.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1048576;

let dir;
let app;
let base;
let google;
const mails = [];

async function start(options) {
  const a = createApp({ version: 'test', publicDir: path.join(ROOT, 'public'), host: '127.0.0.1', ...options });
  await new Promise((resolve) => a.server.listen(0, '127.0.0.1', resolve));
  return { app: a, base: `http://127.0.0.1:${a.server.address().port}` };
}

/** A browser-like client with its own cookies (respecting each cookie's Path). */
function client(url = base) {
  const jar = new Map();
  function remember(res) {
    for (const set of res.headers.getSetCookie()) {
      const [pair, ...attrs] = set.split(';').map((s) => s.trim());
      const [name, value] = pair.split('=');
      const cookiePath = (attrs.find((a) => /^path=/i.test(a)) || 'Path=/').slice(5);
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(name);
      else jar.set(name, { value, path: cookiePath });
    }
  }
  const cookieHeader = (reqPath, withSession = true) => [...jar]
    .filter(([name, c]) => reqPath.startsWith(c.path) && (withSession || name !== 'sqla_session'))
    .map(([name, c]) => `${name}=${c.value}`).join('; ');

  async function send(name, body, { query = '', raw = false, contentType = 'application/json' } = {}) {
    const cookie = cookieHeader(`/api/${name}`);
    const res = await fetch(`${url}/api/${name}${query}`, {
      method: 'POST',
      headers: { 'X-SQLite-Admin': '1', 'Content-Type': contentType, ...(cookie ? { Cookie: cookie } : {}) },
      body: contentType === 'application/json' ? JSON.stringify(body ?? {}) : body,
    });
    remember(res);
    if (raw) return res;
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status, reason: data.reason });
    return data;
  }
  /** A top-level navigation (not followed past the first redirect). */
  async function get(reqPath, { withSession = true } = {}) {
    const cookie = cookieHeader(reqPath.split('?')[0], withSession);
    const res = await fetch(`${url}${reqPath}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    remember(res);
    return res;
  }
  return {
    call: (name, body) => send(name, body),
    raw: (name, body) => send(name, body, { raw: true }),
    upload: (query, bytes) => send('uploadDatabase', bytes, { query: `?${new URLSearchParams(query)}`, contentType: 'application/octet-stream' }),
    get,
    get session() { return jar.get('sqla_session')?.value || ''; },
  };
}

const names = (list) => list.map((d) => d.name).sort();
const placed = (list) => list.map((d) => [d.name, d.location]).sort();

/** The most recent email sent to an address. */
function mailTo(address) {
  const m = mails.filter((x) => x.to.toLowerCase() === address.toLowerCase()).at(-1);
  assert.ok(m, `no email was sent to ${address}`);
  return m;
}
const linkToken = (mail, kind) => {
  const m = new RegExp(`/#/${kind}\\?token=([\\w-]+)`).exec(mail.text);
  assert.ok(m, `no ${kind} link in: ${mail.text}`);
  return m[1];
};

/** Sign up with email and open the confirmation link, in the same browser. */
async function signUp(c, email, password) {
  await c.call('signup', { email, password });
  return c.call('verifyEmail', { token: linkToken(mailTo(email), 'verify') });
}

/** A stand-in for Google's token endpoint. Tests register the codes it will accept. */
function fakeGoogle() {
  const codes = new Map();
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const p = new URLSearchParams(body);
    const entry = codes.get(p.get('code'));
    codes.delete(p.get('code'));
    const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
    if (req.url !== '/token' || !entry || p.get('client_id') !== 'test-client' || p.get('client_secret') !== 'test-secret'
      || p.get('grant_type') !== 'authorization_code' || challenge !== entry.challenge || p.get('redirect_uri') !== entry.redirectUri) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims = { iss: 'https://accounts.fake-google.test', aud: 'test-client', exp: Math.floor(Date.now() / 1000) + 300, nonce: entry.nonce, ...entry.claims };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(claims)}.signature` }));
  });
  return { server, codes };
}

/** Go through "Continue with Google" as `claims` describe. Returns where the browser ends up. */
async function googleSignIn(c, claims, { nonce, state } = {}) {
  const startRes = await c.get('/auth/google');
  assert.equal(startRes.status, 302);
  const to = new URL(startRes.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, `${google.base}/auth`);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  const code = crypto.randomBytes(8).toString('hex');
  google.codes.set(code, {
    challenge: to.searchParams.get('code_challenge'), nonce: nonce ?? to.searchParams.get('nonce'),
    redirectUri: to.searchParams.get('redirect_uri'), claims,
  });
  // Google sends the browser back; the SameSite=Strict session cookie is not sent on that request.
  const back = await c.get(`/auth/google/callback?code=${code}&state=${state ?? to.searchParams.get('state')}`, { withSession: false });
  assert.equal(back.status, 302);
  return back.headers.get('location');
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqla-server-test-'));
  google = fakeGoogle();
  await new Promise((resolve) => google.server.listen(0, '127.0.0.1', resolve));
  google.base = `http://127.0.0.1:${google.server.address().port}`;
  ({ app, base } = await start({
    public: true, dataDir: dir, queryTimeout: 1500, guestQuota: 2 * MB, userQuota: 4 * MB, maxUpload: 3 * MB,
    minFree: 0,
    publicUrl: 'http://set-after-listen',
    mailer: { async send(m) { mails.push(m); } },
    google: {
      clientId: 'test-client', clientSecret: 'test-secret', authUrl: `${google.base}/auth`, tokenUrl: `${google.base}/token`,
      issuers: ['https://accounts.fake-google.test'],
    },
    rateLimits: { signupsPerHour: 1000, emailsPerHourPerIp: 1000, emailsPerHourPerAddress: 1000, sessionsPerHour: 1000, failuresPer15Min: 1000 },
  }));
  app.options.publicUrl = base;
});

after(async () => {
  await app.close();
  google.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Workspaces and limits

test('each guest gets a private workspace with a sample database', async () => {
  const a = client();
  const b = client();
  assert.deepEqual(names(await a.call('databases')), ['sample.db']);
  await a.call('createDatabase', { name: 'mine' });
  assert.deepEqual(names(await a.call('databases')), ['mine.db', 'sample.db']);
  assert.deepEqual(names(await b.call('databases')), ['sample.db']);
  await assert.rejects(b.call('schema', { db: 'mine.db' }), /not found/);
  const status = await a.call('status');
  assert.equal(status.public, true);
  assert.equal(status.user, null);
  assert.deepEqual(status.auth, { email: true, google: true, signup: true });
  assert.equal(status.dataDir, undefined);
});

test('user SQL cannot reach the file system or lift limits', async () => {
  const a = client();
  await a.call('databases');
  const run = async (sql) => {
    const r = await a.call('query', { db: 'sample.db', sql });
    return r.failed ? r.results.at(-1).error : null;
  };
  assert.match(await run(`ATTACH '${path.join(dir, 'app.db').replace(/'/g, "''")}' AS accounts`), /not authorized|disabled/);
  assert.match(await run(`VACUUM INTO '${path.join(dir, 'stolen.db').replace(/'/g, "''")}'`), /authoriz|disabled/);
  assert.equal(fs.existsSync(path.join(dir, 'stolen.db')), false);
  assert.match(await run('PRAGMA max_page_count = 1000000000'), /not authorized|disabled/);
  assert.match(await run('PRAGMA hard_heap_limit = 1'), /not authorized|disabled/);
  assert.match(await run("SELECT load_extension('evil')"), /not authorized|no such function/);
  assert.equal(await run('PRAGMA max_page_count'), null);
  // Settings that would lift a limit can be read but not changed.
  for (const pragma of ['page_size = 65536', 'wal_autocheckpoint = 0', 'temp_store = FILE', 'trusted_schema = ON']) {
    assert.match(await run(`PRAGMA ${pragma}`), /not authorized|disabled/, pragma);
  }
  assert.equal(await run('PRAGMA page_size'), null);
  const overview = await a.call('overview', { db: 'sample.db' });
  assert.equal(overview.info.file, 'sample.db');
});

test('a runaway query is stopped without affecting the workspace', async () => {
  const a = client();
  await a.call('databases');
  const started = Date.now();
  await assert.rejects(
    a.call('query', { db: 'sample.db', sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c' }),
    (e) => e.status === 504 && /stopped/.test(e.message),
  );
  assert.ok(Date.now() - started < 5000);
  const r = await a.call('query', { db: 'sample.db', sql: 'SELECT count(*) FROM artists' });
  assert.ok(r.results[0].rows[0][0] > 0);
  // The stopped query must really be gone, not still holding the file open (deleting fails on Windows then).
  await a.call('deleteDatabase', { db: 'sample.db' });
  assert.deepEqual(names(await a.call('databases')), []);
});

test('an operation that needs too much memory is stopped without affecting the workspace', async () => {
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqla-memory-test-'));
  const mem = await start({ public: true, dataDir: memDir, minFree: 0, workerMemoryMb: 192, queryTimeout: 20_000 });
  try {
    const a = client(mem.base);
    await a.call('databases');
    // About 600 MB inside SQLite, outside the JavaScript heap.
    const sql = "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 60) SELECT length(group_concat(hex(zeroblob(5000000)))) FROM c";
    await assert.rejects(a.call('query', { db: 'sample.db', sql }), (e) => e.status === 413 && /192 MB of memory/.test(e.message));
    const r = await a.call('query', { db: 'sample.db', sql: 'SELECT count(*) FROM artists' });
    assert.ok(r.results[0].rows[0][0] > 0);
  } finally {
    await mem.app.close();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

test('storage quota stops a database from growing', async () => {
  const a = client();
  await a.call('createDatabase', { name: 'big' });
  const r = await a.call('query', {
    db: 'big.db',
    sql: 'CREATE TABLE t(b); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 400) INSERT INTO t SELECT randomblob(10000) FROM c',
  });
  assert.equal(r.failed, true);
  assert.match(r.results.at(-1).error, /quota/i);
  const usage = await a.call('usage');
  assert.ok(usage.locations[0].used <= 2 * MB);
});

test('temporary tables and empty databases stay within the quota', async () => {
  const a = client();
  await a.upload({ name: 'empty.db' }, new Uint8Array(0));
  const fill = (table) => `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 400) INSERT INTO ${table} SELECT randomblob(10000) FROM c`;
  // TEMP tables live outside the workspace directory, but count against the same limit.
  let r = await a.call('query', { db: 'empty.db', sql: `CREATE TEMP TABLE scratch(b); ${fill('scratch')}` });
  assert.equal(r.failed, true);
  assert.match(r.results.at(-1).error, /quota|full/i);
  // Changing temp_store would reopen the TEMP database without its limit.
  r = await a.call('query', { db: 'empty.db', sql: `PRAGMA temp_store = MEMORY; CREATE TEMP TABLE scratch2(b); ${fill('scratch2')}` });
  assert.equal(r.failed, true);
  // A larger page size would multiply a quota that is counted in pages.
  r = await a.call('query', { db: 'empty.db', sql: `PRAGMA page_size = 65536; CREATE TABLE t(b); ${fill('t')}` });
  assert.equal(r.failed, true);
  assert.ok((await a.call('usage')).locations[0].used <= 2 * MB);
});

test('upload and download round trip', async () => {
  const src = path.join(dir, 'upload-src.db');
  createSampleDatabase(src);
  const a = client();
  const up = await a.upload({ name: 'uploaded.db' }, fs.readFileSync(src));
  assert.equal(up.name, 'uploaded.db');
  const res = await a.raw('downloadDatabase', { db: 'uploaded.db' });
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
  assert.equal(Number(res.headers.get('content-length')), bytes.length);
  await assert.rejects(a.upload({ name: 'bad.db' }, Buffer.from('not a database at all')), /not an SQLite 3 database/);
  await assert.rejects(a.upload({ name: 'huge.db' }, Buffer.alloc(4 * MB)), (e) => e.status === 413);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')).flatMap((ws) => fs.readdirSync(path.join(dir, 'tmp', ws))), []);
});

// ---------------------------------------------------------------------------------------------
// Email accounts

test('signing up by email needs the confirmation link, and keeps guest databases', async () => {
  const a = client();
  await a.call('createDatabase', { name: 'draft' });
  const r = await a.call('signup', { email: 'Alice@Example.com', password: 'correct horse' });
  assert.equal(r.email, 'Alice@Example.com');
  assert.equal((await a.call('status')).user, null);
  const mail = mailTo('alice@example.com');
  assert.match(mail.subject, /confirm/i);
  assert.ok(mail.text.includes(`${base}/#/verify?token=`));

  // Not usable until confirmed; the error says why.
  await assert.rejects(a.call('login', { email: 'alice@example.com', password: 'correct horse' }), (e) => e.status === 403 && e.reason === 'unverified');

  const guestSession = a.session;
  const v = await a.call('verifyEmail', { token: linkToken(mail, 'verify') });
  assert.equal(v.user.email, 'Alice@Example.com');
  assert.notEqual(a.session, guestSession);
  assert.equal((await a.call('status')).user.email, 'Alice@Example.com');
  assert.deepEqual(placed(await a.call('databases')), [['draft.db', 'temp'], ['sample.db', 'temp']]);
  // The link works once.
  await assert.rejects(client().call('verifyEmail', { token: linkToken(mail, 'verify') }), (e) => e.status === 400);

  await a.call('saveDatabase', { db: 'draft.db' });
  await a.call('createDatabase', { name: 'direct', location: 'saved' });
  await a.call('logout');
  assert.deepEqual(names(await a.call('databases')), ['sample.db']);

  await assert.rejects(a.call('login', { email: 'alice@example.com', password: 'wrong password' }), (e) => e.status === 401);
  await a.call('login', { email: 'ALICE@example.com', password: 'correct horse' });
  assert.deepEqual(placed(await a.call('databases')), [['direct.db', 'saved'], ['draft.db', 'saved'], ['sample.db', 'temp']]);

  // Another visitor can't see alice's databases.
  assert.deepEqual(names(await client().call('databases')), ['sample.db']);
});

test('signing up with a registered address emails the owner and changes nothing', async () => {
  const a = client();
  await signUp(a, 'erin@example.com', 'erin password');
  const before = mails.length;
  const b = client();
  const r = await b.call('signup', { email: 'erin@example.com', password: 'attacker password' });
  assert.equal(r.email, 'erin@example.com');
  assert.equal(mails.length, before + 1);
  assert.match(mailTo('erin@example.com').text, /already have an account/);
  await assert.rejects(b.call('login', { email: 'erin@example.com', password: 'attacker password' }), (e) => e.status === 401);
  await b.call('login', { email: 'erin@example.com', password: 'erin password' });
});

test("someone else's pending sign-up can't choose the owner's password", async () => {
  const attacker = client();
  await attacker.call('signup', { email: 'victim@example.com', password: 'attacker password' });
  const attackerLink = linkToken(mailTo('victim@example.com'), 'verify');
  const victim = client();
  await victim.call('signup', { email: 'victim@example.com', password: 'victim password' });
  await victim.call('verifyEmail', { token: linkToken(mailTo('victim@example.com'), 'verify') });
  // The attacker's link no longer works, and their password was never set.
  await assert.rejects(client().call('verifyEmail', { token: attackerLink }), (e) => e.status === 400);
  await assert.rejects(attacker.call('login', { email: 'victim@example.com', password: 'attacker password' }), (e) => e.status === 401);
  await client().call('login', { email: 'victim@example.com', password: 'victim password' });
});

test('password reset by email', async () => {
  const a = client();
  await signUp(a, 'frank@example.com', 'old password');
  const other = client();
  await other.call('login', { email: 'frank@example.com', password: 'old password' });

  const before = mails.length;
  assert.deepEqual(await client().call('requestPasswordReset', { email: 'nobody@example.com' }), { ok: true, email: 'nobody@example.com' });
  assert.equal(mails.length, before);

  const c = client();
  await c.call('requestPasswordReset', { email: 'FRANK@example.com' });
  const token = linkToken(mailTo('frank@example.com'), 'reset');
  await assert.rejects(c.call('resetPassword', { token, password: 'short' }), /at least 8/);
  await c.call('resetPassword', { token, password: 'new password' });
  assert.equal((await c.call('status')).user.email, 'frank@example.com');
  assert.equal((await other.call('status')).user, null);
  await assert.rejects(c.call('resetPassword', { token, password: 'another password' }), (e) => e.status === 400);
  await assert.rejects(client().call('login', { email: 'frank@example.com', password: 'old password' }), (e) => e.status === 401);
  await client().call('login', { email: 'frank@example.com', password: 'new password' });
});

test('temporary databases that clash with saved names are renamed on login', async () => {
  const a = client();
  await signUp(a, 'bob@example.com', 'bob password');
  await a.call('createDatabase', { name: 'notes', location: 'saved' });
  await a.call('logout');
  await a.call('createDatabase', { name: 'notes' });
  await a.call('login', { email: 'bob@example.com', password: 'bob password' });
  assert.deepEqual(placed(await a.call('databases')), [['notes (2).db', 'temp'], ['notes.db', 'saved'], ['sample.db', 'temp']]);
});

test('changing the password signs out other sessions; deleting the account removes its data', async () => {
  const a = client();
  const other = client();
  await signUp(a, 'carol@example.com', 'first password');
  await other.call('login', { email: 'carol@example.com', password: 'first password' });
  await a.call('createDatabase', { name: 'keep', location: 'saved' });
  await assert.rejects(a.call('changePassword', { current: 'nope', password: 'second password' }), (e) => e.status === 403);
  await a.call('changePassword', { current: 'first password', password: 'second password' });
  assert.equal((await other.call('status')).user, null);
  assert.equal((await a.call('status')).user.email, 'carol@example.com');

  await a.call('deleteAccount', { password: 'second password' });
  assert.equal((await a.call('status')).user, null);
  await assert.rejects(a.call('login', { email: 'carol@example.com', password: 'second password' }), (e) => e.status === 401);
});

// ---------------------------------------------------------------------------------------------
// Google accounts

test('Continue with Google creates an account and keeps guest databases', async () => {
  const a = client();
  await a.call('createDatabase', { name: 'before-google' });
  const where = await googleSignIn(a, { sub: 'g-100', email: 'gina@gmail.com', email_verified: true, name: 'Gina' });
  assert.equal(where, '/#/?signedIn=google');
  const status = await a.call('status');
  assert.deepEqual(status.user, { email: 'gina@gmail.com', name: 'Gina' });
  assert.deepEqual(names(await a.call('databases')), ['before-google.db', 'sample.db']);
  const { user } = await a.call('account');
  assert.equal(user.google, true);
  assert.equal(user.hasPassword, false);

  // Signing in again finds the same account; a password can be added and then used.
  await a.call('createDatabase', { name: 'kept', location: 'saved' });
  const b = client();
  await googleSignIn(b, { sub: 'g-100', email: 'gina@gmail.com', email_verified: true });
  assert.ok(names(await b.call('databases')).includes('kept.db'));
  await b.call('changePassword', { password: 'gina password' });
  await client().call('login', { email: 'gina@gmail.com', password: 'gina password' });
});

test('Google sign-in links to the account with the same address', async () => {
  const a = client();
  await signUp(a, 'hank@gmail.com', 'hank password');
  await a.call('createDatabase', { name: 'hank', location: 'saved' });
  const g = client();
  await googleSignIn(g, { sub: 'g-200', email: 'hank@gmail.com', email_verified: true });
  assert.ok(names(await g.call('databases')).includes('hank.db'));
  const { user } = await g.call('account');
  assert.deepEqual([user.hasPassword, user.google], [true, true]);

  // A pending email sign-up is cancelled when the real owner signs in with Google.
  await client().call('signup', { email: 'ivy@gmail.com', password: 'attacker password' });
  const attackerLink = linkToken(mailTo('ivy@gmail.com'), 'verify');
  await googleSignIn(client(), { sub: 'g-300', email: 'ivy@gmail.com', email_verified: true });
  await assert.rejects(client().call('verifyEmail', { token: attackerLink }), (e) => e.status === 400);
  await assert.rejects(client().call('login', { email: 'ivy@gmail.com', password: 'attacker password' }), (e) => e.status === 401);
});

test('Google sign-in rejects tampered or unverified responses', async () => {
  const claims = { sub: 'g-400', email: 'jo@gmail.com', email_verified: true };
  // The state doesn't belong to this browser.
  assert.equal(await googleSignIn(client(), claims, { state: 'forged' }), '/#/?authError=google-expired');
  // The ID token wasn't issued for this sign-in.
  assert.equal(await googleSignIn(client(), claims, { nonce: 'other' }), '/#/?authError=google-failed');
  assert.equal(await googleSignIn(client(), { ...claims, email_verified: false }), '/#/?authError=google-unverified');
  const c = client();
  const cancelled = await c.get('/auth/google');
  const state = new URL(cancelled.headers.get('location')).searchParams.get('state');
  assert.equal((await c.get(`/auth/google/callback?error=access_denied&state=${state}`, { withSession: false })).headers.get('location'), '/#/?authError=google-cancelled');
  assert.equal((await client().call('status')).user, null);
});

// ---------------------------------------------------------------------------------------------

test('API requests need the custom header', async () => {
  const res = await fetch(`${base}/api/databases`, { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('behind a proxy, rate limits use the address the proxy saw, not one the client made up', async () => {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqla-proxy-test-'));
  const local = await start({ dataDir: localDir, password: 'secret', trustProxy: true });
  try {
    // The client sends its own X-Forwarded-For; the proxy appends the real address.
    const login = (i) => fetch(`${local.base}/api/login`, {
      method: 'POST',
      headers: { 'X-SQLite-Admin': '1', 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` },
      body: JSON.stringify({ password: 'wrong' }),
    });
    for (let i = 0; i < 5; i++) assert.equal((await login(i)).status, 401);
    assert.equal((await login(99)).status, 429);
  } finally {
    await local.app.close();
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});

test('local mode still serves the data directory behind the shared password', async () => {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqla-local-test-'));
  createSampleDatabase(path.join(localDir, 'sample.db'));
  const local = await start({ dataDir: localDir, password: 'secret' });
  try {
    const c = client(local.base);
    await assert.rejects(c.call('databases'), (e) => e.status === 401);
    await c.call('login', { password: 'secret' });
    assert.deepEqual(names(await c.call('databases')), ['sample.db']);
    const status = await c.call('status');
    assert.equal(status.public, false);
    assert.equal(status.dataDir, path.resolve(localDir));
    // Local users may ATTACH their own files.
    const r = await c.call('query', { db: 'sample.db', sql: "ATTACH ':memory:' AS scratch" });
    assert.equal(r.failed, undefined);
  } finally {
    await local.app.close();
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});
