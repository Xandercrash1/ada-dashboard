'use strict';
const test = require('node:test');
const assert = require('node:assert');
const engine = require('./todo-engine');
const { normalizeTask } = require('./todo-validate');
const { rule } = require('./waits-for');

const mk = (o) => ({ id: 'task-x', type: 'backlog', name: 'n', project: 'P', priority: 'Low', notes: '', tags: [], added: '2026-11-01', ...o });
const ctx = { today: '2026-11-26' };   // a Thursday

test('business-day math', () => {
  assert.strictEqual(engine.addBusinessDays('2026-11-27', 1), '2026-11-30');   // Fri + 1 = Mon
  assert.strictEqual(engine.addBusinessDays('2026-11-25', 10), '2026-12-09');  // Wed + 10 = Wed two weeks on
  assert.strictEqual(engine.addBusinessDays('2026-11-26', 0), '2026-11-26');
  assert.strictEqual(engine.addBusinessDays('2026-11-28', 1), '2026-11-30');   // Sat + 1 = Mon
});

test('completion reschedules waiters, leaves everything else', () => {
  const target = mk({ id: 'task-t', name: 'Order the new TV', releaseBusinessDays: 10 });
  const waiter = mk({ id: 'task-w', name: 'Set up AdaTwo screen', notes: 'old', priority: 'High' });
  const sched = mk({ id: 'task-s', type: 'scheduled', dueDate: '2026-12-01', waitsFor: 'task-t' });
  const rec = mk({ id: 'task-r', type: 'recurring', frequency: 'Daily', nextDue: '2026-11-26', waitsFor: 'task-t' });
  const other = mk({ id: 'task-o', waitsFor: 'task-zzz' });
  const plain = mk({ id: 'task-p' });
  waiter.waitsFor = 'task-t';
  const tasks = [waiter, sched, rec, other, plain];
  const out = rule(target, tasks, ctx);
  const by = (id) => out.find((t) => t.id === id);
  assert.strictEqual(by('task-w').type, 'scheduled');
  assert.strictEqual(by('task-w').dueDate, '2026-12-10');
  assert.strictEqual(by('task-w').waitsFor, null);
  assert.strictEqual(by('task-w').priority, 'High');
  assert.ok(by('task-w').notes.startsWith('Rescheduled 2026-12-10: "Order the new TV" was checked off (waited on it).\nold'));
  assert.strictEqual(by('task-s').dueDate, '2026-12-10');
  assert.strictEqual(by('task-r').waitsFor, 'task-t');
  assert.strictEqual(by('task-r').nextDue, '2026-11-26');
  assert.deepStrictEqual(by('task-o'), other);
  assert.deepStrictEqual(by('task-p'), plain);
  assert.strictEqual(tasks[0].waitsFor, 'task-t', 'input not mutated');
});

test('idempotent: a second run changes nothing', () => {
  const target = mk({ id: 'task-t', name: 'T' });
  const once = rule(target, [mk({ id: 'task-w', waitsFor: 'task-t' })], ctx);
  assert.strictEqual(once[0].dueDate, '2026-11-26');   // null release = completion day
  assert.strictEqual(rule(target, once, ctx), undefined);
});

test('validation', () => {
  const base = { type: 'backlog', name: 'a', project: 'P' };
  assert.strictEqual(normalizeTask({ ...base, waitsFor: 'task-abc-123', releaseBusinessDays: 10 }, null).task.waitsFor, 'task-abc-123');
  assert.strictEqual(normalizeTask({ ...base, releaseBusinessDays: '7' }, null).task.releaseBusinessDays, 7);
  assert.strictEqual(normalizeTask(base, null).task.waitsFor, null);
  assert.strictEqual(normalizeTask({ ...base, waitsFor: '' }, null).task.waitsFor, null);
  for (const bad of [{ waitsFor: 'nope' }, { waitsFor: 'task-' }, { releaseBusinessDays: 61 }, { releaseBusinessDays: -1 }, { releaseBusinessDays: 1.5 }, { releaseBusinessDays: 'x' }]) {
    assert.ok(normalizeTask({ ...base, ...bad }, null).errors, JSON.stringify(bad));
  }
  assert.ok(normalizeTask({ waitsFor: 'task-me' }, mk({ id: 'task-me' })).errors, 'not itself');
  // PATCH keeps values
  const ex = mk({ id: 'task-e', waitsFor: 'task-t', releaseBusinessDays: 5 });
  const r = normalizeTask({ name: 'renamed' }, ex).task;
  assert.strictEqual(r.waitsFor, 'task-t'); assert.strictEqual(r.releaseBusinessDays, 5);
});

test('engine hides waiting tasks until the target is gone', () => {
  const target = mk({ id: 'task-t', type: 'scheduled', dueDate: '2026-11-26' });
  const waiter = mk({ id: 'task-w', type: 'scheduled', dueDate: '2026-11-26', waitsFor: 'task-t' });
  const bl = mk({ id: 'task-b', waitsFor: 'task-t' });
  const ids = (v) => [...v.pastDue, ...v.today, ...v.upcoming].map((t) => t.id);
  const hidden = engine.buildView([target, waiter, bl], '2026-11-26');
  assert.deepStrictEqual(ids(hidden), ['task-t']);
  const shown = engine.buildView([waiter, bl], '2026-11-26');   // target deleted
  assert.ok(ids(shown).includes('task-w'));
  assert.strictEqual(engine.withoutWaiting([target, waiter]).length, 1);
});
