'use strict';

/**
 * projects.js — the Projects tab's data (One Ada, Plan — One Ada.md § 4 P2-4).
 *
 * Reads the READ-ONLY vault clone at ~/ada-vault (P2-3, pulled every 5 min by
 * cron). Nothing here writes to the vault. The allow-list is the registry:
 * only folders named in Projects/REGISTRY.md, only .md/.txt files under them,
 * plus device/START.md. Every resolved path is realpath-checked to stay inside
 * its project folder (no `..`, no symlinks out).
 *
 * Routes live under /api/projects* and /api/one-ada/*, which the role wall
 * already denies to pages users; adminOnly is the belt to that brace.
 */

const fs = require('fs');
const forum = require('./forum');
const os = require('os');
const path = require('path');

const VAULT = process.env.ADA_VAULT_DIR || path.join(os.homedir(), 'ada-vault');
const REGISTRY = 'Projects/REGISTRY.md';
const DOC_EXT = /\.(md|txt)$/i;
const MAX_DOCS = 300;
const MAX_DOC_BYTES = 512 * 1024;

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Parses Projects/REGISTRY.md → [{ name, slug, path, home, deviceOnly, requires, web, ruled }]. */
function readRegistry(vault = VAULT) {
  const text = fs.readFileSync(path.join(vault, REGISTRY), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const head = splitRow(lines[0]).map((h) => h.toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ci = { project: col(/^project/), home: col(/^home/), dev: col(/device-only/), req: col(/requires/), web: col(/^web/), ruled: col(/ruling/) };
  const out = [];
  for (const line of lines.slice(1)) {
    const c = splitRow(line);
    if (c.every((x) => /^:?-+:?$/.test(x) || !x)) continue;   // the --- separator
    const cell = (i) => (i >= 0 && c[i] && c[i] !== '—' && c[i] !== '-' ? c[i] : '');
    const raw = cell(ci.project);
    if (!raw) continue;
    const pm = /`([^`]+)`/.exec(raw);
    const name = raw.replace(/\s*\(`[^`]*`\)\s*/, '').replace(/[*_`]/g, '').trim();
    const webCell = cell(ci.web), wm = /https?:\/\/[^\s)>\]]+/.exec(webCell);
    out.push({
      name, slug: slugify(name), path: pm ? pm[1].replace(/\/?$/, '/') : '',
      home: cell(ci.home) || 'repo', deviceOnly: cell(ci.dev), requires: cell(ci.req),
      web: wm ? wm[0] : '', ruled: cell(ci.ruled),
    });
  }
  return out;
}

/** Resolves a project-relative file, refusing anything outside the project dir. */
function safeResolve(projectDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const base = fs.realpathSync(projectDir);
  let full;
  try { full = fs.realpathSync(path.join(base, rel)); } catch { return null; }
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

function listDocs(dir, base = dir, depth = 0, out = []) {
  if (depth > 4 || out.length >= MAX_DOCS) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listDocs(full, base, depth + 1, out);
    else if (e.isFile()) {
      const st = fs.statSync(full), rel = path.relative(base, full);
      out.push({ rel, title: e.name.replace(DOC_EXT, ''), viewable: DOC_EXT.test(e.name) && st.size <= MAX_DOC_BYTES, size: st.size, mtime: st.mtime.toISOString() });
    }
    if (out.length >= MAX_DOCS) break;
  }
  return out;
}

function create(opts = {}) {
  const vault = opts.vault || VAULT;
  const find = (slug) => readRegistry(vault).find((p) => p.slug === slug);
  // Any project with a folder in the vault gets a hub, including a device-hosted one with a repo snapshot
  // (e.g. "device:adatwo (live) · repo (snapshot)"). A purely device-only project simply has no folder.
  let readPages = () => [];   // set by mount(): the dashboard's page registry, for each hub's project pages
  const projectDir = (p) => (p && p.path ? path.join(vault, p.path) : null);

  function list() {
    return readRegistry(vault).map((p) => {
      const dir = projectDir(p);
      return { ...p, hasHub: !!dir && fs.existsSync(dir) };
    });
  }

  function hub(slug) {
    const p = find(slug), dir = projectDir(p);
    if (!p) return { status: 404, body: { error: 'Unknown project.' } };
    if (!dir || !fs.existsSync(dir)) return { status: 404, body: { error: `${p.name} has no docs in the vault${p.requires ? ` (on ${p.requires} only)` : ''}.` } };
    const docs = listDocs(dir);
    const statusFile = docs.find((d) => d.rel === 'projectStatus.md');
    const statusMd = statusFile ? fs.readFileSync(path.join(dir, 'projectStatus.md'), 'utf8') : '';
    const pages = (readPages() || []).filter((pg) => pg.project === slug).map((pg) => ({ id: pg.id, title: pg.title, icon: pg.icon }));
    let forumInfo = { open: 0, pending: 0, total: 0 };
    try { forumInfo = forumSummary(slug); } catch { /* forum store unreadable: hub still loads */ }
    return { status: 200, body: { ...p, statusMd, docs: docs.filter((d) => d.rel !== 'projectStatus.md'), pages, forum: forumInfo } };
  }

  function doc(slug, rel) {
    const p = find(slug), dir = projectDir(p);
    if (!dir || !fs.existsSync(dir)) return { status: 404, body: { error: 'Unknown project.' } };
    const full = safeResolve(dir, rel);
    if (!full || !DOC_EXT.test(full)) return { status: 404, body: { error: 'Not a viewable document.' } };
    const st = fs.statSync(full);
    if (st.size > MAX_DOC_BYTES) return { status: 413, body: { error: 'Document too large to view here.' } };
    return { status: 200, body: { project: p.name, rel: path.relative(fs.realpathSync(dir), full), md: fs.readFileSync(full, 'utf8'), mtime: st.mtime.toISOString() } };
  }

  // Project forums (forum.js, 2026-10-06): VPS-native, data/forums/<slug>/<NN>.jsonl is the source of truth.
  // Claude answers through forum-cli.js on the box, never through these routes (they are Alex's).
  function forumProject(slug) {
    let p = null;
    try { p = find(slug); } catch { /* registry unreadable: fall back to existing forum data */ }
    if (!p && !(forum.SLUG_RE.test(slug) && forum.threadNums(slug).length)) throw new forum.ForumError(404, 'Unknown project.');
    return { slug, name: p ? p.name : slug, registered: !!p };
  }
  const forumSummary = (slug) => {
    const ts = forum.listThreads(slug);
    return { open: ts.filter((t) => t.status === 'open').length, pending: ts.filter((t) => t.pending).length, total: ts.length };
  };
  function forumAllList() {
    const have = new Map(forum.listForums().map((f) => [f.slug, f]));
    let reg = []; try { reg = readRegistry(vault); } catch { /* none */ }
    return [...have.values()].map((f) => ({ ...f, name: (reg.find((p) => p.slug === f.slug) || {}).name || f.slug }));
  }
  function forumList(slug, full) {
    const p = forumProject(slug);
    return { status: 200, body: { project: p.name, slug, threads: forum.listThreads(slug, { full }) } };
  }
  function forumGet(slug, nn) {
    const p = forumProject(slug), t = forum.readThread(slug, nn);
    return t ? { status: 200, body: { project: p.name, thread: t } } : { status: 404, body: { error: 'No such thread.' } };
  }
  function forumCreate(slug, b) {
    const p = forumProject(slug);
    if (!p.registered) throw new forum.ForumError(404, 'Unknown project.');
    b = b || {};
    return { status: 201, body: { thread: forum.createThread(slug, { title: b.title, severity: b.severity, scope: b.scope, body: b.body, author: 'alex' }) } };
  }
  function forumSubmit(slug, b) { forumProject(slug); return { status: 200, body: forum.submitBatch(slug, b && b.replies) }; }
  function forumCloseReopen(slug, nn, action, b) {
    forumProject(slug);
    const ev = (action === 'close' ? forum.closeThread : forum.reopenThread)(slug, nn, 'alex', b && b.note);
    return { status: 200, body: { ok: true, type: ev.type, thread: forum.readThread(slug, nn) } };
  }

  function start() {
    const f = path.join(vault, 'device/START.md');
    if (!fs.existsSync(f)) return { status: 404, body: { error: 'device/START.md is not in the vault yet.' } };
    return { status: 200, body: { md: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtime.toISOString() } };
  }

  function vaultHead() {
    try { return fs.readFileSync(path.join(vault, '.git/HEAD'), 'utf8').trim(); } catch { return null; }
  }

  function mount(app, { isAdminReq, readPagesRegistry }) {
    if (readPagesRegistry) readPages = readPagesRegistry;
    const adminOnly = (req, res, next) => (isAdminReq(req) ? next() : res.status(403).json({ error: 'Not available for your account.' }));
    const send = (res, r) => res.status(r.status).json(r.body);
    const guard = (fn) => (req, res) => { try { send(res, fn(req)); } catch (e) { res.status(e instanceof forum.ForumError ? e.status : 500).json({ error: e instanceof forum.ForumError ? e.message : e.code === 'ENOENT' ? 'The vault clone is not available on this server.' : e.message }); } };
    // A custom header blocks cross-site POSTs (same pattern as devices.js / X-Device-Confirm).
    const confirm = (req, res, next) => (req.get('X-Forum-Confirm') === '1' ? next() : res.status(400).json({ error: 'Missing X-Forum-Confirm header.' }));
    app.get('/api/projects', adminOnly, guard(() => ({ status: 200, body: list() })));
    app.get('/api/projects/:slug', adminOnly, guard((req) => hub(req.params.slug)));
    app.get('/api/projects/:slug/doc', adminOnly, guard((req) => doc(req.params.slug, req.query.p)));
    app.get('/api/forums', adminOnly, guard(() => ({ status: 200, body: forumAllList() })));
    app.get('/api/projects/:slug/forum', adminOnly, guard((req) => forumList(req.params.slug, req.query.full === '1')));
    app.post('/api/projects/:slug/forum', adminOnly, confirm, guard((req) => forumCreate(req.params.slug, req.body)));
    app.post('/api/projects/:slug/forum/submit', adminOnly, confirm, guard((req) => forumSubmit(req.params.slug, req.body)));
    app.get('/api/projects/:slug/forum/:nn(\\d+)', adminOnly, guard((req) => forumGet(req.params.slug, req.params.nn)));
    app.post('/api/projects/:slug/forum/:nn(\\d+)/:action(close|reopen)', adminOnly, confirm, guard((req) => forumCloseReopen(req.params.slug, req.params.nn, req.params.action, req.body)));
    app.get('/api/one-ada/start', adminOnly, guard(() => start()));
  }

  return { mount, list, hub, doc, start, vaultHead, forumList, forumSubmit, forumCreate, forumGet, forumCloseReopen, forumAllList };
}

module.exports = { create, readRegistry, safeResolve, slugify };
