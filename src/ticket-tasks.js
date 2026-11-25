/*
 * ticket-tasks.js — a ticket that needs Alex has exactly one task, and the two close together (task automation
 * phase 2, Alex 2026-11-24; docs/TASK-AUTOMATION.md § Tickets).
 *
 *   rule(task, tasks, ctx)  registered as 'ticket-task': Alex checking off the task closes its ticket.
 *   sync()                  reconciles both ways, safe to run any number of times (the worker runs it every minute,
 *                           routes run it straight after a ticket changes):
 *     open ticket, needsAlex, no task yet         -> one task (autoKind 'ticket', autoKey = ticket id), linked by taskId
 *     open ticket whose linked task was checked off -> ticket closed (covers a rule run that failed or was lost)
 *     open ticket whose linked task was deleted   -> needsAlex turned off with a note, so it is never re-created
 *     task whose ticket is closed, gone, or no longer needs Alex -> task closed (resolveAuto)
 * Lock order: the todo lock, then the ticket lock. Never call sync() while holding the ticket lock.
 */
'use strict';
const { isClosed } = require('./ticket-store');

const KIND = 'ticket';
const RULE = 'ticket-task';
const PROJECT = 'AI Server';

function taskFields(tk, today) {
  return {
    type: 'scheduled', name: `Ticket: ${tk.title}`.slice(0, 200), project: PROJECT, dueDate: today,
    notes: `Dashboard ticket ${tk.id} needs you (Server > Feedback). Checking this off closes the ticket.\n\n${String(tk.body || '').slice(0, 1500)}`,
    tags: [], owner: 'alex', sharedWith: [],
  };
}

function rule(tickets) {
  return (task, _tasks, ctx) => {
    if (task.autoKind !== KIND || !task.autoKey) return undefined;
    if (ctx.origin === `automation:${RULE}`) return undefined;   // the sync closed it because the ticket was already handled
    tickets.mutate((items) => {
      const tk = items.find((i) => i.id === task.autoKey);
      if (!tk || isClosed(tk)) return;
      tk.notes = (tk.notes ? tk.notes + '\n' : '') + `[auto] Closed ${new Date().toISOString()}: Alex checked off its task.`;
      tickets.applyUpdate(tk, { status: 'done', processedBy: tk.processedBy || 'alex (task)' });
    });
    return undefined;
  };
}

function create({ tickets, store, automation, upsertAutoTask, engine }) {
  function sync() {
    return store.withLock(() => {
      const list = tickets.read(), today = engine.todayString(), now = new Date();
      let tasks = store.readTasks();
      const start = tasks;
      const completed = new Set(store.readCompleted().filter((c) => !String(c.source || '').startsWith('automation:')).map((c) => c.taskId));   // a person's completion only
      const link = {}, closeDone = [], unflag = [];
      for (const tk of list) {
        if (!tk.needsAlex || isClosed(tk)) continue;
        if (tasks.some((t) => t.autoKind === KIND && t.autoKey === tk.id)) continue;
        if (tk.taskId) { (completed.has(tk.taskId) ? closeDone : unflag).push(tk.id); continue; }
        tasks = upsertAutoTask(tasks, KIND, tk.id, taskFields(tk, today), { source: `automation:${RULE}`, now });
        link[tk.id] = tasks[tasks.length - 1].id;
      }
      if (tasks !== start) store.writeTasks(tasks);
      // Tasks whose ticket no longer wants one. resolveAuto writes the store itself (and runs the rules, which skip).
      const byId = new Map(list.map((t) => [t.id, t]));
      const stale = store.readTasks().filter((t) => t.autoKind === KIND && (() => { const tk = byId.get(t.autoKey); return !tk || isClosed(tk) || !tk.needsAlex; })());
      if (tickets.exists()) for (const t of stale) automation.resolveAuto(KIND, t.autoKey, { rule: RULE });   // no ticket file (e.g. mid-restore): close nothing
      const touched = Object.keys(link).length + closeDone.length + unflag.length;
      if (touched) {
        tickets.mutate((items) => {
          const at = new Date().toISOString();
          for (const tk of items) {
            if (link[tk.id]) { tk.taskId = link[tk.id]; tk.updatedAt = at; }
            if (isClosed(tk)) continue;
            if (closeDone.includes(tk.id)) {
              tk.notes = (tk.notes ? tk.notes + '\n' : '') + `[auto] Closed ${at}: Alex checked off its task.`;
              tickets.applyUpdate(tk, { status: 'done', processedBy: tk.processedBy || 'alex (task)' });
            } else if (unflag.includes(tk.id)) {
              tk.notes = (tk.notes ? tk.notes + '\n' : '') + `[auto] ${at}: its task was deleted, so it no longer makes one. Flag it again to get a new task.`;
              tickets.applyUpdate(tk, { needsAlex: false });
              delete tk.taskId;
            }
          }
        });
      }
      return { created: Object.keys(link).length, closedTickets: closeDone.length, unflagged: unflag.length, closedTasks: tickets.exists() ? stale.length : 0 };
    });
  }
  return { sync };
}

module.exports = { create, rule, KIND, RULE };
