// Tests for loop.js, the dashboard side of the self-improvement loop. Run: node --test src/loop.test.js
// Nothing here touches the real ~/ops/loop or starts a real deploy: HOME is pointed at a temp dir BEFORE loop.js is
// loaded (loop.js reads HOME at require time), so OPS and LIVE_SRC live under that temp dir. For the "live checkout"
// cases the module is copied to <tmpHome>/dashboard/src/ so isLive() is true, and deploy-ticket.py there is a STUB
// that only writes a marker file. Not covered: the complete-route gate (403 unless alex, 409 without confirm) lives in
// server.js's route and needs the whole server; only its rule side (loop-deploy) is tested here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const engine = require('./todo-engine');
const A = require('./task-automation');
const T = require('./ticket-store');

const REAL_HOME = process.env.HOME;
test.after(() => { process.env.HOME = REAL_HOME; });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Build a harness. live=true loads a copy of loop.js from <home>/dashboard/src (isLive() true); otherwise the repo's own.
function harness({ live = false, buildEnabled = false } = {}) {
  const home = tmp('loop-home-');
  const ops = path.join(home, 'ops', 'loop');
  fs.mkdirSync(path.join(ops, 'logs'), { recursive: true });
  if (buildEnabled) fs.writeFileSync(path.join(ops, 'BUILD_ENABLED'), '');
  // stub runner: records its arguments, never does anything else
  fs.writeFileSync(path.join(ops, 'deploy-ticket.py'), `import sys\nopen(${JSON.stringify(path.join(home, 'ran.txt'))}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n`);
  let modPath;
  if (live) {
    const src = path.join(home, 'dashboard', 'src'); fs.mkdirSync(src, { recursive: true });
    for (const f of ['loop.js', 'ticket-store.js']) fs.copyFileSync(path.join(__dirname, f), path.join(src, f));
    modPath = path.join(src, 'loop.js');
  } else {
    modPath = path.join(__dirname, 'loop.js');
  }
  process.env.HOME = home;
  delete require.cache[require.resolve(modPath)];
  const loopMod = require(modPath);
  process.env.HOME = REAL_HOME;

  const dataDir = tmp('loop-data-');
  const rd = (n) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, n), 'utf8')); } catch (e) { return []; } };
  const wr = (n, v) => fs.writeFileSync(path.join(dataDir, n), JSON.stringify(v));
  const store = { DATA_DIR: dataDir, withLock: (fn) => fn(), readTasks: () => rd('todo_tasks.json'), writeTasks: (t) => wr('todo_tasks.json', t), readCompleted: () => rd('todo_completed.json'), writeCompleted: (c) => wr('todo_completed.json', c) };
  const automation = A.create({ store, engine, dataDir });
  const tickets = T.open(tmp('loop-tk-'));
  let syncs = 0;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.isAdmin = req.get('x-admin') === '1'; next(); });
  const loop = loopMod.create({ app, tickets, store, upsertAutoTask: A.upsertAutoTask, engine, automation, isAdminReq: (req) => req.isAdmin, sync: () => { syncs++; } });
  return { home, ops, loopMod, loop, store, automation, tickets, app, rd, syncCount: () => syncs, ran: () => { try { return fs.readFileSync(path.join(home, 'ran.txt'), 'utf8'); } catch (e) { return ''; } } };
}

function call(app, method, url, body, admin = true) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: url, method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin': '1' } : {}) } }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; });
        res.on('end', () => { srv.close(); let json = null; try { json = JSON.parse(s); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(data);
    });
  });
}
const mk = (h, extra = {}) => h.tickets.create({ type: 'idea', title: 'Make X better', ...extra }).item;
const deployTasks = (h) => h.store.readTasks().filter((t) => t.autoKind === 'deploy');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('admin-only: every loop route answers 403 to a non-admin and changes nothing', async () => {
  const h = harness();
  const tk = mk(h, { stage: 'proposed' });
  for (const [m, u, b] of [['GET', '/api/loop/proposals'], ['POST', `/api/feedback/${tk.id}/proposal`, { action: 'approve' }], ['POST', '/api/loop/ready', { ticketId: tk.id }], ['GET', '/api/loop/status'], ['POST', '/api/loop/pause', { paused: true }]]) {
    const r = await call(h.app, m, u, b, false);
    assert.strictEqual(r.status, 403, `${m} ${u}`);
  }
  assert.strictEqual(h.tickets.read()[0].stage, 'proposed');
  assert.strictEqual(h.store.readTasks().length, 0);
});

test('POST /api/loop/ready: one "Deploy: X (tested)" task for Alex, ticket goes to ready; a second call updates, never duplicates', async () => {
  const h = harness();
  const tk = mk(h, { stage: 'building' });
  const r1 = await call(h.app, 'POST', '/api/loop/ready', { ticketId: tk.id, summary: 'first summary' });
  assert.strictEqual(r1.status, 200); assert.strictEqual(r1.json.ok, true); assert.ok(r1.json.taskId);
  let tasks = deployTasks(h);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].name, 'Deploy: Make X better (tested)');
  assert.strictEqual(tasks[0].owner, 'alex'); assert.strictEqual(tasks[0].project, 'AI Server');
  assert.strictEqual(tasks[0].autoKey, tk.id); assert.strictEqual(tasks[0].id, r1.json.taskId);
  assert.match(tasks[0].notes, /first summary/);
  assert.strictEqual(h.tickets.read()[0].stage, 'ready');
  assert.match(h.tickets.read()[0].notes, /waiting for Alex's deploy tick/);
  const r2 = await call(h.app, 'POST', '/api/loop/ready', { ticketId: tk.id, summary: 'second summary' });
  assert.strictEqual(r2.status, 200); assert.strictEqual(r2.json.taskId, r1.json.taskId);
  tasks = deployTasks(h);
  assert.strictEqual(tasks.length, 1, 'still exactly one task');
  assert.match(tasks[0].notes, /second summary/); assert.ok(!/first summary/.test(tasks[0].notes));
  assert.strictEqual(h.store.readTasks().length, 1);
});

test('POST /api/loop/ready: unknown ticket and closed ticket are 404, nothing created', async () => {
  const h = harness();
  assert.strictEqual((await call(h.app, 'POST', '/api/loop/ready', { ticketId: 'fb-nope' })).status, 404);
  assert.strictEqual((await call(h.app, 'POST', '/api/loop/ready', {})).status, 404);
  const tk = mk(h); h.tickets.update(tk.id, { status: 'done' });
  assert.strictEqual((await call(h.app, 'POST', '/api/loop/ready', { ticketId: tk.id })).status, 404);
  assert.strictEqual(h.store.readTasks().length, 0);
});

test('GET /api/loop/proposals: proposed, open, not snoozed, oldest first', async () => {
  const h = harness();
  const a = mk(h, { title: 'older', stage: 'proposed' });
  const b = mk(h, { title: 'newer', stage: 'proposed' });
  const later = mk(h, { title: 'snoozed', stage: 'proposed' });
  const closed = mk(h, { title: 'closed', stage: 'proposed' });
  mk(h, { title: 'not proposed', stage: 'approved' });
  h.tickets.mutate((items) => {
    items.find((i) => i.id === a.id).createdAt = '2026-01-01T00:00:00.000Z';
    items.find((i) => i.id === b.id).createdAt = '2026-02-01T00:00:00.000Z';
    items.find((i) => i.id === later.id).laterUntil = new Date(Date.now() + 864e5).toISOString();
  });
  h.tickets.update(closed.id, { status: 'wont-do' });
  const r = await call(h.app, 'GET', '/api/loop/proposals');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.map((t) => t.title), ['older', 'newer']);
  // a snooze that has expired comes back
  h.tickets.mutate((items) => { items.find((i) => i.id === later.id).laterUntil = new Date(Date.now() - 1000).toISOString(); });
  assert.strictEqual((await call(h.app, 'GET', '/api/loop/proposals')).json.length, 3);
});

test('proposal approve / decline / later, plus the refusals', async () => {
  const h = harness();
  const ap = mk(h, { title: 'ap', stage: 'proposed' }), de = mk(h, { title: 'de', stage: 'proposed' }), la = mk(h, { title: 'la', stage: 'proposed' });
  const url = (t) => `/api/feedback/${t.id}/proposal`;
  const get = (t) => h.tickets.read().find((i) => i.id === t.id);

  let r = await call(h.app, 'POST', url(ap), { action: 'approve' });
  assert.strictEqual(r.status, 200); assert.strictEqual(get(ap).stage, 'approved'); assert.match(get(ap).notes, /Alex approved/);
  assert.strictEqual(get(ap).status, 'new', 'approving leaves the ticket open');

  r = await call(h.app, 'POST', url(de), { action: 'decline' });
  assert.strictEqual(r.status, 200); assert.strictEqual(get(de).stage, 'declined'); assert.strictEqual(get(de).status, 'wont-do');
  assert.strictEqual(get(de).processedBy, 'alex'); assert.match(get(de).notes, /won't be proposed again/);

  const before = Date.now();
  r = await call(h.app, 'POST', url(la), { action: 'later' });
  assert.strictEqual(r.status, 200); assert.strictEqual(get(la).stage, 'proposed');
  const until = Date.parse(get(la).laterUntil);
  assert.ok(Math.abs(until - (before + 7 * 864e5)) < 60e3, 'later = 7 days');
  assert.ok(!(await call(h.app, 'GET', '/api/loop/proposals')).json.some((t) => t.id === la.id), 'snoozed off the card');

  // refusals: not waiting for a yes, unknown id, bad action (the ticket is left alone)
  assert.strictEqual((await call(h.app, 'POST', url(ap), { action: 'approve' })).status, 409);
  assert.strictEqual((await call(h.app, 'POST', '/api/feedback/fb-nope/proposal', { action: 'approve' })).status, 404);
  const bad = mk(h, { stage: 'proposed' });
  assert.strictEqual((await call(h.app, 'POST', url(bad), { action: 'dance' })).status, 400);
  assert.strictEqual((await call(h.app, 'POST', url(bad), {})).status, 400);
  assert.strictEqual(get(bad).stage, 'proposed');
  assert.ok(h.syncCount() >= 3, 'the ticket-task sync runs after a proposal answer');
});

test('approving after "later" clears the snooze', async () => {
  const h = harness();
  const tk = mk(h, { stage: 'proposed' });
  await call(h.app, 'POST', `/api/feedback/${tk.id}/proposal`, { action: 'later' });
  assert.ok(h.tickets.read()[0].laterUntil);
  // still stage proposed, so approving works and removes laterUntil
  await call(h.app, 'POST', `/api/feedback/${tk.id}/proposal`, { action: 'approve' });
  assert.strictEqual(h.tickets.read()[0].laterUntil, undefined);
});

// --- the loop-deploy rule, run through the real automation so "origin" is what the server really passes -------------
function ruleHarness(opts) {
  A.rules.clear();
  const h = harness(opts);
  const started = [];
  A.register('loop-deploy', { onComplete: h.loopMod.rule(h.tickets, { start: (id) => { started.push(id); return null; } }) });
  h.started = started;
  return h;
}
async function readyTask(h, stage = 'building') {
  const tk = mk(h, { stage });
  const r = await call(h.app, 'POST', '/api/loop/ready', { ticketId: tk.id, summary: 's' });
  return { tk, task: h.store.readTasks().find((t) => t.id === r.json.taskId) };
}

test('rule: a person completing the deploy task with the ticket at ready sets deploying and starts exactly one deploy', async () => {
  const h = ruleHarness();
  const { tk, task } = await readyTask(h);
  assert.strictEqual(h.automation.completeLocked(h.store.readTasks(), task).status, 200);   // source 'user'
  assert.deepStrictEqual(h.started, [tk.id]);
  const after = h.tickets.read()[0];
  assert.strictEqual(after.stage, 'deploying'); assert.match(after.notes, /Alex ticked "Deploy"/);
  assert.strictEqual(deployTasks(h).length, 0);
  // running the rule again (queue replay) is harmless: the stage is no longer ready
  h.loopMod.rule(h.tickets, { start: (id) => { h.started.push(id); return null; } })(task, [], { origin: 'user' });
  assert.strictEqual(h.started.length, 1);
});

test('rule: an automation origin never deploys (the sync closing the task is not Alex)', async () => {
  const h = ruleHarness();
  const { tk } = await readyTask(h);
  // the sync path: ticket goes to a stage that isn't ready/deploying -> resolveAuto closes the task with origin automation:loop-deploy
  h.tickets.update(tk.id, { stage: 'failed' });
  h.loop.syncDeployTasks();
  assert.deepStrictEqual(h.started, []);
  assert.strictEqual(h.tickets.read()[0].stage, 'failed');
  // and called directly with any automation: origin
  const { tk: tk2, task: t2 } = await readyTask(h);
  const rule = h.loopMod.rule(h.tickets, { start: (id) => { h.started.push(id); return null; } });
  rule(t2, [], { origin: 'automation:something-else' });
  assert.deepStrictEqual(h.started, []);
  assert.strictEqual(h.tickets.read().find((i) => i.id === tk2.id).stage, 'ready');
});

test('rule: ticket not at ready, closed, missing, or a non-deploy task does nothing', async () => {
  const h = ruleHarness();
  const rule = h.loopMod.rule(h.tickets, { start: (id) => { h.started.push(id); return null; } });
  const notReady = mk(h, { stage: 'building' });
  rule({ autoKind: 'deploy', autoKey: notReady.id }, [], { origin: 'user' });
  const closed = mk(h, { stage: 'ready' }); h.tickets.update(closed.id, { status: 'done' });
  rule({ autoKind: 'deploy', autoKey: closed.id }, [], { origin: 'user' });
  rule({ autoKind: 'deploy', autoKey: 'fb-missing' }, [], { origin: 'user' });
  rule({ autoKind: 'deploy' }, [], { origin: 'user' });
  const ready = mk(h, { stage: 'ready' });
  rule({ autoKind: 'ticket', autoKey: ready.id }, [], { origin: 'user' });
  rule({ autoKey: ready.id }, [], { origin: 'user' });
  assert.deepStrictEqual(h.started, []);
  assert.strictEqual(h.tickets.read().find((i) => i.id === ready.id).stage, 'ready');
  assert.strictEqual(h.tickets.read().find((i) => i.id === notReady.id).stage, 'building');
});

// --- startDeploy, driven through the default rule start. Stub runner only; see the header. ---------------------------
function defaultRuleDeploy(h, ticketId) {
  const rule = h.loopMod.rule(h.tickets);   // default start = the real startDeploy
  rule({ autoKind: 'deploy', autoKey: ticketId }, [], { origin: 'user' });
}

test('startDeploy: refuses when this is not the live checkout, even with BUILD_ENABLED set', async () => {
  const h = harness({ live: false, buildEnabled: true });
  const tk = mk(h, { stage: 'ready' });
  defaultRuleDeploy(h, tk.id);
  await wait(400);
  assert.strictEqual(h.ran(), '', 'nothing spawned');
  assert.strictEqual(fs.existsSync(path.join(h.ops, 'logs', 'deploy.log')), false);
});

test('startDeploy: live checkout without BUILD_ENABLED does not spawn', async () => {
  const h = harness({ live: true, buildEnabled: false });
  const tk = mk(h, { stage: 'ready' });
  defaultRuleDeploy(h, tk.id);
  await wait(400);
  assert.strictEqual(h.ran(), '');
});

test('startDeploy: live + BUILD_ENABLED spawns the (stub) runner once, with the ticket id', async () => {
  const h = harness({ live: true, buildEnabled: true });
  const tk = mk(h, { stage: 'ready' });
  defaultRuleDeploy(h, tk.id);
  for (let i = 0; i < 40 && !h.ran(); i++) await wait(100);
  assert.strictEqual(h.ran(), `${tk.id}\n`);
});

test('startDeploy: a malformed ticket id never spawns (shell-injection guard), though the stage still moves', async () => {
  const h = harness({ live: true, buildEnabled: true });
  const bad = mk(h, { stage: 'ready' });
  const evil = `${bad.id}; touch ${path.join(h.home, 'pwned')}`;
  h.tickets.mutate((items) => { items[0].id = evil; });
  defaultRuleDeploy(h, evil);
  await wait(500);
  assert.strictEqual(h.ran(), ''); assert.strictEqual(fs.existsSync(path.join(h.home, 'pwned')), false);
  for (const id of ['', 'FB-1', 'fb-', 'x fb-1', 'fb-1\n$(id)']) {
    h.tickets.mutate((items) => { items[0].id = id || 'fb-x'; items[0].stage = 'ready'; });
    defaultRuleDeploy(h, id || 'fb-x');
  }
  await wait(500);
  assert.ok(!/\$\(|pwned|FB-/.test(h.ran()), 'no odd id reached the runner');
});

// --- syncDeployTasks ---------------------------------------------------------------------------------------------------
test('syncDeployTasks: keeps the task while ready or deploying, closes it otherwise (with the automation origin)', async () => {
  const h = ruleHarness();
  const { tk } = await readyTask(h);
  h.loop.syncDeployTasks(); assert.strictEqual(deployTasks(h).length, 1, 'ready: kept');
  h.tickets.update(tk.id, { stage: 'deploying' });
  h.loop.syncDeployTasks(); assert.strictEqual(deployTasks(h).length, 1, 'deploying: kept');
  h.tickets.update(tk.id, { stage: 'deployed' });
  h.loop.syncDeployTasks(); assert.strictEqual(deployTasks(h).length, 0, 'deployed: closed');
  const done = h.store.readCompleted();
  assert.strictEqual(done.length, 1); assert.strictEqual(done[0].source, 'automation:loop-deploy');
  assert.deepStrictEqual(h.started, [], 'closing by sync never starts a deploy');
});

test('syncDeployTasks: closes the task of a closed or deleted ticket, but leaves everything alone when there is no ticket file', async () => {
  const h = ruleHarness();
  const a = await readyTask(h), b = await readyTask(h);
  h.tickets.update(a.tk.id, { status: 'done' });
  h.tickets.remove(b.tk.id);
  h.loop.syncDeployTasks();
  assert.strictEqual(deployTasks(h).length, 0);
  // a deploy task whose ticket file is missing (mid-restore) is NOT closed
  const h2 = ruleHarness();
  await readyTask(h2);
  fs.unlinkSync(h2.tickets.FILE);
  h2.loop.syncDeployTasks();
  assert.strictEqual(deployTasks(h2).length, 1);
  assert.deepStrictEqual(h2.started, []);
});

test('syncDeployTasks: ignores non-deploy tasks', () => {
  const h = ruleHarness();
  h.store.writeTasks([{ id: 'x', type: 'scheduled', name: 'Chore', project: 'Chores', dueDate: '2026-11-25' }, { id: 'y', type: 'scheduled', name: 'T', project: 'AI Server', dueDate: '2026-11-25', autoKind: 'ticket', autoKey: 'fb-gone' }]);
  h.loop.syncDeployTasks();
  assert.strictEqual(h.store.readTasks().length, 2);
});

// --- status and pause -------------------------------------------------------------------------------------------------
test('GET /api/loop/status: no run yet, then the report and the paused switch', async () => {
  const h = harness();
  let r = await call(h.app, 'GET', '/api/loop/status');
  assert.deepStrictEqual(r.json, { paused: false, status: null });
  fs.writeFileSync(path.join(h.ops, 'status.json'), JSON.stringify({ ok: true, built: 2 }));
  fs.writeFileSync(path.join(h.ops, 'PAUSED'), 'x');
  r = await call(h.app, 'GET', '/api/loop/status');
  assert.deepStrictEqual(r.json, { paused: true, status: { ok: true, built: 2 } });
  fs.writeFileSync(path.join(h.ops, 'status.json'), '{broken');
  assert.strictEqual((await call(h.app, 'GET', '/api/loop/status')).json.status, null, 'a broken report reads as none');
});

test('POST /api/loop/pause: refused on a non-live checkout (nothing written); on live it pauses and un-pauses', async () => {
  const off = harness({ live: false });
  const r0 = await call(off.app, 'POST', '/api/loop/pause', { paused: true });
  assert.strictEqual(r0.status, 409); assert.strictEqual(fs.existsSync(path.join(off.ops, 'PAUSED')), false);

  const h = harness({ live: true });
  let r = await call(h.app, 'POST', '/api/loop/pause', { paused: true });
  assert.deepStrictEqual([r.status, r.json], [200, { paused: true }]);
  assert.match(fs.readFileSync(path.join(h.ops, 'PAUSED'), 'utf8'), /paused by Alex/);
  r = await call(h.app, 'POST', '/api/loop/pause', { paused: false });
  assert.deepStrictEqual(r.json, { paused: false });
  assert.ok(fs.readdirSync(h.ops).some((f) => f.startsWith('PAUSED.cleared-')), 'the old marker is kept, renamed');
  r = await call(h.app, 'POST', '/api/loop/pause', { paused: false });   // un-pausing when not paused is a no-op
  assert.deepStrictEqual(r.json, { paused: false });
});

test('rule: a deploy that cannot start goes back to ready and flags Alex, never stuck at deploying', async () => {
  const h = ruleHarness();
  const tk = mk(h, { stage: 'ready' });
  const rule = h.loopMod.rule(h.tickets, { start: () => 'building and deploying are switched off' });
  rule({ autoKind: 'deploy', autoKey: tk.id }, [], { origin: 'user' });
  let after = h.tickets.read().find((t) => t.id === tk.id);
  assert.strictEqual(after.stage, 'ready');
  assert.strictEqual(after.needsAlex, true);
  assert.match(after.notes, /did not start: building and deploying are switched off/);
  // a runner that throws is handled the same way
  h.tickets.update(tk.id, { needsAlex: false });
  h.loopMod.rule(h.tickets, { start: () => { throw new Error('spawn failed'); } })({ autoKind: 'deploy', autoKey: tk.id }, [], { origin: 'user' });
  after = h.tickets.read().find((t) => t.id === tk.id);
  assert.strictEqual(after.stage, 'ready');
  assert.match(after.notes, /could not be started \(spawn failed\)/);
});
