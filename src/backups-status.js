'use strict';

/**
 * backups-status.js — read-only Backups card data (Server tab > Health & Stats).
 * Reads the filesystem only: ~/backups/restic/<device>/snapshots (mtime = upload time) and the tail of
 * ~/ops/logs/backup-restic.log. Never calls restic, never touches a password file. Cached ~60 s.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(os.homedir(), 'backups', 'restic');
const LOG = path.join(os.homedir(), 'ops', 'logs', 'backup-restic.log');
const TTL_MS = 60 * 1000;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function dirSize(dir) {   // sum of file sizes (like du -sb, without directory blocks)
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch { /* vanished mid-walk */ }
    }
  }
  return total;
}

function repoInfo(name) {
  const repo = path.join(REPO_ROOT, name);
  let newest = 0, count = 0;
  try {
    for (const f of fs.readdirSync(path.join(repo, 'snapshots'))) {
      try { newest = Math.max(newest, fs.statSync(path.join(repo, 'snapshots', f)).mtimeMs); count++; } catch { /* skip */ }
    }
  } catch { /* no snapshots dir */ }
  return { name, newest: newest ? new Date(newest).toISOString() : null, snapshots: count, sizeBytes: dirSize(repo) };
}

// Log lines look like "2026-11-11 03:30:04 ok: 11 snapshots", "... drive: copied", "... FAILED: <what>".
// Times are server-local; convert to an ISO instant.
function parseLog() {
  let lines = [];
  try {
    const st = fs.statSync(LOG);
    const fd = fs.openSync(LOG, 'r');
    const len = Math.min(st.size, 16384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    lines = buf.toString('utf8').split('\n');
  } catch { return { lastRun: null, drive: null }; }
  const re = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (.*)$/;
  const at = (m) => new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
  let lastRun = null, drive = null;
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const msg = m[7];
    if (/^ok\b/.test(msg)) lastRun = { at: at(m), ok: true, text: msg };
    else if (/^FAILED: (?!drive)/.test(msg)) lastRun = { at: at(m), ok: false, text: msg };
    if (/^drive: copied/.test(msg)) drive = { at: at(m), ok: true, text: msg };
    else if (/^FAILED: drive/.test(msg)) drive = { at: at(m), ok: false, text: msg };
  }
  return { lastRun, drive };
}

function build() {
  let names = [];
  try {
    names = fs.readdirSync(REPO_ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && NAME_RE.test(e.name)).map(e => e.name);
  } catch { /* none */ }
  names.sort((a, b) => (a === 'vps' ? -1 : b === 'vps' ? 1 : a.localeCompare(b)));
  const log = parseLog();
  return {
    generatedAt: new Date().toISOString(),
    devices: names.map(repoInfo),
    lastRun: log.lastRun,
    drive: log.drive,
    homeCopyNote: 'AdaTwo keeps a home copy at 5am (not visible from here)',
  };
}

function create() {
  let cache = null, cachedAt = 0;
  function status() {
    if (!cache || Date.now() - cachedAt > TTL_MS) { cache = build(); cachedAt = Date.now(); }
    return cache;
  }
  function mount(app, { isAdminReq }) {
    const adminOnly = (req, res, next) => (isAdminReq(req) ? next() : res.status(403).json({ error: 'Not available for your account.' }));
    app.get('/api/backups/status', adminOnly, (req, res) => {
      try { res.json(status()); } catch { res.status(500).json({ error: 'Backup status could not be read.' }); }
    });
  }
  return { mount, status };
}

module.exports = { create };
