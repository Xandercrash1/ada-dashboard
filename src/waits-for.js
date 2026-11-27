'use strict';
/*
 * waits-for.js — "this task waits for that one" (Alex, 2026-11-26). Task fields: waitsFor (id of the task waited on)
 * and, on the task waited on, releaseBusinessDays (default 0). While the target is open, waiting tasks are hidden from
 * the day view (todo-engine withoutWaiting). When the target is checked off, each waiting backlog/scheduled task
 * becomes scheduled for releaseBusinessDays weekdays after the completion day. Recurring waiters are left alone.
 * Idempotent: a rescheduled task has waitsFor = null, so a second run finds nothing.
 */
const engine = require('./todo-engine');

function rule(task, tasks, ctx) {
  if (!task || !task.id) return undefined;
  const due = engine.addBusinessDays(ctx.today, Number(task.releaseBusinessDays) || 0);
  let changed = false;
  const out = tasks.map((t) => {
    if (t.waitsFor !== task.id) return t;
    if (t.type !== 'backlog' && t.type !== 'scheduled') { console.log(`[waits-for] left recurring task ${t.id} alone`); return t; }
    changed = true;
    const line = `Rescheduled ${due}: "${task.name}" was checked off (waited on it).`;
    return { ...t, type: 'scheduled', dueDate: due, waitsFor: null, notes: t.notes ? `${line}\n${t.notes}` : line, updatedAt: new Date().toISOString() };
  });
  return changed ? out : undefined;
}

module.exports = { rule };
