/*
 * loop.js — the dashboard side of the self-improvement loop (Alex, 2026-11-25;
 * Projects/Auto Ticket Processing/Plan — Self-Improvement Loop.md in the Ada vault).
 *
 * The nightly script (~/ops/loop/nightly-loop.py) finds bugs, proposes ideas and builds the two oldest buildable
 * tickets in a throwaway clone. Everything it does lands here as tickets; nothing deploys without Alex:
 *   POST /api/feedback/:id/proposal {action: approve|decline|later}   the Home Proposals card
 *   GET  /api/loop/proposals                                           what the card shows
 *   POST /api/loop/ready {ticketId, summary}                           a tested change -> one "Deploy: X (tested)" task
 *   GET  /api/loop/status                                              the last run's report + the paused switch
 *   POST /api/loop/pause {paused}                                      the kill switch
 * Checking off a deploy task needs {confirm: true} (the server refuses it otherwise; the UIs ask "Are you sure?"
 * first), then the 'loop-deploy' rule starts ~/ops/loop/deploy-ticket.py, which applies the change in staging,
 * tests, pushes, promotes and verifies. Only the live checkout (~/dashboard) ever starts a deploy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isClosed } = require('./ticket-store');

const KIND = 'deploy';
const RULE = 'loop-deploy';
const OPS = path.join(process.env.HOME || '/home/ubuntu', 'ops', 'loop');
const LIVE_SRC = path.resolve(process.env.HOME || '/home/ubuntu', 'dashboard', 'src');
const isLive = () => path.resolve(__dirname) === LIVE_SRC;

// The rule: Alex (a person, not automation) checked off a deploy task -> start the deploy runner, detached.
function rule(tickets, { start = startDeploy } = {}) {
  return (task, _tasks, ctx) => {
    if (task.autoKind !== KIND || !task.autoKey) return undefined;
    if (String(ctx.origin || '').startsWith('automation:')) return undefined;   // closed by the sync, not by Alex
    const tk = tickets.read().find((i) => i.id === task.autoKey);
    if (!tk || isClosed(tk) || tk.stage !== 'ready') return undefined;   // nothing waiting (safe to run twice)
    tickets.update(tk.id, { stage: 'deploying', notes: noteOn(tk, `[loop] ${new Date().toISOString()}: Alex ticked "Deploy" (confirmed); deploying.`) });
    let why;
    try { why = start(tk.id); } catch (e) { why = `the deploy runner could not be started (${e.message})`; }
    if (why) {   // never leave it at "deploying" with nothing running (test review 2026-11-25): back to ready, and tell Alex
      const cur = tickets.read().find((i) => i.id === tk.id) || tk;
      tickets.update(tk.id, { stage: 'ready', needsAlex: true, notes: noteOn(cur, `[loop] ${new Date().toISOString()}: the deploy did not start: ${why}. Nothing changed; the VPS PM will put a new Deploy task on your list once it can run.`) });
    }
    return undefined;
  };
}
const noteOn = (tk, line) => (tk.notes ? `${tk.notes}\n${line}` : line);

// Returns null when the runner was started, or why it wasn't.
function startDeploy(ticketId) {
  const refuse = (why) => { console.log(`[loop] deploy of ${ticketId} not started: ${why}`); return why; };
  if (!isLive()) return refuse('only the live checkout deploys');
  // Off until the builder has its sandbox (review 2026-11-25): the same switch as the nightly builder.
  if (!fs.existsSync(path.join(OPS, 'BUILD_ENABLED'))) return refuse('building and deploying are switched off');
  if (!/^fb-[0-9a-z-]+$/.test(ticketId)) return refuse('the ticket id is malformed');
  // Fully detached (the shell exits at once, so the runner is re-parented away from this process): promote.sh restarts
  // live mid-deploy, and pm2 kills live's whole process tree (review 2026-11-25).
  const log = path.join(OPS, 'logs', 'deploy.log');
  spawn('sh', ['-c', 'setsid python3 "$1" "$2" >> "$3" 2>&1 < /dev/null &', 'sh', path.join(OPS, 'deploy-ticket.py'), ticketId, log], { detached: true, stdio: 'ignore' }).unref();
  return null;
}

function create({ app, tickets, store, upsertAutoTask, engine, automation, isAdminReq, sync }) {
  const adminOnly = (req, res) => { if (isAdminReq(req)) return false; res.status(403).json({ error: 'Admins only.' }); return true; };
  const statusFile = path.join(OPS, 'status.json');
  const pausedFile = path.join(OPS, 'PAUSED');

  // The deploy task for a ready ticket, kept in step by the same reconcile as ticket tasks.
  function syncDeployTasks() {
    store.withLock(() => {
      const list = tickets.read();
      if (!tickets.exists()) return;
      const byId = new Map(list.map((t) => [t.id, t]));
      for (const t of store.readTasks().filter((x) => x.autoKind === KIND)) {
        const tk = byId.get(t.autoKey);
        if (!tk || isClosed(tk) || !['ready', 'deploying'].includes(tk.stage)) automation.resolveAuto(KIND, t.autoKey, { rule: RULE });
      }
    });
  }

  app.get('/api/loop/proposals', (req, res) => {
    if (adminOnly(req, res)) return;
    const now = new Date().toISOString();
    res.json(tickets.read().filter((t) => t.stage === 'proposed' && !isClosed(t) && !(t.laterUntil && t.laterUntil > now))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)));
  });

  app.post('/api/feedback/:id/proposal', (req, res) => {
    if (adminOnly(req, res)) return;
    const action = (req.body || {}).action;
    const at = new Date().toISOString();
    let r;
    try {
      r = tickets.mutate((items) => {
        const tk = items.find((i) => i.id === req.params.id);
        if (!tk) return { error: 'Ticket not found', code: 404 };
        if (tk.stage !== 'proposed') return { error: `This ticket isn't waiting for a yes (stage: ${tk.stage || 'none'}).`, code: 409 };
        if (action === 'approve') { tk.stage = 'approved'; delete tk.laterUntil; tk.notes = noteOn(tk, `[loop] ${at}: Alex approved it; the nightly builder takes it when it's among the oldest.`); }
        else if (action === 'decline') { tickets.applyUpdate(tk, { status: 'wont-do', stage: 'declined', processedBy: 'alex' }); tk.notes = noteOn(tk, `[loop] ${at}: Alex declined it; it won't be proposed again.`); }
        else if (action === 'later') { tk.laterUntil = new Date(Date.now() + 7 * 864e5).toISOString(); tk.notes = noteOn(tk, `[loop] ${at}: Alex said later; back on the card in a week.`); }
        else return { error: 'action must be approve, decline or later', code: 400 };
        tk.updatedAt = at;
        return { item: tk };
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
    if (r.error) return res.status(r.code).json({ error: r.error });
    sync(); try { syncDeployTasks(); } catch (e) { /* the worker retries */ }
    res.json(r.item);
  });

  app.post('/api/loop/ready', (req, res) => {
    if (adminOnly(req, res)) return;
    const { ticketId, summary } = req.body || {};
    const tk = tickets.read().find((t) => t.id === ticketId);
    if (!tk || isClosed(tk)) return res.status(404).json({ error: 'No open ticket with that id.' });
    try {
      tickets.update(tk.id, { stage: 'ready', notes: noteOn(tk, `[loop] ${new Date().toISOString()}: built, tested on a copy and reviewed; waiting for Alex's deploy tick.`) });
      let task;
      store.withLock(() => {
        const tasks = upsertAutoTask(store.readTasks(), KIND, tk.id, {
          type: 'scheduled', name: `Deploy: ${tk.title} (tested)`.slice(0, 200), project: 'AI Server', dueDate: engine.todayString(),
          notes: `Ticket ${tk.id}. Checking this off asks "Are you sure?", then deploys it: staging, tests, push, promote, live checks, automatic rollback.\n\n${String(summary || '').slice(0, 3000)}`,
          tags: [], owner: 'alex', sharedWith: [],
        }, { source: `automation:${RULE}`, now: new Date() });
        store.writeTasks(tasks);
        task = tasks.find((t) => t.autoKind === KIND && t.autoKey === tk.id);
      });
      res.json({ ok: true, taskId: task && task.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/loop/status', (req, res) => {
    if (adminOnly(req, res)) return;
    let status = null;
    try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (e) { /* no run yet */ }
    res.json({ paused: fs.existsSync(pausedFile), status });
  });

  app.post('/api/loop/pause', (req, res) => {
    if (adminOnly(req, res)) return;
    if (!isLive()) return res.status(409).json({ error: 'Only the live dashboard controls the loop.' });
    try {
      if ((req.body || {}).paused) fs.writeFileSync(pausedFile, `paused by Alex ${new Date().toISOString()}\n`);
      else if (fs.existsSync(pausedFile)) fs.renameSync(pausedFile, path.join(OPS, `PAUSED.cleared-${Date.now()}`));
      res.json({ paused: fs.existsSync(pausedFile) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { syncDeployTasks };
}

module.exports = { create, rule, KIND, RULE };
