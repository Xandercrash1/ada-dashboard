'use strict';

/**
 * todo-store.js — storage layer shared by src/server.js and src/todo-cli.js.
 *
 * Contract §2 (storage), §5 (CLI concurrency): `data/todo_tasks.json` and
 * `data/todo_completed.json`, same conventions as tasks.json/feedback.json
 * (excluded from deploy.sh's rsync via its blanket `--exclude 'data/'`, so
 * a deploy can never clobber these).
 *
 * Both the CLI and the HTTP server require this module rather than each
 * implementing their own read/write, so there is exactly one atomic-write
 * implementation and one lock implementation — never a second, laxer one.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const TASKS_FILE = path.join(DATA_DIR, 'todo_tasks.json');
const COMPLETED_FILE = path.join(DATA_DIR, 'todo_completed.json');
const LOCK_FILE = path.join(DATA_DIR, '.todo.lock');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Same "throw on corruption, never swallow-and-[]" contract as server.js's
// readJsonStoreOrThrow (added there 2026-08-26 after a swallow-and-`[]`
// pattern destroyed chat sessions) — a missing file is normal (first run),
// a file that exists but fails to parse is data corruption and must not be
// silently overwritten with an empty array.
function readJsonStoreOrThrow(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Refusing to load "${filePath}" — it exists but is not valid JSON (${parseErr.message}). Not overwriting it.`);
  }
}

// Atomic write: write to a temp file in the SAME directory, then rename.
// rename() on the same filesystem is atomic, so a reader never observes a
// half-written file (contract §5's core requirement).
function atomicWriteJson(filePath, data) {
  ensureDataDir();
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// --- Cross-process mutex around read-modify-write mutations --------------
// Atomic rename alone prevents a TORN write, but not a LOST UPDATE: if the
// CLI and the server both read, both mutate, and both write, the second
// write silently discards the first's change — "a lost update here is a
// lost task" (contract §5). The Python engine closed this with an
// exclusive flock; Node has no equivalent built in, so this is a simple
// create-exclusive lockfile with a bounded wait and stale-lock reclaim.
// Every store mutation (create/update/delete/complete/rollForward-persist)
// in both server.js and todo-cli.js goes through withLock().
const LOCK_STALE_MS = 5000;   // a lock this old is presumed abandoned (crashed holder)
const LOCK_RETRY_MS = 15;
const LOCK_MAX_WAIT_MS = 3000;

function sleepMs(ms) {
  // Synchronous, non-spinning sleep — blocks this process's thread without
  // burning CPU in a busy loop. Deliberate: these are fast local JSON I/O
  // ops, so worst-case contention is milliseconds, and there is no async
  // mutex primitive available across two separate Node processes (CLI vs
  // server) without adding a dependency.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  ensureDataDir();
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE); // reclaim a lock left by a process that crashed without cleanup
          continue;
        }
      } catch (_) {
        // Lock vanished between the failed open and this stat — fine, loop and retry the open.
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error('Timed out waiting for the todo store lock — another process may be stuck holding it.');
      }
      sleepMs(LOCK_RETRY_MS);
    }
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (_) {
    // already gone — fine
  }
}

function withLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function readTasks() {
  return readJsonStoreOrThrow(TASKS_FILE);
}
function writeTasks(tasks) {
  atomicWriteJson(TASKS_FILE, tasks);
}
function readCompleted() {
  return readJsonStoreOrThrow(COMPLETED_FILE);
}
function writeCompleted(items) {
  atomicWriteJson(COMPLETED_FILE, items);
}

module.exports = {
  DATA_DIR,
  TASKS_FILE,
  COMPLETED_FILE,
  readTasks,
  writeTasks,
  readCompleted,
  writeCompleted,
  withLock,
  atomicWriteJson,
  readJsonStoreOrThrow
};
