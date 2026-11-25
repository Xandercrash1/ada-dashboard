'use strict';

/**
 * subscriptions.js — "switch X to the subscription card" automation.
 *
 * When a scheduled/backlog task linked to a subscription row
 * (row.switchTaskId === task.id) is completed, the row is marked onCard and a
 * single open task "Set the subscription card's autopay to $T" is created (or
 * updated in place) telling Alex what to set the card's autopay to.
 *
 * Shared by src/server.js and src/todo-cli.js so a completion from either
 * path fires the hook. processCompletion() is pure (tests use it directly);
 * onTaskCompleted() is the store-backed wrapper and must be called INSIDE
 * todoStore.withLock (the lock is not reentrant) with the tasks array that
 * the caller is about to write.
 */

const path = require('path');
const todoStore = require('./todo-store');
const todoEngine = require('./todo-engine');

const SUBS_FILE = path.join(todoStore.DATA_DIR, 'subscriptions.json');
const AUTO_KIND = 'subcard-autopay';
const BUFFER = 10;
const MIN_PAYMENT = 30;

const money = n => Number(n).toFixed(2);

function readSubscriptions() { return todoStore.readJsonStoreOrThrow(SUBS_FILE); }
function writeSubscriptions(rows) { todoStore.atomicWriteJson(SUBS_FILE, rows); }

// Monthly subs on the card only; yearly are covered by the buffer on purpose.
function computeTotal(subs) {
  const items = subs.filter(s => s.onCard && s.cycle === 'monthly' && s.price != null && Number.isFinite(Number(s.price)));
  const total = items.reduce((sum, s) => sum + Number(s.price), 0) + BUFFER + MIN_PAYMENT;
  return { items, total: Math.round(total * 100) / 100 };
}

function buildNotes(items, total, completedName) {
  const lines = items.map(s => `${s.name}: $${money(s.price)}`);
  lines.push(`+ $${money(BUFFER)} buffer`);
  lines.push(`+ $${money(MIN_PAYMENT)} minimum payment`);
  lines.push(`= $${money(total)}`);
  lines.push('');
  lines.push(`Generated when '${completedName}' was checked off.`);
  return lines.join('\n');
}

/**
 * processCompletion(subs, tasks, completedTask, now, today)
 *   -> { subs, tasks, changed, autopayTask }
 * Mutates nothing it was given; returns fresh arrays.
 */
function processCompletion(subs, tasks, completedTask, now, today) {
  const idx = subs.findIndex(s => s.switchTaskId && s.switchTaskId === completedTask.id);
  if (idx === -1 || completedTask.type === 'recurring') return { subs, tasks, changed: false, autopayTask: null };

  const nowIso = now.toISOString();
  const newSubs = subs.map((s, i) => (i === idx ? { ...s, onCard: true, onCardAt: nowIso } : s));
  const { items, total } = computeTotal(newSubs);
  const name = `Set the subscription card's autopay to $${money(total)}`;
  const notes = buildNotes(items, total, completedTask.name);

  const newTasks = tasks.slice();
  const openIdx = newTasks.findIndex(t => t.autoKind === AUTO_KIND);
  let autopayTask;
  if (openIdx !== -1) {
    autopayTask = { ...newTasks[openIdx], name, notes, dueDate: today, updatedAt: nowIso };
    newTasks[openIdx] = autopayTask;
  } else {
    autopayTask = {
      id: todoEngine.generateId(),
      type: 'scheduled',
      name,
      project: 'Chores',
      priority: 'Low',
      notes,
      tags: [],
      frequency: null,
      skippable: null,
      nextDue: null,
      dueTime: null,
      endDate: null,
      dueDate: today,
      added: null,
      owner: 'alex',
      sharedWith: [],
      sourceFile: null,
      autoKind: AUTO_KIND,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    newTasks.push(autopayTask);
  }
  return { subs: newSubs, tasks: newTasks, changed: true, autopayTask };
}

/**
 * Store-backed hook. Call inside todoStore.withLock, after the completed task
 * has been removed from `tasks` and BEFORE the caller writes tasks. Returns the
 * tasks array to write (same array if nothing linked).
 */
function onTaskCompleted(completedTask, tasks) {
  const subs = readSubscriptions();
  if (!Array.isArray(subs) || !subs.length) return tasks;
  const r = processCompletion(subs, tasks, completedTask, new Date(), todoEngine.todayString());
  if (!r.changed) return tasks;
  writeSubscriptions(r.subs);
  return r.tasks;
}

module.exports = { SUBS_FILE, AUTO_KIND, readSubscriptions, writeSubscriptions, computeTotal, processCompletion, onTaskCompleted };
