#!/usr/bin/env node
/*
 * Registers Nutrition as a page, so it shows under "Your pages" on Home (for admin and every 303
 * account) and under the Lifestyle project's hub. It is a built-in view, not a canvas page:
 * the entry has kind "builtin" and its id is the view's id.
 *
 *   node scripts/register-nutrition-page.js <dataDir> [--dry]
 *
 * Safe to run again: an identical entry changes nothing, a changed one is brought back in line,
 * and every other page in data/pages.json is left exactly as it was. data/ is not deployed by git,
 * so run this on the live checkout after the code is deployed.
 */
const fs = require('fs');
const path = require('path');

const ENTRY = { id: 'nutrition', title: 'Nutrition', icon: 'fa-apple-whole', owner: 'alex', sharedWith: ['@303'], project: 'lifestyle', kind: 'builtin' };
const dataDir = process.argv[2];
const dry = process.argv.includes('--dry');
if (!dataDir || dataDir.startsWith('--')) { console.error('Usage: register-nutrition-page.js <dataDir> [--dry]'); process.exit(2); }
const file = path.join(dataDir, 'pages.json');
let pages;
try { pages = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(1); }
if (!Array.isArray(pages)) { console.error(`${file} is not a list of pages.`); process.exit(1); }

const i = pages.findIndex((p) => p && p.id === ENTRY.id);
let action;
if (i < 0) { pages.push({ ...ENTRY }); action = 'add'; }
else if (pages[i].kind !== 'builtin') { console.error('A different page already uses the id "nutrition". Nothing changed.'); process.exit(1); }
else {
  const cur = pages[i], want = { ...cur, ...ENTRY, sharedWith: [...new Set([...(Array.isArray(cur.sharedWith) ? cur.sharedWith : []), '@303'])] };
  if (JSON.stringify(cur) === JSON.stringify(want)) action = 'none'; else { pages[i] = want; action = 'update'; }
}
if (action === 'none') { console.log('Nutrition is already registered. No changes.'); process.exit(0); }
console.log(`${dry ? '[dry run] would ' : ''}${action === 'add' ? 'add' : 'update'} the Nutrition page entry in ${file} (${pages.length} pages afterwards).`);
if (dry) process.exit(0);
const mode = fs.statSync(file).mode & 0o777;
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(pages, null, 2), { mode });
fs.renameSync(tmp, file);
console.log('Done.');
