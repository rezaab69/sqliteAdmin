# Graph Report - sqlite  (2026-09-23)

## Corpus Check
- 35 files · ~56,627 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 3, .css 1)

## Summary
- 580 nodes · 2110 edges · 16 communities (14 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.84)
- Token cost: 120,376 input · 7,500 output

## Community Hubs (Navigation)
- Frontend App Shell & API Client
- Server API & SQL Utilities
- Data Browser & Result Grid
- Database Manager & HTTP Server
- Workers, Mailer & Entry Point
- Schema Designer & Structure Views
- README Features & Security Docs
- Account Store
- Worker Pool
- SQL Editor Component
- Package Manifest
- ER Diagram Renderer
- Favicon Branding
- Session & Credential Security
- Loopback Binding Default

## God Nodes (most connected - your core abstractions)
1. `h()` - 113 edges
2. `icon()` - 65 edges
3. `$$` - 64 edges
4. `toast()` - 58 edges
5. `api()` - 52 edges
6. `renderBrowse()` - 48 edges
7. `renderSql()` - 38 edges
8. `createApp()` - 36 edges
9. `go()` - 34 edges
10. `errorBox()` - 32 edges

## Surprising Connections (you probably didn't know these)
- `start()` --calls--> `createApp()`  [EXTRACTED]
  test/server.test.js → lib/server.js
- `buildOrder()` --calls--> `qi()`  [EXTRACTED]
  lib/api.js → public/js/shared/sql.js
- `index.html SPA shell` --conceptually_related_to--> `Strict Content-Security-Policy / no HTML insertion`  [INFERRED]
  public/index.html → README.md
- `objectInfo()` --calls--> `fail()`  [EXTRACTED]
  lib/api.js → lib/util.js
- `keyInfo()` --calls--> `qi()`  [EXTRACTED]
  lib/api.js → public/js/shared/sql.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Public-mode containment of untrusted SQL** — readme_child_process_isolation, readme_query_timeout, readme_sql_file_access_blocking, readme_storage_quotas, readme_rate_limiting [EXTRACTED 1.00]
- **Default web security lockdown** — readme_loopback_default, readme_csrf_custom_header, readme_dns_rebinding_protection, readme_database_name_validation, readme_session_cookies, readme_content_security_policy [EXTRACTED 1.00]
- **Account authentication flow** — readme_user_accounts, readme_smtp_mailer, readme_google_oauth_pkce, readme_public_url, readme_hashed_tokens, readme_account_enumeration_protection [INFERRED 0.85]

## Communities (16 total, 2 thin omitted)

### Community 0 - "Frontend App Shell & API Client"
Cohesion: 0.09
Nodes (90): api(), apiDownload(), ApiError, apiUpload(), failure(), HEADERS, onAuthRequired(), currentUser() (+82 more)

### Community 1 - "Server API & SQL Utilities"
Cohesion: 0.05
Nodes (65): RFC-4180, buildOrder(), buildWhere(), clampInt(), coerce(), columnsOf(), contentDisposition(), createApi() (+57 more)

### Community 2 - "Data Browser & Result Grid"
Cohesion: 0.08
Nodes (77): apiBlob(), addHistory(), browseHref(), clearHistory(), deleteSaved(), getHistory(), getSaved(), href() (+69 more)

### Community 3 - "Database Manager & HTTP Server"
Cohesion: 0.06
Nodes (43): BLOCKED_PRAGMAS, DB_EXTENSIONS, DbManager, hasDbExtension(), mb(), moveFile(), readDir(), SIDE_FILES (+35 more)

### Community 4 - "Workers, Mailer & Entry Point"
Cohesion: 0.05
Nodes (41): address(), b64(), buildMessage(), connect(), createMailer(), replyReader(), smtpSend(), startTls() (+33 more)

### Community 5 - "Schema Designer & Structure Views"
Cohesion: 0.19
Nodes (39): confirmRun(), execSql(), go(), isReadOnly(), schemaChanged(), card(), codeBlock(), confirmDialog() (+31 more)

### Community 6 - "README Features & Security Docs"
Cohesion: 0.07
Nodes (38): index.html SPA shell, #root mount element with loading spinner, theme.js early (non-module) theme script, Account enumeration protection, Per-workspace child process isolation, Strict Content-Security-Policy / no HTML insertion, Data directory layout (app.db, workspaces, users, tmp), Database management features (+30 more)

### Community 7 - "Account Store"
Cohesion: 0.11
Nodes (8): AccountStore, checkPassword(), hashPassword(), normalizeEmail(), now(), scrypt, sha256(), validatePassword()

### Community 8 - "Worker Pool"
Cohesion: 0.25
Nodes (5): WORKER, WorkerPool, HttpError, ref_node_child_process, ref_node_url

### Community 9 - "SQL Editor Component"
Cohesion: 0.22
Nodes (18): createSqlEditor(), acceptAc(), candidates(), closeAc(), currentLines(), indentSelection(), insertText(), openAc() (+10 more)

### Community 10 - "Package Manifest"
Cohesion: 0.14
Nodes (13): bin, sqlite-admin, description, engines, node, license, main, name (+5 more)

### Community 11 - "ER Diagram Renderer"
Cohesion: 0.39
Nodes (7): store, autoLayout(), clip(), renderDiagram(), drawLinks(), place(), svg()

### Community 12 - "Favicon Branding"
Cohesion: 0.67
Nodes (3): Brand Blue #2563eb, Database Cylinder Glyph, App Favicon (Database Icon)

### Community 13 - "Session & Credential Security"
Cohesion: 0.67
Nodes (3): CSRF protection via custom API header, scrypt passwords and SHA-256 hashed tokens, HttpOnly SameSite=Strict session cookies

## Knowledge Gaps
- **71 isolated node(s):** `DML`, `DDL`, `FILTER_OPS`, `PRAGMAS`, `DB_EXTENSIONS` (+66 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 112 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `$$` connect `Server API & SQL Utilities` to `Frontend App Shell & API Client`, `Data Browser & Result Grid`, `ER Diagram Renderer`, `Schema Designer & Structure Views`?**
  _High betweenness centrality (0.327) - this node is a cross-community bridge._
- **Why does `fail()` connect `Database Manager & HTTP Server` to `Worker Pool`, `Server API & SQL Utilities`, `Account Store`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Why does `h()` connect `Frontend App Shell & API Client` to `Server API & SQL Utilities`, `Data Browser & Result Grid`, `Schema Designer & Structure Views`, `SQL Editor Component`, `ER Diagram Renderer`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **What connects `DML`, `DDL`, `FILTER_OPS` to the rest of the system?**
  _71 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Frontend App Shell & API Client` be split into smaller, more focused modules?**
  _Cohesion score 0.09067957079739113 - nodes in this community are weakly interconnected._
- **Should `Server API & SQL Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.054746835443037975 - nodes in this community are weakly interconnected._
- **Should `Data Browser & Result Grid` be split into smaller, more focused modules?**
  _Cohesion score 0.08449367088607596 - nodes in this community are weakly interconnected._