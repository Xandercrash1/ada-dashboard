'use strict';
// Run: node --test src/gemini-usage.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const u = require('./gemini-usage');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gu-')), 'u.json');

test('counts calls, 429s, errors and tokens per model; file is mode 600', () => {
  const f = tmp(); let t = new Date('2026-11-27T15:00:00Z');
  const c = u.create({ file: f, now: () => t });
  c.record('gemini-3.8-flash', 'ok', { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
  c.record('gemini-3.8-flash', '429'); c.record('gemini-3.8-flash', 'error');
  const m = c.summary().today.models['gemini-3.8-flash'];
  assert.deepEqual([m.calls, m.ok, m.rate429, m.errors, m.totalTokens], [3, 1, 1, 1, 15]);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!/prompt"|text/i.test(fs.readFileSync(f, 'utf8').replace(/promptTokens/g, '')));
});
test('day rolls over at Eastern midnight, not UTC', () => {
  const f = tmp(); let t = new Date('2026-11-28T04:30:00Z'); // 23:30 Nov 27 Eastern
  const c = u.create({ file: f, now: () => t });
  c.record('m', 'ok');
  t = new Date('2026-11-28T05:30:00Z'); // 00:30 Nov 28 Eastern
  c.record('m', 'ok');
  const s = c.summary();
  assert.equal(s.today.date, '2026-11-28'); assert.equal(s.today.models.m.calls, 1);
  assert.equal(s.days[1].date, '2026-11-27'); assert.equal(s.days[1].calls, 1);
});
test('prunes to the last 30 days', () => {
  const f = tmp(); let t = new Date('2026-10-01T15:00:00Z');
  const c = u.create({ file: f, now: () => t });
  c.record('m', 'ok');
  t = new Date('2026-10-30T15:00:00Z'); c.record('m', 'ok'); // day 30: Oct 1 still kept
  assert.ok(JSON.parse(fs.readFileSync(f)).days['2026-10-01']);
  t = new Date('2026-10-31T15:00:00Z'); c.record('m', 'ok'); // Oct 1 now 31 days back
  assert.ok(!JSON.parse(fs.readFileSync(f)).days['2026-10-01']);
});
test('a write failure is swallowed', () => {
  const c = u.create({ file: '/nonexistent-dir-xyz/u.json' });
  assert.doesNotThrow(() => c.record('m', 'ok'));
  assert.doesNotThrow(() => c.summary());
});
test('endpoint is admin-walled in server.js', () => {
  const s = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const i = s.indexOf("app.get('/api/gemini-usage'");
  assert.ok(i > 0);
  assert.match(s.slice(i, i + 200), /!isAdminReq\(req\)\) return res\.status\(403\)/);
});
