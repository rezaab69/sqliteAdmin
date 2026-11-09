// Runs each workspace's database work in its own child process (see worker.js). Calls to one workspace run
// one at a time, in order, so connections and open transactions carry over between requests. A call that
// runs past its timeout is stopped by killing the process; only that workspace is affected.
//
// These are processes rather than worker threads because a thread can only be interrupted while it runs
// JavaScript: a runaway query inside SQLite would keep running (and keep its files open) after
// worker.terminate(), and node:sqlite has no way to interrupt a statement.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from './util.js';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
// Server secrets that workers, which run untrusted SQL, have no use for.
const SECRET_ENV = ['GOOGLE_CLIENT_SECRET', 'SQLITE_ADMIN_SMTP_URL', 'SQLITE_ADMIN_PASSWORD'];

function workerEnv(config, memoryMb) {
  const env = { ...process.env, SQLITE_ADMIN_WORKER: JSON.stringify(config) };
  for (const name of SECRET_ENV) delete env[name];
  if (memoryMb) env.SQLITE_ADMIN_MEMORY_LIMIT = String(memoryMb * 1048576);
  else delete env.SQLITE_ADMIN_MEMORY_LIMIT;
  return env;
}

export class WorkerPool {
  /**
   * @param {object} o
   * @param {number} [o.max] Maximum number of live workers.
   * @param {number} [o.idleMs] Stop a worker after this long without calls.
   * @param {number} [o.memoryMb] Memory limit per worker process, SQLite's memory included (0 = none). A worker
   *   that goes over it is stopped, failing the call that was running.
   */
  constructor({ max = 16, idleMs = 10 * 60_000, memoryMb = 0 } = {}) {
    this.max = max;
    this.idleMs = idleMs;
    this.memoryMb = memoryMb;
    this.entries = new Map();
    this.timer = setInterval(() => this.reap(), Math.min(idleMs, 60_000)).unref();
  }

  /**
   * Run an API call on the worker for `key`, starting one with `config` if needed. A worker whose config
   * differs (e.g. the user just logged in) is replaced.
   */
  call(key, config, msg, { timeout = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const entry = this.entry(key, config);
      entry.queue.push({ msg, timeout, resolve, reject });
      this.pump(entry);
    });
  }

  entry(key, config) {
    const sig = JSON.stringify(config);
    let e = this.entries.get(key);
    if (e && e.sig !== sig) {
      this.kill(e, new HttpError(409, 'Your session changed while this request was running. Please try again.'));
      e = null;
    }
    if (!e) {
      if (this.entries.size >= this.max) this.evictIdle();
      const worker = fork(WORKER, [], {
        serialization: 'advanced',
        env: workerEnv(config, this.memoryMb),
        execArgv: this.memoryMb ? [`--max-old-space-size=${this.memoryMb}`] : [],
        // fd 4: the worker's memory watchdog writes there just before it stops the process (see worker.js).
        stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'],
      });
      e = { key, sig, config, worker, queue: [], current: null, seq: 0, lastUsed: Date.now(), dead: false, overMemory: false };
      e.exited = new Promise((resolve) => worker.once('exit', resolve));
      const entry = e;
      worker.stdio[4].on('data', () => { entry.overMemory = true; });
      worker.stdio[4].on('error', () => {});
      worker.on('message', (m) => this.onMessage(entry, m));
      worker.on('error', (err) => this.onCrash(entry, err));
      // 'close' rather than 'exit': it comes after everything on fd 4 has been read.
      worker.on('close', (code, signal) => this.onCrash(entry, null, code, signal));
      this.entries.set(key, e);
    }
    e.lastUsed = Date.now();
    return e;
  }

  pump(e) {
    if (e.dead || e.current || !e.queue.length) return;
    const job = e.queue.shift();
    e.current = job;
    job.id = ++e.seq;
    if (job.timeout) {
      job.timer = setTimeout(() => {
        const secs = Math.round(job.timeout / 1000);
        this.kill(e, new HttpError(504, `The operation took longer than ${secs} seconds and was stopped. Any open transaction was rolled back.`), { requeue: true });
      }, job.timeout);
    }
    e.worker.send({ ...job.msg, id: job.id });
  }

  onMessage(e, m) {
    const job = e.current;
    if (!job || m.id !== job.id) return;
    clearTimeout(job.timer);
    e.current = null;
    e.lastUsed = Date.now();
    if (m.error) job.reject(Object.assign(new HttpError(m.error.status, m.error.message), { workerStack: m.error.stack }));
    else job.resolve(m);
    this.pump(e);
  }

  onCrash(e, err, code, signal) {
    if (e.dead) return;
    if (e.overMemory) {
      const mb = this.memoryMb;
      this.kill(e, new HttpError(413, `The operation needed more than ${mb} MB of memory and was stopped. Any open transaction was rolled back.`), { requeue: true });
      return;
    }
    if (err) console.error(err);
    else console.error(`Database worker for a workspace exited (code ${code}, signal ${signal})`);
    this.kill(e, new HttpError(500, 'The database process stopped unexpectedly (it may have run out of memory). Please try again.'), { requeue: true });
  }

  /**
   * Terminate a worker. The running call fails with `err`. Queued calls either fail too or, with `requeue`,
   * run on a fresh worker (they were waiting behind the call that failed).
   */
  kill(e, err, { requeue = false } = {}) {
    if (e.dead) return Promise.resolve();
    e.dead = true;
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    if (e.current) {
      clearTimeout(e.current.timer);
      e.current.reject(err);
      e.current = null;
    }
    const queued = e.queue.splice(0);
    if (requeue && queued.length) {
      const fresh = this.entry(e.key, e.config);
      fresh.queue.push(...queued);
      this.pump(fresh);
    } else {
      for (const job of queued) job.reject(err);
    }
    if (e.worker.exitCode === null && e.worker.signalCode === null) e.worker.kill('SIGKILL');
    // Resolves once the process is gone and its database files are closed.
    return e.exited;
  }

  /** Stop the worker for `key`, if any (e.g. when its workspace is deleted). */
  stop(key) {
    const e = this.entries.get(key);
    return e ? this.kill(e, new HttpError(410, 'This workspace was closed.')) : Promise.resolve();
  }

  evictIdle() {
    let oldest = null;
    for (const e of this.entries.values()) {
      if (!e.current && !e.queue.length && (!oldest || e.lastUsed < oldest.lastUsed)) oldest = e;
    }
    if (!oldest) throw new HttpError(503, 'The server is busy. Please try again in a moment.');
    this.kill(oldest, new HttpError(410, 'This workspace was closed.'));
  }

  reap() {
    const cutoff = Date.now() - this.idleMs;
    for (const e of [...this.entries.values()]) {
      if (!e.current && !e.queue.length && e.lastUsed < cutoff) this.kill(e, new HttpError(410, 'This workspace was closed.'));
    }
  }

  close() {
    clearInterval(this.timer);
    return Promise.all([...this.entries.values()].map((e) => this.kill(e, new HttpError(503, 'The server is shutting down.'))));
  }
}
