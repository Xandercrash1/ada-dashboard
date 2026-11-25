'use strict';
/*
 * error-report.js — real errors become tickets (Alex, 2026-11-25; plan: Auto Ticket Processing, "Real errors").
 * Records two things to data/error-reports.jsonl, which the nightly loop reads and turns into keyed bug tickets:
 *   - every API answer with status 500 or more (method, route shape, status, the error text the handler sent);
 *   - browser errors sent by public/error-report.js (POST /api/client-error).
 * Nothing about the person is kept except their role, and IDs, numbers and long quoted text are masked out of messages.
 * The file is capped (it rolls over to .old at 1 MB), and each browser can send at most 30 reports a minute.
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;

function scrub(s, n = 300) {
  return String(s == null ? '' : s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '(email)')
    .replace(/(["'`])[^"'`]*\1/g, '$1…$1')            // every quoted string: typed text (names, recipes, foods) stays out
    .replace(/\b(paige|matt)\b/gi, '(name)')
    .replace(/\b(fb|task|sub)-[0-9a-z-]+/gi, '$1-(id)')
    .replace(/\b[0-9a-f]{12,}\b/gi, '(hex)')
    .replace(/\d{4,}/g, '(n)')
    .replace(/[<>`]/g, '')                            // nothing that could become markup in a ticket
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}
// "/api/todo/tasks/task-123/complete" -> "/api/todo/tasks/:id/complete", so one bug is one ticket.
function routeShape(req) {
  if (req.route && req.route.path && typeof req.route.path === 'string') return (req.baseUrl || '') + req.route.path;
  // No route matched: keep /api/<area>/<thing>, mask the rest (it can hold names or ids).
  return String(req.path || '').split('/').slice(0, 5).map((seg, i) => (i > 3 || /\d|^[0-9a-f-]{8,}$/i.test(seg) ? ':id' : seg.replace(/[^\w-]/g, ''))).join('/');
}

function create({ dataDir, clock = () => new Date() }) {
  const file = path.join(dataDir, 'error-reports.jsonl');
  function append(rec) {
    try {
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.old'); } catch (e) { /* no file yet */ }
      fs.appendFileSync(file, JSON.stringify({ at: clock().toISOString(), ...rec }) + '\n');
    } catch (e) { console.error('[error-report] could not record:', e.message); }
  }

  // Express middleware: remember the error text a handler sends with a 5xx, then record it when the answer is done.
  function capture(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    const json = res.json.bind(res);
    res.json = (body) => { if (res.statusCode >= 500 && body && typeof body === 'object') res.locals.errorText = body.error || body.message; return json(body); };
    res.on('finish', () => {
      if (res.statusCode < 500) return;
      append({ kind: 'server', method: req.method, route: routeShape(req), status: res.statusCode,
        message: scrub(res.locals.errorText || '(no error text)'), role: (req.user && req.user.role) || 'none' });
    });
    next();
  }

  const recent = new Map();   // ip -> timestamps in the last minute
  const daily = new Map();    // user (or ip) + day -> count; at most 300 a day each
  function mount(app) {
    app.post('/api/client-error', (req, res) => {
      const ip = req.ip || 'x'; const now = Date.now();
      const times = (recent.get(ip) || []).filter((t) => now - t < 60000);
      if (times.length >= 30) return res.status(429).json({ error: 'Too many reports.' });
      times.push(now); recent.set(ip, times);
      if (recent.size > 500) recent.clear();
      const dk = ((req.user && req.user.username) || ip) + '|' + new Date(now).toISOString().slice(0, 10);
      const n = (daily.get(dk) || 0) + 1; daily.set(dk, n);
      if (daily.size > 2000) daily.clear();
      if (n > 300) return res.status(429).json({ error: 'Too many reports today.' });
      const b = req.body || {};
      const message = scrub(b.message);
      if (!message) return res.status(400).json({ error: 'message is required.' });
      append({ kind: 'client', message, source: scrub(String(b.source || '').replace(/^https?:\/\/[^/]+/, ''), 120),
        line: Number.isFinite(+b.line) ? +b.line : null, col: Number.isFinite(+b.col) ? +b.col : null,
        page: scrub(String(b.page || '').replace(/[?#].*$/, ''), 60), stack: scrub(b.stack, 600), role: (req.user && req.user.role) || 'none' });
      res.status(204).end();
    });
  }
  return { capture, mount, file };
}

module.exports = { create, scrub, routeShape };
