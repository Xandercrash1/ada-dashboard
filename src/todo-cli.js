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
 *   node todo-cli.js today [--device adaone|none] [--json]   (list takes --device too)
 *
 * `--json` on every command for machine-readable output (contract §5 —
 * "the caller is usually an AI agent").
 */

const engine = require('./todo-engine');
const store = require('./todo-store');
const automation = require('./automation-rules').create({ store, engine, sharing: require('./sharing') });   // docs/TASK-AUTOMATION.md
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
    device: args.device,
    waitsFor: args['waits-for'],
    releaseBusinessDays: args['release-business-days'],
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

// --device X: X's items plus those of every device X reaches over SSH (src/device-reach.js); --exact: X's only;
// --device none: items with no device (the VPS or Alex's phone).
function deviceFilter(args) {
  if (args.device === 'none') return (t) => !t.device;
  const devs = args.exact ? [args.device] : require('./device-reach').reachable(store.DATA_DIR, args.device);
  return (t) => devs.includes(t.device);
}

function cmdList(args) {
  let tasks = store.readTasks();
  if (args.project) tasks = tasks.filter(t => t.project === args.project);
  if (args.type) tasks = tasks.filter(t => t.type === args.type);
  if (args.device) tasks = tasks.filter(deviceFilter(args));   // --device adaone (+ the devices it reaches; --exact: only it) | none
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
    const task = tasks.find(t => t.id === id);
    if (!task) { result = { error: `No task with id ${id}` }; return; }
    if (task.autoKind === 'deploy') { result = { error: `"${task.name}" deploys to the live dashboard when ticked, so only Alex can tick it, signed in to the dashboard.` }; return; }
    const r = automation.completeLocked(tasks, task, { source: 'cli' });   // same path as the dashboard: history, rules, queue
    result = r.status !== 200 ? { error: r.body.error } : task.type === 'recurring' ? { task: r.body } : r.body;
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
  const awake = engine.withoutWaiting(rolled);   // tasks waiting on another open task stay out of the day view (still in `list`)
  const view = engine.buildView(args.device ? awake.filter(deviceFilter(args)) : awake, today);
  const response = { pastDue: view.pastDue, today: view.today, upcoming: view.upcoming, generatedFor: today };
  if (view.flagged && view.flagged.length) response.flagged = view.flagged;
  // A device's session start (CLAUDE.md § Session start) needs its undated items too, not just what's due.
  if (args.device) {
    const shown = new Set([...view.pastDue, ...view.today, ...view.upcoming].map(t => t.id));
    response.undated = awake.filter(deviceFilter(args)).filter(t => t.type === 'backlog' && !shown.has(t.id));
  }

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
    if (v.undated) printSection('No due date (this device)', v.undated);
    if (!v.pastDue.length && !v.today.length && !v.upcoming.length && !(v.undated && v.undated.length)) console.log('Nothing due.');
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
          '  add --project P --type recurring|scheduled|backlog --name N [--due YYYY-MM-DD] [--next-due YYYY-MM-DD] [--frequency "..."] [--time "8:00pm"] [--device mac|adaone|adatwo] [--waits-for TASK_ID] [--release-business-days N] [--priority High|Medium|Low] [--notes "..."] [--skippable true|false] [--end-date YYYY-MM-DD] [--added YYYY-MM-DD]\n' +
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
