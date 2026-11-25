/*
 * automation-rules.js — every rule registered with task-automation.js, in one list (docs/TASK-AUTOMATION.md).
 * Required by both server.js and todo-cli.js, so a completion runs the same rules wherever it happens.
 * To add a rule: write it in its project's module, register it here, list it in the doc, test it.
 */
'use strict';
const automation = require('./task-automation');
const subscriptions = require('./subscriptions');

// Subscriptions (Mac PM): checking off "Switch X to the subscription card" marks X on the card and keeps ONE
// "Set the subscription card's autopay to $T" task up to date. Safe to run twice (subscriptions.test.js).
automation.register('subcard-autopay', { onComplete: (task, tasks) => subscriptions.onTaskCompleted(task, tasks) });

// Tickets (VPS PM, phase 2): Alex checking off a ticket's task closes the ticket. The other direction, and repairs,
// are ticket-tasks.js sync(), run by the server worker. Safe to run twice (closing a closed ticket does nothing).
const tickets = require('./ticket-store').open(require('./todo-store').DATA_DIR);
automation.register('ticket-task', { onComplete: require('./ticket-tasks').rule(tickets) });

module.exports = automation;
