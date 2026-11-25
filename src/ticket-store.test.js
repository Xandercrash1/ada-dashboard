// Tests for ticket-store.js and ticket-tasks.js (task automation phase 2). Run: node --test src/ticket-store.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const engine = require('./todo-engine');
const A = require('./task-automation');
const T = require('./ticket-store');
const TT = require('./ticket-tasks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-test-'));

test('create, then the same key: open -> updated (no second ticket), closed -> reopened', () => {
  const s = T.open(tmp());
  const a = s.create({ type: 'bug', title: 'Health check: disk', body: 'x', dedupeKey: 'health:disk' });
  assert.strictEqual(a.outcome, 'created');
  const b = s.create({ type: 'bug', title: 'Health check: disk', body: 'y', dedupeKey: 'health:disk' });
  assert.strictEqual(b.outcome, 'updated'); assert.strictEqual(b.item.id, a.item.id); assert.strictEqual(b.item.repeats, 2);
  assert.strictEqual(s.read().length, 1);
  assert.strictEqual(s.resolve('health:disk', { note: 'passed again' }).item.status, 'done');
  assert.ok(s.read()[0].processedAt);
  assert.strictEqual(s.resolve('health:disk').item, null, 'resolving twice does nothing');
  const c = s.create({ type: 'bug', title: 'Health check: disk', body: 'z', dedupeKey: 'health:disk' });
  assert.strictEqual(c.outcome, 'reopened'); assert.strictEqual(c.item.status, 'new'); assert.strictEqual(c.item.repeats, 3);
  assert.match(c.item.notes, /reopened/);
  assert.strictEqual(s.read().length, 1);
  // no key: always a new ticket, unique ids
  s.create({ type: 'idea', title: 'one' }); s.create({ type: 'idea', title: 'two' });
  const ids = s.read().map((i) => i.id); assert.strictEqual(new Set(ids).size, ids.length);
});

test('validation, update, remove, and a broken file is never overwritten', () => {
  const dir = tmp(), s = T.open(dir);
  assert.ok(s.create({ type: 'nope', title: 'x' }).error);
  assert.ok(s.create({ type: 'bug', title: '  ' }).error);
  const { item } = s.create({ type: 'bug', title: 'x' });
  assert.ok(s.update(item.id, { status: 'bogus' }).error);
  assert.strictEqual(s.update(item.id, { status: 'in-progress', needsAlex: true }).item.needsAlex, true);
  assert.ok(s.update('fb-missing', { status: 'done' }).notFound);
  assert.ok(s.remove('fb-missing').notFound);
  s.remove(item.id); assert.strictEqual(s.read().length, 0);
  fs.writeFileSync(path.join(dir, 'feedback.json'), '{broken');
  assert.throws(() => s.create({ type: 'bug', title: 'y' }), /not valid JSON/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8'), '{broken');
  assert.ok(!fs.existsSync(path.join(dir, '.feedback.lock')), 'lock released after a throw');
});

test('two processes writing at once lose nothing (the lock)', () => {
  const dir = tmp();
  const script = `const s=require(${JSON.stringify(path.join(__dirname, 'ticket-store'))}).open(${JSON.stringify(dir)});for(let i=0;i<40;i++)s.create({type:'bug',title:process.argv[1]+i});`;
  const { spawn } = require('child_process');
  return Promise.all(['a', 'b', 'c'].map((tag) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', script, tag]); p.on('exit', (c) => (c === 0 ? res() : rej(new Error('exit ' + c))));
  }))).then(() => {
    const items = T.open(dir).read();
    assert.strictEqual(items.length, 120);
    assert.strictEqual(new Set(items.map((i) => i.id)).size, 120);
  });
});

function world() {
  A.rules.clear();
  const dir = tmp();
  const f = (n) => path.join(dir, n);
  const rd = (n) => { try { return JSON.parse(fs.readFileSync(f(n), 'utf8')); } catch (e) { return []; } };
  const wr = (n, v) => fs.writeFileSync(f(n), JSON.stringify(v));
  const store = { DATA_DIR: dir, withLock: (fn) => fn(), readTasks: () => rd('todo_tasks.json'), writeTasks: (t) => wr('todo_tasks.json', t), readCompleted: () => rd('todo_completed.json'), writeCompleted: (c) => wr('todo_completed.json', c) };
  const tickets = T.open(dir);
  A.register('ticket-task', { onComplete: TT.rule(tickets) });
  const automation = A.create({ store, engine, dataDir: dir });
  const sync = TT.create({ tickets, store, automation, upsertAutoTask: A.upsertAutoTask, engine }).sync;
  const taskFor = (id) => store.readTasks().find((t) => t.autoKind === 'ticket' && t.autoKey === id);
  return { store, tickets, automation, sync, taskFor, rd };
}

test('needs Alex -> exactly one task; checking it off closes the ticket', () => {
  const w = world();
  const { item } = w.tickets.create({ type: 'bug', title: 'Run the sudo step', needsAlex: true });
  w.tickets.create({ type: 'bug', title: 'Plain ticket' });
  assert.strictEqual(w.sync().created, 1);
  assert.strictEqual(w.sync().created, 0, 'sync is idempotent');
  const task = w.taskFor(item.id);
  assert.ok(task); assert.strictEqual(task.name, 'Ticket: Run the sudo step'); assert.strictEqual(task.owner, 'alex');
  assert.strictEqual(w.store.readTasks().length, 1);
  assert.strictEqual(w.tickets.read().find((t) => t.id === item.id).taskId, task.id);
  w.automation.completeLocked(w.store.readTasks(), task, { source: 'user' });
  const tk = w.tickets.read().find((t) => t.id === item.id);
  assert.strictEqual(tk.status, 'done'); assert.match(tk.notes, /checked off its task/);
  assert.strictEqual(w.sync().created, 0, 'a closed ticket never gets a new task');
});

test('ticket closed elsewhere -> its task closes; the rule does not touch the ticket again', () => {
  const w = world();
  const { item } = w.tickets.create({ type: 'bug', title: 'x', needsAlex: true });
  w.sync();
  w.tickets.update(item.id, { status: 'wont-do', notes: 'decided against it' });
  assert.strictEqual(w.sync().closedTasks, 1);
  assert.strictEqual(w.taskFor(item.id), undefined);
  const tk = w.tickets.read()[0];
  assert.strictEqual(tk.status, 'wont-do'); assert.strictEqual(tk.notes, 'decided against it');
  assert.strictEqual(w.store.readCompleted()[0].source, 'automation:ticket-task');
});

test('unflag closes the task but leaves the ticket open; flag again -> a fresh task', () => {
  const w = world();
  const { item } = w.tickets.create({ type: 'bug', title: 'x', needsAlex: true });
  w.sync(); const first = w.taskFor(item.id).id;
  w.tickets.update(item.id, { needsAlex: false }); w.sync();
  assert.strictEqual(w.taskFor(item.id), undefined); assert.strictEqual(w.tickets.read()[0].status, 'new');
  w.tickets.update(item.id, { needsAlex: true }); w.sync();
  assert.ok(w.taskFor(item.id)); assert.notStrictEqual(w.taskFor(item.id).id, first);
  assert.strictEqual(w.tickets.read()[0].status, 'new');
});

test('repair paths: a lost rule run still closes the ticket; a deleted task unflags instead of looping', () => {
  const w = world();
  const a = w.tickets.create({ type: 'bug', title: 'a', needsAlex: true }).item;
  const b = w.tickets.create({ type: 'bug', title: 'b', needsAlex: true }).item;
  w.sync();
  // a: completed while the rule was missing (e.g. a crash): history has it, the ticket is still open
  A.rules.clear();
  w.automation.completeLocked(w.store.readTasks(), w.taskFor(a.id), { source: 'user' });
  assert.strictEqual(w.tickets.read().find((t) => t.id === a.id).status, 'new');
  // b: task deleted by hand
  w.store.writeTasks(w.store.readTasks().filter((t) => t.autoKey !== b.id));
  const r = w.sync();
  assert.strictEqual(r.closedTickets, 1); assert.strictEqual(r.unflagged, 1); assert.strictEqual(r.created, 0);
  assert.strictEqual(w.tickets.read().find((t) => t.id === a.id).status, 'done');
  const tb = w.tickets.read().find((t) => t.id === b.id);
  assert.strictEqual(tb.needsAlex, false); assert.strictEqual(tb.status, 'new');
  assert.strictEqual(w.sync().created, 0, 'nothing comes back');
});

test('a reopened ticket that needs Alex gets a new task', () => {
  const w = world();
  const { item } = w.tickets.create({ type: 'bug', title: 'x', needsAlex: true, dedupeKey: 'k' });
  w.sync();
  w.automation.completeLocked(w.store.readTasks(), w.taskFor(item.id), { source: 'user' });
  assert.strictEqual(w.tickets.read()[0].status, 'done');
  assert.strictEqual(w.tickets.create({ type: 'bug', title: 'x', dedupeKey: 'k' }).outcome, 'reopened');
  assert.strictEqual(w.sync().created, 1);
});

test('review fixes: hand-reopen and refile-with-flag are not closed again; reopen drops stage/session, keeps body; wont-do stays', () => {
  const w = world();
  // #1 reopened by hand after Alex finished its task
  const a = w.tickets.create({ type: 'bug', title: 'a', needsAlex: true }).item;
  w.sync(); w.automation.completeLocked(w.store.readTasks(), w.taskFor(a.id), { source: 'user' });
  w.tickets.update(a.id, { status: 'new' }); w.sync();
  assert.strictEqual(w.tickets.read().find((t) => t.id === a.id).status, 'new');
  assert.ok(w.taskFor(a.id), 'a fresh task instead');
  // #2 unflag, then the same key filed again with the flag
  const b = w.tickets.create({ type: 'bug', title: 'b', needsAlex: true, dedupeKey: 'kb' }).item;
  w.sync(); w.tickets.update(b.id, { needsAlex: false }); w.sync();
  w.tickets.create({ type: 'bug', title: 'b', needsAlex: true, dedupeKey: 'kb' }); w.sync();
  assert.strictEqual(w.tickets.read().find((t) => t.id === b.id).status, 'new');
  assert.ok(w.taskFor(b.id));
  // #3/#4 reopen clears stagedAt/sessionId and keeps the original body
  const c = w.tickets.create({ type: 'bug', title: 'c', body: 'original', dedupeKey: 'kc' }).item;
  w.tickets.mutate((items) => { const t = items.find((i) => i.id === c.id); t.stagedAt = 'x'; t.sessionId = 's'; });
  w.tickets.update(c.id, { status: 'done' });
  const r = w.tickets.create({ type: 'bug', title: 'c', body: 'different', dedupeKey: 'kc' });
  assert.strictEqual(r.outcome, 'reopened'); assert.strictEqual(r.item.body, 'original');
  assert.strictEqual(r.item.stagedAt, undefined); assert.strictEqual(r.item.sessionId, undefined); assert.match(r.item.notes, /different/);
  // wont-do is counted, not reopened
  const d = w.tickets.create({ type: 'bug', title: 'd', dedupeKey: 'kd' }).item;
  w.tickets.update(d.id, { status: 'wont-do' });
  assert.strictEqual(w.tickets.create({ type: 'bug', title: 'd', dedupeKey: 'kd' }).item.status, 'wont-do');
});

test('review fix: a missing ticket file closes no tasks', () => {
  const w = world();
  w.tickets.create({ type: 'bug', title: 'x', needsAlex: true }); w.sync();
  fs.renameSync(w.tickets.FILE, w.tickets.FILE + '.away');
  assert.strictEqual(w.sync().closedTasks, 0);
  assert.strictEqual(w.store.readTasks().length, 1);
});
