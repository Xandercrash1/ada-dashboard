'use strict';

/**
 * Test file for todo-engine.js, per contract §3: exercises the recurrence
 * tables in spec §2.1/§2.3 case by case, plus rollForward idempotency,
 * buildView purity, and the duplicate-name completion fix.
 *
 * No test framework dependency — plain assertions, run with:
 *   node src/todo-engine.test.js
 * Exits non-zero on first failure.
 */

const assert = require('assert');
const engine = require('./todo-engine');

let passed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
    process.exitCode = 1;
  } else {
    passed++;
    console.log(`ok - ${label} => ${a}`);
  }
}

console.log('--- calcNextDue (spec §2.1) ---');
// Named examples from the contract/spec, verified against the Python source.
check('Daily +1', engine.calcNextDue('Daily', '2026-08-26'), '2026-08-27');
check('Weekdays Fri -> Mon', engine.calcNextDue('Weekdays', '2026-08-28'), '2026-08-31'); // Fri 08-28 +1 = Sat 08-29 -> advance past weekend -> Mon 08-31
check('Weekly (Wed) completed on Wed -> full +7', engine.calcNextDue('Weekly (Wed)', '2026-08-26'), '2026-09-02');
check('Every 2 Weeks (Sun) -> 8-14 day range, 09-06', engine.calcNextDue('Every 2 Weeks (Sun)', '2026-08-26'), '2026-09-06');
check('Monthly (31st) from Jan 15 -> Feb 28 (non-leap)', engine.calcNextDue('Monthly (31st)', '2026-01-15'), '2026-02-28');
check('Yearly from Feb 29 (leap) -> Feb 28 next year', engine.calcNextDue('Yearly', '2024-02-29'), '2025-02-28');
check('Unknown -> null', engine.calcNextDue('Fortnightly', '2026-08-26'), null);
check('Weekly (Sunday) full name -> null (validated, not crashed)', engine.calcNextDue('Weekly (Sunday)', '2026-08-26'), null);
check('Case-sensitive: weekly (Wed) -> null', engine.calcNextDue('weekly (Wed)', '2026-08-26'), null);
check('Space-sensitive: Weekly(Wed) -> null', engine.calcNextDue('Weekly(Wed)', '2026-08-26'), null);
check('Bare Weekly -> null', engine.calcNextDue('Weekly', '2026-08-26'), null);
check('2026-13-40 completedOn -> null (invalid date, no crash)', engine.calcNextDue('Daily', '2026-13-40'), null);

console.log('--- advanceSkippable (spec §2.3) ---');
// today = Wed 2026-08-26 for all rows in the table.
check('Daily -> today', engine.advanceSkippable('Daily', '2026-08-26'), '2026-08-26');
check('Weekdays, today is a weekday -> today', engine.advanceSkippable('Weekdays', '2026-08-26'), '2026-08-26');
check('Weekdays, today is Saturday -> advances past weekend', engine.advanceSkippable('Weekdays', '2026-08-29'), '2026-08-31');
check('Weekly (X) -> first X on-or-after today, NO +7', engine.advanceSkippable('Weekly (Sun)', '2026-08-26'), '2026-08-30');
check('Every 2 Weeks (X) -> SAME as Weekly, asymmetry confirmed (0-6 days out, not 8-14)', engine.advanceSkippable('Every 2 Weeks (Sun)', '2026-08-26'), '2026-08-30');
check('Monthly (N), this month Nth >= today', engine.advanceSkippable('Monthly (28th)', '2026-08-26'), '2026-08-28');
check('Monthly (N), this month Nth < today -> next month', engine.advanceSkippable('Monthly (1st)', '2026-08-26'), '2026-09-01');
check('Yearly falls through to today', engine.advanceSkippable('Yearly', '2026-08-26'), '2026-08-26');
check('Unrecognised falls through to today', engine.advanceSkippable('Fortnightly', '2026-08-26'), '2026-08-26');
check('Empty falls through to today', engine.advanceSkippable('', '2026-08-26'), '2026-08-26');

console.log('--- asymmetry side-by-side (contract §1.5) ---');
{
  const cnd = engine.calcNextDue('Every 2 Weeks (Sun)', '2026-08-26');     // completion-anchored, +7 applied -> 8-14 days out
  const adv = engine.advanceSkippable('Every 2 Weeks (Sun)', '2026-08-26'); // today-anchored, no +7 -> 0-6 days out
  assert.notStrictEqual(cnd, adv, 'calcNextDue and advanceSkippable must disagree for Every 2 Weeks — the asymmetry is real and must be preserved');
  console.log(`ok - asymmetry preserved: calcNextDue=${cnd} advanceSkippable=${adv}`);
  passed++;
}

console.log('--- resolveSkippable (spec §2.4) ---');
check('Yes -> true', engine.resolveSkippable('Yes', 'Weekly (Wed)'), true);
check('No -> false', engine.resolveSkippable('No', 'Daily'), false);
check('blank + Daily -> true (default)', engine.resolveSkippable('', 'Daily'), true);
check('blank + Weekdays -> true (default)', engine.resolveSkippable('', 'Weekdays'), true);
check('blank + Weekly -> false (default)', engine.resolveSkippable('', 'Weekly (Wed)'), false);

console.log('--- parseDueParts / timeToMinutes (spec §3.1/§3.3) ---');
check('date + time', engine.parseDueParts('2026-08-30 8:00pm'), { date: '2026-08-30', time: '8:00pm' });
check('date only', engine.parseDueParts('2026-08-30'), { date: '2026-08-30', time: null });
check('empty', engine.parseDueParts(''), { date: null, time: null });
check('"8pm" alone (not a date) -> null,null', engine.parseDueParts('8pm'), { date: null, time: null });
check('space before meridiem drops time: "2026-08-30 8:00 pm"', engine.parseDueParts('2026-08-30 8:00 pm'), { date: '2026-08-30', time: null });
check('invalid calendar date -> null,null, no throw', engine.parseDueParts('2026-13-40'), { date: null, time: null });
check('trailing junk ignored (prefix match)', engine.parseDueParts('2026-08-30 8:00pm and some trailing junk'), { date: '2026-08-30', time: '8:00pm' });
check('untimed sorts after timed: 9999 sentinel', engine.timeToMinutes(''), 9999);
check('untimed sorts after timed: null', engine.timeToMinutes(null), 9999);
check('12:00am -> 0', engine.timeToMinutes('12:00am'), 0);
check('12:00pm -> 720', engine.timeToMinutes('12:00pm'), 720);
check('8:00pm -> 1200', engine.timeToMinutes('8:00pm'), 1200);

console.log('--- buildView (spec §4.6-4.7) — purity ---');
{
  const tasks = [
    { id: 't1', type: 'recurring', name: 'Daily thing', frequency: 'Daily', skippable: true, nextDue: '2026-08-26', dueTime: null, priority: 'Low' },
    { id: 't2', type: 'backlog', name: 'Backlog thing', priority: 'Medium', added: '2026-08-01' }
  ];
  const before = JSON.stringify(tasks);
  engine.buildView(tasks, '2026-08-26');
  const after = JSON.stringify(tasks);
  assert.strictEqual(before, after, 'buildView must not mutate its input');
  console.log('ok - buildView does not mutate input');
  passed++;
}

console.log('--- buildView — windowing + backlog guarantee ---');
{
  // Window contains ONLY a Daily recurring item -> backlog guarantee should fire.
  const today = '2026-08-26';
  const tasks = [
    { id: 'r1', type: 'recurring', name: 'Daily chore', frequency: 'Daily', skippable: true, nextDue: today, dueTime: null, priority: 'Low' },
    { id: 'b1', type: 'backlog', name: 'Old backlog item', priority: 'High', added: '2026-01-01' },
    { id: 'b2', type: 'backlog', name: 'Newer backlog item', priority: 'High', added: '2026-06-01' }
  ];
  const view = engine.buildView(tasks, today);
  assert.strictEqual(view.backlogGuaranteeItem && view.backlogGuaranteeItem.id, 'b1', 'guarantee should pick highest-priority, then earliest-Added backlog item');
  assert.strictEqual(view.today[view.today.length - 1].id, 'b1', 'guarantee item should be last in Today');
  console.log('ok - backlog guarantee fires and picks the right item, sorted last');
  passed++;
}
{
  // Window contains a non-Daily/Weekdays item -> guarantee must NOT fire.
  const today = '2026-08-26';
  const tasks = [
    { id: 's1', type: 'scheduled', name: 'Scheduled today', dueDate: today, dueTime: null, priority: 'Low' },
    { id: 'b1', type: 'backlog', name: 'Backlog item', priority: 'High', added: '2026-01-01' }
  ];
  const view = engine.buildView(tasks, today);
  assert.strictEqual(view.backlogGuaranteeItem, null, 'guarantee must not fire when the window has a non-Daily/Weekdays item');
  console.log('ok - backlog guarantee suppressed when window has a real item');
  passed++;
}
{
  // Unskippable recurring, overdue -> PAST DUE, never in Today/Upcoming.
  const today = '2026-08-26';
  const tasks = [
    { id: 'r1', type: 'recurring', name: 'Overdue unskippable', frequency: 'Weekly (Mon)', skippable: false, nextDue: '2026-08-20', dueTime: null, priority: 'High' }
  ];
  const view = engine.buildView(tasks, today);
  assert.strictEqual(view.pastDue.length, 1);
  assert.strictEqual(view.today.length, 0 + (view.backlogGuaranteeItem ? 1 : 0)); // no backlog pool here, so 0
  console.log('ok - unskippable overdue recurring lands in PAST DUE only');
  passed++;
}
{
  // past_due is NOT consulted for the backlog guarantee (spec §4.7) — lots
  // of overdue items must not suppress it.
  const today = '2026-08-26';
  const tasks = [
    { id: 'r1', type: 'recurring', name: 'Overdue 1', frequency: 'Weekly (Mon)', skippable: false, nextDue: '2026-08-10', dueTime: null, priority: 'High' },
    { id: 'r2', type: 'recurring', name: 'Overdue 2', frequency: 'Weekly (Tue)', skippable: false, nextDue: '2026-08-11', dueTime: null, priority: 'High' },
    { id: 'b1', type: 'backlog', name: 'Backlog item', priority: 'Medium', added: '2026-01-01' }
  ];
  const view = engine.buildView(tasks, today);
  assert.strictEqual(view.pastDue.length, 2);
  assert.strictEqual(view.backlogGuaranteeItem && view.backlogGuaranteeItem.id, 'b1', 'past_due must not suppress the guarantee');
  console.log('ok - backlog guarantee ignores past_due, as specced');
  passed++;
}
{
  // Daily/Weekdays recurring never shown in advance.
  const today = '2026-08-26';
  const tasks = [
    { id: 'r1', type: 'recurring', name: 'Daily tomorrow', frequency: 'Daily', skippable: true, nextDue: '2026-08-27', dueTime: null, priority: 'Low' }
  ];
  const view = engine.buildView(tasks, today);
  assert.strictEqual(view.today.length + view.upcoming.length, view.backlogGuaranteeItem ? 1 : 0, 'Daily due tomorrow must not appear anywhere except via the guarantee slot');
  console.log('ok - Daily/Weekdays recurring never shown in advance');
  passed++;
}

console.log('--- End Date comparison (spec §2.6 / LIVE BUGS §8) — nextDue vs endDate, NOT today vs endDate ---');
{
  // Regression pin for the real "Fill A Donation Bag" row (Chores
  // Recurring.md line 14): Last Completed 2026-08-11, Next Due 2026-08-12,
  // End Date 2026-08-23. today = 2026-08-26 in this whole test file.
  // nextDue (08-12) is NOT past endDate (08-23) -> the row must stay
  // visible, and since it's unskippable and overdue, it must land in
  // PAST DUE. Comparing today (08-26) > endDate (08-23) instead would
  // wrongly hide it — that was the actual bug, caught by a parity diff
  // against the live Main.md.
  const today = '2026-08-26';
  const donationBag = {
    id: 'donation-bag', type: 'recurring', name: 'Fill A Donation Bag',
    frequency: 'Weekly (Wed)', skippable: false,
    nextDue: '2026-08-12', dueTime: null, endDate: '2026-08-23', priority: 'Low'
  };
  const view = engine.buildView([donationBag], today);
  assert.strictEqual(view.pastDue.length, 1, 'nextDue before endDate, endDate in the past -> must be VISIBLE');
  assert.strictEqual(view.pastDue[0].id, 'donation-bag');
  assert.strictEqual(view.today.length, 0);
  assert.strictEqual(view.upcoming.length, 0);
  console.log('ok - nextDue (08-12) before endDate (08-23) -> visible in PAST DUE, despite today > endDate');
  passed++;

  // The other direction: nextDue AFTER endDate -> hidden (the real rule).
  const expiredOccurrence = { ...donationBag, id: 'donation-bag-2', nextDue: '2026-08-30', endDate: '2026-08-23' };
  const view2 = engine.buildView([expiredOccurrence], today);
  assert.strictEqual(view2.pastDue.length, 0);
  assert.strictEqual(view2.today.length, 0);
  assert.strictEqual(view2.upcoming.length, 0);
  console.log('ok - nextDue (08-30) after endDate (08-23) -> hidden from all sections');
  passed++;

  // Confirm the ordering claim too: the end-date check runs BEFORE
  // past-due handling, so an expired unskippable row is filtered by the
  // end-date check, not routed into PAST DUE by it.
  assert.deepStrictEqual(view2.pastDue, [], 'an expired-occurrence row must never reach PAST DUE — the end-date check runs first');
  console.log('ok - end-date check runs before past-due handling (expired row never reaches PAST DUE)');
  passed++;

  // And it is hidden, never removed — buildView is pure, so the task
  // object itself is untouched; only the VIEW omits it.
  assert.strictEqual(expiredOccurrence.nextDue, '2026-08-30', 'buildView must not mutate/remove the underlying task — hidden, not deleted');
  console.log('ok - expired-occurrence row is hidden from the view only, never mutated/removed from the data');
  passed++;
}

console.log('--- rollForward idempotency ---');
{
  const today = '2026-08-26';
  const tasks = [
    { id: 'r1', type: 'recurring', name: 'Skippable overdue weekly', frequency: 'Weekly (Sun)', skippable: true, nextDue: '2026-08-10', dueTime: '8:00pm', priority: 'Low' },
    { id: 'r2', type: 'recurring', name: 'Unskippable overdue', frequency: 'Weekly (Mon)', skippable: false, nextDue: '2026-08-10', dueTime: null, priority: 'High' }
  ];
  const first = engine.rollForward(tasks, today);
  assert.strictEqual(first.changed, true, 'first run should advance the skippable overdue row');
  assert.strictEqual(first.tasks.find(t => t.id === 'r1').nextDue, '2026-08-30');
  assert.strictEqual(first.tasks.find(t => t.id === 'r2').nextDue, '2026-08-10', 'unskippable row must be untouched by rollForward');
  assert.strictEqual(first.tasks.find(t => t.id === 'r1').dueTime, '8:00pm', 'dueTime must be preserved across the advance');

  const second = engine.rollForward(first.tasks, today);
  assert.strictEqual(second.changed, false, 'second run against the same today must be a no-op — idempotency');
  assert.deepStrictEqual(second.tasks, first.tasks, 'idempotent run must produce byte-identical task list');
  console.log('ok - rollForward is idempotent on a second run with the same today');
  passed++;

  // Original input array/objects must not have been mutated.
  assert.strictEqual(tasks[0].nextDue, '2026-08-10', 'rollForward must not mutate its input');
  console.log('ok - rollForward does not mutate its input');
  passed++;
}

console.log('--- stable sort / tie order (spec §4.5) ---');
{
  const today = '2026-08-26';
  // Four same-day, same-priority scheduled tasks in a specific input order —
  // ties must preserve that order (registry/file traversal order).
  const tasks = ['D', 'B', 'C', 'A'].map((n, i) => ({
    id: `s${i}`, type: 'scheduled', name: n, dueDate: today, dueTime: null, priority: 'Medium'
  }));
  const view = engine.buildView(tasks, today);
  check('stable order preserved for exact ties', view.today.map(t => t.name), ['D', 'B', 'C', 'A']);
}

console.log('--- duplicate-name completion targets only the matching id (contract §1.1) ---');
{
  // The four laundry rows, per spec §LIVE BUGS 1 / contract §1.1 — same
  // name, different frequencies, distinct ids. Simulates the /complete
  // handler's own id-targeted update (server.js does the actual DB write;
  // this proves the engine-level building block — calcNextDue keyed by the
  // completed task's OWN frequency — produces distinct results per id, so
  // an id-targeted update cannot cross-contaminate the other three rows).
  const laundry = [
    { id: 'laundry-sun', name: 'Put Away A Basket Of Laundry', frequency: 'Weekly (Sun)', nextDue: '2026-08-23' },
    { id: 'laundry-mon', name: 'Put Away A Basket Of Laundry', frequency: 'Weekly (Mon)', nextDue: '2026-08-24' },
    { id: 'laundry-wed', name: 'Put Away A Basket Of Laundry', frequency: 'Weekly (Wed)', nextDue: '2026-08-19' },
    { id: 'laundry-fri', name: 'Put Away A Basket Of Laundry', frequency: 'Weekly (Fri)', nextDue: '2026-08-21' }
  ];
  const today = '2026-08-26';
  // Complete only 'laundry-wed'.
  const targetId = 'laundry-wed';
  const updated = laundry.map(t => {
    if (t.id !== targetId) return t; // <- the fix: id-targeted, not name-targeted
    return { ...t, lastCompleted: today, nextDue: engine.calcNextDue(t.frequency, today) };
  });
  const target = updated.find(t => t.id === targetId);
  const others = updated.filter(t => t.id !== targetId);
  assert.strictEqual(target.nextDue, engine.calcNextDue('Weekly (Wed)', today));
  assert.strictEqual(target.lastCompleted, today);
  for (const o of others) {
    const original = laundry.find(t => t.id === o.id);
    assert.strictEqual(o.nextDue, original.nextDue, `non-targeted row ${o.id} must be untouched`);
    assert.strictEqual(o.lastCompleted, undefined, `non-targeted row ${o.id} must not gain lastCompleted`);
  }
  console.log('ok - id-targeted completion leaves the other 3 identically-named rows untouched');
  passed++;
}

console.log(`\n${passed} checks passed.`);
if (process.exitCode) {
  console.error('\nSOME CHECKS FAILED.');
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED.');
}
