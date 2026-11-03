// HTTP server: static files, sessions and accounts, and dispatch of API calls to the worker thread that owns
// the caller's workspace.
//
// Local mode (the default) serves one workspace, the data directory, optionally behind a single password.
// Public mode gives every visitor a private temporary workspace; visitors who sign up or log in also get a
// permanent "saved" location in their account.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { WorkerPool } from './pool.js';
import { AccountStore, normalizeEmail, validatePassword } from './accounts.js';
import { hasDbExtension } from './dbmanager.js';
import { fail, HttpError } from './util.js';

const MB = 1048576;
const HOUR = 3600_000;
const SESSION_COOKIE = 'sqla_session';
// API methods whose handlers write their own response (files) or read a non-JSON body.
const RAW_HANDLERS = new Set(['export', 'import', 'uploadDatabase', 'downloadDatabase', 'blob']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const PUBLIC_DEFAULTS = {
  guestQuota: 100 * MB, userQuota: 500 * MB, maxDatabases: 25, maxUpload: 100 * MB, maxResponse: 512 * MB,
  queryTimeout: 30_000, guestTtl: 24 * HOUR, userTtl: 30 * 24 * HOUR, maxWorkers: 16, workerMemoryMb: 512,
  minFree: 1024 * MB, sqliteHeapLimit: 1024 * MB, allowSignup: true,
};
const LOCAL_DEFAULTS = { maxWorkers: 1, queryTimeout: 0, workerMemoryMb: 0 };

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed */ }
    }
  }
  return out;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`Request body too large (limit ${Math.round(limit / MB)} MB)`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
}

/** Counts events per key in a fixed time window. */
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  entry(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset < now) {
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    return e;
  }

  /** Record an event; false when the key is over its limit. */
  hit(key) {
    return ++this.entry(key).count <= this.limit;
  }

  blocked(key) {
    return this.entry(key).count >= this.limit;
  }

  reset(key) {
    this.hits.delete(key);
  }
}

/**
 * @param {object} options See server.js for the command-line equivalents. Sizes are in bytes, times in ms.
 */
export function createApp(options) {
  const o = { ...(options.public ? PUBLIC_DEFAULTS : LOCAL_DEFAULTS), ...options };
  const dataDir = path.resolve(o.dataDir);
  const publicDir = path.resolve(o.publicDir);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(o.host);
  const maxJson = o.public ? 32 * MB : 256 * MB;
  const maxImport = o.public ? o.maxUpload : 1024 * MB;

  const probe = new DatabaseSync(':memory:');
  const sqliteVersion = probe.prepare('SELECT sqlite_version() AS v').get().v;
  const compileOptions = probe.prepare('PRAGMA compile_options').all().map((r) => r.compile_options);
  // Process-wide cap on SQLite's memory, shared by all workers.
  if (o.sqliteHeapLimit) probe.exec(`PRAGMA hard_heap_limit = ${Math.floor(o.sqliteHeapLimit)}`);
  probe.close();

  const pool = new WorkerPool({ max: o.maxWorkers, idleMs: o.public ? 10 * 60_000 : Infinity, memoryMb: o.workerMemoryMb });

  // -------------------------------------------------------------------------------------------
  // Workspaces

  let accounts = null;
  let sweepTimer = null;
  let localTmp = null;
  const dirs = {
    workspaces: path.join(dataDir, 'workspaces'),
    users: path.join(dataDir, 'users'),
    tmp: path.join(dataDir, 'tmp'),
  };

  if (o.public) {
    fs.rmSync(dirs.tmp, { recursive: true, force: true });
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    accounts = new AccountStore({ file: path.join(dataDir, 'app.db'), guestTtl: o.guestTtl, userTtl: o.userTtl });
    // Workspaces whose sessions no longer exist (e.g. expired while the server was down).
    const live = accounts.workspaces();
    for (const ws of fs.readdirSync(dirs.workspaces)) if (!live.has(ws)) fs.rmSync(path.join(dirs.workspaces, ws), { recursive: true, force: true });
    sweepTimer = setInterval(() => {
      for (const ws of accounts.sweep()) removeWorkspace(ws).catch((e) => console.error(e));
    }, 5 * 60_000).unref();
  } else {
    localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-admin-'));
  }

  function workspace(session) {
    if (!o.public) {
      return {
        key: 'local',
        config: { manager: { dataDir, extraFiles: o.extraFiles || [], readOnly: !!o.readOnly, tmpDir: localTmp }, maxResponseBytes: 0 },
      };
    }
    const temp = path.join(dirs.workspaces, session.workspace);
    const locations = [{ id: 'temp', dir: temp, quota: o.guestQuota }];
    if (session.userId) locations.push({ id: 'saved', dir: path.join(dirs.users, String(session.userId)), quota: o.userQuota });
    return {
      key: session.workspace,
      config: {
        manager: { locations, secure: true, maxDatabases: o.maxDatabases, minFreeBytes: o.minFree, tmpDir: path.join(dirs.tmp, session.workspace) },
        maxResponseBytes: o.maxResponse,
        // New guests get a demo database to explore.
        sampleIn: o.sample !== false && !session.userId ? temp : null,
      },
    };
  }

  async function removeWorkspace(ws) {
    await pool.stop(ws);
    fs.rmSync(path.join(dirs.workspaces, ws), { recursive: true, force: true });
    fs.rmSync(path.join(dirs.tmp, ws), { recursive: true, force: true });
  }

  /** Database names must be unique across a user's locations; rename temporary ones that clash. */
  function resolveNameConflicts(session) {
    const temp = path.join(dirs.workspaces, session.workspace);
    const saved = path.join(dirs.users, String(session.userId));
    if (!fs.existsSync(temp) || !fs.existsSync(saved)) return;
    const savedNames = new Set(fs.readdirSync(saved).map((n) => n.toLowerCase()));
    const taken = new Set([...fs.readdirSync(temp).map((n) => n.toLowerCase()), ...savedNames]);
    for (const name of fs.readdirSync(temp)) {
      if (!hasDbExtension(name) || !savedNames.has(name.toLowerCase())) continue;
      const ext = path.extname(name);
      const base = name.slice(0, -ext.length);
      let next = name;
      for (let i = 2; taken.has(next.toLowerCase()); i++) next = `${base} (${i})${ext}`;
      taken.add(next.toLowerCase());
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (fs.existsSync(path.join(temp, name + suffix))) fs.renameSync(path.join(temp, name + suffix), path.join(temp, next + suffix));
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  const clientIp = (req) => {
    if (o.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress;
  };
  const isHttps = (req) => !!req.socket.encrypted
    || (!!o.trustProxy && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()));

  function addCookie(req, res, cookie) {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), `${cookie}${isHttps(req) ? '; Secure' : ''}`]);
  }

  function setSessionCookie(req, res, token, maxAgeMs) {
    addCookie(req, res, `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  }

  const cookieToken = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE];

  function hostAllowed(hostHeader) {
    if (!loopback) return true;
    if (!hostHeader) return false;
    const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(name);
  }

  function setSecurityHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    });
  }

  function status(session) {
    const base = { app: o.version, sqlite: sqliteVersion, compileOptions, readOnly: !!o.readOnly, public: !!o.public };
    if (!o.public) {
      return { ...base, node: process.version, platform: `${os.type()} ${os.release()}`, dataDir, authRequired: !!o.password };
    }
    return {
      ...base,
      user: session && session.userId ? { email: session.email, name: session.name || null } : null,
      auth: { email: emailAuth, google: !!google, signup: !!o.allowSignup },
      limits: {
        guestQuota: o.guestQuota, userQuota: o.userQuota, maxDatabases: o.maxDatabases, maxUpload: o.maxUpload,
        queryTimeout: o.queryTimeout, guestTtl: o.guestTtl, userTtl: o.userTtl,
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Local mode: one optional shared password

  const localSessions = new Map();
  const LOCAL_TTL = 12 * HOUR;
  const loginFailures = new RateLimiter(5, 60_000);

  function localAuthenticated(req) {
    if (!o.password) return true;
    const token = cookieToken(req);
    const expires = token && localSessions.get(token);
    if (!expires || expires < Date.now()) {
      if (token) localSessions.delete(token);
      return false;
    }
    localSessions.set(token, Date.now() + LOCAL_TTL);
    return true;
  }

  function checkSharedPassword(input) {
    const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
    const b = crypto.createHash('sha256').update(o.password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  const localHandlers = {
    async login(req, res) {
      const ip = clientIp(req);
      if (loginFailures.blocked(ip)) fail('Too many attempts. Try again in a minute.', 429);
      const body = await readJson(req, 1e4);
      if (!o.password) return { ok: true };
      if (!checkSharedPassword(body.password)) {
        loginFailures.hit(ip);
        await new Promise((r) => setTimeout(r, 400));
        fail('Wrong password', 401);
      }
      loginFailures.reset(ip);
      const token = crypto.randomBytes(32).toString('hex');
      localSessions.set(token, Date.now() + LOCAL_TTL);
      setSessionCookie(req, res, token, LOCAL_TTL);
      return { ok: true };
    },
    async logout(req, res) {
      const token = cookieToken(req);
      if (token) localSessions.delete(token);
      setSessionCookie(req, res, '', 0);
      return { ok: true };
    },
  };

  // -------------------------------------------------------------------------------------------
  // Public mode: guest sessions and user accounts
  //
  // Accounts are identified by email address. People sign up with an email address and a password (the
  // account works once they open the confirmation link we email them) or with their Google account.

  const VERIFY_TTL = 24 * HOUR;
  const RESET_TTL = HOUR;
  const limits = {
    sessionsPerHour: 30, signupsPerHour: 5, emailsPerHourPerIp: 10, emailsPerHourPerAddress: 3, failuresPer15Min: 10,
    ...o.rateLimits,
  };
  const newSessions = new RateLimiter(limits.sessionsPerHour, HOUR);
  const signups = new RateLimiter(limits.signupsPerHour, HOUR);
  const emailsPerIp = new RateLimiter(limits.emailsPerHourPerIp, HOUR);
  const emailsPerAddress = new RateLimiter(limits.emailsPerHourPerAddress, HOUR);
  const accountFailures = new RateLimiter(limits.failuresPer15Min, 15 * 60_000);
  const emailAuth = !!o.mailer;
  const google = o.google && o.google.clientId && o.google.clientSecret ? {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    ...o.google,
  } : null;
  // Links in emails and the Google redirect use the configured address, never the request's Host header.
  const siteUrl = () => String(o.publicUrl || '').replace(/\/+$/, '');
  if (o.public && (emailAuth || google) && !o.publicUrl) {
    throw new Error('Set --public-url (the address people use to reach the site) to send email links or use Google sign-in.');
  }

  const userInfo = (user) => ({ email: user.email, name: user.name || null });

  /** Send an account email, with limits so the site can't be used to flood someone's inbox. */
  async function sendEmail(req, to, subject, text) {
    if (!emailsPerIp.hit(clientIp(req)) || !emailsPerAddress.hit(to.toLowerCase())) {
      fail('Too many emails were requested. Please try again later.', 429);
    }
    try {
      await o.mailer.send({ to, subject, text });
    } catch (e) {
      console.error(`Could not send email: ${e.message}`);
      fail('The email could not be sent. Please try again later.', 502);
    }
  }

  function currentSession(req, res, { create = false } = {}) {
    const token = cookieToken(req);
    const session = accounts.getSession(token);
    if (session || !create) return { token, session };
    if (!newSessions.hit(clientIp(req))) fail('Too many new sessions from your network. Please try again later.', 429);
    const created = accounts.createSession();
    setSessionCookie(req, res, created.token, o.userTtl);
    return created;
  }

  function requireUser(req, res) {
    const current = currentSession(req, res);
    if (!current.session || !current.session.userId) fail('Please log in first.', 401);
    return current;
  }

  /** Sign `user` in in this browser. A guest's databases carry over; another user's session ends. */
  async function signIn(req, res, user, browserToken = cookieToken(req)) {
    const old = accounts.getSession(browserToken);
    // A guest's worker restarts with the account's saved location added.
    if (old) await (old.userId ? removeWorkspace(old.workspace) : pool.stop(old.workspace));
    const { token, session } = accounts.signIn(browserToken, user.id);
    resolveNameConflicts(session);
    setSessionCookie(req, res, token, o.userTtl);
    return { ok: true, user: userInfo(user) };
  }

  async function checkAccountPassword(req, userId, password) {
    const ip = clientIp(req);
    if (accountFailures.blocked(ip)) fail('Too many attempts. Try again later.', 429);
    if (!(await accounts.checkUserPassword(userId, password))) {
      accountFailures.hit(ip);
      fail('The password is wrong.', 403);
    }
  }

  const publicHandlers = {
    async status(req, res) {
      return status(currentSession(req, res).session);
    },

    /**
     * Sign up with an email address. The reply is the same whether or not the address is already
     * registered (the owner gets an email either way), so this can't be used to find out who has an account.
     */
    async signup(req, res) {
      if (!emailAuth || !o.allowSignup) fail('Signing up with an email address is not available on this server.', 403);
      const body = await readJson(req, 1e4);
      const email = normalizeEmail(body.email);
      validatePassword(body.password);
      if (!signups.hit(clientIp(req))) fail('Too many sign-ups from your network. Please try again later.', 429);
      const existing = accounts.findByEmail(email);
      if (existing && existing.verifiedAt) {
        await sendEmail(req, existing.email, 'Your SQLite Admin account',
          `Hello,\n\nSomeone (hopefully you) tried to sign up for SQLite Admin with this email address, but you already have an account.\n\n`
          + (existing.password ? 'Log in' : 'Log in with "Continue with Google"') + ` at ${siteUrl()}/\n\n`
          + 'If you forgot your password, use "Forgot password?" on the log-in form.\n\nIf this wasn\'t you, you can ignore this email.\n');
      } else {
        const user = existing || accounts.createUser(email);
        const token = await accounts.createVerifyToken(user.id, body.password, VERIFY_TTL);
        await sendEmail(req, user.email, 'Confirm your email for SQLite Admin',
          `Hello,\n\nPlease confirm your email address to finish creating your SQLite Admin account:\n\n${siteUrl()}/#/verify?token=${token}\n\n`
          + 'The link works for 24 hours. If you didn\'t sign up, you can ignore this email.\n');
      }
      return { ok: true, email };
    },

    /** Open the link from the confirmation email: activates the account and signs in. */
    async verifyEmail(req, res) {
      const body = await readJson(req, 1e4);
      const found = accounts.consumeToken(body.token, 'verify');
      if (!found) fail('This confirmation link is invalid or has expired. Please sign up again to get a new one.', 400);
      return signIn(req, res, accounts.completeVerification(found.userId, found.data));
    },

    async login(req, res) {
      const ip = clientIp(req);
      if (accountFailures.blocked(ip)) fail('Too many attempts. Try again in a few minutes.', 429);
      const body = await readJson(req, 1e4);
      const user = await accounts.verifyPassword(body.email, body.password);
      if (!user) {
        accountFailures.hit(ip);
        if (await accounts.matchesPendingSignup(body.email, body.password)) {
          throw Object.assign(new HttpError(403, 'Please confirm your email address first: open the link we emailed you. (Check your spam folder, or sign up again to get a new link.)'), { reason: 'unverified' });
        }
        fail('Wrong email or password.', 401);
      }
      accountFailures.reset(ip);
      return signIn(req, res, user);
    },

    /** Email a password-reset link. The reply doesn't reveal whether the address has an account. */
    async requestPasswordReset(req, res) {
      if (!emailAuth) fail('Password reset by email is not available on this server.', 403);
      const body = await readJson(req, 1e4);
      const email = normalizeEmail(body.email);
      const user = accounts.findByEmail(email);
      if (user) {
        const token = accounts.createToken(user.id, 'reset', RESET_TTL);
        await sendEmail(req, user.email, 'Reset your SQLite Admin password',
          `Hello,\n\nTo choose a new password for your SQLite Admin account, open this link:\n\n${siteUrl()}/#/reset?token=${token}\n\n`
          + 'The link works for one hour. If you didn\'t ask for this, you can ignore this email; your password stays the same.\n');
      } else if (!emailsPerIp.hit(clientIp(req)) || !emailsPerAddress.hit(email.toLowerCase())) {
        fail('Too many emails were requested. Please try again later.', 429);
      }
      return { ok: true, email };
    },

    /** Set a new password from a reset link. Signs out everywhere else and signs in here. */
    async resetPassword(req, res) {
      const body = await readJson(req, 1e4);
      validatePassword(body.password);
      const found = accounts.consumeToken(body.token, 'reset');
      if (!found) fail('This reset link is invalid or has expired. Please request a new one.', 400);
      await accounts.setPassword(found.userId, body.password);
      // Opening the link proves the address, so an unconfirmed account is now confirmed.
      accounts.completeVerification(found.userId, null);
      for (const ws of accounts.endUserSessions(found.userId)) await removeWorkspace(ws);
      return signIn(req, res, accounts.getUser(found.userId));
    },

    async logout(req, res) {
      const { token, session } = currentSession(req, res);
      if (session) {
        accounts.deleteSession(token);
        await removeWorkspace(session.workspace);
      }
      setSessionCookie(req, res, '', 0);
      return { ok: true };
    },

    async account(req, res) {
      const { session } = requireUser(req, res);
      return { user: accounts.describe(accounts.getUser(session.userId)) };
    },

    /** Change the password, or set one on an account that so far only signs in with Google. */
    async changePassword(req, res) {
      const { token, session } = requireUser(req, res);
      const body = await readJson(req, 1e4);
      if (accounts.getUser(session.userId).password) await checkAccountPassword(req, session.userId, body.current);
      await accounts.setPassword(session.userId, body.password);
      // Sign out everywhere else.
      for (const ws of accounts.endUserSessions(session.userId, token)) await removeWorkspace(ws);
      return { ok: true };
    },

    /** Confirm with the password, or (for Google-only accounts) by typing the email address. */
    async deleteAccount(req, res) {
      const { session } = requireUser(req, res);
      const body = await readJson(req, 1e4);
      const user = accounts.getUser(session.userId);
      if (user.password) await checkAccountPassword(req, session.userId, body.password);
      else if (String(body.confirm ?? '').trim().toLowerCase() !== user.email.toLowerCase()) fail('Type your email address to confirm.', 403);
      for (const ws of accounts.deleteUser(session.userId)) await removeWorkspace(ws);
      fs.rmSync(path.join(dirs.users, String(session.userId)), { recursive: true, force: true });
      setSessionCookie(req, res, '', 0);
      return { ok: true };
    },
  };

  // -------------------------------------------------------------------------------------------
  // Sign in with Google (OpenID Connect authorization code flow with PKCE)

  const OAUTH_COOKIE = 'sqla_oauth';
  const OAUTH_TTL = 10 * 60_000;
  // state -> { verifier, nonce, browserToken, expires }. The browser's session cookie is remembered here
  // because it is SameSite=Strict and so is not sent when Google redirects back to us.
  const oauthStates = new Map();

  const redirect = (res, location) => res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }).end();

  function googleStart(req, res) {
    if (!google) return redirect(res, '/#/?authError=google-disabled');
    const t = Date.now();
    for (const [k, v] of oauthStates) if (v.expires < t) oauthStates.delete(k);
    if (oauthStates.size > 10_000) return redirect(res, '/#/?authError=busy');
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    oauthStates.set(state, { verifier, nonce, browserToken: cookieToken(req), expires: t + OAUTH_TTL });
    // Ties the flow to this browser, so someone else's half-finished sign-in can't be completed here.
    addCookie(req, res, `${OAUTH_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=${OAUTH_TTL / 1000}`);
    const params = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: `${siteUrl()}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return redirect(res, `${google.authUrl}?${params}`);
  }

  async function googleCallback(req, res, url) {
    const back = (error) => redirect(res, error ? `/#/?authError=${error}` : '/#/?signedIn=google');
    addCookie(req, res, `${OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=0`);
    const state = url.searchParams.get('state') || '';
    const saved = oauthStates.get(state);
    oauthStates.delete(state);
    if (!google) return back('google-disabled');
    if (url.searchParams.get('error')) return back('google-cancelled');
    if (!saved || saved.expires < Date.now() || parseCookies(req.headers.cookie)[OAUTH_COOKIE] !== state) return back('google-expired');

    let claims;
    try {
      const r = await fetch(google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code: url.searchParams.get('code') || '',
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: `${siteUrl()}/auth/google/callback`,
          grant_type: 'authorization_code',
          code_verifier: saved.verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || typeof data.id_token !== 'string') throw new Error(`token request failed: ${r.status} ${data.error || ''}`);
      claims = JSON.parse(Buffer.from(data.id_token.split('.')[1] || '', 'base64url').toString('utf8'));
    } catch (e) {
      console.error(`Google sign-in failed: ${e.message}`);
      return back('google-failed');
    }
    // The ID token came straight from Google's token endpoint over TLS, so OpenID Connect (Core 1.0,
    // section 3.1.3.7) lets us rely on TLS instead of checking its signature. Its claims are still checked.
    if (!google.issuers.includes(claims.iss) || claims.aud !== google.clientId || !(claims.exp * 1000 > Date.now())
      || claims.nonce !== saved.nonce || typeof claims.sub !== 'string' || !claims.sub) {
      console.error('Google sign-in failed: the ID token did not pass validation');
      return back('google-failed');
    }
    if (typeof claims.email !== 'string' || claims.email_verified !== true) return back('google-unverified');

    let user = accounts.findByGoogle(claims.sub);
    if (!user) {
      const existing = accounts.findByEmail(claims.email);
      if (existing && existing.googleSub) return back('google-mismatch');
      if (existing) {
        user = accounts.linkGoogle(existing.id, claims);
      } else {
        if (!o.allowSignup) return back('signup-closed');
        if (!signups.hit(clientIp(req))) return back('rate-limited');
        user = accounts.createGoogleUser({ email: claims.email, sub: claims.sub, name: claims.name });
      }
    }
    await signIn(req, res, user, saved.browserToken);
    return back(null);
  }

  // -------------------------------------------------------------------------------------------
  // API dispatch

  async function receiveUpload(req, dir) {
    const declared = Number(req.headers['content-length']) || 0;
    const limit = o.public ? o.maxUpload : Infinity;
    const tooLarge = () => Object.assign(new Error(`The file is larger than the ${Math.round(limit / MB)} MB upload limit.`), { status: 413 });
    if (declared > limit) throw tooLarge();
    if (o.minFree) {
      const st = fs.statfsSync(dataDir);
      if (st.bavail * st.bsize < o.minFree + declared) fail('The server is low on storage space. Please try again later.', 507);
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `upload-${crypto.randomBytes(6).toString('hex')}`);
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > limit) cb(tooLarge());
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file));
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    return file;
  }

  function sendFileResponse(res, { status: code, headers, file, remove }) {
    const head = Object.fromEntries(Object.entries(headers || {}).filter(([k]) => k.toLowerCase() !== 'content-length'));
    if (!file) {
      res.writeHead(code, { ...head, 'Content-Length': 0 }).end();
      return;
    }
    res.writeHead(code, { ...head, 'Content-Length': fs.statSync(file).size });
    const stream = fs.createReadStream(file);
    stream.on('close', () => { if (remove) fs.rm(file, { force: true }, () => {}); });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async function dispatch(req, res, url, name, session) {
    const { key, config } = workspace(session);
    const raw = RAW_HANDLERS.has(name);
    const msg = { kind: raw ? 'raw' : 'json', name, query: url.search.slice(1) };
    if (name === 'uploadDatabase') msg.file = await receiveUpload(req, config.manager.tmpDir);
    else if (name === 'import') msg.text = (await readBody(req, maxImport)).toString('utf8');
    else msg.body = await readJson(req, maxJson);
    let reply;
    try {
      // Raw calls export or copy whole databases, so they get more time.
      reply = await pool.call(key, config, msg, { timeout: raw ? o.queryTimeout * 4 : o.queryTimeout });
    } catch (e) {
      if (msg.file) fs.rm(msg.file, { force: true }, () => {});
      throw e;
    }
    if (reply.response) sendFileResponse(res, reply.response);
    else sendJson(res, 200, reply.result);
  }

  async function handleApi(req, res, url) {
    const name = url.pathname.slice('/api/'.length);
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
    // A custom header cannot be sent cross-origin without a CORS preflight, which we never approve.
    if (req.headers['x-sqlite-admin'] !== '1') return sendJson(res, 403, { error: 'Missing X-SQLite-Admin header' });

    if (o.public) {
      if (Object.hasOwn(publicHandlers, name)) return sendJson(res, 200, await publicHandlers[name](req, res));
      return dispatch(req, res, url, name, currentSession(req, res, { create: true }).session);
    }
    if (Object.hasOwn(localHandlers, name)) return sendJson(res, 200, await localHandlers[name](req, res));
    if (!localAuthenticated(req)) return sendJson(res, 401, { error: 'Login required', loginRequired: true });
    if (name === 'status') return sendJson(res, 200, status());
    return dispatch(req, res, url, name, null);
  }

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(req, res);
    const url = new URL(req.url, 'http://localhost');
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden: unexpected Host header');
      return;
    }
    try {
      if (url.pathname === '/healthz') res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (o.public && url.pathname === '/auth/google' && req.method === 'GET') googleStart(req, res);
      else if (o.public && url.pathname === '/auth/google/callback' && req.method === 'GET') {
        await googleCallback(req, res, url).catch((e) => {
          console.error(e);
          if (!res.headersSent) redirect(res, '/#/?authError=google-failed');
        });
      }
      else serveStatic(req, res, url.pathname);
    } catch (e) {
      const code = e.status || (e.code === 'ERR_SQLITE_ERROR' || e instanceof SyntaxError ? 400 : 500);
      if (code === 500) console.error(e.workerStack || e);
      if (res.headersSent) res.destroy();
      else sendJson(res, code, { error: e.message, reason: e.reason });
    }
  });

  async function close() {
    clearInterval(sweepTimer);
    server.close();
    server.closeAllConnections();
    await pool.close();
    if (accounts) accounts.close();
    if (localTmp) fs.rmSync(localTmp, { recursive: true, force: true });
  }

  return { server, close, options: o };
}
