'use strict';
// Tasks that list several computers (`devices`): validation, CLI filters, claim. The CLI runs against a throwaway copy of
// src/ so its data dir (../data) is a temp one, never the real store.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { normalizeTask } = require('./todo-validate');

const base = { type: 'backlog', name: 'n', project: 'P', added: '2026-11-28' };
const norm = (o, ex) => normalizeTask({ ...base, ...o }, ex || null);

test('devices: normalized, deduped, sorted; 1 item becomes device; empty is null', () => {
  assert.deepStrictEqual(norm({ devices: ['AdaOne', 'mac', 'mac'] }).task.devices, ['adaone', 'mac']);
  assert.strictEqual(norm({ devices: ['AdaOne', 'mac'] }).task.device, null);
  const one = norm({ devices: ['mac'] }).task; assert.strictEqual(one.device, 'mac'); assert.strictEqual(one.devices, null);
  assert.strictEqual(norm({ devices: [] }).task.devices, null);
  assert.deepStrictEqual(norm({ devices: 'any' }).task.devices, ['adaone', 'adatwo', 'mac']);
  assert.deepStrictEqual(norm({ devices: 'mac,adatwo' }).task.devices, ['adatwo', 'mac']);
});
test('devices: unknown names and device+devices together are rejected', () => {
  assert.ok(norm({ devices: ['mac', 'toaster'] }).errors);
  assert.ok(norm({ devices: ['mac', 'adaone'], device: 'mac' }).errors);
});
test('a patch keeps devices unless it sets device; plain device tasks are unchanged', () => {
  const ex = norm({ devices: ['mac', 'adaone'] }).task;
  assert.deepStrictEqual(normalizeTask({ name: 'renamed' }, ex).task.devices, ['adaone', 'mac']);
  const p = normalizeTask({ device: 'adatwo' }, ex).task; assert.strictEqual(p.device, 'adatwo'); assert.strictEqual(p.devices, null);
  assert.strictEqual(normalizeTask({ device: null }, ex).task.devices, null);
  const plain = norm({ device: 'mac' }).task; assert.strictEqual(plain.device, 'mac'); assert.strictEqual(plain.devices, null);
});

// ---- CLI against a temp copy
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-'));
fs.cpSync(path.join(__dirname), path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(root, 'data'));
try { fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(root, 'node_modules')); } catch {}
const cli = (...a) => spawnSync('node', [path.join(root, 'src/todo-cli.js'), ...a, '--json'], { encoding: 'utf8' });
const ok = (...a) => { const r = cli(...a); assert.strictEqual(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };
const add = (name, dev) => ok('add', '--type', 'backlog', '--project', 'P', '--name', name, ...(dev ? ['--device', dev] : []));

test('CLI add: list, any, single, none', () => {
  const m = add('multi', 'mac,adaone'), any = add('anyone', 'any'), one = add('single', 'adatwo'), none = add('nodev');
  assert.deepStrictEqual(m.devices, ['adaone', 'mac']); assert.strictEqual(m.device, null);
  assert.deepStrictEqual(any.devices, ['adaone', 'adatwo', 'mac']);
  assert.strictEqual(one.device, 'adatwo'); assert.ok(!one.devices);
  assert.ok(!none.devices && !none.device);
});
test('CLI filters: list and today include devices tasks; --exact and reach; none excludes them', () => {
  const names = (o) => o.map(t => t.name).sort();
  assert.deepStrictEqual(names(ok('list', '--device', 'mac', '--exact')), ['anyone', 'multi']);
  assert.deepStrictEqual(names(ok('list', '--device', 'adatwo', '--exact')), ['anyone', 'single']);
  assert.deepStrictEqual(names(ok('list', '--device', 'none')), ['nodev']);
  // AdaOne reaches AdaTwo by default: it also sees the AdaTwo-only task
  assert.deepStrictEqual(names(ok('list', '--device', 'adaone')), ['anyone', 'multi', 'single']);
  const td = ok('today', '--device', 'mac', '--exact');   // the backlog guarantee puts one item in `today`, the rest are undated
  assert.deepStrictEqual(names([...td.today, ...td.undated]), ['anyone', 'multi']);
});
test('claim: sets device, clears devices, notes it; no-op when already ours; refuses others', () => {
  const t = ok('list', '--device', 'mac', '--exact').find(x => x.name === 'multi');
  const c = ok('claim', t.id, '--device', 'adaone');
  assert.strictEqual(c.device, 'adaone'); assert.ok(!c.devices); assert.match(c.notes, /Claimed by adaone, \d{4}-\d\d-\d\dT/);
  const again = ok('claim', t.id, '--device', 'adaone'); assert.strictEqual(again.notes, c.notes);
  const r = cli('claim', t.id, '--device', 'mac'); assert.notStrictEqual(r.status, 0); assert.match(r.stdout, /already claimed by adaone/);
  assert.strictEqual(ok('list', '--device', 'adaone', '--exact').find(x => x.id === t.id).device, 'adaone');
  const u = ok('list', '--device', 'mac', '--exact').find(x => x.name === 'anyone');
  assert.notStrictEqual(cli('claim', u.id, '--device', 'toaster').status, 0);
  assert.notStrictEqual(cli('claim', 'task-nope', '--device', 'mac').status, 0);
  const s = ok('list', '--device', 'adatwo', '--exact').find(x => x.name === 'single');
  assert.notStrictEqual(cli('claim', s.id, '--device', 'mac').status, 0);
  assert.deepStrictEqual(ok('list', '--device', 'mac', '--exact').find(x => x.name === 'anyone').devices, ['adaone', 'adatwo', 'mac']);
});
test('claim: two racing claims, exactly one wins (the store lock)', () => {
  const t = add('race', 'mac,adaone,adatwo');
  const run = (d) => require('child_process').spawn('node', [path.join(root, 'src/todo-cli.js'), 'claim', t.id, '--device', d, '--json']);
  return Promise.all(['mac', 'adaone', 'adatwo'].map(d => new Promise(res => { const p = run(d); p.on('close', code => res({ d, code })); }))).then(rs => {
    const wins = rs.filter(r => r.code === 0);
    assert.strictEqual(wins.length, 1);
    assert.strictEqual(ok('list').find(x => x.id === t.id).device, wins[0].d);
  });
});
