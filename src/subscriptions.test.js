'use strict';

/**
 * Tests for subscriptions.js (pure logic). Run: node src/subscriptions.test.js
 * Exits non-zero on failure.
 */

const assert = require('assert');
const subs = require('./subscriptions');
const todoEngine = require('./todo-engine');

let passed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); process.exitCode = 1; }
  else { passed++; console.log(`ok - ${label}`); }
}

const NOW = new Date('2026-11-24T12:00:00.000Z');
const TODAY = '2026-11-24';
const row = (id, price, cycle, onCard, taskId) => ({ id, name: id, price, cycle, onCard, onCardAt: null, switchTaskId: taskId });
const sched = (id, name) => ({ id, type: 'scheduled', name, project: 'Chores', dueDate: '2026-12-01' });

// computeTotal
check('computeTotal: nothing on card = 40', subs.computeTotal([row('a', 5, 'monthly', false)]).total, 40);
check('computeTotal: monthly only, yearly excluded, null skipped',
  subs.computeTotal([row('a', 10, 'monthly', true), row('b', 99, 'yearly', true), row('c', null, 'monthly', true), row("d", 5.5, "monthly", true)]).total, 55.5);
check('computeTotal: float rounding', subs.computeTotal([row('a', 0.1, 'monthly', true), row('b', 0.2, 'monthly', true)]).total, 40.3);

// create
const rows = [row('x', 1, 'monthly', false, 't1'), row('y', 6.5, 'monthly', true, 't2')];
const r = subs.processCompletion(rows, [], sched('t1', 'Switch X to the subscription card'), NOW, TODAY);
check('create: changed', r.changed, true);
check('create: row marked on card', [r.subs[0].onCard, r.subs[0].onCardAt], [true, NOW.toISOString()]);
check('create: one new task', r.tasks.length, 1);
check('create: name', r.autopayTask.name, "Set the subscription card's autopay to $47.50");
check('create: shape', [r.autopayTask.type, r.autopayTask.project, r.autopayTask.dueDate, r.autopayTask.autoKind], ['scheduled', 'Chores', TODAY, 'subcard-autopay']);
const n = r.autopayTask.notes;
assert(n.includes('x: $1.00') && n.includes('y: $6.50') && n.includes('+ $10.00 buffer') &&
  n.includes('+ $30.00 minimum payment') && n.includes('= $47.50') &&
  n.includes("Generated when 'Switch X to the subscription card' was checked off."));
passed++; console.log('ok - create: notes breakdown');
check('create: inputs not mutated', rows[0].onCard, false);

// update in place
const second = subs.processCompletion(r.subs.concat([row('z', 2, 'monthly', false, 't3')]),
  r.tasks, sched('t3', 'Switch Z'), new Date('2026-11-25T09:00:00.000Z'), '2026-11-25');
check('update: still one autopay task', second.tasks.filter(t => t.autoKind === 'subcard-autopay').length, 1);
check('update: same id kept', second.autopayTask.id, r.autopayTask.id);
check('update: name/due updated', [second.autopayTask.name, second.autopayTask.dueDate], ["Set the subscription card's autopay to $49.50", '2026-11-25']);

// unlinked
const u = subs.processCompletion(rows, [sched('q', 'Other')], sched('q', 'Other'), NOW, TODAY);
check('unlinked: no change', [u.changed, u.tasks.length, u.subs === rows], [false, 1, true]);
const rec = subs.processCompletion(rows, [], { id: 't1', type: 'recurring', name: 'r' }, NOW, TODAY);
check('recurring: no hook', rec.changed, false);
// already on card (a retry after the autopay task was done): no change, no new task
{
  const onRows = [row('x', 1, 'monthly', true, 't1')], before = [sched('other', 'Something else')];
  const g = subs.processCompletion(onRows, before, sched('t1', 'Switch X to the subscription card'), NOW, TODAY);
  check('already on card: no change, no task, inputs returned as-is', [g.changed, g.autopayTask, g.tasks === before, g.subs === onRows, g.tasks.length], [false, null, true, true, 1]);
}

// --- Subscriptions page: due-date rule, create, validation, totals ---
check('due: before arrival -> arrival', subs.switchDueDate('2026-11-24', '2026-12-09'), '2026-12-09');
check('due: day before arrival -> arrival', subs.switchDueDate('2026-12-07', '2026-12-09'), '2026-12-09');
check('due: arrival is tomorrow -> that day', subs.switchDueDate('2026-12-08', '2026-12-09'), '2026-12-09');
check('due: today is arrival -> tomorrow', subs.switchDueDate('2026-12-09', '2026-12-09'), '2026-12-10');
check('due: after arrival -> tomorrow', subs.switchDueDate('2026-12-20', '2026-12-09'), '2026-12-21');
check('due: month rollover', subs.switchDueDate('2026-12-31', '2026-12-09'), '2027-01-01');

const okv = subs.validateNew({ name: '  Netflix  ', price: '15.499', cycle: 'yearly' });
check('validate: trims, rounds, cycle', okv.value, { name: 'Netflix', price: 15.5, cycle: 'yearly' });
check('validate: defaults', subs.validateNew({ name: 'X' }).value, { name: 'X', price: null, cycle: 'monthly' });
check('validate: blank/null price ok', [subs.validateNew({ name: 'X', price: '' }).value.price, subs.validateNew({ name: 'X', price: null }).value.price], [null, null]);
check('validate: zero price ok', subs.validateNew({ name: 'X', price: 0 }).value.price, 0);
check('validate: empty name rejected', !!subs.validateNew({ name: '   ', price: 1 }).errors, true);
check('validate: missing name rejected', !!subs.validateNew({}).errors, true);
check('validate: name > 100 rejected', !!subs.validateNew({ name: 'a'.repeat(101) }).errors, true);
check('validate: name = 100 ok', !!subs.validateNew({ name: 'a'.repeat(100) }).value, true);
check('validate: negative price rejected', !!subs.validateNew({ name: 'X', price: -1 }).errors, true);
check('validate: non-numeric price rejected', !!subs.validateNew({ name: 'X', price: 'abc' }).errors, true);
check('validate: bad cycle rejected', !!subs.validateNew({ name: 'X', cycle: 'weekly' }).errors, true);

const NOW2 = new Date('2026-11-24T12:00:00.000Z');
const withPrice = subs.planCreate([row('a', 5, 'monthly', false)], [], { name: 'Spotify', price: 11.99, cycle: 'monthly' }, NOW2, '2026-11-24', { cardArrival: '2026-12-09', cap: 300 });
check('create: priced -> one task', withPrice.createdTasks.length, 1);
check('create: switch task fields', [withPrice.createdTasks[0].name, withPrice.createdTasks[0].type, withPrice.createdTasks[0].project, withPrice.createdTasks[0].dueDate, withPrice.createdTasks[0].notes],
  ['Switch Spotify to the subscription card', 'scheduled', 'Chores', '2026-12-09', 'Subscription consolidation: dashboard → Subscriptions page.']);
check('create: row links task, not on card', [withPrice.row.onCard, withPrice.row.onCardAt, withPrice.row.switchTaskId === withPrice.createdTasks[0].id, withPrice.row.price], [false, null, true, 11.99]);
check('create: row + task appended', [withPrice.subs.length, withPrice.tasks.length], [2, 1]);
const blank = subs.planCreate([], [], { name: 'Mystery', price: null, cycle: 'monthly' }, NOW2, '2026-12-20', { cardArrival: '2026-12-09', cap: 300 });
check('create: blank price -> two tasks', blank.createdTasks.map(t => t.name), ['Switch Mystery to the subscription card', 'Add the price for Mystery to the subscriptions list']);
check('create: blank price due dates (after arrival)', blank.createdTasks.map(t => t.dueDate), ['2026-12-21', '2026-12-21']);
const blank2 = subs.planCreate([], [], { name: 'Mystery', price: null, cycle: 'monthly' }, NOW2, '2026-11-24', { cardArrival: '2026-12-09', cap: 300 });
check('create: blank price due dates (before arrival)', blank2.createdTasks.map(t => t.dueDate), ['2026-12-09', '2026-11-25']);
check('create: id slug unique', subs.planCreate([{ id: 'mystery' }], [], { name: 'Mystery', price: 1, cycle: 'monthly' }, NOW2, '2026-11-24').row.id, 'mystery-2');

const tl = [row('a', 10, 'monthly', true), row('b', 5.5, 'monthly', true), row('c', 120, 'yearly', true), row('d', 18.98, 'monthly', false), row('e', 60, 'yearly', false), row('f', null, 'monthly', false)];
check('totals: math', subs.computeTotals(tl, { cardArrival: '2026-12-09', cap: 300 }),
  { onCardMonthly: 15.5, autopay: 55.5, notMovedMonthly: 18.98, notMovedYearly: 60, cap: 300, cardArrival: '2026-12-09' });
check('totals: empty', subs.computeTotals([]).autopay, 40);

// --- on-card route (markOnCard) against a temp data dir, plus the shared completion ---
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const todoStore = require('./todo-store');
  // DATA_DIR is fixed at ../data, so back up and restore whatever the store files hold.
  const files = [subs.SUBS_FILE, subs.SETTINGS_FILE, path.join(todoStore.DATA_DIR, 'todo_tasks.json'), path.join(todoStore.DATA_DIR, 'todo_completed.json')];
  const backup = files.map(f => (fs.existsSync(f) ? fs.readFileSync(f) : null));
  try {
    // Mirror of server.js completeTaskLocked (log first, remove second, then the hook).
    const complete = (tasks, task) => {
      const completed = todoStore.readCompleted();
      const entry = { id: 'completed-test', taskId: task.id, name: task.name, project: task.project, type: task.type, completedAt: NOW.toISOString(), notes: task.notes || '', tags: [] };
      completed.unshift(entry); todoStore.writeCompleted(completed);
      todoStore.writeTasks(subs.onTaskCompleted(task, tasks.filter(t => t.id !== task.id)));
      return entry;
    };
    const seed = (rowsArr, tasksArr) => { subs.writeSubscriptions(rowsArr); todoStore.writeTasks(tasksArr); todoStore.writeCompleted([]); };

    // 1. existing switch task
    seed([row('x', 1, 'monthly', false, 't1'), row('y', 6.5, 'monthly', true, 't2')], [sched('t1', 'Switch X to the subscription card')]);
    let res = subs.markOnCard('x', complete);
    check('on-card: status 200', res.status, 200);
    check('on-card: switch task removed', todoStore.readTasks().some(t => t.id === 't1'), false);
    check('on-card: completed entry exists', todoStore.readCompleted().map(c => c.taskId), ['t1']);
    check('on-card: row onCard', res.body.row.onCard, true);
    const ap = todoStore.readTasks().filter(t => t.autoKind === 'subcard-autopay');
    check('on-card: autopay created at $47.50', [ap.length, ap[0].name, res.body.autopayTaskId === ap[0].id, res.body.totals.autopay], [1, "Set the subscription card's autopay to $47.50", true, 47.5]);

    // 2. already onCard: no-op
    const before = JSON.stringify([fs.readFileSync(subs.SUBS_FILE, 'utf8'), todoStore.readTasks(), todoStore.readCompleted()]);
    res = subs.markOnCard('x', complete);
    check('on-card: already onCard is a no-op', [res.status, JSON.stringify([fs.readFileSync(subs.SUBS_FILE, 'utf8'), todoStore.readTasks(), todoStore.readCompleted()]) === before], [200, true]);

    // 3. missing switch task: sets onCard and updates the existing autopay task in place
    const rows3 = subs.readSubscriptions().concat([row('z', 2, 'monthly', false, 'gone'), row('w', 3, 'monthly', false, null)]);
    subs.writeSubscriptions(rows3);
    res = subs.markOnCard('z', complete);
    const ap3 = todoStore.readTasks().filter(t => t.autoKind === 'subcard-autopay');
    check('on-card: missing switch task -> onCard, autopay updated in place', [res.status, res.body.row.onCard, ap3.length, ap3[0].id === ap[0].id, ap3[0].name, todoStore.readCompleted().length],
      [200, true, 1, true, "Set the subscription card's autopay to $49.50", 1]);
    check('on-card: missing task notes line', ap3[0].notes.includes('Generated when z was marked on the card on the Subscriptions page.'), true);
    res = subs.markOnCard('w', complete);
    check('on-card: no switchTaskId -> onCard, autopay $52.50', [res.body.row.onCard, res.body.totals.autopay], [true, 52.5]);

    // 3b. missing switch task and no autopay task yet: created
    seed([row('q', 4, 'monthly', false, null)], []);
    res = subs.markOnCard('q', complete);
    check('on-card: missing task, no autopay yet -> created', [res.body.row.onCard, todoStore.readTasks().filter(t => t.autoKind === 'subcard-autopay').length, res.body.totals.autopay], [true, 1, 44]);

    // 4. unknown id
    res = subs.markOnCard('nope', complete);
    check('on-card: unknown id -> 404', res.status, 404);

    // 5. shared completion on a plain unlinked task: logged, removed, nothing else touched
    seed([row('x', 1, 'monthly', false, 't1')], [sched('p1', 'Plain'), sched('p2', 'Other')]);
    const entry = complete(todoStore.readTasks(), todoStore.readTasks()[0]);
    check('completion: unlinked task logged and removed', [todoStore.readTasks().map(t => t.id), todoStore.readCompleted().map(c => c.taskId), entry.name], [['p2'], ['p1'], 'Plain']);
    check('completion: unlinked leaves subscriptions untouched', subs.readSubscriptions()[0].onCard, false);
  } finally {
    files.forEach((f, i) => { if (backup[i] === null) { try { fs.unlinkSync(f); } catch (e) {} } else fs.writeFileSync(f, backup[i]); });
  }
}

// --- edit a row (PATCH): validation, plan, and store-backed flows ---
check('patch validate: empty body rejected', !!subs.validatePatch({}).errors, true);
check('patch validate: bad name/price/cycle/notes/onCard all rejected',
  [subs.validatePatch({ name: ' ' }), subs.validatePatch({ price: 'abc' }), subs.validatePatch({ price: -2 }), subs.validatePatch({ cycle: 'weekly' }),
   subs.validatePatch({ notes: 'x'.repeat(501) }), subs.validatePatch({ notes: 5 }), subs.validatePatch({ onCard: 'yes' })].map(v => !!v.errors),
  [true, true, true, true, true, true, true]);
check('patch validate: good fields', subs.validatePatch({ name: ' A ', price: '3.456', cycle: 'yearly', notes: ' hi ', onCard: false }).value,
  { name: 'A', price: 3.46, cycle: 'yearly', notes: 'hi', onCard: false });
check('patch validate: price null ok, notes 500 ok', [subs.validatePatch({ price: null }).value.price, !!subs.validatePatch({ notes: 'x'.repeat(500) }).value], [null, true]);

{
  const fs = require('fs'), path = require('path');
  const todoStore = require('./todo-store');
  const files = [subs.SUBS_FILE, subs.SETTINGS_FILE, path.join(todoStore.DATA_DIR, 'todo_tasks.json'), path.join(todoStore.DATA_DIR, 'todo_completed.json')];
  const backup = files.map(f => (fs.existsSync(f) ? fs.readFileSync(f) : null));
  try {
    const complete = (tasks, task) => {
      const completed = todoStore.readCompleted();
      const entry = { id: 'completed-test', taskId: task.id, name: task.name, project: task.project, type: task.type, completedAt: NOW.toISOString(), notes: task.notes || '', tags: [] };
      completed.unshift(entry); todoStore.writeCompleted(completed);
      todoStore.writeTasks(subs.onTaskCompleted(task, tasks.filter(t => t.id !== task.id)));
      return entry;
    };
    const seed = (rowsArr, tasksArr, doneArr) => { subs.writeSubscriptions(rowsArr); todoStore.writeTasks(tasksArr); todoStore.writeCompleted(doneArr || []); };
    const apOf = () => todoStore.readTasks().filter(t => t.autoKind === 'subcard-autopay');
    const autopayTask = (name) => ({ id: 'ap1', type: 'scheduled', name, project: 'Chores', dueDate: '2026-11-20', autoKind: 'subcard-autopay', notes: '' });

    // edit price -> autopay updated in place
    seed([row('x', 10, 'monthly', true, 't1')], [autopayTask('old')]);
    let res = subs.editSubscription('x', { price: 12.5 }, complete);
    check('edit price: 200, row price, autopay name/id', [res.status, res.body.row.price, apOf().length, apOf()[0].id, apOf()[0].name, res.body.totals.autopay],
      [200, 12.5, 1, 'ap1', "Set the subscription card's autopay to $52.50", 52.5]);
    check('edit price: autopay notes list the row', apOf()[0].notes.includes('x: $12.50') && apOf()[0].notes.includes('= $52.50'), true);
    // notes and cycle
    res = subs.editSubscription('x', { notes: 'Annual deal', cycle: 'yearly' }, complete);
    check('edit notes/cycle: saved, yearly leaves autopay at buffer+min', [res.body.row.notes, res.body.row.cycle, apOf()[0].name], ['Annual deal', 'yearly', "Set the subscription card's autopay to $40.00"]);
    res = subs.editSubscription('x', { notes: '' }, complete);
    check('edit notes: blank clears', 'notes' in res.body.row, false);

    // Yes -> No, switch task already completed: reopened with same id, off the completed log
    seed([row('x', 10, 'monthly', true, 't1')], [autopayTask('old')], [{ id: 'c1', taskId: 't1', name: 'Switch x to the subscription card' }]);
    res = subs.editSubscription('x', { onCard: false }, complete);
    const t1 = todoStore.readTasks().find(t => t.id === 't1');
    check('Yes->No: switch task reopened (same id), completed log emptied', [res.body.row.onCard, res.body.row.onCardAt, !!t1, t1 && t1.name, todoStore.readCompleted().length],
      [false, null, true, 'Switch x to the subscription card', 0]);
    check('Yes->No: autopay recalculated without the row', apOf()[0].name, "Set the subscription card's autopay to $40.00");

    // Yes -> No, switch task gone entirely: created
    seed([row('x', 10, 'monthly', true, 'gone')], [autopayTask('old')]);
    res = subs.editSubscription('x', { onCard: false }, complete);
    const made = todoStore.readTasks().find(t => t.name === 'Switch x to the subscription card');
    check('Yes->No: gone task recreated and linked', [!!made, res.body.row.switchTaskId === (made && made.id), made && made.project], [true, true, 'Chores']);

    // No -> Yes: open switch task completed, autopay updated
    seed([row('x', 10, 'monthly', false, 't1')], [sched('t1', 'Switch x to the subscription card'), autopayTask('old')]);
    res = subs.editSubscription('x', { onCard: true }, complete);
    check('No->Yes: switch task completed and logged, row on card, autopay $50.00',
      [res.body.row.onCard, todoStore.readTasks().some(t => t.id === 't1'), todoStore.readCompleted().map(c => c.taskId), apOf().length, apOf()[0].name],
      [true, false, ['t1'], 1, "Set the subscription card's autopay to $50.00"]);

    // rename renames the open switch and price tasks
    seed([row('x', null, 'monthly', false, 't1')], [sched('t1', 'Switch x to the subscription card'), sched('t9', 'Add the price for x to the subscriptions list'), sched('t8', 'Add the price for other to the subscriptions list')]);
    res = subs.editSubscription('x', { name: 'Newname' }, complete);
    check('rename: switch and price tasks renamed, others untouched', todoStore.readTasks().map(t => t.name),
      ['Switch Newname to the subscription card', 'Add the price for Newname to the subscriptions list', 'Add the price for other to the subscriptions list']);
    check('rename: nothing on card and no autopay task -> none created', apOf().length, 0);

    // price filled in from blank completes its "Add the price" task (under the new name too)
    seed([row('x', null, 'monthly', false, 't1')], [sched('t1', 'Switch x to the subscription card'), sched('t9', 'Add the price for x to the subscriptions list')]);
    res = subs.editSubscription('x', { name: 'Y', price: 4 }, complete);
    check('price from blank: price task completed, switch task kept', [todoStore.readTasks().map(t => t.id), todoStore.readCompleted().map(c => c.taskId)], [['t1'], ['t9']]);

    // route wiring with a fake app: 403 for non-admin, 400 for bad input, 404 for unknown id
    const routes = {};
    subs.mount({ get() {}, post() {}, delete() {}, patch(p, g, h) { routes.patch = (req) => { let out; const res = { status(c) { out = { status: c }; return res; }, json(b) { out.body = b; } }; g(req, res, () => h(req, res)); return out; }; } }, { isAdminReq: r => !!r.admin, completeScheduled: complete });
    seed([row('x', 1, 'monthly', false, 't1')], []);
    check('route: non-admin -> 403', routes.patch({ params: { id: 'x' }, body: { price: 2 } }).status, 403);
    check('route: bad input -> 400', routes.patch({ admin: true, params: { id: 'x' }, body: { price: 'abc' } }).status, 400);
    check('route: empty body -> 400', routes.patch({ admin: true, params: { id: 'x' }, body: {} }).status, 400);
    check('route: unknown id -> 404', routes.patch({ admin: true, params: { id: 'nope' }, body: { price: 2 } }).status, 404);
    check('route: good -> 200', routes.patch({ admin: true, params: { id: 'x' }, body: { price: 2 } }).status, 200);


    // --- cancel / restore / delete ---
    const cancelled = (id, price, cycle, onCard, taskId) => ({ ...row(id, price, cycle, onCard, taskId), status: 'cancelled', cancelledAt: NOW.toISOString() });
    check('computeTotals ignores cancelled rows', [subs.computeTotals([row('a', 10, 'monthly', true), cancelled('b', 20, 'monthly', true), cancelled('c', 5, 'yearly', false), cancelled('d', 7, 'monthly', false)]).onCardMonthly,
      subs.computeTotals([cancelled('c', 5, 'yearly', false), cancelled('d', 7, 'monthly', false)]).notMovedMonthly, subs.computeTotals([cancelled('c', 5, 'yearly', false)]).notMovedYearly], [10, 0, 0]);
    check('computeTotal ignores cancelled rows', subs.computeTotal([row('a', 10, 'monthly', true), cancelled('b', 20, 'monthly', true)]).total, 50);

    seed([row('x', 10, 'monthly', true, 't1'), row('y', 5, 'monthly', false, 't2'), row('z', null, 'monthly', false, 't3')],
      [sched('t1', 'Switch x to the subscription card'), sched('t2', 'Switch y to the subscription card'), sched('t3', 'Switch z to the subscription card'), sched('t9', 'Add the price for z to the subscriptions list'), autopayTask('old')],
      [{ id: 'c0', taskId: 'other', name: 'Other' }]);
    res = subs.cancelSubscription('x');
    check('cancel: 200, status, date, off card, totals', [res.status, res.body.row.status, typeof res.body.row.cancelledAt, res.body.row.onCard, res.body.totals.onCardMonthly], [200, 'cancelled', 'string', false, 0]);
    check('cancel: switch task removed (not completed), autopay recalculated', [todoStore.readTasks().some(t => t.id === 't1'), todoStore.readCompleted().map(c => c.taskId), apOf()[0].name], [false, ['other'], "Set the subscription card's autopay to $40.00"]);
    const snap = JSON.stringify([subs.readSubscriptions(), todoStore.readTasks()]);
    res = subs.cancelSubscription('x');
    check('cancel twice: 200 no-op', [res.status, JSON.stringify([subs.readSubscriptions(), todoStore.readTasks()]) === snap], [200, true]);
    res = subs.cancelSubscription('z');
    check('cancel: price task and switch task both removed', todoStore.readTasks().map(t => t.id).sort(), ['ap1', 't2']);
    res = subs.restoreSubscription('z');
    const nt = todoStore.readTasks().map(t => t.name);
    check('restore (price null): status removed, switch and price tasks recreated', [res.status, 'status' in res.body.row, 'cancelledAt' in res.body.row, res.body.row.onCard, nt.includes('Switch z to the subscription card'), nt.includes('Add the price for z to the subscriptions list'),
      todoStore.readTasks().some(t => t.id === res.body.row.switchTaskId)], [200, false, false, false, true, true, true]);
    res = subs.restoreSubscription('x');
    nt.length = 0; nt.push(...todoStore.readTasks().map(t => t.name));
    check('restore (price set): switch task only', [nt.includes('Switch x to the subscription card'), nt.filter(n => n.startsWith('Add the price for x')).length], [true, 0]);
    res = subs.restoreSubscription('x');
    check('restore not-cancelled: 200 no-op', res.status, 200);
    check('cancel/restore unknown id -> 404', [subs.cancelSubscription('nope').status, subs.restoreSubscription('nope').status], [404, 404]);

    // delete
    seed([row('x', 10, 'monthly', true, 't1'), row('y', 5, 'monthly', true, 't2'), row('z', null, 'monthly', false, 't3')],
      [sched('t1', 'Switch x to the subscription card'), sched('t2', 'Switch y to the subscription card'), sched('t3', 'Switch z to the subscription card'), sched('t9', 'Add the price for z to the subscriptions list'), autopayTask('old')]);
    res = subs.deleteSubscription('z');
    check('delete: row and its tasks gone, others kept', [res.status, subs.readSubscriptions().map(r => r.id), todoStore.readTasks().map(t => t.id)], [200, ['x', 'y'], ['t1', 't2', 'ap1']]);
    res = subs.deleteSubscription('x');
    check('delete on-card row: autopay recalculated', [res.status, apOf()[0].name, res.body.totals.onCardMonthly], [200, "Set the subscription card's autopay to $45.00", 5]);
    check('delete unknown -> 404', subs.deleteSubscription('nope').status, 404);

    // PATCH on a cancelled row
    seed([cancelled('x', 10, 'monthly', false, 't1')], []);
    res = subs.editSubscription('x', { onCard: true }, complete);
    check('patch onCard true on cancelled -> 409 Restore it first', [res.status, res.body.error, subs.readSubscriptions()[0].onCard], [409, 'Restore it first', false]);
    res = subs.editSubscription('x', { name: 'New', price: 3, cycle: 'yearly', notes: 'n' }, complete);
    check('patch name/price/cycle/notes on cancelled -> 200, stays cancelled', [res.status, res.body.row.name, res.body.row.price, res.body.row.status], [200, 'New', 3, 'cancelled']);

    // money page ignores cancelled rows
    {
      const money = require('./money');
      const mrows = [row('a', 10, 'monthly', false), cancelled('b', 20, 'monthly', false)];
      const empty = { transactions: [], accounts: [], recurring: [], variable: [], rules: [] };
      const sm = money.summarize(empty, '2026-11', mrows);
      check('money summarize: cancelled row not in recurring', [sm.recurring.items.map(i => i.name), sm.recurring.monthlyCents], [['a'], 1000]);
    }

    // route wiring for the new routes
    const r2 = {};
    const mk = (name) => (p, g, h) => { r2[name + ' ' + p] = (req) => { let out; const rs = { status(c) { out = { status: c }; return rs; }, json(b) { out.body = b; } }; g(req, rs, () => h(req, rs)); return out; }; };
    subs.mount({ get() {}, post: mk('post'), patch() {}, delete: mk('delete') }, { isAdminReq: q => !!q.admin, completeScheduled: complete });
    seed([row('x', 1, 'monthly', false, 't1')], []);
    check('route cancel: non-admin 403, admin 200', [r2['post /api/subscriptions/:id/cancel']({ params: { id: 'x' } }).status, r2['post /api/subscriptions/:id/cancel']({ admin: true, params: { id: 'x' } }).status], [403, 200]);
    check('route restore 200, delete 200 then 404', [r2['post /api/subscriptions/:id/restore']({ admin: true, params: { id: 'x' } }).status, r2['delete /api/subscriptions/:id']({ admin: true, params: { id: 'x' } }).status, r2['delete /api/subscriptions/:id']({ admin: true, params: { id: 'x' } }).status], [200, 200, 404]);

    // --- phase 3: settings ---
    try { fs.unlinkSync(subs.SETTINGS_FILE); } catch (e) { /* none */ }
    check('settings: defaults when the file is missing', subs.getSettings(), { cardArrival: '2026-12-09', cap: 300 });
    check('settings validate: bad date/cap rejected', [subs.validateSettings({ cardArrival: '2026-02-30' }), subs.validateSettings({ cardArrival: 'tomorrow' }), subs.validateSettings({ cap: 0 }), subs.validateSettings({ cap: 10001 }), subs.validateSettings({ cap: 'x' }), subs.validateSettings({})].map(v => !!v.errors), [true, true, true, true, true, true]);
    check('settings validate: good values', subs.validateSettings({ cardArrival: '2026-12-20', cap: '250.5' }).value, { cardArrival: '2026-12-20', cap: 250.5 });
    fs.writeFileSync(subs.SETTINGS_FILE, '{not json');
    check('settings: garbage file -> defaults', subs.getSettings(), { cardArrival: '2026-12-09', cap: 300 });
    fs.writeFileSync(subs.SETTINGS_FILE, JSON.stringify({ cardArrival: 'bad', cap: 99999 }));
    check('settings: invalid saved values ignored', subs.getSettings(), { cardArrival: '2026-12-09', cap: 300 });
    try { fs.unlinkSync(subs.SETTINGS_FILE); } catch (e) { /* none */ }

    // arrival change moves OPEN switch tasks linked from rows only
    const mkTask = (id, name, due, created) => ({ ...sched(id, name), dueDate: due, createdAt: created });
    seed([row('x', 5, 'monthly', false, 't1'), row('y', 5, 'monthly', true, 't2'), row('z', 5, 'monthly', false, 't3')],
      [mkTask('t1', 'Switch x to the subscription card', '2026-12-09', '2026-11-24T15:00:00.000Z'), mkTask('t3', 'Switch z to the subscription card', '2026-12-09', '2026-12-15T15:00:00.000Z'), mkTask('p1', 'Switch x to the subscription card', '2026-12-09', '2026-11-24T15:00:00.000Z'), mkTask('o1', 'Other task', '2026-12-09', '2026-11-24T15:00:00.000Z')]);
    res = subs.saveSettings({ cardArrival: '2026-12-30' });
    const dueOf = id => todoStore.readTasks().find(t => t.id === id).dueDate;
    check('arrival change: open linked switch tasks moved, unlinked/other untouched', [res.status, res.body.movedTasks, dueOf('t1'), dueOf('t3'), dueOf('p1'), dueOf('o1')], [200, 2, '2026-12-30', '2026-12-30', '2026-12-09', '2026-12-09']);
    check('arrival change: persisted, getSettings and totals follow', [subs.getSettings().cardArrival, subs.getSettings().cap, res.body.totals.cardArrival], ['2026-12-30', 300, '2026-12-30']);
    res = subs.saveSettings({ cardArrival: '2026-11-01' });
    check('arrival in the past: due the day after the task was made (or later)', [dueOf('t1'), dueOf('t3')], ['2026-11-25', '2026-12-16']);
    res = subs.saveSettings({ cap: 450 });
    check('cap change only: no tasks moved, persisted next to arrival', [res.body.movedTasks, subs.getSettings()], [0, { cardArrival: '2026-11-01', cap: 450 }]);
    check('computeTotals uses saved settings', [subs.computeTotals([]).cap, subs.computeTotals([]).cardArrival], [450, '2026-11-01']);
    check('add route rule follows saved arrival', subs.switchDueDate('2026-11-20'), '2026-11-21');
    // completed switch tasks aren't in the task list, so nothing to move; a cancelled row's link is ignored
    seed([{ ...row('c', 5, 'monthly', false, 't1'), status: 'cancelled' }], [mkTask('t1', 'Switch c to the subscription card', '2026-12-09', '2026-11-24T15:00:00.000Z')]);
    res = subs.saveSettings({ cardArrival: '2027-01-15' });
    check('arrival change: cancelled row link ignored', [res.body.movedTasks, dueOf('t1')], [0, '2026-12-09']);
    try { fs.unlinkSync(subs.SETTINGS_FILE); } catch (e) { /* none */ }
    {
      const rs = {};
      const mk2 = (name) => (p, g, h) => { rs[name + ' ' + p] = (req) => { let out = { status: 200 }; const rr = { status(c) { out = { status: c }; return rr; }, json(b) { out.body = b; } }; g(req, rr, () => h(req, rr)); return out; }; };
      const order = [];
      subs.mount({ get: (p, ...a) => { order.push('get ' + p); mk2('get')(p, ...a); }, post() {}, delete() {}, patch: (p, ...a) => { order.push('patch ' + p); mk2('patch')(p, ...a); } }, { isAdminReq: q => !!q.admin, completeScheduled: complete });
      check('settings routes registered before the /:id routes', [order.indexOf('patch /api/subscriptions/settings') < order.indexOf('patch /api/subscriptions/:id'), order.indexOf('get /api/subscriptions/settings') < order.indexOf('get /api/subscriptions')], [true, true]);
      seed([], []);
      check('settings route: non-admin 403, bad 400, good 200', [rs['patch /api/subscriptions/settings']({ params: {}, body: { cap: 5 } }).status, rs['patch /api/subscriptions/settings']({ admin: true, body: { cap: 0 } }).status, rs['patch /api/subscriptions/settings']({ admin: true, body: { cap: 5 } }).status], [403, 400, 200]);
      check('settings route: GET returns saved', rs['get /api/subscriptions/settings']({ admin: true }).body.settings.cap, 5);
      try { fs.unlinkSync(subs.SETTINGS_FILE); } catch (e) { /* none */ }
    }

    // --- phase 4a: still-to-find rows ---
    check('validateNew: toFind with name only ok; with a price rejected; bad renewsOn rejected', [subs.validateNew({ name: 'Mystery', toFind: true }).value, !!subs.validateNew({ name: 'M', toFind: true, price: 3 }).errors, !!subs.validateNew({ name: 'M', renewsOn: '2026-13-01' }).errors],
      [{ name: 'Mystery', price: null, cycle: 'monthly', toFind: true }, true, true]);
    const tf = subs.planCreate([], [], subs.validateNew({ name: 'Mystery', toFind: true }).value, NOW2, '2026-11-24');
    check('toFind create: flagged row, no switch or price task', [tf.row.toFind, tf.row.switchTaskId, tf.createdTasks.length, tf.tasks.length], [true, null, 0, 0]);
    seed([], []);
    res = subs.createSubscription(subs.validateNew({ name: 'Mystery', toFind: true }).value);
    check('toFind create (store): no tasks written', [todoStore.readTasks().length, subs.readSubscriptions()[0].toFind], [0, true]);
    check('toFind counts in no totals', [subs.computeTotal([{ ...row('a', 5, 'monthly', true), toFind: true }]).total, subs.computeTotals([{ ...row('a', 5, 'monthly', false), toFind: true }, { ...row('b', 7, 'yearly', false), toFind: true }]).notMovedMonthly, subs.computeTotals([{ ...row('b', 7, 'yearly', false), toFind: true }]).notMovedYearly], [40, 0, 0]);
    {
      const money = require('./money');
      const empty = { transactions: [], accounts: [], recurring: [], variable: [], rules: [] };
      const sm = money.summarize(empty, '2026-11', [row('a', 10, 'monthly', false), { ...row('b', null, 'monthly', false), toFind: true }]);
      check('money summarize: toFind row skipped', sm.recurring.items.map(i => i.name), ['a']);
    }
    res = subs.markOnCard('mystery', complete);
    check('toFind: mark on card -> 409, stays off', [res.status, subs.readSubscriptions()[0].onCard], [409, false]);
    res = subs.editSubscription('mystery', { onCard: true }, complete);
    check('toFind: PATCH onCard -> 409', res.status, 409);
    res = subs.editSubscription('mystery', { name: 'Mystery 2' }, complete);
    check('toFind: rename keeps it a no-task row', [res.status, res.body.row.toFind, todoStore.readTasks().length], [200, true, 0]);
    res = subs.editSubscription('mystery', { price: 6, cycle: 'monthly' }, complete);
    check('toFind + price -> normal row with a switch task, no price task', [res.body.row.toFind, todoStore.readTasks().map(t => t.name)], [undefined, ['Switch Mystery 2 to the subscription card']]);
    check('toFind converted: switch task linked, autopay untouched when nothing on card', [res.body.row.switchTaskId === todoStore.readTasks()[0].id, apOf().length], [true, 0]);
    seed([{ ...row('m', null, 'monthly', false, null), toFind: true }], []);
    res = subs.editSubscription('m', { toFind: false }, complete);
    check('untick toFind without a price -> switch and price tasks', [res.body.row.toFind, todoStore.readTasks().map(t => t.name).sort()], [undefined, ['Add the price for m to the subscriptions list', 'Switch m to the subscription card']]);
    res = subs.editSubscription('m', { toFind: true }, complete);
    check('normal row cannot be flipped to still-to-find -> 409', res.status, 409);
    seed([{ ...row('m', null, 'monthly', false, null), toFind: true }], []);
    res = subs.editSubscription('m', { toFind: true, price: 4 }, complete);
    check('toFind true with a price -> 400', res.status, 400);
    // cancel / restore / delete a toFind row
    seed([{ ...row('m', null, 'monthly', false, null), toFind: true }], [sched('t5', 'Other')]);
    res = subs.cancelSubscription('m');
    res = subs.restoreSubscription('m');
    check('toFind: cancel then restore keeps it still-to-find, no tasks added', [res.body.row.toFind, todoStore.readTasks().map(t => t.id)], [true, ['t5']]);
    res = subs.deleteSubscription('m');
    check('toFind: delete', [res.status, subs.readSubscriptions().length], [200, 0]);

    // --- phase 4b: renewals ---
    const RN = n => `Renews in 7 days: keep or cancel ${n}?`;
    const renewTasks = () => todoStore.readTasks().filter(t => t.name.startsWith('Renews in 7 days'));
    seed([row('x', 50, 'yearly', false, 't1')], [sched('t1', 'Switch x to the subscription card')]);
    res = subs.editSubscription('x', { renewsOn: '2027-03-15' }, complete);
    check('renewsOn on a yearly row: one task, due 7 days before, Chores, linked', [renewTasks().length, renewTasks()[0].name, renewTasks()[0].dueDate, renewTasks()[0].project, renewTasks()[0].type, res.body.row.renewTaskId === renewTasks()[0].id, res.body.row.renewsOn], [1, RN('x'), '2027-03-08', 'Chores', 'scheduled', true, '2027-03-15']);
    check('renew task carries no price', /\$|\d+\.\d\d/.test(renewTasks()[0].name + (renewTasks()[0].notes || '')), false);
    res = subs.editSubscription('x', { renewsOn: '2027-04-01' }, complete);
    check('changing renewsOn moves the same task', [renewTasks().length, renewTasks()[0].dueDate], [1, '2027-03-25']);
    res = subs.editSubscription('x', { price: 60 }, complete);
    check('unrelated edit leaves the renew task alone', [renewTasks().length, renewTasks()[0].dueDate], [1, '2027-03-25']);
    res = subs.editSubscription('x', { name: 'Xtra' }, complete);
    check('rename renames the renew task', renewTasks().map(t => t.name), [RN('Xtra')]);
    res = subs.editSubscription('x', { renewsOn: '2020-01-01' }, complete);
    check('renewal date already past -> due today', renewTasks()[0].dueDate, todoEngine.todayString());
    res = subs.editSubscription('x', { renewsOn: '2027-04-01', cycle: 'monthly' }, complete);
    check('cycle -> monthly removes the renew task, keeps the date', [renewTasks().length, res.body.row.renewTaskId, res.body.row.renewsOn], [0, undefined, '2027-04-01']);
    res = subs.editSubscription('x', { cycle: 'yearly' }, complete);
    check('cycle back to yearly with a date -> task again', renewTasks().length, 1);
    res = subs.editSubscription('x', { renewsOn: null }, complete);
    check('clearing renewsOn removes the task', [renewTasks().length, 'renewsOn' in res.body.row, 'renewTaskId' in res.body.row], [0, false, false]);
    res = subs.editSubscription('x', { renewsOn: '2027-04-01' }, complete);
    res = subs.cancelSubscription('x');
    check('cancel removes the renew task (and its link), keeps the date', [renewTasks().length, 'renewTaskId' in res.body.row, res.body.row.renewsOn], [0, false, '2027-04-01']);
    res = subs.restoreSubscription('x');
    check('restore brings the renew task back', renewTasks().length, 1);
    res = subs.deleteSubscription('x');
    check('delete removes the renew task', renewTasks().length, 0);
    // completing it does nothing else, and later edits don't resurrect it
    seed([row('x', 50, 'yearly', false, 't1')], [sched('t1', 'Switch x to the subscription card')]);
    res = subs.editSubscription('x', { renewsOn: '2027-03-15' }, complete);
    complete(todoStore.readTasks(), renewTasks()[0]);
    check('completing the renew task: row unchanged apart from the stale link', [subs.readSubscriptions()[0].renewsOn, subs.readSubscriptions()[0].onCard, todoStore.readTasks().map(t => t.id)], ['2027-03-15', false, ['t1']]);
    res = subs.editSubscription('x', { price: 61 }, complete);
    check('after completing, an unrelated edit does not recreate it', renewTasks().length, 0);
    res = subs.editSubscription('x', { renewsOn: '2028-03-15' }, complete);
    check('after completing, a new date creates the next one', renewTasks().length, 1);
    // monthly rows and toFind rows never get one
    seed([], []);
    res = subs.createSubscription(subs.validateNew({ name: 'Mo', cycle: 'monthly', renewsOn: '2027-05-05', price: 3 }).value);
    check('monthly row with renewsOn: no renew task', renewTasks().length, 0);
    res = subs.createSubscription(subs.validateNew({ name: 'Yr', cycle: 'yearly', renewsOn: '2027-05-05', price: 3 }).value);
    check('add a yearly row with renewsOn: switch task and renew task', [todoStore.readTasks().map(t => t.name).sort()], [['Renews in 7 days: keep or cancel Yr?', 'Switch Mo to the subscription card', 'Switch Yr to the subscription card']]);
    check('validatePatch: renewsOn good, null clears, bad rejected, toFind bool', [subs.validatePatch({ renewsOn: '2027-01-02' }).value, subs.validatePatch({ renewsOn: '' }).value, !!subs.validatePatch({ renewsOn: '01/02/2027' }).errors, !!subs.validatePatch({ toFind: 'y' }).errors, subs.validatePatch({ toFind: false }).value],
      [{ renewsOn: '2027-01-02' }, { renewsOn: null }, true, true, { toFind: false }]);

    // unknown id
    seed([row('x', 1, 'monthly', false, 't1')], []);
    res = subs.editSubscription('nope', { price: 1 }, complete);
    check('edit: unknown id -> 404', res.status, 404);
  } finally {
    files.forEach((f, i) => { if (backup[i] === null) { try { fs.unlinkSync(f); } catch (e) {} } else fs.writeFileSync(f, backup[i]); });
  }
}

console.log(`${passed} checks passed`);
