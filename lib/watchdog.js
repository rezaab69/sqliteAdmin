// Memory limit for a worker process (see worker.js and pool.js).
//
// SQLite allocates outside the JavaScript heap, and Node builds it without the memory statistics that
// PRAGMA hard_heap_limit needs, so SQLite's memory can't be capped from inside. Instead this module runs as a
// thread of the worker process: it keeps running while the main thread is busy inside SQLite, watches the
// memory of the whole process, and stops the process when it goes over the limit.
//
// Before stopping, it writes "memory:<call id>" to fd 4, a pipe that only the server reads, separate from
// the IPC channel. <call id> is the call that was running (0 = none), shared with the main thread through
// `running`, so the server can tell the call that used the memory from calls that were merely waiting.
import fs from 'node:fs';
import { isMainThread, workerData } from 'node:worker_threads';

const NOTE_FD = 4;
const INTERVAL_MS = 10;

/** Tell the server that this process is over its memory limit, then stop it at once. */
export function stopForMemory(callId) {
  const note = Buffer.from(`memory:${callId}\n`);
  let written = 0;
  // A few bytes into an empty pipe; retry the rare EAGAIN rather than lose the reason.
  for (let tries = 0; written < note.length && tries < 1000; tries++) {
    try {
      written += fs.writeSync(NOTE_FD, note, written);
    } catch (e) {
      if (e.code !== 'EAGAIN') break; // The server is gone.
    }
  }
  process.kill(process.pid, 'SIGKILL');
}

if (!isMainThread) {
  const { limit, running } = workerData;
  setInterval(() => {
    if (process.memoryUsage.rss() > limit) stopForMemory(Atomics.load(running, 0));
  }, INTERVAL_MS);
}
