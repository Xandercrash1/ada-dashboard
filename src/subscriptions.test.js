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

console.log(`${passed} checks passed`);
