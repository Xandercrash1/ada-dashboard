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

console.log(`${passed} checks passed`);
