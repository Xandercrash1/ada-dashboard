'use strict';

/**
 * Tests for subscriptions.js (pure logic). Run: node src/subscriptions.test.js
 * Exits non-zero on failure.
 */

const assert = require('assert');
const subs = require('./subscriptions');

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
  const files = [subs.SUBS_FILE, path.join(todoStore.DATA_DIR, 'todo_tasks.json'), path.join(todoStore.DATA_DIR, 'todo_completed.json')];
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
  const files = [subs.SUBS_FILE, path.join(todoStore.DATA_DIR, 'todo_tasks.json'), path.join(todoStore.DATA_DIR, 'todo_completed.json')];
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

    // route wiring with a fake app: 403 for non-admin, 400 for bad input, 404 for unknown id
    const routes = {};
    subs.mount({ get() {}, post() {}, patch(p, g, h) { routes.patch = (req) => { let out; const res = { status(c) { out = { status: c }; return res; }, json(b) { out.body = b; } }; g(req, res, () => h(req, res)); return out; }; } }, { isAdminReq: r => !!r.admin, completeScheduled: complete });
    seed([row('x', 1, 'monthly', false, 't1')], []);
    check('route: non-admin -> 403', routes.patch({ params: { id: 'x' }, body: { price: 2 } }).status, 403);
    check('route: bad input -> 400', routes.patch({ admin: true, params: { id: 'x' }, body: { price: 'abc' } }).status, 400);
    check('route: empty body -> 400', routes.patch({ admin: true, params: { id: 'x' }, body: {} }).status, 400);
    check('route: unknown id -> 404', routes.patch({ admin: true, params: { id: 'nope' }, body: { price: 2 } }).status, 404);
    check('route: good -> 200', routes.patch({ admin: true, params: { id: 'x' }, body: { price: 2 } }).status, 200);

    // unknown id
    seed([row('x', 1, 'monthly', false, 't1')], []);
    res = subs.editSubscription('nope', { price: 1 }, complete);
    check('edit: unknown id -> 404', res.status, 404);
  } finally {
    files.forEach((f, i) => { if (backup[i] === null) { try { fs.unlinkSync(f); } catch (e) {} } else fs.writeFileSync(f, backup[i]); });
  }
}

console.log(`${passed} checks passed`);
