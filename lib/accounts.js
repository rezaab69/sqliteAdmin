// User accounts and browser sessions for public mode, kept in the server's own SQLite file (app.db), which
// is never reachable through the API.
//
//   users(id, email, password, email_verified_at, google_sub, name, created_at, last_login)
//     email is unique (case-insensitive). password is "scrypt$N$r$p$<salt base64>$<hash base64>", or NULL for
//     accounts that only sign in with Google. google_sub is Google's stable account ID. Dates are ISO 8601.
//   sessions(token_hash, workspace, user_id, created_at, last_seen, expires_at)
//     token_hash is the SHA-256 of the cookie value; times are Unix milliseconds. Every session, guest or
//     not, owns a temporary workspace directory named by `workspace`.
//   tokens(token_hash, kind, user_id, expires_at, data)
//     Single-use links sent by email: kind 'verify' (confirm the address) or 'reset' (set a new password).
//     A 'verify' token carries the password hash chosen at sign-up; it only becomes the account's password
//     when that link is opened, so someone who signs up with another person's address can't pick their
//     password.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const TOUCH_INTERVAL = 60_000;
// Unconfirmed sign-ups are removed after this long.
const UNVERIFIED_TTL = 7 * 24 * 3600_000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = () => crypto.randomBytes(16).toString('hex');
const now = () => new Date().toISOString();

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when there is no password to check, so a login takes as long either way.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

export function normalizeEmail(email) {
  const e = String(email ?? '').trim();
  if (e.length > 254 || !EMAIL_RE.test(e)) fail('Please enter a valid email address.');
  return e;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) fail('The password must be at least 8 characters long.');
  if (password.length > 200) fail('The password is too long.');
}

const USER_COLUMNS = 'id, email, password, email_verified_at AS verifiedAt, google_sub AS googleSub, name, created_at AS createdAt, last_login AS lastLogin';

export class AccountStore {
  /**
   * @param {object} o
   * @param {string} o.file Path of the account database.
   * @param {number} o.guestTtl Guest sessions end after this many ms without activity.
   * @param {number} o.userTtl Signed-in sessions end after this many ms without activity.
   */
  constructor({ file, guestTtl, userTtl }) {
    this.guestTtl = guestTtl;
    this.userTtl = userTtl;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    // A development version identified accounts by username. Without accounts in it, the file is upgraded
    // (guest sessions keep working); username accounts can't be turned into email accounts.
    const cols = this.db.prepare("SELECT name FROM pragma_table_info('users')").all().map((r) => r.name);
    if (cols.includes('username')) {
      if (this.db.prepare('SELECT count(*) AS n FROM users').get().n > 0) {
        throw new Error(`${file} has accounts from a development version of SQLite Admin that used usernames instead of email addresses. Delete it (and the users and workspaces directories next to it) to start fresh.`);
      }
      this.db.exec('DROP TABLE users');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password TEXT,
        email_verified_at TEXT,
        google_sub TEXT UNIQUE,
        name TEXT,
        created_at TEXT NOT NULL,
        last_login TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        workspace TEXT NOT NULL UNIQUE,
        user_id INTEGER REFERENCES users(id),
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
    `);
  }

  ttl(userId) {
    return userId ? this.userTtl : this.guestTtl;
  }

  // -------------------------------------------------------------------------------------------
  // Sessions

  /** Start a session. Returns the cookie token and the session. */
  createSession(userId = null, workspace = newId()) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    this.db.prepare('INSERT INTO sessions (token_hash, workspace, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), workspace, userId, t, t, t + this.ttl(userId));
    return { token, session: this.getSession(token) };
  }

  /** Look up a live session by cookie token, extending its lifetime. */
  getSession(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = this.db.prepare(`
      SELECT s.token_hash, s.workspace, s.user_id, s.last_seen, s.expires_at, u.email, u.name
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    const t = Date.now();
    if (!row || row.expires_at < t) return null;
    if (t - row.last_seen > TOUCH_INTERVAL) {
      this.db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?')
        .run(t, t + this.ttl(row.user_id), row.token_hash);
    }
    return { workspace: row.workspace, userId: row.user_id, email: row.email, name: row.name };
  }

  deleteSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  /**
   * Sign a user in, keeping the workspace of a guest session (if given) so work done before logging in is
   * not lost. The token is always replaced, to prevent session fixation.
   */
  signIn(guestToken, userId) {
    const old = guestToken ? this.getSession(guestToken) : null;
    if (old) this.deleteSession(guestToken);
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), userId);
    return this.createSession(userId, old && !old.userId ? old.workspace : undefined);
  }

  /** Remove a user's sessions (optionally all but one). Returns the removed sessions' workspaces. */
  endUserSessions(userId, exceptToken) {
    const keep = exceptToken ? sha256(exceptToken) : '';
    const rows = this.db.prepare('SELECT workspace FROM sessions WHERE user_id = ? AND token_hash <> ?').all(userId, keep);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, keep);
    return rows.map((r) => r.workspace);
  }

  workspaces() {
    return new Set(this.db.prepare('SELECT workspace FROM sessions').all().map((r) => r.workspace));
  }

  // -------------------------------------------------------------------------------------------
  // Users

  getUser(id) {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) || null;
  }

  findByEmail(email) {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(String(email ?? '').trim()) || null;
  }

  findByGoogle(sub) {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?`).get(String(sub)) || null;
  }

  /** Public view of a user, for the API. */
  describe(user) {
    return {
      email: user.email, name: user.name || null, createdAt: user.createdAt, lastLogin: user.lastLogin,
      hasPassword: !!user.password, google: !!user.googleSub, verified: !!user.verifiedAt,
    };
  }

  /** Create an unconfirmed account. It gets its password when the address is confirmed. */
  createUser(email) {
    const r = this.db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').run(normalizeEmail(email), now());
    return this.getUser(Number(r.lastInsertRowid));
  }

  /** A confirmation token that will set `password` on the account. Earlier links stay valid. */
  async createVerifyToken(userId, password, ttl) {
    validatePassword(password);
    return this.createToken(userId, 'verify', ttl, { data: await hashPassword(password), replace: false });
  }

  /** The address is confirmed: activate the password from that sign-up, unless already confirmed. */
  completeVerification(userId, passwordHash) {
    const user = this.getUser(userId);
    if (!user.verifiedAt) {
      this.db.prepare('UPDATE users SET password = ?, email_verified_at = ? WHERE id = ?').run(passwordHash, now(), userId);
    }
    this.db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'verify'").run(userId);
    return this.getUser(userId);
  }

  /** Whether the password matches a pending sign-up of an unconfirmed account (to explain a failed login). */
  async matchesPendingSignup(email, password) {
    const user = this.findByEmail(email);
    if (!user || user.verifiedAt) return false;
    const pending = this.db.prepare("SELECT data FROM tokens WHERE user_id = ? AND kind = 'verify' AND expires_at > ?").all(user.id, Date.now());
    for (const { data } of pending) if (await checkPassword(String(password ?? ''), data)) return true;
    return false;
  }

  /** Create an account for a Google user; Google has already confirmed the address. */
  createGoogleUser({ email, sub, name }) {
    const r = this.db.prepare('INSERT INTO users (email, email_verified_at, google_sub, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(email, now(), String(sub), name || null, now());
    return this.getUser(Number(r.lastInsertRowid));
  }

  /**
   * Attach a Google account to the account with the same (Google-confirmed) email address. An unconfirmed
   * account has no password yet, and its pending sign-up links are cancelled: they were requested by
   * someone who never proved they own the address.
   */
  linkGoogle(userId, { sub, name }) {
    this.db.prepare('UPDATE users SET google_sub = ?, name = COALESCE(name, ?), email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
      .run(String(sub), name || null, now(), userId);
    this.db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'verify'").run(userId);
    return this.getUser(userId);
  }

  markVerified(userId) {
    this.db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(now(), userId);
  }

  /** Return the user when the email and password match, otherwise null. */
  async verifyPassword(email, password) {
    const user = this.findByEmail(email);
    const ok = await checkPassword(String(password ?? ''), user && user.password ? user.password : DUMMY_HASH);
    return ok && user && user.password ? user : null;
  }

  async checkUserPassword(userId, password) {
    const user = this.getUser(userId);
    return !!user && !!user.password && checkPassword(String(password ?? ''), user.password);
  }

  async setPassword(userId, password) {
    validatePassword(password);
    this.db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(password), userId);
  }

  deleteUser(userId) {
    const workspaces = this.endUserSessions(userId);
    this.db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return workspaces;
  }

  // -------------------------------------------------------------------------------------------
  // Email tokens

  /** Create a single-use token, by default replacing earlier ones of the same kind. */
  createToken(userId, kind, ttl, { data = null, replace = true } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    if (replace) this.db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(userId, kind);
    this.db.prepare('INSERT INTO tokens (token_hash, kind, user_id, expires_at, data) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), kind, userId, Date.now() + ttl, data);
    return token;
  }

  /** Use up a token. Returns { userId, data }, or null when it is unknown, used or expired. */
  consumeToken(token, kind) {
    if (typeof token !== 'string' || !token) return null;
    const hash = sha256(token);
    const row = this.db.prepare('SELECT user_id, expires_at, data FROM tokens WHERE token_hash = ? AND kind = ?').get(hash, kind);
    if (!row) return null;
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hash);
    return row.expires_at < Date.now() ? null : { userId: row.user_id, data: row.data };
  }

  // -------------------------------------------------------------------------------------------

  /** Delete expired sessions, tokens and stale unconfirmed sign-ups. Returns workspaces to remove. */
  sweep() {
    const t = Date.now();
    const workspaces = this.db.prepare('SELECT workspace FROM sessions WHERE expires_at < ?').all(t).map((r) => r.workspace);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(t);
    const stale = new Date(t - UNVERIFIED_TTL).toISOString();
    for (const { id } of this.db.prepare('SELECT id FROM users WHERE email_verified_at IS NULL AND google_sub IS NULL AND created_at < ?').all(stale)) {
      workspaces.push(...this.deleteUser(id));
    }
    return workspaces;
  }

  close() {
    this.db.close();
  }
}
