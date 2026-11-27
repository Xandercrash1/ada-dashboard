// Tests for page-cleanup.js (pages that remove themselves) and the 303 wall on task completion. Run: node --test src/page-cleanup.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rule, validateIds } = require('./page-cleanup');
const sharing = require('./sharing');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-cleanup-'));
  const dataDir = path.join(root, 'data'), pendingDir = path.join(root, 'trash');
  fs.mkdirSync(path.join(dataDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'history', 'new-tv'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'media', 'page-new-tv'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'pages', 'new-tv.json'), '{"widgets":[]}');
  fs.writeFileSync(path.join(dataDir, 'pages', 'other.json'), '{"widgets":[]}');
  fs.writeFileSync(path.join(dataDir, 'history', 'new-tv', '1700000000000.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'media', 'page-new-tv', 'a.webp'), 'img');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, '_Manifest.md'), '# Manifest\n- **`old`** — something\n');
  const reg = [{ id: 'other', title: 'Other' }, { id: 'new-tv', title: 'New TV', removeWhenDone: ['task-a', 'task-b'] }];
  fs.writeFileSync(path.join(dataDir, 'pages.json'), JSON.stringify(reg));
  const logs = [];
  const onComplete = rule({ dataDir, pendingDir, log: (m) => logs.push(m), today: () => '2026-11-27' });
  const registry = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'pages.json'), 'utf8'));
  return { dataDir, pendingDir, onComplete, registry, logs };
}
const t = (id) => ({ id, name: id });

test('one task done: the page stays', () => {
  const s = setup();
  s.onComplete(t('task-a'), [t('task-b'), t('task-z')]);   // task-b is still open
  assert.deepStrictEqual(s.registry().map((p) => p.id), ['other', 'new-tv']);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'pages', 'new-tv.json')));
  assert.deepStrictEqual(fs.readdirSync(s.pendingDir), ['_Manifest.md']);
});

test('an unrelated completion does nothing', () => {
  const s = setup();
  s.onComplete(t('task-zzz'), []);
  assert.strictEqual(s.registry().length, 2);
});

test('all done: page, history and images move to Trash Pending, registry entry gone, manifest appended; re-run is a no-op', () => {
  const s = setup();
  assert.strictEqual(s.onComplete(t('task-b'), [t('task-z')]), undefined, 'never changes tasks');
  assert.deepStrictEqual(s.registry().map((p) => p.id), ['other']);
  const folder = path.join(s.pendingDir, 'page new-tv 2026-11-27');
  assert.ok(fs.existsSync(path.join(folder, 'new-tv.json')));
  assert.ok(fs.existsSync(path.join(folder, 'history', '1700000000000.json')));
  assert.ok(fs.existsSync(path.join(folder, 'page-new-tv-images', 'a.webp')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(folder, 'registry-entry.json'), 'utf8')).id, 'new-tv');
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'pages', 'new-tv.json')));
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'history', 'new-tv')));
  assert.ok(fs.existsSync(path.join(s.dataDir, 'pages', 'other.json')), 'other pages untouched');
  const m = fs.readFileSync(path.join(s.pendingDir, '_Manifest.md'), 'utf8');
  assert.match(m, /- \*\*`old`\*\* — something/, 'earlier entries kept');
  assert.match(m, /- \*\*`page new-tv 2026-11-27`\*\* — page removed automatically: all its tasks done \(task-a, task-b\)\./);
  assert.match(m, /To restore:/);
  // run again (and the other task's completion arriving late): nothing changes
  const before = fs.readFileSync(path.join(s.pendingDir, '_Manifest.md'), 'utf8');
  s.onComplete(t('task-b'), []); s.onComplete(t('task-a'), []);
  assert.strictEqual(fs.readFileSync(path.join(s.pendingDir, '_Manifest.md'), 'utf8'), before);
  assert.deepStrictEqual(s.registry().map((p) => p.id), ['other']);
  assert.strictEqual(s.logs.length, 1);
});

test('a half-finished earlier run is completed without a second manifest entry', () => {
  const s = setup();
  s.onComplete(t('task-b'), []);
  // simulate a crash after the move but before the registry write
  const regFile = path.join(s.dataDir, 'pages.json');
  fs.writeFileSync(regFile, JSON.stringify([{ id: 'new-tv', removeWhenDone: ['task-a', 'task-b'] }]));
  s.onComplete(t('task-a'), []);
  assert.deepStrictEqual(s.registry(), []);
  assert.strictEqual((fs.readFileSync(path.join(s.pendingDir, '_Manifest.md'), 'utf8').match(/page new-tv 2026-11-27/g) || []).length, 1);
});

test('removeWhenDone validation (PATCH rule)', () => {
  assert.deepStrictEqual(validateIds(['task-1', 'task_2', 'task-1']).ids, ['task-1', 'task_2']);
  for (const bad of [[], 'task-1', null, ['../x'], ['a b'], [1], Array.from({ length: 11 }, (_, i) => 't' + i), ['x'.repeat(65)]]) {
    assert.ok(validateIds(bad).error, JSON.stringify(bad));
  }
});

// The 303 wall: authorizeRole (server.js) lets a non-admin reach /api/todo/tasks/:id/complete only when sharing.canSee
// says the task is theirs. server.js starts a listener, so this mounts the same two lines in a tiny app.
test('a 303 user cannot complete an Alex-only task; an admin and a shared 303 user can', async () => {
  const express = require('express');
  const tasks = [{ id: 'task-alex', name: 'Alex only' }, { id: 'task-shared', name: 'Shared', sharedWith: ['@303'] }];
  const app = express();
  const done = [];
  app.use((req, _res, next) => { req.user = { username: req.get('x-user'), role: req.get('x-role') }; next(); });
  app.post('/api/todo/tasks/:id/complete', (req, res) => {
    const task = tasks.find((x) => x.id === req.params.id);
    if (!sharing.canSee(req.user, task)) return res.status(403).json({ error: 'Not available for your account.' });
    done.push(task.id); res.json({ success: true });
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = (id, user, role) => fetch(`http://127.0.0.1:${srv.address().port}/api/todo/tasks/${id}/complete`, { method: 'POST', headers: { 'x-user': user, 'x-role': role } });
  try {
    assert.strictEqual((await post('task-alex', 'paige', '303')).status, 403);
    assert.strictEqual((await post('task-missing', 'paige', '303')).status, 403);
    assert.strictEqual((await post('task-shared', 'paige', '303')).status, 200);
    assert.strictEqual((await post('task-alex', 'alex', 'admin')).status, 200);
    assert.deepStrictEqual(done, ['task-shared', 'task-alex']);
  } finally { srv.close(); }
});
