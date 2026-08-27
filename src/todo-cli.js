#!/usr/bin/env node
'use strict';

/**
 * todo-cli.js — operates directly on the JSON store, NOT over HTTP, so it
 * needs no password (contract §5: "The local Claude system on my Mac can
 * simply SSH in and add stuff when needed.").
 *
 * Reuses todo-engine.js / todo-store.js / todo-validate.js — the exact same
 * modules the HTTP API uses. No second, laxer parser.
 *
 * Usage:
 *   node todo-cli.js add --project "Chores" --type scheduled --name "..." --due 2026-08-30 --priority High
 *   node todo-cli.js add --project "Chores" --type recurring --name "..." --frequency "Weekly (Sun)" --next-due 2026-08-30 [--time "8:00pm"] [--skippable true|false] [--end-date 2026-12-31]
 *   node todo-cli.js add --project "Vault TODO" --type backlog --name "..." [--added 2026-08-26]
 *   node todo-cli.js list [--project X] [--type Y] [--json]
 *   node todo-cli.js complete <id> [--json]
 *   node todo-cli.js today [--json]
 *
 * `--json` on every command for machine-readable output (contract §5 —
 * "the caller is usually an AI agent").
 */

const engine = require('./todo-engine');
const store = require('./todo-store');
const { normalizeTask } = require('./todo-validate');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function output(json, data, plainFn) {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    plainFn(data);
  }
}

function fail(json, message) {
  if (json) {
    process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function cmdAdd(args) {
  const raw = {
    type: args.type,
    name: args.name,
    project: args.project,
    priority: args.priority,
    notes: args.notes,
    frequency: args.frequency,
    nextDue: args['next-due'] || args.due,
    dueDate: args.due,
    dueTime: args.time,
    endDate: args['end-date'],
    added: args.added
  };
  if (args.skippable !== undefined) {
    const b = toBool(args.skippable);
    if (b === undefined) return fail(args.json, `--skippable must be "true" or "false" (got ${JSON.stringify(args.skippable)})`);
    raw.skippable = b;
  }

  const { task, errors } = normalizeTask(raw, null);
  if (errors) return fail(args.json, errors.join('; '));

  const nowIso = new Date().toISOString();
  const newTask = {
    id: engine.generateId(),
    ...task,
    sourceFile: null,
    createdAt: nowIso,
    updatedAt: nowIso
  };

  store.withLock(() => {
    const tasks = store.readTasks();
    tasks.push(newTask);
    store.writeTasks(tasks);
  });

  output(args.json, newTask, t => console.log(`Added ${t.type} task "${t.name}" (${t.id}) to ${t.project}.`));
}

function cmdList(args) {
  let tasks = store.readTasks();
  if (args.project) tasks = tasks.filter(t => t.project === args.project);
  if (args.type) tasks = tasks.filter(t => t.type === args.type);
  output(args.json, tasks, list => {
    if (!list.length) { console.log('No tasks.'); return; }
    for (const t of list) {
      const due = t.nextDue || t.dueDate || (t.added ? `(backlog, added ${t.added})` : '');
      console.log(`${t.id}  [${t.type}]  ${t.project} — ${t.name}  ${due}  ${t.priority}`);
    }
  });
}

function cmdComplete(args) {
  const id = args._[0];
  if (!id) return fail(args.json, 'Usage: todo-cli.js complete <id>');
  const today = engine.todayString();

  let result;
  store.withLock(() => {
    const tasks = store.readTasks();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) { result = { error: `No task with id ${id}` }; return; }
    const task = tasks[idx];

    if (task.type === 'recurring') {
      const nextDue = engine.calcNextDue(task.frequency, today);
      if (nextDue === null) {
        result = { error: `Cannot complete "${task.name}": frequency "${task.frequency}" is unparseable, so no next due date could be computed.` };
        return;
      }
      tasks[idx] = { ...task, lastCompleted: today, nextDue, updatedAt: new Date().toISOString() };
      store.writeTasks(tasks);
      result = { task: tasks[idx] };
      return;
    }

    const completed = store.readCompleted();
    const entry = {
      id: `completed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id,
      name: task.name,
      project: task.project,
      type: task.type,
      completedAt: new Date().toISOString(),
      notes: task.notes || ''
    };
    completed.unshift(entry);
    store.writeCompleted(completed);
    const remaining = tasks.filter(t => t.id !== task.id); // id-targeted — §1.1
    store.writeTasks(remaining);
    result = { success: true, completedEntry: entry };
  });

  if (result.error) return fail(args.json, result.error);
  output(args.json, result, r => console.log(r.task ? `Completed "${r.task.name}" — next due ${r.task.nextDue}.` : `Completed "${r.completedEntry.name}".`));
}

function cmdToday(args) {
  const today = engine.todayString();
  const rolled = store.withLock(() => {
    const tasks = store.readTasks();
    const { tasks: newTasks, changed } = engine.rollForward(tasks, today);
    if (changed) store.writeTasks(newTasks);
    return newTasks;
  });
  const view = engine.buildView(rolled, today);
  const response = { pastDue: view.pastDue, today: view.today, upcoming: view.upcoming, generatedFor: today };
  if (view.flagged && view.flagged.length) response.flagged = view.flagged;

  output(args.json, response, v => {
    const printSection = (label, items) => {
      if (!items.length) return;
      console.log(`\n## ${label}`);
      for (const t of items) {
        const due = t.nextDue || t.dueDate || '';
        console.log(`- [ ] ${t.name} (${t.project})${due ? ' ' + due : ''}${t.dueTime ? ' ' + t.dueTime : ''}`);
      }
    };
    printSection('PAST DUE', v.pastDue);
    printSection('Today', v.today);
    printSection('Upcoming', v.upcoming);
    if (!v.pastDue.length && !v.today.length && !v.upcoming.length) console.log('Nothing due.');
  });
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  try {
    switch (cmd) {
      case 'add': return cmdAdd(args);
      case 'list': return cmdList(args);
      case 'complete': return cmdComplete(args);
      case 'today': return cmdToday(args);
      default:
        process.stderr.write(
          'Usage: todo-cli.js <add|list|complete|today> [...args] [--json]\n' +
          '  add --project P --type recurring|scheduled|backlog --name N [--due YYYY-MM-DD] [--next-due YYYY-MM-DD] [--frequency "..."] [--time "8:00pm"] [--priority High|Medium|Low] [--notes "..."] [--skippable true|false] [--end-date YYYY-MM-DD] [--added YYYY-MM-DD]\n' +
          '  list [--project P] [--type T]\n' +
          '  complete <id>\n' +
          '  today\n'
        );
        process.exitCode = 1;
    }
  } catch (err) {
    fail(args.json, err.message);
  }
}

main();
