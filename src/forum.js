'use strict';

/**
 * forum.js — VPS-native project forums (2026-10-06; Alex: "Forums fully on the VPS").
 *
 * The dashboard's data is the source of truth, not vault .md files.
 *
 * Store: data/forums/<project-slug>/<NN>.jsonl — ONE append-only file per thread, one JSON event
 * per line:
 *   {type:'open',  nn, title, severity, scope, author, ts, body}
 *   {type:'post',  id, author:'alex'|'claude', ts, body}
 *   {type:'close', author, ts, note}      {type:'reopen', author, ts, note}
 * A thread's state is the FOLD of its events (readThread). A closed thread's file is never deleted,
 * and NN is permanent: next = highest ever used + 1 (files are never removed; a .nn high-water mark
 * inside the forum dir guards against a hand-deleted file).
 *
 * Concurrency: every event is ONE appendFileSync (O_APPEND) of a single line, so concurrent
 * appenders never lose or interleave lines. Thread creation + NN allocation take a per-forum lock
 * (atomic mkdir of <slug>/.lock, stale after 10 s), and the new file is opened O_EXCL ('wx') as a
 * second line of defence: an existing thread can never be overwritten.
 *
 * Who answers (Alex 2026-10-06, option (a)): a live Mac/AdaTwo Claude session polls
 * `forum-cli.js pending` about once a minute; Claude's replies come in through the CLI, never the browser.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;          // = PROJECT_SLUG_RE in server.js / projects.js slugify()
const SEVERITIES = ['Critical', 'Significant', 'Moderate', 'Minor'];
const MAX_BODY = 8000, MAX_TITLE = 200, MAX_SCOPE = 200, MAX_BATCH = 100;
const LOCK_STALE_MS = 10000, LOCK_WAIT_MS = 15000;
const CLOSED_RE = /(^|\s)CLOSED\s*$/;                 // Forum Protocol: a comment ending in CLOSED (all caps)

class ForumError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pad = (n) => String(n).padStart(2, '0');
const nowIso = () => new Date().toISOString();

function createForum(root) {
  root = path.resolve(root);

  const dirOf = (slug) => {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new ForumError(400, 'Invalid project slug.');
    return path.join(root, slug);
  };
  const fileOf = (slug, nn) => path.join(dirOf(slug), `${pad(nn)}.jsonl`);
  const checkNn = (nn) => {
    const n = Number(nn);
    if (!Number.isInteger(n) || n < 1 || n > 9999) throw new ForumError(400, 'Invalid thread number.');
    return n;
  };

  // --- per-forum lock -----------------------------------------------------------------------
  function withLock(slug, fn) {
    const dir = dirOf(slug);
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, '.lock');
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { fs.mkdirSync(lock); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }   // vanished: retry
        if (age > LOCK_STALE_MS) {
          // rename is atomic: of several racing breakers only one wins; the rest just retry mkdir.
          const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
          try { fs.renameSync(lock, aside); fs.rmdirSync(aside); } catch { /* someone else broke it */ }
          continue;
        }
        if (Date.now() > deadline) throw new ForumError(503, 'Forum is busy; try again.');
        sleepMs(5 + Math.floor(Math.random() * 20));
      }
    }
    try { return fn(dir); }
    finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
  }

  // --- events -------------------------------------------------------------------------------
  const line = (ev) => JSON.stringify(ev) + '\n';
  function append(file, ev) { fs.appendFileSync(file, line(ev), { flag: 'a' }); }   // ONE write per event

  function fold(slug, nn, text) {
    let t = null, bad = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { bad++; continue; }     // a torn/corrupt line never poisons the thread
      if (!ev || typeof ev !== 'object') { bad++; continue; }
      if (ev.type === 'open' && !t) {
        t = { slug, nn, title: ev.title, severity: ev.severity, scope: ev.scope || '', author: ev.author, openedAt: ev.ts, body: ev.body || '',
          imported: !!ev.imported, status: 'open', posts: [], closedAt: null, closeNote: '', updatedAt: ev.ts };
      } else if (!t) { bad++; }
      else if (ev.type === 'post') { t.posts.push({ id: ev.id, author: ev.author, ts: ev.ts, body: ev.body, imported: !!ev.imported }); t.updatedAt = ev.ts; }
      else if (ev.type === 'close') { t.status = 'closed'; t.closedAt = ev.ts; t.closeNote = ev.note || ''; t.updatedAt = ev.ts; }
      else if (ev.type === 'reopen') { t.status = 'open'; t.closedAt = null; t.closeNote = ''; t.updatedAt = ev.ts; }
      else bad++;
    }
    if (!t) return null;
    // the opening body counts as a post by the opener for "whose turn is it"
    const last = t.posts.length ? t.posts[t.posts.length - 1].author : t.author;
    t.lastAuthor = last;
    t.pending = t.status === 'open' && last === 'alex';
    if (bad) t.corruptLines = bad;
    return t;
  }

  function readThread(slug, nn) {
    nn = checkNn(nn);
    let text;
    try { text = fs.readFileSync(fileOf(slug, nn), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    return fold(slug, nn, text);
  }

  function threadNums(slug) {
    let names;
    try { names = fs.readdirSync(dirOf(slug)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.map((n) => /^(\d{2,4})\.jsonl$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  }

  const summary = (t, full) => {
    if (full) return t;
    const { posts, body, ...rest } = t;
    return { ...rest, postCount: posts.length };
  };

  function listThreads(slug, { full = false } = {}) {
    return threadNums(slug).map((n) => readThread(slug, n)).filter(Boolean).map((t) => summary(t, full));
  }

  function listForums() {
    let names;
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.filter((e) => e.isDirectory() && SLUG_RE.test(e.name)).map((e) => {
      const ts = listThreads(e.name);
      return { slug: e.name, threads: ts.length, open: ts.filter((t) => t.status === 'open').length,
        closed: ts.filter((t) => t.status === 'closed').length, pending: ts.filter((t) => t.pending).length };
    }).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // --- validation ---------------------------------------------------------------------------
  function cleanText(v, max, what, required) {
    const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
    if (required && !s) throw new ForumError(400, `${what} is empty.`);
    if (s.length > max) throw new ForumError(413, `${what} is too long (max ${max}).`);
    return s;
  }
  const cleanAuthor = (a) => { if (a !== 'alex' && a !== 'claude') throw new ForumError(400, 'Author must be alex or claude.'); return a; };

  // --- writes -------------------------------------------------------------------------------
  /** Creates a thread; NN = highest ever used + 1 unless `nn` is given (import). Never overwrites. */
  function createThread(slug, o = {}) {
    const title = cleanText(o.title, MAX_TITLE, 'Title', true);
    const scope = cleanText(o.scope, MAX_SCOPE, 'Scope', false);
    const body = cleanText(o.body, MAX_BODY, 'Body', false);
    const severity = o.severity ? SEVERITIES.find((s) => s.toLowerCase() === String(o.severity).toLowerCase()) : 'Moderate';
    if (!severity) throw new ForumError(400, `Severity must be one of ${SEVERITIES.join(', ')}.`);
    const author = cleanAuthor(o.author || 'alex');
    return withLock(slug, (dir) => {
      const hw = path.join(dir, '.nn');
      let nn;
      if (o.nn != null) nn = checkNn(o.nn);
      else {
        let high = 0;
        try { high = parseInt(fs.readFileSync(hw, 'utf8'), 10) || 0; } catch { /* none yet */ }
        nn = Math.max(high, ...threadNums(slug)) + 1;
      }
      const events = o.events && o.events.length ? o.events : [];
      const ev = { type: 'open', nn, title, severity, scope, author, ts: o.ts || nowIso(), body, ...(o.imported ? { imported: true } : {}) };
      const text = [ev, ...events].map(line).join('');
      let fd;
      try { fd = fs.openSync(fileOf(slug, nn), 'wx'); }                       // O_EXCL: never overwrite
      catch (e) { if (e.code === 'EEXIST') throw new ForumError(409, `Thread ${pad(nn)} already exists.`); throw e; }
      try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
      let high = 0;
      try { high = parseInt(fs.readFileSync(hw, 'utf8'), 10) || 0; } catch { /* none */ }
      if (nn > high) fs.writeFileSync(hw, String(nn));
      return readThread(slug, nn);
    });
  }

  function requireOpen(slug, nn) {
    const t = readThread(slug, nn);
    if (!t) throw new ForumError(404, `No thread ${pad(checkNn(nn))} in ${slug}.`);
    if (t.status === 'closed') throw new ForumError(409, `Thread ${pad(nn)} is closed; reopen it first.`);
    return t;
  }

  function newPostId() { return 'p' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

  function addPost(slug, nn, author, body, extra = {}) {
    nn = checkNn(nn); cleanAuthor(author);
    body = cleanText(body, MAX_BODY, 'Reply', true);
    requireOpen(slug, nn);
    const ev = { type: 'post', id: newPostId(), author, ts: nowIso(), body, ...extra };
    append(fileOf(slug, nn), ev);
    return ev;
  }

  /**
   * Claude's answer from a polling loop: refused (409) unless the thread is STILL waiting on Claude, checked and
   * appended under the forum lock. Two live sessions (Mac + AdaTwo) polling at once can then never both answer
   * the same Alex post: exactly one wins, the other gets 409 and moves on.
   */
  function answerIfPending(slug, nn, body) {
    nn = checkNn(nn);
    return withLock(slug, () => {
      const t = readThread(slug, nn);
      if (!t) throw new ForumError(404, `No thread ${pad(nn)} in ${slug}.`);
      if (!t.pending) throw new ForumError(409, `Thread ${pad(nn)} is not waiting on Claude (already answered or closed).`);
      return addPost(slug, nn, 'claude', body);
    });
  }

  function closeThread(slug, nn, author, note = '') {
    nn = checkNn(nn); cleanAuthor(author);
    const t = readThread(slug, nn);
    if (!t) throw new ForumError(404, `No thread ${pad(nn)} in ${slug}.`);
    if (t.status === 'closed') throw new ForumError(409, `Thread ${pad(nn)} is already closed.`);
    const ev = { type: 'close', author, ts: nowIso(), note: cleanText(note, 500, 'Note', false) };
    append(fileOf(slug, nn), ev);
    return ev;
  }

  function reopenThread(slug, nn, author, note = '') {
    nn = checkNn(nn); cleanAuthor(author);
    const t = readThread(slug, nn);
    if (!t) throw new ForumError(404, `No thread ${pad(nn)} in ${slug}.`);
    if (t.status === 'open') throw new ForumError(409, `Thread ${pad(nn)} is not closed.`);
    const ev = { type: 'reopen', author, ts: nowIso(), note: cleanText(note, 500, 'Note', false) };
    append(fileOf(slug, nn), ev);
    return ev;
  }

  /**
   * The Submit button: replies from Alex, in one request. All-or-nothing validation (an unknown or
   * closed thread rejects the whole batch before anything is written). A reply ending in CLOSED
   * also closes its thread (Forum Protocol: CLOSED is Alex's permission to close).
   */
  function submitBatch(slug, replies) {
    if (!Array.isArray(replies) || !replies.length) throw new ForumError(400, 'Nothing to submit.');
    if (replies.length > MAX_BATCH) throw new ForumError(413, 'Too many replies in one submit.');
    const clean = [];
    for (const r of replies) {
      const body = cleanText(r && r.body, MAX_BODY, 'A reply', false);
      if (!body) continue;
      const nn = checkNn(r && r.nn);
      requireOpen(slug, nn);
      clean.push({ nn, body });
    }
    if (!clean.length) throw new ForumError(400, 'Nothing to submit.');
    const posted = [], closed = [];
    for (const r of clean) {
      const ev = addPost(slug, r.nn, 'alex', r.body);
      posted.push({ nn: r.nn, id: ev.id });
      if (CLOSED_RE.test(r.body) && readThread(slug, r.nn).status === 'open') { closeThread(slug, r.nn, 'alex', 'CLOSED in reply'); closed.push(r.nn); }
    }
    return { ok: true, count: posted.length, posted, closed };
  }

  // --- the polling loop's view ---------------------------------------------------------------
  /** Open threads whose last post is Alex's, across every forum (or one). Full thread text included. */
  function pending(slug) {
    const slugs = slug ? [slug] : listForums().map((f) => f.slug);
    const out = [];
    for (const s of slugs) for (const t of listThreads(s, { full: true })) if (t.pending) {
      let i = t.posts.length;
      while (i > 0 && t.posts[i - 1].author === 'alex') i--;
      out.push({ ...t, unanswered: t.posts.slice(i), waitingSince: (t.posts[i] || { ts: t.openedAt }).ts });
    }
    return out.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
  }

  /** Claude's live (non-imported) replies after `sinceIso`, grouped per thread — the notify email's content. */
  function claudeSince(sinceIso) {
    const out = [];
    for (const f of listForums()) for (const t of listThreads(f.slug, { full: true })) {
      const news = t.posts.filter((p) => p.author === 'claude' && !p.imported && (!sinceIso || p.ts > sinceIso));
      if (news.length) out.push({ slug: f.slug, nn: t.nn, title: t.title, replies: news });
    }
    return out;
  }

  const notifyFile = path.join(root, '.notify.json');
  const readNotify = () => { try { return JSON.parse(fs.readFileSync(notifyFile, 'utf8')); } catch { return { lastNotifiedAt: null }; } };
  function writeNotify(state) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = notifyFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, notifyFile);
  }

  return { root, createThread, addPost, answerIfPending, closeThread, reopenThread, submitBatch, readThread, listThreads, listForums, threadNums,
    pending, claudeSince, readNotify, writeNotify, SEVERITIES };
}

const DEFAULT_ROOT = process.env.FORUM_DATA_DIR || path.join(__dirname, '../data/forums');
const isLiveTree = () => path.basename(path.resolve(__dirname, '..')) !== 'dashboard-staging';
/** Where links in the notify email point. Live vs staging is decided by which tree this file sits in. */
const baseUrl = () => String(process.env.FORUM_BASE_URL || (isLiveTree() ? 'https://303dashboard.duckdns.org' : 'http://localhost:3001')).replace(/\/+$/, '');

/**
 * Public bounce route (mount BEFORE requireAuth): the session cookie is SameSite=Strict, so a link clicked in
 * a mail client arrives cookie-less. This page only does a same-site hop to the login-gated forum page,
 * and reveals nothing (slug and nn are format-checked before being echoed). Same pattern as devices.js.
 */
function mountPublic(app) {
  app.get('/forum/open/:slug', (req, res) => {
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return res.status(404).send('Unknown forum.');
    const nn = /^\d{1,4}$/.test(String(req.query.t || '')) ? `#t-${Number(req.query.t)}` : '';
    const to = `/forum.html?project=${encodeURIComponent(slug)}${nn}`;
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ada · forum</title>`
        + `<meta http-equiv="refresh" content="0;url=${to}"><script>location.replace(${JSON.stringify(to)})</script>`
        + `<p style="font-family:system-ui;padding:24px">Opening the forum… <a href="${to}">continue</a></p>`);
  });
}

module.exports = { ...createForum(DEFAULT_ROOT), createForum, ForumError, mountPublic, baseUrl, isLiveTree, SLUG_RE, DEFAULT_ROOT };
