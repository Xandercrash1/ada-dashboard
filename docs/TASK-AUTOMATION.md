# Task automation: the one standard

_Alex, 2026-11-24: one documented system for automatic tasks, used by every project, so upgrading it upgrades everything. Built by the VPS PM. The design record is in the Ada vault: `Projects/AI Server/Plan — Task Automation Standard.md`._

"Automatic tasks" covers three things:
- tasks that check themselves off;
- tasks that a completion creates or updates;
- tasks that a page action creates.

**Rule for every project:** anything that creates, completes or reacts to tasks automatically goes through `src/task-automation.js`, registers in `src/automation-rules.js`, and is listed below. Never wire a project-specific hook into a route.

## The contract

| Piece | What it is |
|---|---|
| `completeLocked(tasks, task, {source, depth})` | **The only completion path.** The Tasks route, `todo-cli.js complete` and page buttons (Subscriptions on-card) all call it, inside `todoStore.withLock()`. It returns the same body as always: a repeating task returns the updated task (moved on, not logged to history); any other task returns `{ success, completedEntry }`, logged to history before it's removed. |
| `register(rule, { onComplete(task, tasks, ctx) })` | A rule that reacts to completions. It returns the new tasks array (or nothing) and may write its own data. **It must be safe to run twice.** `ctx` holds `source`, `depth`, `today`, `now` and `upsertAutoTask`. |
| `upsertAutoTask(tasks, autoKind, autoKey, fields, ctx)` | "One open task per kind (+ key), kept up to date". It updates the open one in place, keeping its id, or adds one. It's never duplicated. |
| `resolveAuto(autoKind, autoKey)` | The owner of a condition (a route, or the worker) closes its auto task when the condition is met. It goes through `completeLocked`, with `source: automation:<rule>`. **Never call it from inside a rule's `onComplete`**: it writes the store itself, and the rule's own write would undo it. |
| `task.then = { name, project, dueInDays, notes, then? }` | A code-free "when this is done, create that". It doesn't work on repeating tasks. **For now it can only be set by code**, because the task form and API don't accept `then` yet. |

## Durability, collisions, loops
- **Lock:** `todoStore.withLock()` is a cross-process lockfile, so the server and the CLI never write at the same time.
- **Outbox queue** (`data/automation-queue.json`): each rule's job is written **before** the completion is saved, then run straight away in the same request, so pages see the result at once. A job whose completion was never saved, because of a crash in between, is dropped after a minute and logged as `dropped`.
- **Retries:** if a rule throws, the completion stands, and the job stays queued. The server's worker (`automationTick`, every minute and at start-up) retries it about 1 min, 5 min, 30 min and 2 h after failures 1–4. On the 5th failure it moves to `data/automation-dead.json`, and **one dashboard ticket** is filed ("Task automation stuck: …"), so nothing is ever silently dropped. A job that dies during a CLI completion is ticketed by the next worker run (`ticketed` flag).
- **Broken files never block completions:** an unreadable queue, log or dead-list file is kept as `<name>.corrupt-<time>` and started fresh. The worker's queue step and roll-forward step fail separately.
- **No loops:**
  - Each job has a key (`rule:taskId`, plus the date for repeating tasks). The same key is never queued twice, and never again once it's done.
  - An automation that triggers more automation goes one level deeper. Past depth 3, the job is dead-lettered with the reason.
  - Only automation counts toward that cap: a person ticking off a `then` chain by hand never hits it.
  - A queued job runs only if its completion was really saved: the task is gone, or for a repeating task, `lastCompleted` is that day.
- **Audit:**
  - `data/automation-log.json` (last 1000) records each run's key, rule, result (done / retry / dead / dropped) and attempts.
  - Automatic completions carry `source` in history.
  - Generated tasks show an **auto** mark in the Tasks tab.
  - `GET /api/automation` (admin) returns the queue, the dead list, recent runs and the rules.
- **Repeating tasks:** the "roll a missed skippable task forward" step is saved by the worker. `GET /api/todo` only shows the rolled view and never writes.

## Adding a rule
1. Write the handler in its project's module (pure where possible), safe to run twice.
2. Register it in `src/automation-rules.js`.
3. Add it to the list below.
4. Add tests for the rule, and keep `src/task-automation.test.js` green.

## Current rules
| Rule | Project, owner | What it does |
|---|---|---|
| `subcard-autopay` | Subscriptions (Mac PM) | Checking off "Switch X to the subscription card" marks X on the card and keeps one "Set the subscription card's autopay to $T" task up to date (`src/subscriptions.js`, 55 checks in `subscriptions.test.js`). |
| `then` (built in) | any | `task.then` chains. |

## Scope
- **In:** dashboard tasks (`data/todo_tasks.json`), including repeating tasks.
- **Next (phase 2, to discuss with Alex):** feedback tickets (`health-check.py`, `bug-crawler.js` and `weekly-sweep.py` create and update them).
- **Project boards** (`project-dash.js` lanes) join **project by project**. Fiverr is the first contender. Candidate rules are listed in the vault plan.
