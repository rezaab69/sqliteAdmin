// Child process that owns one workspace's database connections (started by pool.js). The HTTP server sends
// it one API call at a time and kills it when a call runs too long, which is the only way to stop a runaway
// SQLite query.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DbManager } from './dbmanager.js';
import { stopForMemory } from './watchdog.js';
import { createApi } from './api.js';
import { createSampleDatabase } from './sample.js';
import { HttpError, scratchDir } from './util.js';

/**
 * Stands in for http.ServerResponse in raw handlers. The body is written to a temporary file, which the
 * main thread streams to the client. This keeps slow clients from holding the worker, and a failure halfway
 * through can still be reported as a proper error.
 */
class FileResponse {
  constructor(dir, limit) {
    this.dir = dir;
    this.limit = limit;
    this.status = 200;
    this.headers = {};
    this.headersSent = false;
    this.file = null;
    this.remove = true;
    this.fd = null;
    this.bytes = 0;
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    if (!this.headersSent) this.writeHead(200);
    if (this.fd === null) {
      this.file = path.join(this.dir, `response-${crypto.randomBytes(6).toString('hex')}`);
      this.fd = fs.openSync(this.file, 'w');
    }
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.bytes += buf.length;
    if (this.limit && this.bytes > this.limit) {
      throw new HttpError(413, `The download is larger than this server's ${Math.round(this.limit / 1048576)} MB limit. Export fewer rows or tables.`);
    }
    for (let off = 0; off < buf.length;) off += fs.writeSync(this.fd, buf, off);
    return true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null && chunk.length) this.write(chunk);
    else if (!this.headersSent) this.writeHead(200);
    this.close();
  }

  /** Send an existing file as the body. */
  sendFile(file, { remove = false } = {}) {
    if (!this.headersSent) this.writeHead(200);
    this.discard();
    this.file = file;
    this.remove = remove;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  discard() {
    this.close();
    if (this.file && this.remove) fs.rmSync(this.file, { force: true });
    this.file = null;
  }
}

const config = JSON.parse(process.env.SQLITE_ADMIN_WORKER);
// Exit with the server.
process.on('disconnect', () => process.exit(0));

// Memory limit: see watchdog.js. `running` holds the id of the call in progress (0 = none) for the watchdog.
const memoryLimit = Number(process.env.SQLITE_ADMIN_MEMORY_LIMIT) || 0;
const running = new Int32Array(new SharedArrayBuffer(4));
if (memoryLimit) {
  new Worker(new URL('./watchdog.js', import.meta.url), {
    workerData: { limit: memoryLimit, running }, resourceLimits: { maxOldGenerationSizeMb: 16 },
  }).unref();
}
// A safety net only, on Linux: if the machine itself runs out of memory, ask the kernel to stop a workspace
// process rather than the server. Not guaranteed, and not available everywhere (e.g. a read-only /proc).
if (process.platform === 'linux') {
  try { fs.writeFileSync('/proc/self/oom_score_adj', '1000'); } catch { /* not permitted: keep going */ }
}

if (config.sampleIn && !fs.existsSync(config.sampleIn)) {
  fs.mkdirSync(config.sampleIn, { recursive: true });
  createSampleDatabase(path.join(config.sampleIn, 'sample.db'));
}
// Temporary files go in a directory of this process's own, which the server deletes when the process ends,
// however it ends (see pool.js), so a process stopped halfway through a call leaves nothing behind.
const mgr = new DbManager({ ...config.manager, tmpDir: config.manager.tmpDir && scratchDir(config.manager.tmpDir, process.pid) });
const api = createApi(mgr);

function errorStatus(e) {
  if (e.status) return e.status;
  return e.code === 'ERR_SQLITE_ERROR' || e instanceof SyntaxError ? 400 : 500;
}

process.on('message', async (msg) => {
  const { id, kind, name } = msg;
  // Already over the limit before starting, e.g. memory still held after the previous call: stop without
  // running this call, which the server then runs on a fresh process instead of blaming it.
  if (memoryLimit && process.memoryUsage.rss() > memoryLimit) stopForMemory(0);
  Atomics.store(running, 0, id);
  // The call counts as running until its reply has been handed to the OS: if the process is stopped before
  // then, the server blames this call and does not run it again.
  const reply = (m) => process.send(m, () => Atomics.compareExchange(running, 0, id, 0));
  let res = null;
  try {
    const handlers = kind === 'raw' ? api.raw : api.json;
    if (!Object.hasOwn(handlers, name)) throw new HttpError(404, `Unknown API method: ${name}`);
    let result;
    if (kind === 'raw') {
      res = new FileResponse(mgr.tmpDir, config.maxResponseBytes);
      result = await handlers[name]({ body: msg.body || {}, text: msg.text, file: msg.file, query: new URLSearchParams(msg.query || ''), res });
      res.close();
    } else {
      result = await handlers[name](msg.body || {});
    }
    if (res && res.headersSent) {
      reply({ id, response: { status: res.status, headers: res.headers, file: res.file, remove: res.remove } });
    } else {
      reply({ id, result: result ?? { ok: true } });
    }
  } catch (e) {
    if (res) res.discard();
    const status = errorStatus(e);
    reply({ id, error: { message: mgr.errorMessage(e), status, stack: status >= 500 ? e.stack : undefined } });
  }
});
