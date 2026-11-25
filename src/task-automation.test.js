// Contract tests for task-automation.js (docs/TASK-AUTOMATION.md). Run: node --test src/task-automation.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('./todo-engine');
const A = require('./task-automation');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-test-'));
  const f = (n) => path.join(dir, n);
  const rd = (n) => { try { return JSON.parse(fs.readFileSync(f(n), 'utf8')); } catch (e) { return []; } };
  const wr = (n, v) => fs.writeFileSync(f(n), JSON.stringify(v));
  const store = { DATA_DIR: dir, readTasks: () => rd('todo_tasks.json'), writeTasks: (t) => wr('todo_tasks.json', t), readCompleted: () => rd('todo_completed.json'), writeCompleted: (c) => wr('todo_completed.json', c) };
  let t = Date.parse('2026-11-24T17:00:00Z');
  const clock = () => new Date(t);
  const deadOnes = [];
  const auto = A.create({ store, engine, dataDir: dir, clock, onDeadLetter: (j, why) => deadOnes.push(why) });
  return { store, auto, rd, advance: (ms) => { t += ms; }, deadOnes };
}
const sched = (id, extra = {}) => ({ id, type: 'scheduled', name: id, project: 'Chores', dueDate: '2026-11-24', ...extra });
const reset = () => A.rules.clear();

test('completion: history then removal, same body as before; repeating task moves on and is not logged', () => {
  reset(); const { store, auto } = setup();
  store.writeTasks([sched('a'), { id: 'r', type: 'recurring', name: 'Feed cats', frequency: 'Daily', nextDue: '2026-11-24' }]);
  const r = auto.completeLocked(store.readTasks(), store.readTasks()[0]);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.success, true); assert.strictEqual(r.body.completedEntry.taskId, 'a');
  assert.deepStrictEqual(store.readTasks().map((t) => t.id), ['r']);
  const rr = auto.completeLocked(store.readTasks(), store.readTasks()[0]);
  assert.strictEqual(rr.body.lastCompleted, '2026-11-24'); assert.ok(rr.body.nextDue > rr.body.lastCompleted);
  assert.strictEqual(store.readCompleted().length, 1);
});

test('rule runs inline, once; running the same key again does nothing extra; upsert never duplicates', () => {
  reset(); const { store, auto, rd } = setup();
  let runs = 0;
  A.register('count-up', { onComplete: (task, tasks, ctx) => { runs++; return A.upsertAutoTask(tasks, 'counter', null, { name: `Done: ${task.name}`, project: 'Chores', dueDate: ctx.today }, ctx); } });
  store.writeTasks([sched('a'), sched('b')]);
  auto.completeLocked(store.readTasks(), store.readTasks().find((t) => t.id === 'a'));
  auto.completeLocked(store.readTasks(), store.readTasks().find((t) => t.id === 'b'));
  const auto2 = store.readTasks().filter((t) => t.autoKind === 'counter');
  assert.strictEqual(auto2.length, 1); assert.strictEqual(auto2[0].name, 'Done: b'); assert.strictEqual(runs, 2);
  assert.deepStrictEqual(auto.enqueue([{ key: 'count-up:a', rule: 'count-up', task: sched('a'), depth: 0 }]), []);   // already done: not queued again
  assert.deepStrictEqual(rd('automation-queue.json'), []);
});

test('a failing rule never undoes the completion; it retries with backoff and dead-letters after 5 tries with one ticket', () => {
  reset(); const { store, auto, rd, advance, deadOnes } = setup();
  let fail = true;
  A.register('flaky', { onComplete: () => { if (fail) throw new Error('boom'); return undefined; } });
  store.writeTasks([sched('a')]);
  const r = auto.completeLocked(store.readTasks(), store.readTasks()[0]);
  assert.strictEqual(r.body.success, true); assert.deepStrictEqual(store.readTasks(), []);
  assert.strictEqual(rd('automation-queue.json')[0].attempts, 1);
  assert.strictEqual(auto.drain(), 0);   // not due yet (backoff)
  for (let i = 0; i < 4; i++) { advance(3 * 3600e3); auto.drain(); }
  assert.deepStrictEqual(rd('automation-queue.json'), []);
  assert.strictEqual(rd('automation-dead.json').length, 1); assert.strictEqual(deadOnes.length, 1);
  // and a recovered rule goes through on retry
  reset(); A.register('flaky', { onComplete: () => { if (fail) throw new Error('boom'); } });
  store.writeTasks([sched('b')]);
  auto.completeLocked(store.readTasks(), store.readTasks()[0]);
  fail = false; advance(70e3); auto.drain();   // first retry is about a minute later
  assert.deepStrictEqual(rd('automation-queue.json'), []);
  assert.ok(rd('automation-log.json').some((l) => l.key === 'flaky:b' && l.result === 'done'));
});

test('then-chains create the next task; a hand-ticked chain never hits the cap, an automated one stops at depth 3', () => {
  reset(); const { store, auto, rd } = setup();
  store.writeTasks([sched('a', { then: { name: 'Write the thank-you note', dueInDays: 2 } })]);
  auto.completeLocked(store.readTasks(), store.readTasks()[0]);
  const made = store.readTasks()[0];
  assert.strictEqual(made.name, 'Write the thank-you note'); assert.strictEqual(made.dueDate, '2026-11-26'); assert.strictEqual(made.autoKind, 'then');
  let chain = { name: 'last' }; for (let i = 5; i >= 1; i--) chain = { name: `step ${i}`, then: chain };
  store.writeTasks([sched('x', { then: chain })]);
  const names = [];
  for (let i = 0; i < 8 && store.readTasks().length; i++) { const t = store.readTasks()[0]; names.push(t.name); auto.completeLocked(store.readTasks(), t); }
  assert.deepStrictEqual(names, ['x', 'step 1', 'step 2', 'step 3', 'step 4', 'step 5', 'last']);   // by hand: no cap
  assert.deepStrictEqual(rd('automation-dead.json'), []);
  store.writeTasks([sched('y', { then: { name: 'deep' } })]);
  auto.completeLocked(store.readTasks(), store.readTasks()[0], { source: 'automation:test', depth: 3 });   // an automation already 3 deep
  assert.ok(rd('automation-dead.json').some((d) => /deeper than 3/.test(d.why)));
});

test('a broken automation file never blocks a completion; it is set aside and started fresh', () => {
  reset(); const { store, auto, rd } = setup();
  A.register('noop', { onComplete: () => undefined });
  fs.writeFileSync(path.join(store.DATA_DIR, 'automation-log.json'), '{not json');
  store.writeTasks([sched('a')]);
  const r = auto.completeLocked(store.readTasks(), store.readTasks()[0]);
  assert.strictEqual(r.body.success, true); assert.deepStrictEqual(store.readTasks(), []);
  assert.ok(fs.readdirSync(store.DATA_DIR).some((f) => f.startsWith('automation-log.json.corrupt-')));
});

test('dead jobs from a process without a ticket hook get their ticket from the next worker run', () => {
  reset(); const { store, rd } = setup();
  const tickets = [];
  const cli = A.create({ store, engine, dataDir: store.DATA_DIR });   // like todo-cli: no onDeadLetter
  const server = A.create({ store, engine, dataDir: store.DATA_DIR, onDeadLetter: (j) => tickets.push(j.key) });
  store.writeTasks([sched('a', { then: { name: 'x' } })]);
  cli.completeLocked(store.readTasks(), store.readTasks()[0], { source: 'automation:test', depth: 5 });
  assert.strictEqual(rd('automation-dead.json')[0].ticketed, undefined);
  server.drain();
  assert.deepStrictEqual(tickets, ['then:a']); assert.strictEqual(rd('automation-dead.json')[0].ticketed, true);
  server.drain(); assert.strictEqual(tickets.length, 1);   // one ticket only
});

test('a queued job whose completion was never saved is dropped, not run', () => {
  reset(); const { store, auto, rd, advance } = setup();
  let ran = false;
  A.register('watch', { onComplete: () => { ran = true; } });
  store.writeTasks([sched('a')]);
  auto.enqueue([{ key: 'watch:a', rule: 'watch', task: sched('a'), depth: 0 }]);   // as if the process died right after queueing
  store.writeTasks([sched('a'), { id: 'r', type: 'recurring', name: 'Feed cats', frequency: 'Daily', nextDue: '2026-11-24' }]);
  auto.enqueue([{ key: `watch:r:${engine.todayString()}`, rule: 'watch', task: { id: 'r', type: 'recurring' }, depth: 0 }]);   // a repeating completion that never saved
  advance(120e3); auto.drain();
  assert.strictEqual(ran, false); assert.deepStrictEqual(rd('automation-queue.json'), []);
  assert.strictEqual(rd('automation-log.json').filter((l) => l.result === 'dropped').length, 2);
});

test('resolveAuto closes a rule\'s own task through the same path', () => {
  reset(); const { store, auto } = setup();
  store.writeTasks([sched('u', { autoKind: 'use-or-freeze', autoKey: 'item-1' }), sched('v', { autoKind: 'use-or-freeze', autoKey: 'item-2' })]);
  const r = auto.resolveAuto('use-or-freeze', 'item-1');
  assert.strictEqual(r.body.completedEntry.source, 'automation:use-or-freeze');
  assert.deepStrictEqual(store.readTasks().map((t) => t.id), ['v']);
  assert.strictEqual(auto.resolveAuto('use-or-freeze', 'item-1'), null);
});
