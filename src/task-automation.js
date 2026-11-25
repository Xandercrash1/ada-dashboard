/*
 * task-automation.js — the ONE place tasks change automatically (Alex, 2026-11-24; contract in docs/TASK-AUTOMATION.md).
 *
 *   completeLocked(tasks, task, opts)  the only completion path. The Tasks route, the CLI and page buttons all use it.
 *   register(rule, { onComplete })     a rule reacts to completions (e.g. subcard-autopay in subscriptions.js).
 *   upsertAutoTask(...)                "one open task per autoKind+autoKey, kept up to date" (never duplicated).
 *   resolveAuto(...)                   a rule closes its own task when its condition is met (through completeLocked).
 *   task.then = { name, project, dueInDays, notes }   a code-free "when this is done, create that".
 *
 * Every function here must run INSIDE todoStore.withLock(), which is a cross-process lockfile, so the server and
 * the CLI never collide. Durability is an outbox queue (data/automation-queue.json):
 *   1. the job is written to the queue BEFORE the completion is saved (a crash can't lose it);
 *   2. it then runs straight away, inline, so pages see the result in the same request;
 *   3. if a rule throws, the job stays queued and the server's worker retries it with backoff; after MAX_ATTEMPTS
 *      it moves to the dead-letter list (data/automation-dead.json) and onDeadLetter files one ticket.
 * No loops: each job has a key (rule + task id [+ date for repeating tasks]) that can't be queued twice, and a chain
 * depth: an automation that completes or creates a task that triggers more automation goes one level deeper,
 * capped at MAX_DEPTH (past it the job is dead-lettered with the reason). Rules must be safe to run twice.
 * Every run is logged (data/automation-log.json, last 1000) and every automatic completion carries its source.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ATTEMPTS = 5;
const MAX_DEPTH = 3;
const BACKOFF_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3];   // after failures 1-4; the 5th is final. The worker ticks once a minute.
const rules = new Map();

function create({ store, engine, sharing = null, dataDir = store.DATA_DIR, clock = () => new Date(), onDeadLetter = null }) {
  const file = (n) => path.join(dataDir, n);
  // A broken automation file must never block a completion: it is set aside (kept, renamed) and started fresh.
  const read = (n, dflt) => {
    let raw;
    try { raw = fs.readFileSync(file(n), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return dflt; throw e; }
    try { return JSON.parse(raw); } catch (e) {
      const aside = `${file(n)}.corrupt-${Date.now()}`;
      try { fs.renameSync(file(n), aside); } catch (_) { /* already moved */ }
      console.error(`[automation] ${n} was unreadable; kept as ${path.basename(aside)} and started fresh`);
      return dflt;
    }
  };
  const write = (n, v) => { const f = file(n), tmp = `${f}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); };
  const now = () => clock().toISOString();
  const isAuto = (source) => String(source || '').startsWith('automation:');
  const log = (e) => write('automation-log.json', read('automation-log.json', []).concat({ at: now(), ...e }).slice(-1000));

  function enqueue(jobs) {
    if (!jobs.length) return [];
    const q = read('automation-queue.json', []), done = new Set(read('automation-log.json', []).filter((l) => l.result === 'done').map((l) => l.key));
    const keys = new Set(q.map((j) => j.key)), added = [];
    for (const j of jobs) {
      if (keys.has(j.key) || done.has(j.key)) continue;   // the same job can never be queued twice
      keys.add(j.key);
      const job = { id: 'job-' + crypto.randomBytes(5).toString('hex'), attempts: 0, nextAt: now(), createdAt: now(), ...j };
      q.push(job); added.push(job);
    }
    write('automation-queue.json', q);
    return added;
  }
  function jobsFor(task, { source, depth }) {
    const stamp = task.type === 'recurring' ? `:${engine.todayString(clock())}` : '';
    const out = [...rules.keys()].map((rule) => ({ key: `${rule}:${task.id}${stamp}`, rule, task, source, depth }));
    // Only automation counts toward the loop cap: a person ticking off a chain by hand never hits it.
    if (task.then && task.type !== 'recurring') out.push({ key: `then:${task.id}`, rule: 'then', task, source, depth: isAuto(source) ? depth + 1 : 0 });
    return out;
  }

  // Run one job against the live store. Returns true when it is finished (done or dead).
  function runJob(job) {
    const q = () => read('automation-queue.json', []);
    const drop = () => write('automation-queue.json', q().filter((j) => j.id !== job.id));
    if (job.depth > MAX_DEPTH) return dead(job, `chain deeper than ${MAX_DEPTH}: an automation kept triggering more automation`);
    const rule = job.rule === 'then' ? { onComplete: thenRule } : rules.get(job.rule);
    if (!rule) return dead(job, `no rule called "${job.rule}" is registered`);
    // Only act on completions that really happened (the queue is written before the completion is saved).
    const saved = job.task.type === 'recurring'
      ? store.readTasks().some((t) => t.id === job.task.id && t.lastCompleted === job.key.split(':').pop())
      : !store.readTasks().some((t) => t.id === job.task.id);
    if (!saved) {
      if (Date.parse(job.createdAt) < Date.parse(now()) - 60e3) { drop(); log({ key: job.key, rule: job.rule, taskId: job.task.id, result: 'dropped', why: 'the completion was never saved' }); return true; }
      return false;
    }
    try {
      const before = store.readTasks();
      const after = rule.onComplete(job.task, before, { source: `automation:${job.rule}`, origin: job.source, depth: job.depth, upsertAutoTask, today: engine.todayString(clock()), now: clock() });
      if (Array.isArray(after) && after !== before) store.writeTasks(after);
      drop();
      log({ key: job.key, rule: job.rule, taskId: job.task.id, result: 'done', attempts: job.attempts + 1, source: job.source });
      return true;
    } catch (e) {
      const attempts = job.attempts + 1, msg = String(e && e.message || e).slice(0, 300);
      if (attempts >= MAX_ATTEMPTS) return dead({ ...job, attempts }, msg);
      write('automation-queue.json', q().map((j) => (j.id === job.id ? { ...j, attempts, lastError: msg, nextAt: new Date(Date.parse(now()) + BACKOFF_MS[attempts - 1]).toISOString() } : j)));
      log({ key: job.key, rule: job.rule, taskId: job.task.id, result: 'retry', attempts, error: msg });
      return false;
    }
  }
  // One ticket per dead job. The CLI has no ticket hook, so the server's worker files any it left (ticketed: false).
  function ticketDead() {
    if (!onDeadLetter) return;
    const list = read('automation-dead.json', []);
    let changed = false;
    for (const d of list.filter((x) => !x.ticketed)) { try { onDeadLetter(d, d.why); d.ticketed = true; changed = true; } catch (e) { /* tried again next tick */ } }
    if (changed) write('automation-dead.json', list);
  }
  function dead(job, why) {
    write('automation-queue.json', read('automation-queue.json', []).filter((j) => j.id !== job.id));
    write('automation-dead.json', read('automation-dead.json', []).concat({ ...job, why, deadAt: now() }).slice(-200));
    log({ key: job.key, rule: job.rule, taskId: job.task && job.task.id, result: 'dead', attempts: job.attempts, error: why });
    ticketDead();
    return true;
  }

  // "when this is done, create that" (task.then), with no code.
  function thenRule(task, tasks, ctx) {
    const t = task.then || {};
    if (!t.name) throw new Error('then.name is missing');
    const due = new Date(ctx.today + 'T00:00:00Z'); due.setUTCDate(due.getUTCDate() + (Number(t.dueInDays) || 0));
    return upsertAutoTask(tasks, 'then', task.id, { type: 'scheduled', name: String(t.name).slice(0, 200), project: t.project || task.project, dueDate: due.toISOString().slice(0, 10), notes: t.notes || `Created when "${task.name}" was checked off.`, then: t.then, autoDepth: ctx.depth }, ctx);
  }

  /*
   * The one completion path. Call inside store.withLock(). Writes the store itself.
   * -> { status, body }   body is the same shape the Tasks route has always returned:
   *    repeating tasks: the updated task; others: { success: true, completedEntry }
   */
  function completeLocked(tasks, task, { source = 'user', depth } = {}) {
    depth = isAuto(source) ? (depth != null ? depth : task.autoDepth || 0) : 0;
    let body;
    if (task.type === 'recurring') {
      const today = engine.todayString(clock());
      const nextDue = engine.calcNextDue(task.frequency, today);
      if (nextDue === null) return { status: 400, body: { error: `Cannot complete "${task.name}": frequency "${task.frequency}" is unparseable, so no next due date could be computed.` } };
      const jobs = enqueue(jobsFor(task, { source, depth }));
      const updated = { ...task, lastCompleted: today, nextDue, updatedAt: now() };   // dueTime untouched (spread)
      store.writeTasks(tasks.map((t) => (t.id === task.id ? updated : t)));   // repeating completions are NOT logged to history (spec §5.3/§5.4)
      body = updated;
      jobs.forEach(runJob);
      return { status: 200, body };
    }
    const jobs = enqueue(jobsFor(task, { source, depth }));
    // History BEFORE removal: the order is load-bearing (contract §4).
    const completed = store.readCompleted();
    const entry = { id: `completed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, taskId: task.id, name: task.name, project: task.project, type: task.type,
      completedAt: now(), notes: task.notes || '', tags: [], ...(sharing ? sharing.view(task) : {}), ...(source !== 'user' ? { source } : {}), ...(task.autoKind ? { autoKind: task.autoKind } : {}) };
    completed.unshift(entry);
    store.writeCompleted(completed);
    store.writeTasks(tasks.filter((t) => t.id !== task.id));   // id-targeted (§1.1): only this row, even with duplicate names
    jobs.forEach(runJob);
    return { status: 200, body: { success: true, completedEntry: entry } };
  }

  // A rule's condition owner closing its task when the condition is met. Call inside store.withLock(), from a route or
  // the worker — NOT from inside a rule's onComplete (it writes the store, and the rule's own write would undo it).
  function resolveAuto(autoKind, autoKey, { rule = autoKind, depth = 0 } = {}) {
    const tasks = store.readTasks();
    const t = tasks.find((x) => x.autoKind === autoKind && (autoKey == null || x.autoKey === autoKey));
    if (!t) return null;
    return completeLocked(tasks, t, { source: `automation:${rule}`, depth: depth + 1 });
  }

  // The worker: retries what failed inline (and anything left by a crash or restart). Call inside store.withLock().
  function drain() {
    const due = read('automation-queue.json', []).filter((j) => j.nextAt <= now());
    let ran = 0;
    for (const j of due) { runJob(j); ran++; }
    ticketDead();
    return ran;
  }
  const status = () => ({ queue: read('automation-queue.json', []), dead: read('automation-dead.json', []), log: read('automation-log.json', []).slice(-50).reverse(), rules: [...rules.keys()] });

  return { completeLocked, resolveAuto, drain, status, enqueue };
}

/*
 * One open task per autoKind (+ autoKey). Pure: returns a new tasks array.
 * Updates the open one in place (same id) or adds a new one; marks it so the Tasks tab shows "auto".
 */
function upsertAutoTask(tasks, autoKind, autoKey, fields, ctx = {}) {
  const nowIso = (ctx.now || new Date()).toISOString();
  const i = tasks.findIndex((t) => t.autoKind === autoKind && (autoKey == null ? t.autoKey == null : t.autoKey === autoKey));
  if (i !== -1) return tasks.map((t, j) => (j === i ? { ...t, ...fields, autoKind, ...(autoKey != null ? { autoKey } : {}), updatedAt: nowIso } : t));
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return tasks.concat({ id, type: 'scheduled', ...fields, autoKind, ...(autoKey != null ? { autoKey } : {}), source: ctx.source || 'automation', createdAt: nowIso, updatedAt: nowIso });
}

function register(rule, def) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(rule) || rule === 'then') throw new Error(`bad rule name: ${rule}`);
  if (!def || typeof def.onComplete !== 'function') throw new Error(`rule ${rule} needs onComplete(task, tasks, ctx)`);
  rules.set(rule, def);
}

module.exports = { create, register, upsertAutoTask, rules, MAX_ATTEMPTS, MAX_DEPTH, BACKOFF_MS };
