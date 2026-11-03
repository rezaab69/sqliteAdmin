#!/usr/bin/env node
// SQLite Admin — a web-based administration panel for SQLite databases.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './lib/server.js';
import { createSampleDatabase } from './lib/sample.js';
import { createMailer } from './lib/mailer.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MB = 1048576;

const HELP = `SQLite Admin ${VERSION}

Usage: node server.js [options] [--db file ...]

Options:
  -p, --port <n>          Port to listen on (default 8765, env PORT)
  -H, --host <addr>       Address to bind (default 127.0.0.1, env HOST)
  -d, --data <dir>        Directory holding database files (default ./data, env SQLITE_ADMIN_DATA)
      --db <file>         Additional database file to manage (repeatable)
      --password <pw>     Require this password to log in (env SQLITE_ADMIN_PASSWORD)
      --readonly          Open every database read-only
      --no-sample         Do not create the sample database
      --insecure          Allow binding to a non-loopback address without a password
      --query-timeout <s> Stop any single operation after this many seconds (default: none;
                          30 in public mode)
  -h, --help              Show this help

Public website mode (env SQLITE_ADMIN_PUBLIC=1):
      --public            Serve a public website. Every visitor gets a private workspace as a guest;
                          visitors who sign up or log in can also save databases to their account.
      --trust-proxy       Behind a reverse proxy: use X-Forwarded-For / X-Forwarded-Proto
                          (env SQLITE_ADMIN_TRUST_PROXY=1)
      --public-url <url>  Address people use to reach the site, e.g. https://db.example.com; used in
                          email links and for Google sign-in (env SQLITE_ADMIN_PUBLIC_URL)
      --smtp <url>        Send account emails through this SMTP server, e.g.
                          smtps://user:pass@smtp.example.com:465 (env SQLITE_ADMIN_SMTP_URL).
                          Needed for signing up with an email address. "log" prints emails instead.
      --mail-from <addr>  Sender of account emails, e.g. "SQLite Admin <noreply@example.com>"
                          (env SQLITE_ADMIN_MAIL_FROM)
      --google-client-id <id>   Enable "Continue with Google" (env GOOGLE_CLIENT_ID; the secret
                          must be in env GOOGLE_CLIENT_SECRET)
      --no-signup         Do not allow new accounts to be created
      --guest-quota <MB>  Storage for each visitor's temporary databases (default 100)
      --user-quota <MB>   Storage for each account's saved databases (default 500)
      --max-databases <n> Databases per visitor, temporary and saved together (default 25)
      --max-upload <MB>   Largest file that can be uploaded or imported (default 100)
      --guest-hours <h>   Delete a visitor's temporary databases after this long without
                          activity (default 24)
      --max-workers <n>   Workspaces that can have databases open at once (default 16)
`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H' },
      data: { type: 'string', short: 'd' },
      db: { type: 'string', multiple: true },
      password: { type: 'string' },
      readonly: { type: 'boolean' },
      'no-sample': { type: 'boolean' },
      insecure: { type: 'boolean' },
      'query-timeout': { type: 'string' },
      public: { type: 'boolean' },
      'trust-proxy': { type: 'boolean' },
      'no-signup': { type: 'boolean' },
      'public-url': { type: 'string' },
      smtp: { type: 'string' },
      'mail-from': { type: 'string' },
      'google-client-id': { type: 'string' },
      'guest-quota': { type: 'string' },
      'user-quota': { type: 'string' },
      'max-databases': { type: 'string' },
      'max-upload': { type: 'string' },
      'guest-hours': { type: 'string' },
      'max-workers': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  console.error(e.message + '\n\n' + HELP);
  process.exit(1);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

/** Parse a non-negative number option; undefined when not given. */
function num(name, scale = 1) {
  const v = args[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) die(`--${name} must be a non-negative number`);
  return n * scale;
}

const env = (name) => ['1', 'true', 'yes'].includes(String(process.env[name] || '').toLowerCase());
const isPublic = !!args.public || env('SQLITE_ADMIN_PUBLIC');
const port = Number(args.port || process.env.PORT || 8765);
const host = args.host || process.env.HOST || '127.0.0.1';
const dataDir = path.resolve(args.data || process.env.SQLITE_ADMIN_DATA || path.join(ROOT, 'data'));
const password = args.password || process.env.SQLITE_ADMIN_PASSWORD || '';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

const smtpUrl = args.smtp || process.env.SQLITE_ADMIN_SMTP_URL || '';
const mailFrom = args['mail-from'] || process.env.SQLITE_ADMIN_MAIL_FROM || '';
const googleClientId = args['google-client-id'] || process.env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
let publicUrl = args['public-url'] || process.env.SQLITE_ADMIN_PUBLIC_URL || '';

if (isPublic) {
  if (password) die('--password is for single-user mode. In --public mode people log in with their own accounts.');
  if (googleClientId && !googleClientSecret) die('Google sign-in needs the client secret in the GOOGLE_CLIENT_SECRET environment variable.');
  if (!publicUrl && loopback) publicUrl = `http://localhost:${port}`;
  if (publicUrl) {
    let u;
    try { u = new URL(publicUrl); } catch { die(`--public-url is not a valid URL: ${publicUrl}`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') die('--public-url must start with https://');
    if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      console.warn('Warning: --public-url uses http://. Serve the site over HTTPS so passwords and sessions are protected.');
    }
    publicUrl = u.origin + u.pathname.replace(/\/+$/, '');
  }
  if (args.db) die('--db cannot be used with --public: visitors only see their own databases.');
  if (args.readonly) die('--readonly cannot be used with --public.');
  if (typeof DatabaseSync.prototype.setAuthorizer !== 'function') {
    die(`--public needs a Node.js version whose node:sqlite supports setAuthorizer (this is ${process.version}). Please upgrade Node.js.`);
  }
} else if (!loopback && !password && !args.insecure) {
  die(`Refusing to listen on ${host} without a password: anyone on the network could read and modify your databases.\n` +
    'Set --password (or SQLITE_ADMIN_PASSWORD), pass --public to run a multi-user website, or pass --insecure if you really want this.');
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  // In public mode each guest gets their own copy of the sample instead.
  if (!args['no-sample'] && !isPublic) {
    createSampleDatabase(path.join(dataDir, 'sample.db'));
    console.log(`Created sample database in ${dataDir}`);
  }
}

const options = {
  version: VERSION,
  publicDir: path.join(ROOT, 'public'),
  dataDir,
  host,
  public: isPublic,
  password,
  extraFiles: args.db || [],
  readOnly: !!args.readonly,
  sample: !args['no-sample'],
  trustProxy: !!args['trust-proxy'] || env('SQLITE_ADMIN_TRUST_PROXY'),
  allowSignup: !args['no-signup'],
  queryTimeout: num('query-timeout', 1000),
  guestQuota: num('guest-quota', MB),
  userQuota: num('user-quota', MB),
  maxDatabases: num('max-databases'),
  maxUpload: num('max-upload', MB),
  guestTtl: num('guest-hours', 3600_000),
  maxWorkers: num('max-workers'),
  publicUrl: publicUrl || undefined,
  google: googleClientId ? { clientId: googleClientId, clientSecret: googleClientSecret } : undefined,
};
if (isPublic && smtpUrl) {
  try {
    options.mailer = createMailer(smtpUrl, mailFrom || 'SQLite Admin <noreply@localhost>');
  } catch (e) {
    die(e.message);
  }
  if (smtpUrl !== 'log' && !mailFrom) die('--mail-from (or SQLITE_ADMIN_MAIL_FROM) is required with --smtp.');
}
if (options.maxWorkers !== undefined && options.maxWorkers < 1) die('--max-workers must be at least 1');
for (const [k, v] of Object.entries(options)) if (v === undefined) delete options[k];

let app;
try {
  app = createApp(options);
} catch (e) {
  die(e.message);
}

app.server.listen(port, host, () => {
  const shown = host.includes(':') ? `[${host}]` : host;
  console.log(`SQLite Admin ${VERSION} running at http://${shown}:${port}/`);
  console.log(`Data directory: ${dataDir}${args.readonly ? ' (read-only)' : ''}`);
  if (isPublic) {
    const o = app.options;
    console.log(`Public mode: guests get ${Math.round(o.guestQuota / MB)} MB (kept ${Math.round(o.guestTtl / 3600_000)} h), ` +
      `accounts ${Math.round(o.userQuota / MB)} MB; sign-up ${o.allowSignup ? 'open' : 'closed'}; query timeout ${Math.round(o.queryTimeout / 1000)} s.`);
    const methods = [smtpUrl && `email${smtpUrl === 'log' ? ' (emails printed here)' : ''}`, googleClientId && 'Google'].filter(Boolean);
    console.log(methods.length ? `Accounts: ${methods.join(' and ')}. Site address: ${publicUrl}`
      : 'Accounts are off (guests only): add --smtp for email sign-up and/or GOOGLE_CLIENT_ID for Google sign-in.');
    if (googleClientId) console.log(`Google redirect URI to register: ${publicUrl}/auth/google/callback`);
    if (!options.trustProxy) console.log('Serve it over HTTPS. Behind a reverse proxy, add --trust-proxy.');
  } else if (password) {
    console.log('Password protection is enabled.');
  }
});

app.server.on('error', (e) => {
  die(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try --port <n>.` : e.message);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
