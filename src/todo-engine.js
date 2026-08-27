'use strict';

/**
 * todo-engine.js — pure-function port of Ada/TODO/vault_todo.py's recurrence,
 * sorting, windowing and view-building logic.
 *
 * Contract: `Antigravity/TODO Migration — Contract.md`.
 * Behavior source: `Alex's Vault/Projects/AI Server/Report — vault_todo.py Behavioral Spec.md`.
 *
 * HARD RULE (contract §3): pure functions only. No Express, no filesystem,
 * no `Date.now()` / `new Date()` captured implicitly inside business logic.
 * Every function that needs "today" takes it as a parameter, as a
 * "YYYY-MM-DD" string. The only exception is `now()` below, which exists
 * so the rest of the app (server.js) has ONE clock to call instead of
 * scattering `new Date()` — callers still pass the result in explicitly.
 */

// --- Clock -------------------------------------------------------------

const TIMEZONE = 'America/New_York';

// The single clock for the whole app (contract §1.4 + feedback-archive
// addendum). Callers derive "today" or "now" from this, once, and pass the
// value down — nothing downstream calls `new Date()` bare.
function now() {
  return new Date();
}

// "Today" as a YYYY-MM-DD string in the pinned timezone. date.today() in
// Python is the Mac's local date; this is the Node equivalent that does not
// drift with the server's own TZ (contract §1.4 — the whole reason this
// exists).
function todayString(date) {
  const d = date || now();
  // en-CA formats as YYYY-MM-DD, which is exactly the wire format used
  // throughout this module and the storage schema.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(d);
}

// --- Date arithmetic (all in UTC-anchored calendar math — a "YYYY-MM-DD"
// string never carries a timezone of its own, so date math on it must not
// pick one up by accident via the local Date constructor). ---------------

function ymdToUtcDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function utcDateToYmd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(ymd, n) {
  const d = ymdToUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDateToYmd(d);
}
// Python's date.weekday(): Monday=0 ... Sunday=6. JS getUTCDay(): Sunday=0.
function weekdayOf(ymd) {
  const jsDay = ymdToUtcDate(ymd).getUTCDay();
  return (jsDay + 6) % 7;
}
// Days in calendar month `month` (1-12) of `year`.
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  return true;
}

// --- Frequency parsing ---------------------------------------------------
// Exact-match, case-sensitive, three-letter weekday abbreviations only.
// "Weekly (Sunday)" (full name) is deliberately NOT recognized here —
// in Python that's an uncaught KeyError (spec §2.2); per contract §1.3 we
// validate-and-reject at write time instead of crashing, so here it just
// resolves to "invalid" rather than throwing.
const WEEKDAY_ABBR = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const RE_WEEKLY = /^Weekly \(([A-Za-z]{3})\)$/;
const RE_FORTNIGHT = /^Every 2 Weeks \(([A-Za-z]{3})\)$/;
const RE_MONTHLY = /^Monthly \((\d+)[A-Za-z]*\)$/;

function isValidFrequency(freq) {
  if (freq === 'Daily' || freq === 'Weekdays' || freq === 'Yearly') return true;
  let m = RE_WEEKLY.exec(freq);
  if (m) return WEEKDAY_ABBR[m[1]] !== undefined;
  m = RE_FORTNIGHT.exec(freq);
  if (m) return WEEKDAY_ABBR[m[1]] !== undefined;
  m = RE_MONTHLY.exec(freq);
  if (m) return true;
  return false;
}

/**
 * calc_next_due port (spec §2.1). ONLY used at completion time
 * (`/complete` on a recurring task) — anchor = the completion date.
 * Returns a "YYYY-MM-DD" string, or null for anything unparseable
 * (Python: uncaught exception or None; here: always null, never throws —
 * contract §1.3).
 */
function calcNextDue(frequency, completedOn) {
  if (!isValidDate(completedOn)) return null;

  if (frequency === 'Daily') {
    return addDays(completedOn, 1);
  }
  if (frequency === 'Weekdays') {
    let d = addDays(completedOn, 1);
    while (weekdayOf(d) >= 5) d = addDays(d, 1);
    return d;
  }
  let m = RE_WEEKLY.exec(frequency);
  if (m) {
    const target = WEEKDAY_ABBR[m[1]];
    if (target === undefined) return null;
    let d = addDays(completedOn, 1);
    while (weekdayOf(d) !== target) d = addDays(d, 1);
    return d;
  }
  m = RE_FORTNIGHT.exec(frequency);
  if (m) {
    const target = WEEKDAY_ABBR[m[1]];
    if (target === undefined) return null;
    let d = addDays(completedOn, 1);
    while (weekdayOf(d) !== target) d = addDays(d, 1);
    // Deliberate asymmetry vs advanceSkippable (contract §1.5) — the
    // fortnight offset is applied here, NOT in advanceSkippable. Preserved
    // faithfully even though it looks like a bug.
    return addDays(d, 7);
  }
  m = RE_MONTHLY.exec(frequency);
  if (m) {
    const n = Number(m[1]);
    const [y, mo] = completedOn.split('-').map(Number);
    let nextMonth = mo + 1, nextYear = y;
    if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
    const day = Math.min(n, daysInMonth(nextYear, nextMonth));
    return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (frequency === 'Yearly') {
    const [y, mo, d] = completedOn.split('-').map(Number);
    const nextYear = y + 1;
    const day = Math.min(d, daysInMonth(nextYear, mo));
    return `${nextYear}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

/**
 * advance_skippable port (spec §2.3). ONLY used for a skippable recurring
 * task that has gone past due, at render/rollForward time — anchor =
 * today, NOT the (nonexistent) completion date.
 *
 * ⚠️ Deliberate asymmetry with calcNextDue (contract §1.5): the fortnight
 * offset is NOT applied here. A skippable "Every 2 Weeks (X)" that lapses
 * lands 0–6 days out instead of 8–14. Preserved faithfully; flagged as a
 * candidate fix for Alex to rule on, not silently "corrected".
 */
function advanceSkippable(frequency, today) {
  if (!isValidDate(today)) return today;

  if (frequency === 'Daily') return today;

  if (frequency === 'Weekdays') {
    let d = today;
    while (weekdayOf(d) >= 5) d = addDays(d, 1);
    return d;
  }

  let m = RE_WEEKLY.exec(frequency);
  if (!m) m = RE_FORTNIGHT.exec(frequency);
  if (m) {
    const target = WEEKDAY_ABBR[m[1]];
    if (target === undefined) return today; // falls through to today, per spec §2.3 "unrecognised"
    let d = today;
    while (weekdayOf(d) !== target) d = addDays(d, 1);
    return d; // NOTE: no +7 here — see asymmetry comment above.
  }

  const mm = RE_MONTHLY.exec(frequency);
  if (mm) {
    const n = Number(mm[1]);
    const [y, mo] = today.split('-').map(Number);
    const day = Math.min(n, daysInMonth(y, mo));
    const candidate = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (candidate >= today) return candidate;
    let nextMonth = mo + 1, nextYear = y;
    if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
    const day2 = Math.min(n, daysInMonth(nextYear, nextMonth));
    return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(day2).padStart(2, '0')}`;
  }

  // Yearly, unrecognised, or empty — spec §2.3: falls through to today.
  return today;
}

/**
 * Skippability resolution rule (spec §2.4), applied AT IMPORT to produce a
 * real boolean stored on the task. Exact-string, case-sensitive.
 *   skippableRaw === "Yes"                              -> true
 *   skippableRaw === "No"                                -> false
 *   otherwise: true only for Daily/Weekdays, else false
 */
function resolveSkippable(skippableRaw, frequency) {
  if (skippableRaw === 'Yes') return true;
  if (skippableRaw === 'No') return false;
  return frequency === 'Daily' || frequency === 'Weekdays';
}

// --- Date/time string parsing (spec §3.1 parse_date + §3.2 Notes "by …") -

// parse_date port. Prefix match (re.match semantics), not anchored at the
// end — trailing junk is ignored, leading junk fails. Time requires
// "H:MM" + lowercase am/pm with NO space before the meridiem.
const RE_DUE = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d+:\d+(?:am|pm)))?/;
function parseDueParts(str) {
  if (!str) return { date: null, time: null };
  const m = RE_DUE.exec(String(str).trim());
  if (!m) return { date: null, time: null };
  if (!isValidDate(m[1])) return { date: null, time: null }; // e.g. "2026-13-40" — Python throws; here just fails to parse (§1.3)
  return { date: m[1], time: m[2] || null };
}

// "by H(:MM)am/pm" out of a Scheduled row's Notes column, only consulted
// when the Due Date cell had no time. Anchored at start, looser than
// parse_date (minute-less "by 8pm" is accepted). Port as-is (spec §3.2).
const RE_NOTES_TIME = /^[Bb]y\s+(\d+(?::\d+)?(?:am|pm))/;
function parseTimeFromNotes(notes) {
  if (!notes) return null;
  const m = RE_NOTES_TIME.exec(notes);
  return m ? m[1] : null;
}

// time_to_minutes port (spec §3.3). No match -> 9999 sentinel, so untimed
// sorts after everything timed on the same day.
function timeToMinutes(str) {
  if (!str) return 9999;
  const m = /^(\d+):(\d{2})(am|pm)$/i.exec(String(str).trim());
  if (!m) return 9999;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const mer = m[3].toLowerCase();
  if (mer === 'am') { if (h === 12) h = 0; } else if (h !== 12) { h += 12; }
  return h * 60 + min;
}

// --- Sorting --------------------------------------------------------------

const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
function priorityRank(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? PRIORITY_RANK[p] : 2;
}

function taskDue(task) {
  if (task.type === 'recurring') return task.nextDue || null;
  if (task.type === 'scheduled') return task.dueDate || null;
  return null; // backlog is never dated
}

// (due, time_to_minutes, priority_rank) tuple, per spec §4.5.
function sortKey(task) {
  const due = taskDue(task) || '9999-12-31';
  return [due, timeToMinutes(task.dueTime), priorityRank(task.priority)];
}

// Comparator for a STABLE sort (Node's Array.prototype.sort is stable per
// spec since ES2019 / all supported Node versions) — ties preserve the
// array's existing order, which must itself reflect import traversal order
// (registry row -> task file -> row order), per spec §4.5 / contract §1.5.
function compareBySortKey(a, b) {
  const ka = sortKey(a), kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

// --- View building (spec §4) ----------------------------------------------

/**
 * buildView(tasks, today) — PURE. Must not mutate `tasks` or any task
 * object inside it (contract §3). `today` is a "YYYY-MM-DD" string.
 *
 * Returns { pastDue, today, upcoming, backlogGuaranteeItem, flagged }.
 * `flagged` is an addition beyond the contract's minimum shape, satisfying
 * §1.3's "a stored row that fails to parse must be surfaced ... never
 * silently dropped" — in practice this should stay empty, since writes are
 * validated, but it is a defensive net against pre-validation/hand-edited
 * data.
 */
function buildView(tasks, today) {
  const windowEnd = addDays(today, 2); // §4.6 — 3-day inclusive window

  const pastDue = [];
  const flagged = [];
  const windowed = [];

  for (const task of tasks) {
    if (task.type === 'backlog') {
      continue; // never past-due, never windowed (§3.4 / §4.6) — guarantee pool only
    }

    if (task.type === 'recurring') {
      if (!isValidFrequency(task.frequency) || !isValidDate(task.nextDue)) {
        flagged.push(task);
        continue;
      }
      // End Date hides but never removes (spec §LIVE BUGS 8 / §2.6) — the
      // check runs BEFORE past-due handling, so an expired unskippable row
      // never surfaces as PAST DUE either. Ported faithfully, INCLUDING
      // the comparison it uses: `nextDue > endDate` — "is this occurrence
      // scheduled past the end of the series?" — NOT `today > endDate`.
      // The intuitive reading (today vs endDate) is wrong and was caught
      // by a parity diff against the live Main.md: "Fill A Donation Bag"
      // has nextDue=2026-08-12, endDate=2026-08-23 — 08-12 > 08-23 is
      // false, so the row stays visible (and correctly lands in PAST DUE
      // below, since today=2026-08-26 > nextDue and it's unskippable).
      // Comparing today > endDate instead would have hidden it entirely.
      if (task.endDate && isValidDate(task.endDate) && task.nextDue && task.nextDue > task.endDate) {
        continue;
      }
      if (!task.skippable && task.nextDue < today) {
        pastDue.push(task); // §3.4 — only UNSKIPPABLE recurring is past-due
        continue;
      }
      const isDailyLike = task.frequency === 'Daily' || task.frequency === 'Weekdays';
      const inWindow = isDailyLike
        ? task.nextDue === today // never shown in advance
        : (task.nextDue >= today && task.nextDue <= windowEnd);
      if (inWindow) windowed.push(task);
      continue;
    }

    if (task.type === 'scheduled') {
      if (!isValidDate(task.dueDate)) {
        flagged.push(task);
        continue;
      }
      if (task.dueDate < today) {
        pastDue.push(task); // unconditional, §3.4
        continue;
      }
      if (task.dueDate <= windowEnd) windowed.push(task);
      continue;
    }

    // Unknown type — flag rather than silently drop (§1.3).
    flagged.push(task);
  }

  pastDue.sort(compareBySortKey);
  windowed.sort(compareBySortKey);

  // Splitting a sortKey-sorted array by due===today/due>today preserves
  // sortedness (and therefore the stable-tie ordering) of each half.
  const todayItems = windowed.filter(t => taskDue(t) === today);
  const upcomingItems = windowed.filter(t => taskDue(t) > today);

  // Backlog guarantee (§4.7). Triggers when the window (today+upcoming)
  // contains NOTHING but Daily/Weekdays recurring items — including when
  // it is empty. past_due is NOT consulted.
  let backlogGuaranteeItem = null;
  const onlyDailyLike = windowed.every(
    t => t.type === 'recurring' && (t.frequency === 'Daily' || t.frequency === 'Weekdays')
  );
  if (onlyDailyLike) {
    const pool = tasks.filter(t => t.type === 'backlog');
    if (pool.length > 0) {
      const ranked = pool.slice().sort((a, b) => {
        const pr = priorityRank(a.priority) - priorityRank(b.priority);
        if (pr !== 0) return pr;
        const aa = a.added || '', ab = b.added || ''; // raw string compare, empty sorts first
        if (aa < ab) return -1;
        if (aa > ab) return 1;
        return 0;
      });
      backlogGuaranteeItem = ranked[0];
      todayItems.push(backlogGuaranteeItem); // due=null -> sorts last within Today by construction
    }
  }

  return { pastDue, today: todayItems, upcoming: upcomingItems, backlogGuaranteeItem, flagged };
}

/**
 * rollForward(tasks, today) — advances a SKIPPABLE recurring task's
 * nextDue when it has gone past due, per spec §2.5. Returns a NEW array
 * (does not mutate the input array or its unchanged elements); changed
 * items are shallow-cloned. `dueTime` is preserved untouched (advance only
 * ever changes the date part, mirroring the Python "time suffix preserved"
 * behavior).
 *
 * MUST be idempotent: advanceSkippable always returns a date >= today, so
 * a second run's `nextDue < today` test is false and nothing changes.
 */
function rollForward(tasks, today) {
  let changed = false;
  const result = tasks.map(task => {
    if (
      task.type === 'recurring' &&
      task.skippable &&
      isValidFrequency(task.frequency) &&
      isValidDate(task.nextDue) &&
      task.nextDue < today
    ) {
      const advanced = advanceSkippable(task.frequency, today);
      if (advanced !== task.nextDue) {
        changed = true;
        return { ...task, nextDue: advanced, updatedAt: new Date().toISOString() };
      }
    }
    return task;
  });
  return { tasks: result, changed };
}

// --- IDs -------------------------------------------------------------------

function generateId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `task-${Date.now()}-${rand}`;
}

module.exports = {
  TIMEZONE,
  now,
  todayString,
  addDays,
  weekdayOf,
  daysInMonth,
  isValidDate,
  isValidFrequency,
  WEEKDAY_ABBR,
  calcNextDue,
  advanceSkippable,
  resolveSkippable,
  parseDueParts,
  parseTimeFromNotes,
  timeToMinutes,
  priorityRank,
  taskDue,
  sortKey,
  compareBySortKey,
  buildView,
  rollForward,
  generateId
};
