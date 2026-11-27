'use strict';
// Run: node --test src/overdue-review.test.js — selection logic with an injected clock (Eastern time).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const r = require('./overdue-review');
const store = require('./todo-store');

// 2026-11-27 is a Friday; November is EST (UTC-5). 14:00Z = 09:00 Eastern, 11:00Z = 06:00 Eastern.
const NINE = new Date('2026-11-27T14:00:00Z'), SIX = new Date('2026-11-27T11:00:00Z');
const sch = (id, due, extra) => ({ id, name: id, project: 'P', type: 'scheduled', dueDate: due, createdAt: '2026-01-01T00:00:00Z', ...extra });
const rec = (id, nextDue, extra) => ({ id, name: id, project: 'P', type: 'recurring', frequency: { type: 'Daily' }, nextDue, skippable: false, createdAt: '2026-01-01T00:00:00Z', ...extra });

test('picks the oldest overdue and reports days overdue', () => {
  const x = r.review({ tasks: [sch('b', '2026-11-20'), sch('a', '2026-11-10'), sch('c', '2026-11-25')], now: NINE });
  assert.equal(x.task.id, 'a'); assert.equal(x.daysOverdue, 17); assert.equal(x.dueDate, '2026-11-10'); assert.equal(x.showFrom, '08:00');
});
test('ties break by createdAt', () => {
  const x = r.review({ tasks: [sch('late', '2026-11-10', { createdAt: '2026-05-01T00:00:00Z' }), sch('early', '2026-11-10')], now: NINE });
  assert.equal(x.task.id, 'early');
});
test('today and future are not overdue; backlog has no date', () => {
  const x = r.review({ tasks: [sch('t', '2026-11-27'), sch('f', '2026-12-01'), { id: 'bk', type: 'backlog', name: 'bk', added: '2026-01-01' }], now: NINE });
  assert.equal(x.task, null);
});
test('exclusions: autoKind and waitsFor', () => {
  const x = r.review({ tasks: [sch('d', '2026-10-01', { autoKind: 'deploy' }), sch('s', '2026-10-02', { autoKind: 'subcard-autopay' }), sch('w', '2026-10-03', { waitsFor: 'z' }), sch('ok', '2026-11-20')], now: NINE });
  assert.equal(x.task.id, 'ok');
});
test('recurring uses nextDue', () => {
  const x = r.review({ tasks: [rec('r', '2026-11-05'), sch('s', '2026-11-20')], now: NINE });
  assert.equal(x.task.id, 'r'); assert.equal(x.dueDate, '2026-11-05'); assert.equal(x.daysOverdue, 22);
});
test('hidden before 08:00 Eastern, shown after', () => {
  const t = [sch('a', '2026-11-10')];
  assert.equal(r.review({ tasks: t, now: SIX }).task, null);
  assert.equal(r.review({ tasks: t, now: new Date('2026-11-27T12:59:00Z') }).task, null);   // 07:59
  assert.equal(r.review({ tasks: t, now: new Date('2026-11-27T13:00:00Z') }).task.id, 'a'); // 08:00
});
test('handled today hides it; next day shows again at 08:00', () => {
  const t = [sch('a', '2026-11-10')];
  const h = r.review({ tasks: t, handledDate: '2026-11-27', now: NINE });
  assert.equal(h.task, null); assert.equal(h.handled, true);
  assert.equal(r.review({ tasks: t, handledDate: '2026-11-27', now: new Date('2026-11-28T11:00:00Z') }).task, null);   // 06:00 next day
  assert.equal(r.review({ tasks: t, handledDate: '2026-11-27', now: new Date('2026-11-28T14:00:00Z') }).task.id, 'a');
});
test('Eastern date, not UTC: 22:00 Eastern is already next day UTC', () => {
  const x = r.review({ tasks: [sch('a', '2026-11-27')], now: new Date('2026-11-28T03:00:00Z') });   // 22:00 on the 27th Eastern
  assert.equal(x.task, null); assert.equal(x.today, '2026-11-27');
});
test('store: handled date round-trips atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-'));
  const s = r.create({ dataDir: dir, store });
  assert.equal(s.readHandled(), null);
  s.markHandled('2026-11-27');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'overdue-review.json'), 'utf8')), { handledDate: '2026-11-27' });
  assert.equal(s.review([sch('a', '2026-11-10')], NINE).task, null);
  assert.equal(s.review([sch('a', '2026-11-10')], new Date('2026-11-28T14:00:00Z')).task.id, 'a');
  fs.rmSync(dir, { recursive: true });
});
