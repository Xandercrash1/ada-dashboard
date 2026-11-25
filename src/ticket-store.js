/*
 * ticket-store.js — the ONE write path for dashboard tickets (data/feedback.json). Task automation phase 2
 * (Alex, 2026-11-24; docs/TASK-AUTOMATION.md § Tickets).
 *
 *   withLock(fn)                 cross-process lockfile (data/.feedback.lock), same design as todo-store's.
 *   mutate(fn)                   locked read-modify-write: fn(items) changes items in place or returns a new array.
 *   create(fields)               a new ticket, or, when fields.dedupeKey matches an existing one, that ticket again:
 *                                  open   -> updated (repeats + 1, lastSeenAt), never a second ticket
 *                                  closed -> reopened (status new, a dated note, its old task link cleared)
 *   update(id, patch)            status / processedBy / notes / needsAlex, with the same rules as before.
 *   resolve(dedupeKey, opts)     the owner of a condition closes its open ticket when the condition clears.
 *   remove(id)
 *
 * Lock order, everywhere: the todo lock first, then this one, never the other way. Nothing here takes the todo lock.
 * Every writer goes through here: the HTTP routes, the agent tool, the bug crawler, the deploy auto-close, the
 * dead-letter hook, the task <-> ticket sync. Sessions edit tickets through the API, never the JSON file.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TYPES = ['bug', 'improvement', 'feature', 'chore', 'idea'];
const STATUSES = ['new', 'in-progress', 'done', 'wont-do'];
// Self-improvement loop (Projects/Auto Ticket Processing/Plan — Self-Improvement Loop.md): where a ticket is in the loop.
//   proposed -> approved | declined   (Alex, on the Home Proposals card)
//   building -> ready (a tested change waits for Alex's deploy tick) -> deploying -> deployed
//   failed (build failed; twice -> flagged to Alex)   pm (too big for the nightly builder: the VPS PM does it with Alex)
const STAGES = ['proposed', 'approved', 'declined', 'building', 'ready', 'deploying', 'deployed', 'failed', 'pm'];
const KINDS = ['approval', 'decision', 'hands'];
const isClosed = (t) => t.status === 'done' || t.status === 'wont-do';

const instances = new Map();   // one store (and one re-entrancy count) per data dir per process
function open(dataDir) {
  const key = path.resolve(dataDir);
  if (!instances.has(key)) instances.set(key, build(key));
  return instances.get(key);
}
function build(dataDir) {
  const FILE = path.join(dataDir, 'feedback.json');
  const LOCK = path.join(dataDir, '.feedback.lock');
  const STALE_MS = 5000, RETRY_MS = 15, MAX_WAIT_MS = 3000;
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let held = 0;   // re-entrant within one process, so a helper called inside mutate() can't deadlock on itself

  function acquire() {
    const start = Date.now();
    for (;;) {
      try { const fd = fs.openSync(LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) { fs.unlinkSync(LOCK); continue; } } catch (_) { /* gone; retry */ }
        if (Date.now() - start > MAX_WAIT_MS) throw new Error('Timed out waiting for the ticket store lock; another process may be stuck holding it.');
        sleep(RETRY_MS);
      }
    }
  }
  function withLock(fn) {
    if (held) { held++; try { return fn(); } finally { held--; } }
    acquire(); held = 1;
    try { return fn(); } finally { held = 0; try { fs.unlinkSync(LOCK); } catch (_) { /* already gone */ } }
  }
  // Missing file = no tickets yet; a file that won't parse is corruption and is never overwritten.
  function read() {
    let raw;
    try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    try { return JSON.parse(raw); } catch (e) { throw new Error(`Refusing to load "${FILE}": it is not valid JSON (${e.message}). Not overwriting it.`); }
  }
  function write(items) {
    const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2)); fs.renameSync(tmp, FILE);
  }
  function mutate(fn) {
    return withLock(() => {
      const items = read();
      const before = JSON.stringify(items);
      const out = fn(items);
      const next = Array.isArray(out) ? out : items;
      if (JSON.stringify(next) !== before) write(next);
      return out;
    });
  }
  const clearLinks = (t) => { delete t.taskId; delete t.stagedAt; delete t.sessionId; delete t.stage; delete t.buildAttempts; delete t.laterUntil; };   // a fresh round in the loop too
  const note = (t, line) => { t.notes = t.notes ? `${t.notes}\n${line}` : line; };
  const newId = (items) => { let id = `fb-${Date.now()}`; while (items.some((i) => i.id === id)) id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; return id; };

  function applyUpdate(item, patch, nowIso = new Date().toISOString()) {
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) return { error: `Invalid status "${patch.status}". Must be one of: ${STATUSES.join(', ')}` };
      // processedAt is set the first time status leaves 'new' and kept after that (contract §2). A reopened ticket
      // gets a fresh one, so the 24-hour archive and 30-day purge count from the latest close.
      if (item.status === 'new' && patch.status !== 'new' && !item.processedAt) item.processedAt = nowIso;
      if (isClosed(patch) && !isClosed(item)) item.processedAt = nowIso;
      if (!isClosed(patch) && isClosed(item)) clearLinks(item);   // reopened by hand: the old task, stage and session are history
      item.status = patch.status;
    }
    if (patch.stage !== undefined) {
      if (patch.stage !== null && !STAGES.includes(patch.stage)) return { error: `Invalid stage "${patch.stage}". Must be one of: ${STAGES.join(', ')}` };
      if (patch.stage === null) delete item.stage; else item.stage = patch.stage;
    }
    if (patch.device !== undefined) {   // the one device it needs; '' or null = the VPS or Alex's phone (2026-11-25)
      if (patch.device && !DEVICES.includes(patch.device)) return { error: `Invalid device "${patch.device}". Must be one of: ${DEVICES.join(', ')}` };
      if (patch.device) item.device = patch.device; else delete item.device;
    }
    if (patch.laterUntil !== undefined) { if (patch.laterUntil) item.laterUntil = String(patch.laterUntil); else delete item.laterUntil; }
    if (patch.buildAttempts !== undefined) item.buildAttempts = Math.max(0, Number(patch.buildAttempts) || 0);
    if (patch.processedBy !== undefined) item.processedBy = patch.processedBy;
    if (patch.notes !== undefined) item.notes = patch.notes;
    if (patch.needsAlex !== undefined) {
      if (patch.needsAlex && !item.needsAlex) delete item.taskId;   // flagged again: a fresh task, not the old finished one
      item.needsAlex = !!patch.needsAlex;
    }
    item.updatedAt = nowIso;
    return { item };
  }

  function create(f) {
    if (!TYPES.includes(f.type)) return { error: `Invalid type "${f.type}". Must be one of: ${TYPES.join(', ')}` };
    const title = String(f.title || '').trim();
    if (!title) return { error: 'title is required and must be non-empty.' };
    const key = f.dedupeKey ? String(f.dedupeKey).slice(0, 120) : null;
    return mutate((items) => {
      const now = new Date().toISOString();
      const same = key ? items.find((i) => i.dedupeKey === key) : null;
      if (same && !isClosed(same)) {
        same.repeats = (same.repeats || 1) + 1; same.lastSeenAt = now; same.updatedAt = now;
        if (f.body && f.body !== same.body) note(same, `[auto] Seen again ${now}: ${String(f.body).slice(0, 300)}`);
        if (f.needsAlex && !same.needsAlex) { delete same.taskId; same.needsAlex = true; }
        return { item: same, outcome: 'updated' };
      }
      if (same && same.status === 'wont-do') {   // Alex decided against it: counted and noted, never reopened
        same.repeats = (same.repeats || 1) + 1; same.lastSeenAt = now; same.updatedAt = now;
        note(same, `[auto] Seen again ${now} (left as wont-do)${f.body && f.body !== same.body ? ': ' + String(f.body).slice(0, 300) : ''}.`);
        return { item: same, outcome: 'updated' };
      }
      if (same) {
        note(same, `[auto] Came back ${now}; reopened (it was done)${f.body && f.body !== same.body ? ': ' + String(f.body).slice(0, 300) : ''}.`);
        same.status = 'new'; same.repeats = (same.repeats || 1) + 1; same.lastSeenAt = now; same.updatedAt = now;
        if (f.needsAlex !== undefined) same.needsAlex = !!f.needsAlex;
        clearLinks(same);
        if (STAGES.includes(f.stage)) same.stage = f.stage;   // a re-raised proposal goes back on the card   // the old task, stage and session belonged to the last round; the sync makes a new task if needed
        return { item: same, outcome: 'reopened' };
      }
      const item = { id: newId(items), type: f.type, title, body: typeof f.body === 'string' ? f.body : '', status: 'new',
        createdAt: now, updatedAt: now, processedAt: null, processedBy: f.processedBy || null, notes: f.notes || null,
        ...(STAGES.includes(f.stage) ? { stage: f.stage } : {}), ...(KINDS.includes(f.kind) ? { kind: f.kind } : {}), ...(f.source ? { source: String(f.source).slice(0, 40) } : {}),
        ...(f.urgency ? { urgency: f.urgency } : {}), ...(key ? { dedupeKey: key } : {}), ...(f.needsAlex ? { needsAlex: true } : {}),
        ...(DEVICES.includes(f.device) ? { device: f.device } : {}) };
      items.unshift(item);
      return { item, outcome: 'created' };
    });
  }

  function update(id, patch) {
    return mutate((items) => {
      const item = items.find((i) => i.id === id);
      if (!item) return { error: `No feedback item with id ${id}`, notFound: true };
      return applyUpdate(item, patch);
    });
  }

  function resolve(dedupeKey, { note: why = 'the condition cleared', by = 'automation' } = {}) {
    return mutate((items) => {
      const item = items.find((i) => i.dedupeKey === dedupeKey && !isClosed(i));
      if (!item) return { item: null };
      note(item, `[auto] Closed ${new Date().toISOString()}: ${why}.`);
      applyUpdate(item, { status: 'done', processedBy: item.processedBy || by });
      return { item };
    });
  }

  function remove(id) {
    return mutate((items) => {
      const kept = items.filter((i) => i.id !== id);
      return kept.length === items.length ? { error: `No feedback item with id ${id}`, notFound: true } : kept;
    });
  }

  const exists = () => fs.existsSync(FILE);
  return { FILE, LOCK, exists, read, withLock, mutate, create, update, resolve, remove, applyUpdate, isClosed };
}

const { DEVICES } = require('./item-devices');
module.exports = { open, DEVICES, TYPES, STATUSES, STAGES, KINDS, isClosed };
