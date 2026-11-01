'use strict';

/**
 * project-dash.js — per-project status dashboards (2026-11-01; Alex: "a little dashboard ... that can be
 * dynamically updated by claude sessions or LLMs on the VPS"). First user: Income (tidystack Fiverr business).
 * Prototype and decisions: vault Projects/Income/Business Dashboard/prototype.html, Projects/Income/memory.md.
 *
 * Store: data/project-dash/<slug>.json — ONE JSON document per project:
 *   { version, main:{business,report,goal,month,launch,gigs,board,activity,orders,summary},
 *     claude:{active,task,detail,since,session}, queries:[{id,q,kind,context,createdAt,answer,answeredAt}],
 *     checklist:[{id,t,detail,order,done,doneAt}] }
 * A project has a dashboard only once its file exists (the CLI's `init` creates it).
 *
 * Who writes what: Claude sessions write everything through project-dash-cli.js (on the box, no login).
 * Alex's browser writes ONLY two things, through the routes below: a query's answer and a checklist tick.
 *
 * Concurrency: every write is read-modify-write under a per-project lock (atomic mkdir, stale after 10 s),
 * then a tmp-file + rename, so a reader never sees a half-written file and two writers never lose an edit.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;          // = PROJECT_SLUG_RE in server.js / forum.js
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ANSWER = 4000, MAX_TEXT = 2000, MAX_ACTIVITY = 60;
const LOCK_STALE_MS = 10000, LOCK_WAIT_MS = 15000;
const MAIN_KEYS = ['business', 'report', 'goal', 'month', 'launch', 'gigs', 'board', 'activity', 'orders', 'summary'];

class DashError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const nowIso = () => new Date().toISOString();
const newId = (p) => p + crypto.randomBytes(4).toString('hex');
const empty = () => ({ version: 0, main: {}, claude: { active: false }, queries: [], checklist: [] });

function createDash(root) {
  root = path.resolve(root);

  const fileOf = (slug) => {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new DashError(400, 'Invalid project slug.');
    return path.join(root, `${slug}.json`);
  };
  const exists = (slug) => fs.existsSync(fileOf(slug));

  function read(slug) {
    const f = fileOf(slug);
    if (!fs.existsSync(f)) throw new DashError(404, 'This project has no dashboard yet.');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  function withLock(slug, fn) {
    fs.mkdirSync(root, { recursive: true });
    const lock = path.join(root, `.${slug}.lock`);
    const start = Date.now();
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; } } catch { continue; }
        if (Date.now() - start > LOCK_WAIT_MS) throw new DashError(503, 'Dashboard is busy, try again.');
        sleepMs(50);
      }
    }
    try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
  }

  /** Read-modify-write. `mutate(state)` edits in place; return value is passed through. */
  function update(slug, mutate, { create = false } = {}) {
    return withLock(slug, () => {
      const f = fileOf(slug);
      let state;
      if (fs.existsSync(f)) state = JSON.parse(fs.readFileSync(f, 'utf8'));
      else if (create) state = empty();
      else throw new DashError(404, 'This project has no dashboard yet.');
      const out = mutate(state);
      state.version = (state.version || 0) + 1;
      state.savedAt = nowIso();
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, f);
      return out === undefined ? state : out;
    });
  }

  // ---- Alex's two writes (browser) ---------------------------------------------------------
  function answer(slug, id, value) {
    if (!ID_RE.test(String(id))) throw new DashError(400, 'Invalid question id.');
    return update(slug, (s) => {
      const q = s.queries.find((x) => x.id === id);
      if (!q) throw new DashError(404, 'That question is gone.');
      if (value === null) { q.answer = null; q.answeredAt = null; return q; }
      if (q.kind === 'yesno') {
        if (value !== 'yes' && value !== 'no') throw new DashError(400, 'Answer yes or no.');
      } else {
        value = String(value ?? '').trim();
        if (!value) throw new DashError(400, 'Type an answer first.');
        if (value.length > MAX_ANSWER) throw new DashError(400, `Answers are limited to ${MAX_ANSWER} characters.`);
      }
      q.answer = value; q.answeredAt = nowIso();
      return q;
    });
  }

  function tick(slug, id, done) {
    if (!ID_RE.test(String(id))) throw new DashError(400, 'Invalid item id.');
    if (typeof done !== 'boolean') throw new DashError(400, 'done must be true or false.');
    return update(slug, (s) => {
      const c = s.checklist.find((x) => x.id === id);
      if (!c) throw new DashError(404, 'That item is gone.');
      c.done = done; c.doneAt = done ? nowIso() : null;
      return c;
    });
  }

  // ---- Claude's writes (CLI) ---------------------------------------------------------------
  const stamp = (s, by) => { s.main.business = { ...(s.main.business || {}), updated: nowIso(), updatedBy: by || 'Claude' }; };
  const text = (v, name) => {
    const t = String(v ?? '').trim();
    if (!t) throw new DashError(400, `${name} is required.`);
    if (t.length > MAX_TEXT) throw new DashError(400, `${name} is over ${MAX_TEXT} characters.`);
    return t;
  };

  const api = {
    init: (slug, by) => update(slug, (s) => { stamp(s, by); }, { create: true }),
    setMain(slug, key, value, by) {
      if (!MAIN_KEYS.includes(key)) throw new DashError(400, `Unknown section "${key}". One of: ${MAIN_KEYS.join(', ')}.`);
      return update(slug, (s) => { if (value === null) delete s.main[key]; else s.main[key] = value; stamp(s, by); });
    },
    mergeMain(slug, obj, by) {
      const bad = Object.keys(obj).filter((k) => !MAIN_KEYS.includes(k));
      if (bad.length) throw new DashError(400, `Unknown section(s): ${bad.join(', ')}.`);
      return update(slug, (s) => { Object.assign(s.main, obj); stamp(s, by); });
    },
    status(slug, { task, detail, session } = {}) {
      return update(slug, (s) => {
        s.claude = task ? { active: true, task: text(task, 'task'), detail: detail || '', session: session || '', since: nowIso() } : { active: false };
        return s.claude;
      });
    },
    log(slug, src, msg) {
      return update(slug, (s) => {
        const a = Array.isArray(s.main.activity) ? s.main.activity : [];
        const ev = { at: nowIso(), src: text(src, 'source'), msg: text(msg, 'message') };
        s.main.activity = [ev, ...a].slice(0, MAX_ACTIVITY);
        stamp(s, src);
        return ev;
      });
    },
    ask(slug, { q, kind, context }) {
      if (kind && kind !== 'yesno' && kind !== 'text') throw new DashError(400, 'kind is yesno or text.');
      return update(slug, (s) => {
        const item = { id: newId('q'), q: text(q, 'question'), kind: kind || 'text', context: context || '', createdAt: nowIso(), answer: null, answeredAt: null };
        s.queries.push(item);
        return item;
      });
    },
    removeQuery: (slug, id) => update(slug, (s) => {
      const i = s.queries.findIndex((x) => x.id === id);
      if (i < 0) throw new DashError(404, 'No such question.');
      return s.queries.splice(i, 1)[0];
    }),
    addTodo(slug, { t, detail }) {
      return update(slug, (s) => {
        const order = s.checklist.reduce((m, c) => Math.max(m, c.order || 0), 0) + 1;
        const item = { id: newId('c'), t: text(t, 'item'), detail: detail || '', order, done: false, doneAt: null };
        s.checklist.push(item);
        return item;
      });
    },
    removeTodo: (slug, id) => update(slug, (s) => {
      const i = s.checklist.findIndex((x) => x.id === id);
      if (i < 0) throw new DashError(404, 'No such item.');
      return s.checklist.splice(i, 1)[0];
    }),
    clearDone: (slug) => update(slug, (s) => {
      const gone = s.checklist.filter((c) => c.done);
      s.checklist = s.checklist.filter((c) => !c.done);
      return gone;
    }),
    addTask(slug, { t, lane, who, tags }, by) {
      const L = lane || 'todo';
      if (!['todo', 'doing', 'done'].includes(L)) throw new DashError(400, 'lane is todo, doing or done.');
      return update(slug, (s) => {
        const b = s.main.board = s.main.board || { todo: [], doing: [], done: [] };
        const item = { id: newId('t'), t: text(t, 'task'), who: who === 'alex' ? 'alex' : 'ada', tags: tags || [] };
        (b[L] = b[L] || []).push(item);
        stamp(s, by);
        return item;
      });
    },
    moveTask(slug, id, lane, by) {
      if (!['todo', 'doing', 'done', 'gone'].includes(lane)) throw new DashError(400, 'lane is todo, doing, done or gone.');
      return update(slug, (s) => {
        const b = s.main.board = s.main.board || { todo: [], doing: [], done: [] };
        for (const k of Object.keys(b)) {
          const i = (b[k] || []).findIndex((x) => x.id === id);
          if (i >= 0) { const [it] = b[k].splice(i, 1); if (lane !== 'gone') (b[lane] = b[lane] || []).push(it); stamp(s, by); return it; }
        }
        throw new DashError(404, 'No such task.');
      });
    },
  };

  function mount(app, { isAdminReq }) {
    const adminOnly = (req, res, next) => (isAdminReq(req) ? next() : res.status(403).json({ error: 'Not available for your account.' }));
    const confirm = (req, res, next) => (req.get('X-Dash-Confirm') === '1' ? next() : res.status(400).json({ error: 'Missing X-Dash-Confirm header.' }));
    const guard = (fn) => (req, res) => {
      try { res.json(fn(req)); } catch (e) {
        const known = e instanceof DashError;
        res.status(known ? e.status : 500).json({ error: known ? e.message : 'The dashboard store could not be read.' });
      }
    };
    app.get('/api/projects/:slug/dash', adminOnly, guard((req) => read(req.params.slug)));
    app.post('/api/projects/:slug/dash/queries/:id/answer', adminOnly, confirm,
      guard((req) => answer(req.params.slug, req.params.id, req.body ? req.body.answer : undefined)));
    app.post('/api/projects/:slug/dash/checklist/:id', adminOnly, confirm,
      guard((req) => tick(req.params.slug, req.params.id, req.body ? req.body.done : undefined)));
  }

  return { read, exists, answer, tick, mount, ...api };
}

const DEFAULT_ROOT = process.env.PROJECT_DASH_DIR || path.join(__dirname, '../data/project-dash');
module.exports = { ...createDash(DEFAULT_ROOT), createDash, DashError, SLUG_RE, MAIN_KEYS, DEFAULT_ROOT };
