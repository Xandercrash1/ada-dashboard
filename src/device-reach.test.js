'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reach = require('./device-reach');
const { upsertAutoTask } = require('./task-automation');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'reach-')); }
function fakeStore() {
  let tasks = [];
  return { withLock: (fn) => fn(), readTasks: () => tasks, writeTasks: (t) => { tasks = t; } };
}
const engine = { todayString: () => '2026-11-25' };

test('the default: AdaOne reaches AdaTwo; a session on AdaOne picks up both', () => {
  const d = tmp();
  assert.deepStrictEqual(reach.reachable(d, 'adaone'), ['adaone', 'adatwo']);
  assert.deepStrictEqual(reach.reachable(d, 'mac'), ['mac']);
  assert.deepStrictEqual(reach.reachable(d, 'toaster'), ['toaster']);
});

test('one setup task for the Mac -> AdaTwo link, made once, never again after it is gone', () => {
  const d = tmp(); const store = fakeStore();
  reach.ensureSetupTasks({ dataDir: d, store, upsertAutoTask, engine });
  reach.ensureSetupTasks({ dataDir: d, store, upsertAutoTask, engine });
  const t = store.readTasks().filter((x) => x.autoKind === 'device-reach');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].autoKey, 'mac>adatwo');
  assert.strictEqual(t[0].device, 'mac');
  assert.match(t[0].name, /Set up SSH from the Mac to AdaTwo/);
  store.writeTasks([]);   // Alex deleted it: it stays gone
  reach.ensureSetupTasks({ dataDir: d, store, upsertAutoTask, engine });
  assert.strictEqual(store.readTasks().length, 0);
});

test('checking off the setup task adds the link; the Mac then picks up AdaTwo items', () => {
  const d = tmp(); const store = fakeStore();
  reach.ensureSetupTasks({ dataDir: d, store, upsertAutoTask, engine });
  const task = store.readTasks()[0];
  reach.rule(d)(task, [], { origin: 'user' });
  reach.rule(d)(task, [], { origin: 'user' });   // twice is harmless
  assert.deepStrictEqual(reach.read(d).mac, ['adatwo']);
  assert.deepStrictEqual(reach.reachable(d, 'mac'), ['mac', 'adatwo']);
  assert.deepStrictEqual(reach.read(d).adaone, ['adatwo']);   // the existing link is kept
  reach.rule(d)({ autoKind: 'device-reach', autoKey: 'mac>mac' }, [], {});
  reach.rule(d)({ autoKind: 'other', autoKey: 'mac>adaone' }, [], {});
  assert.deepStrictEqual(reach.read(d).mac, ['adatwo']);
});
