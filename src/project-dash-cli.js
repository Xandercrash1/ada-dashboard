#!/usr/bin/env node
'use strict';

/**
 * project-dash-cli.js — Claude's side of the project dashboards (see project-dash.js). Operates directly
 * on the store, NOT over HTTP (same contract as todo-cli.js / forum-cli.js), so it needs no login.
 * Page: /project-dash.html?project=<slug>  (linked from the project's hub when a dashboard exists).
 *
 *   show <slug> [--json]                         whole state (answers, ticks, everything)
 *   init <slug> [--by S]                         create an empty dashboard for a project
 *   set <slug> <section> --json-value '<json>'   replace one section: business report goal month launch
 *        (or --file f.json, or - for stdin)       gigs board activity orders summary   ('null' removes it)
 *   merge <slug> --file f.json                   replace several sections at once (top-level keys = sections)
 *   status <slug> "what I'm doing" [--detail D] [--session S]   show the live "Claude is working on" bar
 *   status <slug> --clear                        hide it (ALWAYS clear it when you stop working)
 *   log <slug> "message" --src S                 add an activity line (newest first, last 60 kept)
 *   ask <slug> "question" [--yesno] [--context C]  post a question for Alex (prints its id)
 *   answers <slug>                               answered questions waiting to be picked up
 *   ack <slug> <qid>                             remove a question once its answer is recorded elsewhere
 *   todo <slug> add "item" [--detail D]  |  todo <slug> rm <cid>  |  todo <slug> clear-done
 *   task <slug> add "task" [--lane todo|doing|done] [--who ada|alex] [--tag T,T]
 *   task <slug> move <tid> <todo|doing|done|gone>
 *
 * `--by S` (or env ADA_SESSION) names who made the change in the header's "Updated by". `--json` everywhere.
 * Env PROJECT_DASH_DIR points the CLI at another store (staging tests).
 */
const fs = require('fs');
const dash = require('./project-dash');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
      else { args[a.slice(2)] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, slug, ...pos] = args._;
const by = typeof args.by === 'string' ? args.by : (process.env.ADA_SESSION || 'Claude');
const asJson = !!args.json;

function readJsonArg() {
  if (typeof args['json-value'] === 'string') return JSON.parse(args['json-value']);
  const f = args.file;
  if (typeof f !== 'string') throw new dash.DashError(400, 'Give the value with --json-value \'<json>\' or --file <path|->.');
  return JSON.parse(f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8'));
}
const out = (v, human) => { console.log(asJson ? JSON.stringify(v, null, 2) : (human !== undefined ? human : JSON.stringify(v, null, 2))); };
const need = (v, what) => { if (!v) throw new dash.DashError(400, `Missing ${what}. Run with no arguments for usage.`); return v; };

function run() {
  if (!cmd) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, '')); return; }
  need(slug, 'project slug');
  switch (cmd) {
    case 'show': return out(dash.read(slug));
    case 'init': dash.init(slug, by); return out({ ok: true, slug }, `Dashboard ready: /project-dash.html?project=${slug}`);
    case 'set': { const key = need(pos[0], 'section'); dash.setMain(slug, key, readJsonArg(), by); return out({ ok: true, section: key }, `Updated ${key}.`); }
    case 'merge': { const v = readJsonArg(); dash.mergeMain(slug, v, by); return out({ ok: true, sections: Object.keys(v) }, `Updated ${Object.keys(v).join(', ')}.`); }
    case 'status': {
      if (args.clear) { dash.status(slug, {}); return out({ ok: true, active: false }, 'Claude status cleared.'); }
      const c = dash.status(slug, { task: need(pos[0], 'task text'), detail: args.detail, session: args.session || by });
      return out(c, `Status: ${c.task}`);
    }
    case 'log': { const ev = dash.log(slug, typeof args.src === 'string' ? args.src : by, need(pos[0], 'message')); return out(ev, 'Logged.'); }
    case 'ask': { const q = dash.ask(slug, { q: need(pos[0], 'question'), kind: args.yesno ? 'yesno' : 'text', context: args.context }); return out(q, `Asked ${q.id}.`); }
    case 'answers': {
      const a = dash.read(slug).queries.filter((q) => q.answer != null);
      return out(a, a.length ? a.map((q) => `${q.id}  ${q.q}\n      → ${q.answer}  (${q.answeredAt})`).join('\n') : 'No answers waiting.');
    }
    case 'ack': { const q = dash.removeQuery(slug, need(pos[0], 'question id')); return out(q, `Removed ${q.id}.`); }
    case 'todo': {
      const sub = pos[0];
      if (sub === 'add') { const c = dash.addTodo(slug, { t: need(pos[1], 'item text'), detail: args.detail }); return out(c, `Added ${c.id}.`); }
      if (sub === 'rm') { const c = dash.removeTodo(slug, need(pos[1], 'item id')); return out(c, `Removed ${c.id}.`); }
      if (sub === 'clear-done') { const g = dash.clearDone(slug); return out(g, `Cleared ${g.length} done item(s).`); }
      throw new dash.DashError(400, 'todo add|rm|clear-done');
    }
    case 'task': {
      const sub = pos[0];
      if (sub === 'add') {
        const tags = typeof args.tag === 'string' ? args.tag.split(',').map((s) => s.trim()).filter(Boolean) : [];
        const t = dash.addTask(slug, { t: need(pos[1], 'task text'), lane: args.lane, who: args.who, tags }, by);
        return out(t, `Added ${t.id}.`);
      }
      if (sub === 'move') { const t = dash.moveTask(slug, need(pos[1], 'task id'), need(pos[2], 'lane'), by); return out(t, `Moved ${t.id} to ${pos[2]}.`); }
      throw new dash.DashError(400, 'task add|move');
    }
    default: throw new dash.DashError(400, `Unknown command "${cmd}".`);
  }
}

try { run(); } catch (e) {
  const msg = e instanceof dash.DashError ? e.message : (e instanceof SyntaxError ? `Bad JSON: ${e.message}` : e.message);
  if (asJson) console.log(JSON.stringify({ error: msg })); else console.error(`Error: ${msg}`);
  process.exit(e instanceof dash.DashError && e.status === 404 ? 4 : 1);
}
