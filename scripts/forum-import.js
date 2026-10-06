#!/usr/bin/env node
'use strict';

/**
 * forum-import.js — one-off migration of a vault `Forum/` folder into the VPS forum store.
 *
 *   node scripts/forum-import.js <project-slug> <path-to-Forum-folder> [--dry-run]
 *
 * Parses `NN — Title.md` (Forum/ plus one level of subfolders):
 *   line 1 `# NN — Title` · header `**Severity:** X · **Scope:** Y` · intro text up to the first col-0 `*` bullet
 *   col-0 `* …` bullet = Alex's post · indented `* **[Claude]:** …` = [Claude]'s post · other lines continue the current post
 *   an Alex post ending in CLOSED closes the thread.
 * KEEPS the permanent NN. REFUSES to overwrite: an existing thread is reported and left untouched (exit 3).
 * Imported events carry `imported:true` (their real times are unknown; file mtime is used), so the notify
 * email never announces them as new answers. Honours FORUM_DATA_DIR. Never touches the source folder.
 */
const fs = require('fs');
const path = require('path');
const forum = require('../src/forum');

const THREAD = /^(\d{2,4}) — (.+)\.md$/;
const CLAUDE = /^\s+\*\s+\*\*\[Claude\]:?\*\*:?\s*/;
const ALEX = /^\*\s+/;

function threadFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && THREAD.test(e.name)) out.push(path.join(dir, e.name));
    else if (e.isDirectory() && !e.name.startsWith('.')) {
      for (const s of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) if (s.isFile() && THREAD.test(s.name)) out.push(path.join(dir, e.name, s.name));
    }
  }
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function parse(file) {
  const [, nnStr, fileTitle] = THREAD.exec(path.basename(file));
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\t/g, '    ');
  const mtime = fs.statSync(file).mtimeMs;
  const lines = text.split('\n');
  let title = fileTitle, i = 0;
  const h1 = /^#\s+(?:\d{2,4}\s+—\s+)?(.*)$/.exec(lines[0] || '');
  if (h1 && h1[1].trim()) { title = h1[1].trim(); i = 1; }
  let severity = 'Moderate', scope = '';
  const intro = [];
  const posts = [];     // { author, lines[] }
  let cur = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const sev = /\*\*Severity:\*\*\s*(\w+)/.exec(l);
    if (sev && !cur && !intro.length) {
      severity = forum.SEVERITIES.find((s) => s.toLowerCase() === sev[1].toLowerCase()) || 'Moderate';
      const sc = /\*\*Scope:\*\*\s*(.*)$/.exec(l); scope = sc ? sc[1].trim() : '';
      continue;
    }
    if (CLAUDE.test(l)) { cur = { author: 'claude', lines: [l.replace(CLAUDE, '')] }; posts.push(cur); }
    else if (ALEX.test(l)) { cur = { author: 'alex', lines: [l.replace(ALEX, '')] }; posts.push(cur); }
    else if (cur) cur.lines.push(l.replace(/^ {1,4}/, ''));
    else intro.push(l);
  }
  const clean = (ls) => ls.join('\n').trim();
  let t = mtime;
  const events = [];
  let closed = false;
  for (const p of posts) {
    const body = clean(p.lines);
    if (!body) continue;
    events.push({ type: 'post', id: `imp${String(events.length).padStart(3, '0')}-${nnStr}`, author: p.author, ts: new Date(t += 1000).toISOString(), body, imported: true });
    closed = p.author === 'alex' && /(^|\s)CLOSED\s*$/.test(body);
  }
  if (closed) events.push({ type: 'close', author: 'alex', ts: new Date(t += 1000).toISOString(), note: 'CLOSED (imported)', imported: true });
  return { nn: Number(nnStr), title, severity, scope, body: clean(intro), ts: new Date(mtime).toISOString(), events, closed };
}

function main() {
  const argv = process.argv.slice(2), dry = argv.includes('--dry-run');
  const [slug, dir] = argv.filter((a) => !a.startsWith('--'));
  if (!slug || !dir) { console.error('usage: forum-import.js <project-slug> <Forum-folder> [--dry-run]'); process.exit(2); }
  if (!forum.SLUG_RE.test(slug)) { console.error('Invalid slug.'); process.exit(2); }
  const files = threadFiles(path.resolve(dir));
  if (!files.length) { console.error('No NN — Title.md files found.'); process.exit(2); }
  const seen = new Set();
  let imported = 0, refused = 0;
  for (const f of files) {
    const t = parse(f);
    if (seen.has(t.nn)) { console.log(`REFUSED ${String(t.nn).padStart(2, '0')}: duplicate NN inside the source (${path.basename(f)})`); refused++; continue; }
    seen.add(t.nn);
    const desc = `${String(t.nn).padStart(2, '0')} ${t.title} [${t.severity}] ${t.events.length} event(s)${t.closed ? ' CLOSED' : ''}`;
    if (forum.readThread(slug, t.nn)) { console.log(`REFUSED ${desc}: thread already exists, left untouched`); refused++; continue; }
    if (dry) { console.log(`would import ${desc}`); continue; }
    try {
      forum.createThread(slug, { nn: t.nn, title: t.title, severity: t.severity, scope: t.scope, body: t.body, author: 'claude', ts: t.ts, events: t.events, imported: true });
      console.log(`imported ${desc}`); imported++;
    } catch (e) { console.log(`REFUSED ${desc}: ${e.message}`); refused++; }
  }
  console.log(`${dry ? 'dry run: ' : ''}${imported} imported, ${refused} refused`);
  process.exit(refused ? 3 : 0);
}
main();
