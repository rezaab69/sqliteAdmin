# SQLite Admin

A web-based administration panel for SQLite databases, in the spirit of phpMyAdmin.
It has **no dependencies**: the server uses Node's built-in `node:sqlite` module and the UI is plain
JavaScript. There is nothing to install or compile.

## Quick start

```bash
node server.js            # or: npm start
```

Open <http://127.0.0.1:8765/>. On first run a `data/` directory is created with a `sample.db` demo
database (artists, albums, tracks, customers, orders…) so there is something to explore.

Requires **Node.js 24 or newer** (it uses `node:sqlite`).

## Features

**Databases**
- List, create, rename, copy, delete, upload (drag & drop) and download `.db` files
- Overview with row counts, per-table disk usage, file/page statistics
- Search a value across every column of every table
- Maintenance: VACUUM, ANALYZE, `PRAGMA optimize`, integrity / quick / foreign-key checks, REINDEX, WAL checkpoint
- Edit settings (PRAGMAs) such as `journal_mode`, `foreign_keys`, `user_version`, `auto_vacuum`, `page_size`
- Designer: an entity-relationship diagram with draggable tables, auto layout and SVG export

**Tables and views**
- Browse with pagination, multi-column sorting (Shift+click), quick search, and filters with 20+ operators
  (`=`, `LIKE`, `IN`, `BETWEEN`, `REGEXP`, `IS NULL`…)
- Double-click a cell to edit it in place; right-click for copy, filter-by-value, set NULL, duplicate, delete
- Row editor with per-column functions (`NULL`, `DEFAULT`, `CURRENT_TIMESTAMP`, raw SQL expressions, load from file)
- BLOB viewer with image preview, hex dump, download and upload
- Foreign-key values link to the referenced row
- Structure: columns, indexes, foreign keys (both directions), triggers and the CREATE statement
- Add, rename or drop columns; create or drop indexes (unique, partial, DESC) and triggers
- **Table designer** for creating tables and changing existing ones (types, keys, defaults, constraints,
  column order, WITHOUT ROWID, STRICT). Changes that SQLite's `ALTER TABLE` can't make are done by a safe,
  transactional table rebuild that keeps data, indexes and triggers
- Operations: rename, copy (with or without data and indexes), empty, drop, materialize a view as a table

**SQL**
- Editor with syntax highlighting, line numbers, schema-aware autocompletion (including table aliases),
  formatting, comment toggling and templates
- Runs multi-statement scripts, showing a result or affected-row count for each statement; runs only the
  selection when text is selected
- `EXPLAIN QUERY PLAN` shown as a tree, with full table scans highlighted
- Per-database query history and saved queries
- An open transaction is shown in a banner with Commit / Roll back buttons

**Import and export**
- Export a database as an SQL dump or JSON, choosing tables and options (structure/data, DROP IF EXISTS,
  batch size, transaction)
- Export a table, the current filtered result, selected rows or any query as CSV, TSV, JSON, SQL or Markdown
- Import SQL scripts (all-or-nothing transaction, optional foreign-key relaxation), or CSV/TSV/JSON into new
  tables (column types inferred) or existing tables (append or replace), with delimiter detection and preview

**Interface**: light and dark themes, resizable sidebar with a filterable object tree, works on phones and
tablets, keyboard shortcuts.

## Options

```
node server.js [options]

  -p, --port <n>        Port to listen on (default 8765, env PORT)
  -H, --host <addr>     Address to bind (default 127.0.0.1, env HOST)
  -d, --data <dir>      Directory holding database files (default ./data, env SQLITE_ADMIN_DATA)
      --db <file>       Manage an additional database file outside the data directory (repeatable)
      --password <pw>   Require a password to log in (env SQLITE_ADMIN_PASSWORD)
      --readonly        Open every database read-only
      --no-sample       Do not create the sample database on first run
      --insecure        Allow binding to a non-loopback address without a password
      --query-timeout <s>  Stop any single operation after this many seconds (default: none; 30 in --public mode)

Public website mode (see below):
      --public          Serve a public website with guest workspaces and user accounts (env SQLITE_ADMIN_PUBLIC=1)
      --trust-proxy     Behind a reverse proxy: use X-Forwarded-For / X-Forwarded-Proto (env SQLITE_ADMIN_TRUST_PROXY=1)
      --public-url <url>   Address people use to reach the site, e.g. https://db.example.com (env SQLITE_ADMIN_PUBLIC_URL)
      --smtp <url>         SMTP server for account emails, e.g. smtps://user:pass@smtp.example.com:465
                           (env SQLITE_ADMIN_SMTP_URL); "log" prints emails to the console instead
      --mail-from <addr>   Sender of account emails (env SQLITE_ADMIN_MAIL_FROM)
      --google-client-id <id>  Enable "Continue with Google" (env GOOGLE_CLIENT_ID; secret in env GOOGLE_CLIENT_SECRET)
      --no-signup       Do not allow new accounts to be created
      --guest-quota <MB>   Storage for each visitor's temporary databases (default 100)
      --user-quota <MB>    Storage for each account's saved databases (default 500)
      --max-databases <n>  Databases per visitor, temporary and saved together (default 25)
      --max-upload <MB>    Largest file that can be uploaded or imported (default 100)
      --guest-hours <h>    Delete a visitor's temporary databases after this long without activity (default 24)
      --max-workers <n>    Workspaces that can have databases open at once (default 16)
```

Examples:

```bash
node server.js --db ~/projects/app/dev.sqlite3          # manage an existing file
node server.js --data /var/lib/myapp --readonly         # inspect production data safely
SQLITE_ADMIN_PASSWORD=change-me node server.js --host 0.0.0.0 --port 8080
node server.js --public --trust-proxy                   # public website behind a reverse proxy
```

## Public website mode

With `--public`, SQLite Admin runs as a website anyone can use to upload, edit and download SQLite databases:

- **Guests** can use every feature straight away. Each visitor gets a private workspace (starting with a copy of
  the sample database) that no one else can see. It is deleted after 24 hours without activity (`--guest-hours`).
- **Accounts** are identified by email address. Visitors can sign up in two ways:
  - **Email and password.** The account works once they open the confirmation link emailed to them (valid for
    24 hours). Forgotten passwords can be reset with an emailed link (valid for one hour).
  - **Continue with Google** (any Google account, including Gmail). If an account with the same address already
    exists, the Google sign-in is linked to it.
- Signed-in users also have **Saved** storage in their account, which is kept until they delete it. New and
  uploaded databases go there by default (untick *Save to my account* to keep one temporary), and any temporary
  database can be moved there with **Save**.
- Databases a guest was working on stay available after they sign up or log in. Temporary databases are deleted
  when the user logs out (the app warns first).
- Users can change their password (which signs out their other devices), add a password to a Google account, and
  delete their account and all its data.

Email sign-up needs `--smtp`; Google sign-in needs a Google client ID (see *Deploying*). With neither, the site
works for guests only.

Everything lives in the data directory:

```
data/app.db               accounts and sessions (never reachable through the API)
data/workspaces/<id>/     each session's temporary databases
data/users/<user id>/     each account's saved databases
data/tmp/                 uploads and downloads in progress (cleared on start)
```

Back up `app.db` and `users/`; `workspaces/` and `tmp/` are disposable.

### Limits and isolation

Because anyone can run SQL on a public site, database work is contained:

- Each active workspace runs in its own **child process**. An operation that takes longer than 30 seconds
  (`--query-timeout`), such as an endless recursive query or a runaway regular expression, is stopped by killing
  that process. Other visitors are not affected, and any open transaction is rolled back. A workspace's process
  also exits after 10 minutes without requests, which rolls back an open transaction too.
- **File access from SQL is blocked**: `ATTACH`, `VACUUM INTO` and PRAGMAs that change process-wide settings or
  directories are refused, SQLite's defensive mode is on, and extensions can't be loaded. Downloads and copies
  still work because the panel runs those statements itself.
- **Storage quotas** are enforced as databases grow (not only on upload), along with the number of databases,
  the upload size and the size of any single export. Writes are refused when the disk has less than 1 GB free.
- Sign-ups, log-ins and new guest sessions are rate-limited per IP address.

## Deploying

Public mode needs a Node.js version whose `node:sqlite` has `setAuthorizer` (it was built and tested on
Node.js 26.7); the server refuses to start in `--public` mode otherwise.

Always serve it over **HTTPS**. The simplest setup is a reverse proxy that terminates TLS, with SQLite Admin
listening on localhost:

```bash
export SQLITE_ADMIN_SMTP_URL='smtps://USER:PASSWORD@smtp.example.com:465'
export GOOGLE_CLIENT_ID='1234-abc.apps.googleusercontent.com'
export GOOGLE_CLIENT_SECRET='...'
node server.js --public --trust-proxy --data /var/lib/sqlite-admin \
  --public-url https://db.example.com --mail-from 'SQLite Admin <noreply@example.com>'
```

Pass secrets through environment variables (as above) rather than command-line options, which other users of
the machine can see in the process list.

Only use `--trust-proxy` when a proxy sits in front: it makes the server believe the `X-Forwarded-For` and
`X-Forwarded-Proto` headers (for rate limiting and for marking cookies `Secure`), which clients could otherwise fake.

`--public-url` is required for email sign-up and Google sign-in: links in emails and the Google redirect are
built from it, never from the request's `Host` header (which an attacker could forge to steal reset links).

**Email** works with any SMTP service (your mail provider, Amazon SES, Mailgun, SendGrid, Postmark…). Use
`smtps://` (TLS, usually port 465) or `smtp://` (STARTTLS, usually port 587); the connection is always encrypted
unless you add `?tls=off`, which is only for a relay on a trusted network. Put a sender address from a domain
your SMTP service is allowed to send for, or the emails will land in spam. To try it locally, use `--smtp log`:
emails, including their links, are printed to the console.

**Google sign-in**: in the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an
*OAuth client ID* of type *Web application* and add `https://db.example.com/auth/google/callback` (your public
URL + `/auth/google/callback`) as an authorized redirect URI; the server prints the exact URI at startup. Set up
the OAuth consent screen with the `openid`, `email` and `profile` scopes. For testing on your own machine, add
`http://localhost:8765/auth/google/callback` as well.

**Caddy** (gets a certificate automatically):

```
db.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

**nginx**: proxy to `http://127.0.0.1:8765`, set `X-Forwarded-For` and `X-Forwarded-Proto`, allow uploads with
`client_max_body_size 100m;`, and give long exports time with `proxy_read_timeout 180s;`.

**Docker**:

```bash
docker build -t sqlite-admin .
docker run -d --name sqlite-admin -p 127.0.0.1:8765:8765 -v sqlite-admin-data:/data \
  -e SQLITE_ADMIN_TRUST_PROXY=1 -e SQLITE_ADMIN_PUBLIC_URL=https://db.example.com \
  -e SQLITE_ADMIN_SMTP_URL -e SQLITE_ADMIN_MAIL_FROM -e GOOGLE_CLIENT_ID -e GOOGLE_CLIENT_SECRET \
  sqlite-admin
```

The image runs in public mode as a non-root user, keeps its data in the `/data` volume and has a health check
(`GET /healthz`).

Sizing: each workspace with databases open uses one Node.js process (about 55 MB, and up to 512 MB of
JavaScript heap while working), so the default `--max-workers 16` needs roughly 1–2 GB of RAM. When every
worker is busy, new visitors get a "server busy" reply until one frees up.

## Security

This tool gives full control over the databases it manages, so it is locked down by default:

- It listens on `127.0.0.1` only. Binding to another address requires `--password` (or an explicit `--insecure`).
- Every API call must carry a custom header, which browsers can't send cross-site without a CORS preflight
  (never granted). This blocks CSRF from other websites.
- On loopback, requests with an unexpected `Host` header are rejected, which protects against DNS rebinding.
- Database names are validated, so the API can't reach files outside the data directory. Files added with
  `--db` can't be renamed or deleted from the UI.
- Passwords are compared in constant time. Sessions use `HttpOnly`, `SameSite=Strict` cookies, and repeated
  failed logins are throttled.
- A strict Content-Security-Policy is sent, and the UI never inserts database content as HTML.

If you expose it beyond your machine, put it behind HTTPS (for example a reverse proxy) and use a strong password.

In public mode, additionally:

- Account passwords are hashed with scrypt; session cookies and emailed links are random tokens stored only as
  SHA-256 hashes, and session cookies are replaced on every login. Emailed links work once and expire.
- Sign-up, log-in and password-reset replies don't reveal whether an address has an account (the owner of an
  existing account gets an email instead), and emails per address and per IP are rate-limited.
- The password chosen at email sign-up only takes effect through that sign-up's own confirmation link, so someone
  who signs up with another person's address can't set their password. Signing in with Google cancels any pending
  email sign-ups for the address.
- Google sign-in uses the authorization code flow with PKCE, a nonce, and a state value bound to the browser by a
  cookie. The ID token is received directly from Google over TLS; its issuer, audience, expiry and nonce are
  checked, and only Google-verified email addresses are accepted.
- Each visitor can only reach the databases in their own workspace and account; user SQL can't open other files
  (see *Limits and isolation* above). Server paths, the Node.js version and the OS are not shown.
- `Strict-Transport-Security` is sent on HTTPS requests.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/⌘ + Enter | Run SQL (or just the selection) |
| Ctrl/⌘ + Space | Autocomplete |
| Ctrl/⌘ + / | Toggle comment |
| Tab / Shift+Tab | Indent / outdent |
| Double-click cell | Edit in place (Enter saves, Esc cancels, Tab moves to the next cell) |
| Right-click cell | Cell actions |
| Esc | Close dialogs and menus |

## Development

```bash
npm test      # node --test: SQL parser, API, and end-to-end server tests (local and public mode)
```

Layout:

```
server.js                 command line: options, startup, shutdown
lib/server.js             HTTP server, sessions and accounts, static files, API dispatch
lib/pool.js               one child process per workspace; queueing, timeouts, limits
lib/worker.js             the child process: runs API calls against its workspace's databases
lib/accounts.js           users, sessions and emailed-link tokens (public mode)
lib/mailer.js             minimal SMTP client for account emails
lib/dbmanager.js          database files and connections, storage locations, quotas, SQL restrictions
lib/api.js                all API operations (browse, edit, query, rebuild, import/export…)
lib/util.js               value encoding, SQL literals, CSV
lib/sample.js             demo database
public/index.html         single-page app shell
public/js/shared/sql.js   SQL tokenizer/splitter/CREATE TABLE parser (shared by server and browser)
public/js/main.js         routing, sidebar, tabs
public/js/views/*.js      one module per screen
```

## Notes and limitations

- Database work runs in a separate process, so the interface stays responsive during a long query. Operations for
  one workspace still run one at a time.
- The SQL tab shows up to the chosen number of rows per result (default 1,000). Use "All rows (CSV)" to download everything.
- A table rebuild recreates the table's indexes and triggers. If one of them refers to a removed or renamed
  column, it is skipped and you get a warning. Views that refer to renamed columns must be updated by hand.
