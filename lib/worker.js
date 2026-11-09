// Child process that owns one workspace's database connections (started by pool.js). The HTTP server sends
// it one API call at a time and kills it when a call runs too long, which is the only way to stop a runaway
// SQLite query.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DbManager } from './dbmanager.js';
import { createApi } from './api.js';
import { createSampleDatabase } from './sample.js';
import { HttpError } from './util.js';

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

// Memory limit. SQLite allocates outside the JavaScript heap, and Node builds it without the memory statistics
// that PRAGMA hard_heap_limit needs, so SQLite can't be capped from inside. Instead a thread, which keeps
// running while this one is busy inside SQLite, watches the memory of the whole process and stops the process
// when it goes over the limit, after telling the server why on fd 4 (see pool.js).
const memoryLimit = Number(process.env.SQLITE_ADMIN_MEMORY_LIMIT) || 0;
if (memoryLimit) {
  new Worker(`
    const fs = require('node:fs');
    const { workerData: { limit } } = require('node:worker_threads');
    setInterval(() => {
      if (process.memoryUsage.rss() > limit) {
        try { fs.writeSync(4, 'memory'); } catch { /* the server is gone */ }
        process.kill(process.pid, 'SIGKILL');
      }
    }, 10);
  `, { eval: true, workerData: { limit: memoryLimit }, resourceLimits: { maxOldGenerationSizeMb: 16 } }).unref();
}
// If the machine itself runs out of memory, Linux should stop a workspace process rather than the server.
if (process.platform === 'linux') {
  try { fs.writeFileSync('/proc/self/oom_score_adj', '1000'); } catch { /* not permitted */ }
}

if (config.sampleIn && !fs.existsSync(config.sampleIn)) {
  fs.mkdirSync(config.sampleIn, { recursive: true });
  createSampleDatabase(path.join(config.sampleIn, 'sample.db'));
}
const mgr = new DbManager(config.manager);
const api = createApi(mgr);

function errorStatus(e) {
  if (e.status) return e.status;
  return e.code === 'ERR_SQLITE_ERROR' || e instanceof SyntaxError ? 400 : 500;
}

process.on('message', async (msg) => {
  const { id, kind, name } = msg;
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
      process.send({ id, response: { status: res.status, headers: res.headers, file: res.file, remove: res.remove } });
    } else {
      process.send({ id, result: result ?? { ok: true } });
    }
  } catch (e) {
    if (res) res.discard();
    const status = errorStatus(e);
    process.send({ id, error: { message: mgr.errorMessage(e), status, stack: status >= 500 ? e.stack : undefined } });
  }
});
