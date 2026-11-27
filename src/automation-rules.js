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
// Self-improvement loop (VPS PM): Alex checking off a "Deploy: X (tested)" task (with its confirm) starts the deploy.
// Only the live checkout starts one (src/loop.js); a re-run finds the ticket no longer "ready" and does nothing.
automation.register('loop-deploy', { onComplete: require('./loop').rule(tickets) });

// Devices (VPS PM, 2026-11-25): Alex checking off "Set up SSH from X to Y" records that X reaches Y, so sessions on X
// also pick up Y's items (src/device-reach.js). Safe to run twice (an existing pair isn't added again).
automation.register('device-reach', { onComplete: require('./device-reach').rule(require('./todo-store').DATA_DIR) });

// Waits for (VPS PM, 2026-11-26): checking off a task reschedules every task that waits on it (src/waits-for.js).
// Safe to run twice (the second run finds no task still waiting on it).
automation.register('waits-for', { onComplete: require('./waits-for').rule });

module.exports = automation;
