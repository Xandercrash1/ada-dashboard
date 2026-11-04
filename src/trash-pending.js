'use strict';

/**
 * trash-pending.js — view, clear and restore the VPS's Trash Pending folder (2026-11-03; Alex: "a dashboard way
 * to be able to view it and clear it", with a restore button).
 *
 * The VPS has no system trash, so Clear never deletes. It moves the items into a dated batch in ~/ops/trash-held,
 * and ~/ops/trash-purge.py deletes a batch for good once it is HOLD_DAYS old. Restore moves one item back to the
 * Trash Pending list. Putting it back where it came from is still a session's job, since that's usually the vault.
 * Delete removes one held item right away, for when Alex doesn't want to wait out the hold.
 *
 * Only the live checkout touches the real folders. Any other tree (staging) works in data/trash-test/.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOLD_DAYS = 30;
const MANIFEST = '_Manifest.md';
const BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;     // the purge script matches the same shape
const NO_REASON = 'No reason recorded in the manifest.';

class TrashError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function defaultDirs() {
  const tree = path.resolve(__dirname, '..');
  if (tree === path.join(os.homedir(), 'dashboard')) {
    return { pendingDir: path.join(os.homedir(), 'Desktop', 'Trash Pending'), heldDir: path.join(os.homedir(), 'ops', 'trash-held') };
  }
  return { pendingDir: path.join(tree, 'data', 'trash-test', 'Trash Pending'), heldDir: path.join(tree, 'data', 'trash-test', 'held') };
}

const batchStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/^(\d{4})(\d{2})(\d{2})T(\d{6})\.\d+Z$/, '$1-$2-$3T$4Z');
const batchDate = (batch) => new Date(batch.replace(/^(.{10}T)(\d{2})(\d{2})(\d{2})Z$/, '$1$2:$3:$4Z'));

// A manifest entry is "- **`name`, `name2`** — reason", plus any indented lines under it.
function parseManifest(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, MANIFEST), 'utf8'); } catch { return new Map(); }
  const entries = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(line);
    if (m) {
      current = { raw: line, reason: m[2].replace(/^[—–-]\s*/, '').replace(/`/g, '') };
      for (const b of m[1].matchAll(/`([^`]+)`/g)) entries.set(b[1].replace(/\/$/, ''), current);
    } else if (current && /^\s+\S/.test(line)) {
      current.raw += '\n' + line;
      current.reason += ' ' + line.trim().replace(/`/g, '');
    } else {
      current = null;
    }
  }
  return entries;
}

function sizeOf(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((sum, n) => sum + sizeOf(path.join(p, n)), 0);
}

function listItems(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const manifest = parseManifest(dir);
  return names.filter((n) => n !== MANIFEST).sort((a, b) => a.localeCompare(b)).map((name) => {
    const p = path.join(dir, name);
    const entry = manifest.get(name);
    return { name, isDir: fs.lstatSync(p).isDirectory(), size: sizeOf(p), reason: entry ? entry.reason : NO_REASON };
  });
}

function create({ pendingDir, heldDir } = defaultDirs()) {
  function list() {
    let batches = [];
    try { batches = fs.readdirSync(heldDir).filter((b) => BATCH_RE.test(b)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const held = batches.sort().reverse().map((batch) => {
      const clearedAt = batchDate(batch);
      return {
        batch,
        clearedAt: clearedAt.toISOString(),
        deletesAt: new Date(clearedAt.getTime() + HOLD_DAYS * 86400000).toISOString(),
        items: listItems(path.join(heldDir, batch)),
      };
    });
    return { holdDays: HOLD_DAYS, pending: listItems(pendingDir), held };
  }

  // Moves only the names the viewer was shown, so an item added after the page loaded stays put.
  function clear(names) {
    if (!Array.isArray(names) || !names.length) throw new TrashError(400, 'Nothing to clear.');
    const present = new Set(listItems(pendingDir).map((i) => i.name));
    const moving = [...new Set(names)].filter((n) => typeof n === 'string' && present.has(n));
    if (!moving.length) throw new TrashError(409, 'Those items are no longer in Trash Pending. Reload the list.');
    const batch = batchStamp();
    const dest = path.join(heldDir, batch);
    fs.mkdirSync(heldDir, { recursive: true });
    try { fs.mkdirSync(dest); } catch (e) {
      if (e.code === 'EEXIST') throw new TrashError(409, 'A clear just ran. Reload the list.');
      throw e;
    }
    const manifest = path.join(pendingDir, MANIFEST);
    if (fs.existsSync(manifest)) fs.copyFileSync(manifest, path.join(dest, MANIFEST));
    for (const n of moving) fs.renameSync(path.join(pendingDir, n), path.join(dest, n));
    // An empty Trash Pending claims items are waiting, so the folder goes once nothing is left in it.
    if (!listItems(pendingDir).length) {
      fs.rmSync(manifest, { force: true });
      fs.rmdirSync(pendingDir);
    }
    return { batch, moved: moving };
  }

  // Names are matched against the batch's own listing, so a request can't reach outside it.
  function heldItemDir(batch, name) {
    if (typeof batch !== 'string' || !BATCH_RE.test(batch)) throw new TrashError(400, 'Unknown batch.');
    const dir = path.join(heldDir, batch);
    if (typeof name !== 'string' || !listItems(dir).some((i) => i.name === name)) throw new TrashError(404, 'That item is not in holding.');
    return dir;
  }

  function dropBatchIfEmpty(dir) {
    if (listItems(dir).length) return;
    fs.rmSync(path.join(dir, MANIFEST), { force: true });
    fs.rmdirSync(dir);
  }

  function restore(batch, name) {
    const dir = heldItemDir(batch, name);
    const target = path.join(pendingDir, name);
    fs.mkdirSync(pendingDir, { recursive: true });
    if (fs.existsSync(target)) throw new TrashError(409, 'Trash Pending already has an item with that name.');
    const entry = parseManifest(dir).get(name);
    fs.renameSync(path.join(dir, name), target);
    // Items cleared together can share one entry, so restoring the second must not write it again.
    const line = entry ? entry.raw : `- **\`${name}\`** — ${NO_REASON}`;
    const manifest = path.join(pendingDir, MANIFEST);
    if (!fs.existsSync(manifest) || !fs.readFileSync(manifest, 'utf8').includes(line)) fs.appendFileSync(manifest, `${line}\n`);
    dropBatchIfEmpty(dir);
    return { restored: name };
  }

  function deleteNow(batch, name) {
    const dir = heldItemDir(batch, name);
    fs.rmSync(path.join(dir, name), { recursive: true });
    dropBatchIfEmpty(dir);
    return { deleted: name };
  }

  function mount(app, { isAdminReq }) {
    const adminOnly = (req, res, next) => (isAdminReq(req) ? next() : res.status(403).json({ error: 'Not available for your account.' }));
    const confirm = (req, res, next) => (req.get('X-Trash-Confirm') === '1' ? next() : res.status(400).json({ error: 'Missing X-Trash-Confirm header.' }));
    const guard = (fn) => (req, res) => {
      try { res.json(fn(req)); } catch (e) {
        const known = e instanceof TrashError;
        res.status(known ? e.status : 500).json({ error: known ? e.message : 'Trash Pending could not be read or changed.' });
      }
    };
    app.get('/api/trash-pending', adminOnly, guard(() => list()));
    app.post('/api/trash-pending/clear', adminOnly, confirm, guard((req) => clear(req.body && req.body.names)));
    app.post('/api/trash-pending/restore', adminOnly, confirm, guard((req) => restore(req.body && req.body.batch, req.body && req.body.name)));
    app.post('/api/trash-pending/delete', adminOnly, confirm, guard((req) => deleteNow(req.body && req.body.batch, req.body && req.body.name)));
  }

  return { list, clear, restore, deleteNow, mount };
}

module.exports = { create, HOLD_DAYS };
