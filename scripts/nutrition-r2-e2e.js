// Round 2 browser check on STAGING: guided setup (with real Coach calls), plan, workout log, review, undo.
// Three real Sonnet calls: one setup chat turn, the initial plan, one manual review.
// Usage: PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node scripts/nutrition-r2-e2e.js <screenshot dir>
// Creates a temporary zz-r2-* 303 account and removes its nutrition file; restore staging data/users.json yourself afterwards.
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/ubuntu/ops/browser/node_modules/playwright');
const B = 'http://127.0.0.1:3001', OUT = process.argv[2];
const DATA = path.join(__dirname, '../data');
const PW = 'r2-pass-' + Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c || x === undefined ? '' : String(x).slice(0, 400)); };
const A = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const user = 'zz-r2-a', IP = '203.0.113.141';
fs.mkdirSync(OUT, { recursive: true });
async function api(m, p, b) { const r0 = await fetch(B + '/api/login', { method: 'POST', headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW }) }); const cookie = (r0.headers.get('set-cookie') || '').split(';')[0]; const r = await fetch(B + p, { method: m, headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json', Cookie: cookie }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }
const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page, n) => page.screenshot({ path: `${OUT}/r2-${n}.png`, fullPage: true });
async function login(page) {
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': IP });
  await page.goto(B + '/login'); await page.waitForSelector('#username');
  await page.fill('#username', user); await page.fill('#password', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#submit-btn')]);
  await page.waitForTimeout(3000);
}
(async () => {
  const inv = (await A('POST', '/api/invites', { role: '303' })).json;
  const r = await fetch(B + '/api/invite/' + inv.url.split('/').pop(), { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.140', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW, displayName: 'R2 Test' }) });
  ok(r.ok, 'temporary 303 user created');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/cdn|net::|favicon|Failed to load resource|telemetry/.test(m.text())) errors.push('console: ' + m.text()); });
  await login(page);
  await page.evaluate(() => switchTab('nutrition')); await page.waitForSelector('#wz-age', { timeout: 15000 });
  ok(true, 'first-time user lands in guided setup (step 1)');
  await shot(page, 'setup-1');
  // step 1: basics (imperial)
  await page.fill('#wz-age', '36'); await page.selectOption('#wz-sex', 'male'); await page.fill('#wz-ft', '5'); await page.fill('#wz-in', '10'); await page.fill('#wz-w', '190'); await page.selectOption('#wz-act', 'light');
  await page.click('[data-act="wz-next"]');
  // step 2: goals + a conversation with the Coach (real call, free during setup)
  await page.waitForSelector('[data-act="wz-goal"]');
  await page.click('[data-act="wz-goal"][data-g="lose_weight"]'); await page.click('[data-act="wz-goal"][data-g="strength"]');
  await page.fill('#wz-t-lose_weight', '175');
  await page.click('[data-act="wz-chat"]'); await page.waitForSelector('#wz-chatin');
  await page.fill('#wz-chatin', 'I lift upper body on Monday and Wednesday and walk 20 minutes most days. I eat about 2000 calories but have no real plan. My left shoulder is a bit sore.');
  await page.click('[data-act="wz-send"]');
  await page.waitForSelector('#wz-chatlog .bg-black\\/5, #wz-chatlog [class*="bg-black"]', { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(500);
  const chatTxt = await page.textContent('#wz-chatlog');
  ok(chatTxt.length > 60 && !/Thinking/.test(chatTxt), 'setup chat: the Coach answered (real call)', chatTxt.slice(-200));
  await shot(page, 'setup-2-chat');
  ok(await noH(page), 'setup step 2: no horizontal scroll');
  const left1 = (await api('GET', '/api/nutrition/coach')).json.limit;
  ok(left1.left === 20, 'setup chat did not count against the 20/day limit', left1);
  await page.click('[data-act="wz-next"]');
  // step 3: training
  await page.waitForSelector('#wz-days');
  await page.selectOption('#wz-days', '3'); await page.selectOption('#wz-min', '45'); await page.click('[data-act="wz-set"][data-k="equipment"][data-v="gym"]'); await page.click('[data-act="wz-set"][data-k="experience"][data-v="intermediate"]');
  await page.fill('#wz-lim', 'sore left shoulder');
  await shot(page, 'setup-3');
  await page.click('[data-act="wz-next"]');
  // step 4: baseline
  await page.waitForSelector('#wz-routine');
  await page.fill('#wz-routine', 'Upper body lifting Monday and Wednesday (about 45 min), a 20 minute walk most days');
  await page.fill('#wz-diet', 'About 2000 kcal a day, no real plan');
  await shot(page, 'setup-4-baseline');
  ok(await noH(page), 'setup step 4: no horizontal scroll');
  await page.click('[data-act="wz-next"]');
  await page.waitForSelector('[data-act="wz-finish"]'); await shot(page, 'setup-5-review');
  await page.click('[data-act="wz-finish"]');
  await page.waitForSelector('[data-act="tab"][data-tab="plan"]', { timeout: 170000 });
  await page.waitForTimeout(1500);
  ok(true, 'initial plan built (real call), landed on the app');
  const st = (await api('GET', '/api/nutrition/state')).json;
  ok(st.setup.done && st.setup.answers.routine.includes('Upper body lifting') && st.setup.answers.diet.includes('2000'), 'baseline stored with the setup', st.setup.answers);
  ok(st.workoutPlan && st.workoutPlan.days.length >= 1 && st.targetMeta.source === 'ai', 'AI set targets and a workout plan', JSON.stringify(st.targetMeta));
  ok(st.goals.length === 2 && st.goals.some((g) => g.type === 'lose_weight' && Math.abs(g.target - 79.4) < 0.3), 'goals stored (target 175 lb = 79.4 kg)', JSON.stringify(st.goals.map((g) => [g.type, g.target])));
  const sum = (st.review && st.review.summary) || '';
  ok(/lift|Monday|Wednesday|walk|keep|kept|current|already|existing/i.test(sum), 'plan explanation builds on the stated baseline', sum);
  const names = st.workoutPlan.days.flatMap((d) => d.sessions.flatMap((x) => x.exercises.map((e) => e.name)));
  ok(!names.some((n) => /overhead|military|snatch|upright row|dips?\b|handstand/i.test(n)), 'plan respects the stated shoulder limit (no exercise on the avoid list)', names.join(', '));
  ok((await api('GET', '/api/nutrition/coach')).json.limit.left === 20, 'initial plan did not count against the limit');
  console.log('SUMMARY:', sum);
  await page.click('[data-act="tab"][data-tab="plan"]'); await page.waitForTimeout(1200);
  ok(/Your plan/.test(await page.textContent('#nutrition-root')) && (await page.locator('[data-act="undo"]').count()) >= 1, 'Plan tab shows "Your plan", change cards and Undo');
  await shot(page, 'plan-390');
  ok(await noH(page), 'plan tab: no horizontal scroll');
  // today tab with workout card
  await page.click('[data-act="tab"][data-tab="today"]'); await page.waitForTimeout(800); await shot(page, 'today-390');
  ok(await noH(page), 'today tab: no horizontal scroll');
  // log a workout
  await page.click('[data-act="tab"][data-tab="plan"]'); await page.waitForTimeout(500);
  await page.click('[data-act="wo-new"]'); await page.waitForSelector('#ws-name');
  await page.fill('#ws-name', 'Test upper body'); await page.fill('#ws-min', '40'); await page.fill('#ws-eff', '7');
  await page.fill('[data-wx="0.name"]', 'Bench press'); await page.fill('[data-wx="0.sets"]', '3'); await page.fill('[data-wx="0.reps"]', '8'); await page.fill('[data-wx="0.weight"]', '135');
  await shot(page, 'workout-sheet-390');
  ok(await noH(page), 'workout sheet: no horizontal scroll');
  await page.click('[data-act="ws-save"]'); await page.waitForTimeout(1500);
  const wos = (await api('GET', '/api/nutrition/workouts')).json;
  ok(wos.length === 1 && wos[0].exercises[0].weightKg > 60 && wos[0].exercises[0].weightKg < 62, 'workout logged (135 lb stored as kg)', JSON.stringify(wos));
  const btn = page.locator('[data-act="wo-plan"]').first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(1200); ok((await api('GET', '/api/nutrition/workouts')).json.length === 2, 'Done as planned logs the planned session'); } else console.log('(no planned session on or before today without a log; skipped Done as planned)');
  await page.click('[data-act="tab"][data-tab="history"]'); await page.waitForTimeout(1200); await shot(page, 'history-390');
  ok(/Workouts, last 30 days/.test(await page.textContent('#nutrition-root')), 'History lists workouts');
  // food for the review, then a manual review (real call, counts)
  const today = new Date(); for (let i = 0; i < 4; i++) { const d = new Date(today.getTime() - i * 864e5).toISOString().slice(0, 10); await api('POST', '/api/nutrition/entries', { date: d, meal: 'lunch', name: 'Chicken and rice', servings: 1, serving: 'plate', per: { calories: 700, protein: 45, carbs: 80, fat: 15 } }); await api('POST', '/api/nutrition/entries', { date: d, meal: 'dinner', name: 'Pasta', servings: 1, serving: 'bowl', per: { calories: 800, protein: 25, carbs: 100, fat: 25 } }); }
  await api('POST', '/api/nutrition/weights', { kg: 86.2 });
  const before = (await api('GET', '/api/nutrition/state')).json;
  await page.click('[data-act="tab"][data-tab="plan"]'); await page.waitForTimeout(800);
  await page.click('[data-act="review"]');
  for (let i = 0; i < 85; i++) { const v = (await api('GET', '/api/nutrition/state')).json; const run = (await api('GET', '/api/nutrition/coach')).json.busy; if (!run && v.review && v.review.mode === 'manual') break; await new Promise((x) => setTimeout(x, 2000)); }
  await page.waitForTimeout(3500);
  const after = (await api('GET', '/api/nutrition/state')).json;
  ok(after.review && after.review.mode === 'manual', 'manual review ran (real call)', JSON.stringify(after.review));
  ok((await api('GET', '/api/nutrition/coach')).json.limit.left === 19, 'manual review counted (19 of 20)');
  console.log('REVIEW:', after.review.summary, '| calories', before.targets.calories, '->', after.targets.calories);
  const dc = Math.abs(after.targets.calories - before.targets.calories) / before.targets.calories;
  ok(dc <= 0.101, 'review changed calories by at most ~10%', dc);
  await shot(page, 'review-390');
  ok(await noH(page), 'plan after review: no horizontal scroll');
  // undo the newest undoable change through the UI
  const undoBtn = page.locator('[data-act="undo"]').first();
  const calNow = after.targets.calories;
  await undoBtn.click(); await page.waitForTimeout(1500);
  const afterUndo = (await api('GET', '/api/nutrition/state')).json;
  ok(afterUndo.changes.some((c) => c.undone) && afterUndo.changes[0].summary.startsWith('Undid:'), 'Undo button restored the earlier state and logged it', afterUndo.changes[0].summary);
  console.log('after undo: calories', calNow, '->', afterUndo.targets.calories, 'plan days', afterUndo.workoutPlan ? afterUndo.workoutPlan.days.length : null);
  await shot(page, 'undo-390');
  // coach tab + profile tab (redo setup button)
  await page.click('[data-act="tab"][data-tab="coach"]'); await page.waitForTimeout(800); await shot(page, 'coach-390'); ok(await noH(page), 'coach tab: no horizontal scroll');
  await page.click('[data-act="tab"][data-tab="profile"]'); await page.waitForTimeout(800); await shot(page, 'profile-390');
  ok(await page.locator('[data-act="wz-redo"]').count() === 1 && await noH(page), 'Profile has Redo setup, no horizontal scroll');
  await ctx.close();
  // desktop
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errors.push('desk: ' + e.message));
  await login(p2); await p2.evaluate(() => switchTab('nutrition')); await p2.waitForSelector('[data-act="tab"][data-tab="plan"]'); 
  for (const t of ['plan', 'today', 'coach']) { await p2.click(`[data-act="tab"][data-tab="${t}"]`); await p2.waitForTimeout(900); await shot(p2, `${t}-1280`); ok(await noH(p2), `desktop ${t}: no horizontal scroll`); }
  await ctx2.close();
  // admin (loopback): wizard on first visit, skip leads to the tabs
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p3 = await ctx3.newPage(); p3.on('pageerror', (e) => errors.push('admin: ' + e.message));
  await p3.goto(B + '/'); await p3.waitForTimeout(2500); await p3.evaluate(() => switchTab('nutrition')); await p3.waitForSelector('#wz-age'); await shot(p3, 'admin-setup-390');
  await p3.click('[data-act="wz-skip"]'); await p3.waitForSelector('[data-act="tab"][data-tab="plan"]');
  ok((await p3.locator('[data-act="tab"]').count()) === 5, 'admin can skip setup; five tabs fit'); ok(await noH(p3), 'admin: no horizontal scroll'); await ctx3.close();
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  for (const u of [user, 'alex']) { try { fs.rmSync(path.join(DATA, 'nutrition', u + '.json'), { force: true }); } catch (e) {} }
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
