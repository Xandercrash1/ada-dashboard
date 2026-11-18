#!/usr/bin/env node
/*
 * One-off, safe to re-run: copy the entries of the old "Diet" splash page (user project
 * up-df8b55678f0e6926, lists food-log / my-foods / goals / meal-plan) into the Nutrition
 * file of its owner, <dataDir>/nutrition/<user>.json.
 *
 *   node scripts/migrate-diet-to-nutrition.js <dataDir> [--dry] [--user alex] [--project up-…]
 *
 * Reads <dataDir>/user-project-data/<project>.json and never changes it (nor the page).
 * Imported items carry legacyId, so a second run skips what is already there.
 * Goals become target overrides only the first time and only if none are set yet.
 */
const fs = require('fs');
const path = require('path');
const { cleanEntry, emptyData, NUTS } = require('../src/nutrition');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--user', '--project'].includes(args[i - 1])));
const dataDir = positional[0];
if (!dataDir) { console.error('Usage: migrate-diet-to-nutrition.js <dataDir> [--dry] [--user alex] [--project up-…]'); process.exit(2); }
const dry = flag('--dry');
const user = opt('--user', 'alex');
const project = opt('--project', 'up-df8b55678f0e6926');

const src = path.join(dataDir, 'user-project-data', `${project}.json`);
const dst = path.join(dataDir, 'nutrition', `${user}.json`);

let lists;
try { lists = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) {
  if (e.code === 'ENOENT') { console.log(`Nothing to import: ${src} does not exist (the page never stored anything).`); process.exit(0); }
  console.error(`Cannot read ${src}: ${e.message}`); process.exit(1);
}
let data;
try { data = { ...emptyData(), ...JSON.parse(fs.readFileSync(dst, 'utf8')) }; } catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Cannot read ${dst}: ${e.message}`); process.exit(1); }
  data = emptyData();
}
data.legacy = data.legacy || {};

const stats = { entries: 0, entriesSkipped: 0, entriesBad: 0, foods: 0, foodsSkipped: 0, plan: 0, planSkipped: 0, goals: 'unchanged' };
const have = new Set(data.entries.map((e) => e.legacyId).filter(Boolean));
for (const o of lists['food-log'] || []) {
  const lid = String(o.id || '');
  if (!lid) { stats.entriesBad++; continue; }
  if (have.has(lid)) { stats.entriesSkipped++; continue; }
  let per = o.per;
  if (!per || typeof per !== 'object') { per = {}; const s = Number(o.servings) || 1; NUTS.forEach((k) => { per[k] = (Number(o[k]) || 0) / s; }); }
  try {
    const clean = cleanEntry({ date: o.date, meal: String(o.meal || 'snack').toLowerCase(), name: o.name, servings: o.servings || 1, serving: o.serving || '', per, source: 'migrated' });
    data.entries.push({ id: 'm-' + lid, ...clean, at: o.at || new Date().toISOString(), legacyId: lid });
    have.add(lid); stats.entries++;
  } catch (e) { stats.entriesBad++; console.warn(`skipped food-log ${lid}: ${e.message}`); }
}
const haveFoods = new Set(data.foods.map((f) => f.legacyId).filter(Boolean));
for (const o of lists['my-foods'] || []) {
  const lid = String(o.id || '');
  if (!lid || haveFoods.has(lid)) { stats.foodsSkipped++; continue; }
  try {
    const clean = cleanEntry({ date: '2000-01-01', meal: 'snack', name: o.name, servings: 1, serving: o.serving || '', per: o });
    data.foods.push({ id: 'm-' + lid, name: clean.name, serving: clean.serving, per: clean.per, legacyId: lid });
    haveFoods.add(lid); stats.foods++;
  } catch (e) { stats.entriesBad++; console.warn(`skipped my-foods ${lid}: ${e.message}`); }
}
// The old weekly meal plan has no home in the new page yet; keep it safe in the file.
data.legacy.mealPlan = data.legacy.mealPlan || [];
const havePlan = new Set(data.legacy.mealPlan.map((p) => p.id));
for (const o of lists['meal-plan'] || []) {
  if (!o || !o.id || havePlan.has(o.id)) { stats.planSkipped++; continue; }
  data.legacy.mealPlan.push(o); havePlan.add(o.id); stats.plan++;
}
const goals = lists.goals || [];
if (goals.length && !data.legacy.goalsImported) {
  if (!Object.keys(data.profile.overrides || {}).length) {
    const g = goals[goals.length - 1];
    data.profile.overrides = {};
    NUTS.forEach((k) => { const v = Number(g[k]); if (v > 0 && v <= 20000) data.profile.overrides[k] = v; });
    stats.goals = 'imported as target overrides';
  } else stats.goals = 'skipped (targets already set)';
  data.legacy.goalsImported = true;
}

console.log(`${dry ? '[dry run] would import' : 'Imported'} for ${user}: ${stats.entries} log entries (${stats.entriesSkipped} already there, ${stats.entriesBad} unusable), ${stats.foods} saved foods (${stats.foodsSkipped} skipped), ${stats.plan} meal-plan rows (${stats.planSkipped} skipped); goals: ${stats.goals}.`);
if (dry) process.exit(0);
if (stats.entries || stats.foods || stats.plan || stats.goals.startsWith('imported') || stats.goals.startsWith('skipped')) {
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, dst);
  console.log(`Wrote ${dst}`);
} else console.log('No changes written.');
