'use strict';
/*
 * overdue-review.js — the Home "Oldest overdue task" card (Alex, 2026-11-27). Once a day, from 08:00 Eastern, Alex
 * is shown his oldest overdue task with Defer / Delete, so things don't sit overdue forever. Handling it (deferred or
 * deleted) hides the card until the next day's 08:00. The handled date is stored in data/overdue-review.json
 * ({handledDate:'YYYY-MM-DD'}), so it holds across devices. Selection is pure and takes an injected clock.
 * Overdue and "today" come from todo-engine (taskDue, todayString, rollForward, Eastern time).
 */
const fs = require('fs');
const path = require('path');
const engine = require('./todo-engine');

const SHOW_FROM_HOUR = 8;
const SHOW_FROM = '08:00';

function easternHour(date) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: engine.TIMEZONE, hour: '2-digit', hour12: false }).format(date);
  return Number(h) % 24;   // some runtimes print midnight as "24"
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86400000);
}

// The oldest overdue task, or null. Excluded: autoKind tasks (loop deploys, ticket tasks, autopay...), tasks that
// wait for another, backlog (no date), and anything not due strictly before today (Eastern).
function pickOldest(tasks, today) {
  const rows = [];
  for (const t of tasks || []) {
    // Ticket tasks are offered (most overdue items are tickets; deleting one just unflags its ticket, ticket-tasks.js sync).
    if (!t || (t.autoKind && t.autoKind !== 'ticket') || t.waitsFor || t.type === 'backlog') continue;
    const due = engine.taskDue(t);
    if (!due || !engine.isValidDate(due) || due >= today) continue;
    rows.push({ t, due });
  }
  rows.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : String(a.t.createdAt || '') < String(b.t.createdAt || '') ? -1 : String(a.t.createdAt || '') > String(b.t.createdAt || '') ? 1 : 0));
  return rows.length ? rows[0] : null;
}

/** review({tasks, handledDate, now}) -> {task|null, handled, showFrom, today, daysOverdue?, dueDate?} */
function review({ tasks, handledDate, now }) {
  const date = now || engine.now();
  const today = engine.todayString(date);
  const handled = handledDate === today;
  const out = { task: null, handled, showFrom: SHOW_FROM, today };
  if (handled || easternHour(date) < SHOW_FROM_HOUR) return out;
  // Same view as the Tasks list: repeating tasks rolled forward first, so a skippable one isn't "overdue".
  const rolled = engine.rollForward(tasks || [], today).tasks;
  const hit = pickOldest(rolled, today);
  if (hit) { out.task = hit.t; out.dueDate = hit.due; out.daysOverdue = daysBetween(hit.due, today); }
  return out;
}

function create({ dataDir, store }) {
  const file = path.join(dataDir, 'overdue-review.json');
  function readHandled() {
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return typeof d.handledDate === 'string' ? d.handledDate : null; } catch (e) { return null; }
  }
  return {
    file,
    readHandled,
    markHandled(date) { store.atomicWriteJson(file, { handledDate: date || engine.todayString() }); },
    review(tasks, now) { return review({ tasks, handledDate: readHandled(), now }); },
  };
}

module.exports = { review, pickOldest, easternHour, daysBetween, create, SHOW_FROM };
