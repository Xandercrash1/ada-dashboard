'use strict';
/*
 * page-cleanup.js — a page removes itself when the tasks it was waiting on are done (Alex, 2026-11-27).
 * A page registry entry (data/pages.json) may carry removeWhenDone: [taskId, ...] (1-10 ids). The rule `page-cleanup`
 * runs on every task completion; for each page listing the completed task, if NONE of its listed tasks is still open,
 * the page is removed: registry entry dropped, and its document, history snapshots and images moved (never deleted)
 * into Trash Pending as one folder "page <id> <date>" with a _Manifest.md entry that says how to restore.
 * Safe to run twice: once the registry entry is gone, nothing matches. A throw is handled by the automation
 * queue (retry, then dead-letter ticket); the task completion itself stands.
 */
const fs = require('fs');
const path = require('path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// -> { ids } or { error }
function validateIds(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 10) return { error: 'removeWhenDone: 1 to 10 task ids' };
  const ids = [];
  for (const x of v) {
    if (typeof x !== 'string' || !ID_RE.test(x)) return { error: 'removeWhenDone: each id is letters, digits, dashes or underscores' };
    if (!ids.includes(x)) ids.push(x);
  }
  return { ids };
}

function move(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(src, dest); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true });   // a move across disks
  }
}

function removePage(page, { dataDir, pendingDir, date }) {
  const id = page.id;
  if (!PAGE_ID_RE.test(id) || id === 'home' || id === 'server' || id === 'todo') throw new Error(`page-cleanup: refusing id "${id}"`);
  const folder = `page ${id} ${date}`;
  const dest = path.join(pendingDir, folder);
  fs.mkdirSync(dest, { recursive: true });
  const parts = [
    [path.join(dataDir, 'pages', `${id}.json`), path.join(dest, `${id}.json`), `data/pages/${id}.json`],
    [path.join(dataDir, 'history', id), path.join(dest, 'history'), `data/history/${id}/`],
    [path.join(dataDir, 'media', `page-${id}`), path.join(dest, `page-${id}-images`), `data/media/page-${id}/`],
  ];
  let moved = 0;
  for (const [src, to] of parts) if (fs.existsSync(src) && !fs.existsSync(to)) { move(src, to); moved++; }
  const entryFile = path.join(dest, 'registry-entry.json');
  if (!fs.existsSync(entryFile)) fs.writeFileSync(entryFile, JSON.stringify(page, null, 2));
  const manifest = path.join(pendingDir, '_Manifest.md');
  let text = ''; try { text = fs.readFileSync(manifest, 'utf8'); } catch (e) { /* new manifest */ }
  if (!text.includes(`\`${folder}\``)) {
    const ids = (page.removeWhenDone || []).join(', ');
    const lines = [
      `- **\`${folder}\`** — page removed automatically: all its tasks done (${ids}).`,
      `  Original: registry entry in data/pages.json (saved here as registry-entry.json), ${parts.map((x) => x[2]).join(', ')}.`,
      `  To restore: put registry-entry.json back into the array in data/pages.json (drop its removeWhenDone, or the same tasks would remove it again), move ${id}.json to data/pages/, history/ to data/history/${id}/ and page-${id}-images/ to data/media/page-${id}/.`,
    ];
    fs.appendFileSync(manifest, (text && !text.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n');
  }
  return { folder, moved };
}

function removeFromRegistry(file, id) {
  const pages = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = pages.filter((p) => p.id !== id);
  if (next.length === pages.length) return false;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, file);
  return true;
}

// The registered rule. Dependencies are injectable for tests.
function rule({ dataDir, pendingDir, log = console.log, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  return function onComplete(task, tasks) {
    if (!task || !task.id) return undefined;
    const regFile = path.join(dataDir, 'pages.json');
    let pages;
    try { pages = JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    const open = new Set(tasks.map((t) => t.id));
    for (const pg of pages) {
      const ids = Array.isArray(pg.removeWhenDone) ? pg.removeWhenDone : [];
      if (!ids.includes(task.id) || ids.some((i) => open.has(i))) continue;
      const r = removePage(pg, { dataDir, pendingDir, date: today() });
      removeFromRegistry(regFile, pg.id);
      log(`[page-cleanup] removed page ${pg.id} (tasks done: ${ids.join(', ')}) -> Trash Pending "${r.folder}"`);
    }
    return undefined;   // tasks unchanged
  };
}

module.exports = { rule, validateIds };
