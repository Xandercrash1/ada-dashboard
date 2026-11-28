'use strict';

/**
 * subscriptions.js — "switch X to the subscription card" automation.
 *
 * When a scheduled/backlog task linked to a subscription row
 * (row.switchTaskId === task.id) is completed, the row is marked onCard and a
 * single open task "Set the subscription card's autopay to $T" is created (or
 * updated in place) telling Alex what to set the card's autopay to.
 *
 * Shared by src/server.js and src/todo-cli.js so a completion from either
 * path fires the hook. processCompletion() is pure (tests use it directly);
 * onTaskCompleted() is the store-backed wrapper and must be called INSIDE
 * todoStore.withLock (the lock is not reentrant) with the tasks array that
 * the caller is about to write.
 */

const path = require('path');
const todoStore = require('./todo-store');
const todoEngine = require('./todo-engine');
const todoValidate = require('./todo-validate');

const SUBS_FILE = path.join(todoStore.DATA_DIR, 'subscriptions.json');
const AUTO_KIND = 'subcard-autopay';
const BUFFER = 10;
const MIN_PAYMENT = 30;

const money = n => Number(n).toFixed(2);

function readSubscriptions() { return todoStore.readJsonStoreOrThrow(SUBS_FILE); }
function writeSubscriptions(rows) { todoStore.atomicWriteJson(SUBS_FILE, rows); }

// Monthly subs on the card only; yearly are covered by the buffer on purpose.
function computeTotal(subs) {
  const items = subs.filter(s => s.onCard && s.cycle === 'monthly' && s.price != null && Number.isFinite(Number(s.price)));
  const total = items.reduce((sum, s) => sum + Number(s.price), 0) + BUFFER + MIN_PAYMENT;
  return { items, total: Math.round(total * 100) / 100 };
}

function buildNotes(items, total, sourceLine) {
  const lines = items.map(s => `${s.name}: $${money(s.price)}`);
  lines.push(`+ $${money(BUFFER)} buffer`);
  lines.push(`+ $${money(MIN_PAYMENT)} minimum payment`);
  lines.push(`= $${money(total)}`);
  lines.push('');
  lines.push(sourceLine);
  return lines.join('\n');
}

/**
 * processCompletion(subs, tasks, completedTask, now, today)
 *   -> { subs, tasks, changed, autopayTask }
 * Mutates nothing it was given; returns fresh arrays.
 */
function processCompletion(subs, tasks, completedTask, now, today) {
  const idx = subs.findIndex(s => s.switchTaskId && s.switchTaskId === completedTask.id);
  if (idx === -1 || completedTask.type === 'recurring') return { subs, tasks, changed: false, autopayTask: null };
  // Already on the card (e.g. a task-automation retry after the autopay task was done): nothing to do. Mac PM OK, 2026-11-24.
  if (subs[idx].onCard) return { subs, tasks, changed: false, autopayTask: null };
  return applyOnCard(subs, tasks, idx, now, today, `Generated when '${completedTask.name}' was checked off.`);
}

/**
 * upsertAutopay(subs, tasks, nowIso, today, sourceLine) -> { tasks, autopayTask }
 * The one place the autopay figure and task are computed: finds the single autoKind task and
 * updates it in place, or creates it. Used by applyOnCard and by the edit route.
 */
function upsertAutopay(subs, tasks, nowIso, today, sourceLine) {
  const { items, total } = computeTotal(subs);
  const name = `Set the subscription card's autopay to $${money(total)}`;
  const notes = buildNotes(items, total, sourceLine);

  const newTasks = tasks.slice();
  const openIdx = newTasks.findIndex(t => t.autoKind === AUTO_KIND);
  let autopayTask;
  if (openIdx !== -1) {
    autopayTask = { ...newTasks[openIdx], name, notes, dueDate: today, updatedAt: nowIso };
    newTasks[openIdx] = autopayTask;
  } else {
    autopayTask = {
      id: todoEngine.generateId(),
      type: 'scheduled',
      name,
      project: 'Chores',
      priority: 'Low',
      notes,
      tags: [],
      frequency: null,
      skippable: null,
      nextDue: null,
      dueTime: null,
      endDate: null,
      dueDate: today,
      added: null,
      owner: 'alex',
      sharedWith: [],
      sourceFile: null,
      autoKind: AUTO_KIND,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    newTasks.push(autopayTask);
  }
  return { tasks: newTasks, autopayTask };
}

/**
 * applyOnCard(subs, tasks, idx, now, today, sourceLine) -> { subs, tasks, changed:true, autopayTask }
 * Marks subs[idx] onCard and creates (or updates in place) the single autopay task.
 * Shared by processCompletion (task checked off) and the Subscriptions page's on-card route.
 */
function applyOnCard(subs, tasks, idx, now, today, sourceLine) {
  const nowIso = now.toISOString();
  const newSubs = subs.map((s, i) => (i === idx ? { ...s, onCard: true, onCardAt: nowIso } : s));
  const { tasks: newTasks, autopayTask } = upsertAutopay(newSubs, tasks, nowIso, today, sourceLine);
  return { subs: newSubs, tasks: newTasks, changed: true, autopayTask };
}

/**
 * Store-backed hook. Call inside todoStore.withLock, after the completed task
 * has been removed from `tasks` and BEFORE the caller writes tasks. Returns the
 * tasks array to write (same array if nothing linked).
 */
function onTaskCompleted(completedTask, tasks) {
  const subs = readSubscriptions();
  if (!Array.isArray(subs) || !subs.length) return tasks;
  const r = processCompletion(subs, tasks, completedTask, new Date(), todoEngine.todayString());
  if (!r.changed) return tasks;
  writeSubscriptions(r.subs);
  return r.tasks;
}

// ---------------------------------------------------------------------------
// Subscriptions page (admin only): totals, add-a-subscription, routes.
// ---------------------------------------------------------------------------

// Small settings object. cardArrival = the day the subscription card shows up.
const SETTINGS = { cardArrival: '2026-12-09', cap: 300 };

const r2 = n => Math.round(n * 100) / 100;
const hasPrice = s => s.price != null && Number.isFinite(Number(s.price));
const NOTE = 'Subscription consolidation: dashboard → Subscriptions page.';

function computeTotals(subs, settings = SETTINGS) {
  const onCardMonthly = r2(computeTotal(subs).items.reduce((a, s) => a + Number(s.price), 0));
  const off = subs.filter(s => !s.onCard && hasPrice(s));
  const notMovedMonthly = r2(off.filter(s => s.cycle === 'monthly').reduce((a, s) => a + Number(s.price), 0));
  const notMovedYearly = r2(off.filter(s => s.cycle === 'yearly').reduce((a, s) => a + Number(s.price), 0));
  return { onCardMonthly, autopay: r2(onCardMonthly + BUFFER + MIN_PAYMENT), notMovedMonthly, notMovedYearly, cap: settings.cap, cardArrival: settings.cardArrival };
}

/** validateNew(body) -> { value:{name,price,cycle} } | { errors:[...] } */
function validateNew(body) {
  const b = body || {};
  const errors = [];
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) errors.push('name is required');
  else if (name.length > 100) errors.push('name must be 100 characters or fewer');
  let price = null;
  if (b.price !== undefined && b.price !== null && b.price !== '') {
    const n = typeof b.price === 'number' ? b.price : (typeof b.price === 'string' && b.price.trim() !== '' ? Number(b.price) : NaN);
    if (!Number.isFinite(n)) errors.push('price must be a number');
    else if (n < 0) errors.push('price must be 0 or more');
    else price = r2(n);
  }
  const cycle = b.cycle === undefined || b.cycle === null || b.cycle === '' ? 'monthly' : b.cycle;
  if (cycle !== 'monthly' && cycle !== 'yearly') errors.push('cycle must be monthly or yearly');
  return errors.length ? { errors } : { value: { name, price, cycle } };
}

/** Switch-task due date: the later of the card arrival and tomorrow. */
function switchDueDate(today, arrival = SETTINGS.cardArrival) {
  const tomorrow = todoEngine.addDays(today, 1);
  return arrival > tomorrow ? arrival : tomorrow;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'subscription';
}

function newScheduledTask(name, dueDate, nowIso) {
  const { task, errors } = todoValidate.normalizeTask({ type: 'scheduled', name, project: 'Chores', priority: 'Low', notes: NOTE, dueDate }, null);
  if (errors) throw new Error(errors.join('; '));
  return { id: todoEngine.generateId(), ...task, tags: [], owner: 'alex', sharedWith: [], sourceFile: null, createdAt: nowIso, updatedAt: nowIso };
}

/** planCreate(subs, tasks, value, now, today) -> { subs, tasks, row, createdTasks }. Pure. */
function planCreate(subs, tasks, value, now, today, settings = SETTINGS) {
  const nowIso = now.toISOString();
  const switchTask = newScheduledTask(`Switch ${value.name} to the subscription card`, switchDueDate(today, settings.cardArrival), nowIso);
  const createdTasks = [switchTask];
  if (value.price === null) {
    createdTasks.push(newScheduledTask(`Add the price for ${value.name} to the subscriptions list`, todoEngine.addDays(today, 1), nowIso));
  }
  let id = slugify(value.name), n = 2;
  while (subs.some(s => s.id === id)) id = `${slugify(value.name)}-${n++}`;
  const row = { id, name: value.name, price: value.price, cycle: value.cycle, onCard: false, onCardAt: null, switchTaskId: switchTask.id };
  return { subs: subs.concat([row]), tasks: tasks.concat(createdTasks), row, createdTasks };
}

/** Store-backed create: one todo-store lock around both the tasks file and subscriptions file. */
function createSubscription(value) {
  return todoStore.withLock(() => {
    const subs = readSubscriptions();
    const tasks = todoStore.readTasks();
    const r = planCreate(subs, tasks, value, new Date(), todoEngine.todayString());
    todoStore.writeTasks(r.tasks);
    writeSubscriptions(r.subs);
    return r;
  });
}

/**
 * Store-backed "mark on the card" from the Subscriptions page. One todo-store lock.
 * completeScheduled(tasks, task) is server.js's shared completion (logs, removes, fires the hook, writes tasks).
 * -> { status, body }
 */
function markOnCard(id, completeScheduled) {
  return todoStore.withLock(() => markOnCardLocked(id, completeScheduled));
}
// Same, for callers already inside todoStore.withLock (the lock is not reentrant).
function markOnCardLocked(id, completeScheduled) {
  {
    const subs = readSubscriptions();
    const idx = subs.findIndex(s => s.id === id);
    if (idx === -1) return { status: 404, body: { error: 'Subscription not found' } };
    const tasks = todoStore.readTasks();
    const finish = (rows, taskList) => {
      const ap = taskList.find(t => t.autoKind === AUTO_KIND);
      return { status: 200, body: { row: rows.find(s => s.id === id), totals: computeTotals(rows), autopayTaskId: ap ? ap.id : null } };
    };
    if (subs[idx].onCard) return finish(subs, tasks);
    const sw = subs[idx].switchTaskId && tasks.find(t => t.id === subs[idx].switchTaskId && t.type !== 'recurring');
    if (sw) {
      completeScheduled(tasks, sw);   // fires onTaskCompleted -> flips onCard, creates/updates autopay
      return finish(readSubscriptions(), todoStore.readTasks());
    }
    const r = applyOnCard(subs, tasks, idx, new Date(), todoEngine.todayString(), `Generated when ${subs[idx].name} was marked on the card on the Subscriptions page.`);
    todoStore.writeTasks(r.tasks);
    writeSubscriptions(r.subs);
    return finish(r.subs, r.tasks);
  }
}

// ---------------------------------------------------------------------------
// Edit a row (PATCH /api/subscriptions/:id)
// ---------------------------------------------------------------------------

const MAX_NOTES = 500;

/** validatePatch(body) -> { value:{...only the given fields} } | { errors:[...] } */
function validatePatch(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = [], value = {};
  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) errors.push('name cannot be empty');
    else if (name.length > 100) errors.push('name must be 100 characters or fewer');
    else value.name = name;
  }
  if (b.price !== undefined) {
    if (b.price === null || b.price === '') value.price = null;
    else {
      const n = typeof b.price === 'number' ? b.price : (typeof b.price === 'string' && b.price.trim() !== '' ? Number(b.price) : NaN);
      if (!Number.isFinite(n)) errors.push('price must be a number');
      else if (n < 0) errors.push('price must be 0 or more');
      else value.price = r2(n);
    }
  }
  if (b.cycle !== undefined) {
    if (b.cycle !== 'monthly' && b.cycle !== 'yearly') errors.push('cycle must be monthly or yearly');
    else value.cycle = b.cycle;
  }
  if (b.notes !== undefined) {
    if (typeof b.notes !== 'string') errors.push('notes must be text');
    else if (b.notes.trim().length > MAX_NOTES) errors.push(`notes must be ${MAX_NOTES} characters or fewer`);
    else value.notes = b.notes.trim();
  }
  if (b.onCard !== undefined) {
    if (typeof b.onCard !== 'boolean') errors.push('onCard must be true or false');
    else value.onCard = b.onCard;
  }
  if (!errors.length && !Object.keys(value).length) errors.push('nothing to change');
  return errors.length ? { errors } : { value };
}

/**
 * planEdit(subs, tasks, completed, idx, value, now, today, settings)
 *   -> { subs, tasks, completed, row, wantsOnCard }
 * Pure. Applies name/price/cycle/notes, renames the row's open tasks, and takes a row OFF the card
 * (reopening or recreating its switch task). Putting a row ON the card (wantsOnCard) is left to the
 * caller, because it must complete the switch task through the shared completion path.
 */
function planEdit(subs, tasks, completed, idx, value, now, today, settings = SETTINGS) {
  const nowIso = now.toISOString();
  const old = subs[idx];
  let row = { ...old };
  for (const k of ['name', 'price', 'cycle']) if (value[k] !== undefined) row[k] = value[k];
  if (value.notes !== undefined) { if (value.notes) row.notes = value.notes; else delete row.notes; }
  let newTasks = tasks.slice();
  let newCompleted = completed;

  if (row.name !== old.name) {
    newTasks = newTasks.map(t => {
      if (t.id === old.switchTaskId && t.type !== 'recurring') return { ...t, name: `Switch ${row.name} to the subscription card`, updatedAt: nowIso };
      if (t.name === `Add the price for ${old.name} to the subscriptions list`) return { ...t, name: `Add the price for ${row.name} to the subscriptions list`, updatedAt: nowIso };
      return t;
    });
  }

  let wantsOnCard = false;
  if (value.onCard === true && !old.onCard) wantsOnCard = true;
  if (value.onCard === false && old.onCard) {
    row.onCard = false; row.onCardAt = null;
    if (!(row.switchTaskId && newTasks.some(t => t.id === row.switchTaskId))) {
      const done = row.switchTaskId && completed.find(c => c.taskId === row.switchTaskId);
      const t = newScheduledTask(`Switch ${row.name} to the subscription card`, switchDueDate(today, settings.cardArrival), nowIso);
      if (done) { t.id = done.taskId; newCompleted = completed.filter(c => c !== done); }   // reopen: same id, off the completed log
      row.switchTaskId = t.id;
      newTasks.push(t);
    }
  }
  return { subs: subs.map((s, i) => (i === idx ? row : s)), tasks: newTasks, completed: newCompleted, row, wantsOnCard };
}

/** Recalculate the autopay task from the current rows. Skips creating one when nothing is on the card. */
function recalcAutopay(subs, tasks, now, today, sourceLine) {
  const exists = tasks.some(t => t.autoKind === AUTO_KIND);
  if (!exists && !subs.some(s => s.onCard)) return { tasks, autopayTask: null };
  return upsertAutopay(subs, tasks, now.toISOString(), today, sourceLine);
}

/** Store-backed edit. One todo-store lock. -> { status, body } */
function editSubscription(id, value, completeScheduled) {
  return todoStore.withLock(() => {
    const subs = readSubscriptions();
    const idx = subs.findIndex(s => s.id === id);
    if (idx === -1) return { status: 404, body: { error: 'Subscription not found' } };
    const now = new Date(), today = todoEngine.todayString();
    const completed = todoStore.readCompleted();
    const r = planEdit(subs, todoStore.readTasks(), completed, idx, value, now, today);
    todoStore.writeTasks(r.tasks);
    if (r.completed !== completed) todoStore.writeCompleted(r.completed);
    writeSubscriptions(r.subs);
    if (r.wantsOnCard) markOnCardLocked(id, completeScheduled);   // completes the switch task; its hook updates autopay
    const finalSubs = readSubscriptions();
    const ap = recalcAutopay(finalSubs, todoStore.readTasks(), now, today, `Updated when ${finalSubs[idx].name} was edited on the Subscriptions page.`);
    if (ap.autopayTask) todoStore.writeTasks(ap.tasks);
    const tasks = todoStore.readTasks();
    const apt = tasks.find(t => t.autoKind === AUTO_KIND);
    return { status: 200, body: { row: finalSubs[idx], totals: computeTotals(finalSubs), autopayTaskId: apt ? apt.id : null } };
  });
}

// Admin-only, checked on the routes themselves (no non-admin allowlist line in server.js).
function mount(app, { isAdminReq, completeScheduled }) {
  const guard = (req, res, next) => (isAdminReq(req) ? next() : res.status(403).json({ error: 'Not available for your account.' }));
  app.get('/api/subscriptions', guard, (req, res) => {
    try {
      const rows = readSubscriptions();
      const byId = new Map(todoStore.readTasks().map(t => [t.id, t]));
      res.json({ rows: rows.map(s => ({ ...s, switchDue: (byId.get(s.switchTaskId) || {}).dueDate || null })), totals: computeTotals(rows), settings: SETTINGS });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/subscriptions/:id/on-card', guard, (req, res) => {
    try {
      const r = markOnCard(req.params.id, completeScheduled);
      res.status(r.status).json(r.body);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/subscriptions/:id', guard, (req, res) => {
    try {
      const v = validatePatch(req.body);
      if (v.errors) return res.status(400).json({ error: v.errors.join('; '), errors: v.errors });
      const r = editSubscription(req.params.id, v.value, completeScheduled);
      res.status(r.status).json(r.body);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/subscriptions', guard, (req, res) => {
    try {
      const v = validateNew(req.body);
      if (v.errors) return res.status(400).json({ error: v.errors.join('; '), errors: v.errors });
      const r = createSubscription(v.value);
      res.status(201).json({ row: r.row, tasks: r.createdTasks.map(t => ({ id: t.id, name: t.name, dueDate: t.dueDate })), taskIds: r.createdTasks.map(t => t.id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { SUBS_FILE, AUTO_KIND, SETTINGS, BUFFER, MIN_PAYMENT, readSubscriptions, writeSubscriptions, computeTotal, processCompletion, applyOnCard, markOnCard, onTaskCompleted,
  computeTotals, validateNew, validatePatch, planEdit, recalcAutopay, editSubscription, upsertAutopay, switchDueDate, planCreate, createSubscription, mount };
