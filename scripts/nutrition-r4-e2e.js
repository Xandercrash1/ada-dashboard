// Nutrition 1.0.1 browser check on STAGING: safe targets and pace, waist goals and log, deficit on Today, help text, long plan text, version label.
// One real Sonnet call (the initial plan). Creates a temporary zz-r4-* 303 account; restore staging data/users.json afterwards.
// Usage: PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node scripts/nutrition-r4-e2e.js <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/ubuntu/ops/browser/node_modules/playwright');
const B = 'http://127.0.0.1:3001', OUT = process.argv[2];
const DATA = path.join(__dirname, '../data');
const PW = 'r4-pass-' + Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c || x === undefined ? '' : String(x).slice(0, 400)); };
const A = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const user = 'zz-r4-a', IP = '203.0.113.161';
fs.mkdirSync(OUT, { recursive: true });
let cookie = '';
async function api(m, p, b) { if (!cookie) { const r0 = await fetch(B + '/api/login', { method: 'POST', headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW }) }); cookie = (r0.headers.get('set-cookie') || '').split(';')[0]; } const r = await fetch(B + p, { method: m, headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json', Cookie: cookie }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }
const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page, n) => page.screenshot({ path: `${OUT}/r4-${n}.png`, fullPage: true });
async function login(page) {
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': IP });
  await page.goto(B + '/login'); await page.waitForSelector('#username');
  await page.fill('#username', user); await page.fill('#password', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#submit-btn')]);
  await page.waitForTimeout(2500);
}
const text = (page) => page.textContent('#nutrition-root');
(async () => {
  const inv = (await A('POST', '/api/invites', { role: '303' })).json;
  const r = await fetch(B + '/api/invite/' + inv.url.split('/').pop(), { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.160', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW, displayName: 'R4' }) });
  ok(r.ok, 'temporary 303 user');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/cdn|net::|favicon|Failed to load resource|telemetry/.test(m.text())) errors.push('console: ' + m.text()); });
  await login(page);
  await page.goto(B + '/nutrition'); await page.waitForSelector('#wz-age', { timeout: 15000 });
  // step 1: 34 y male, 5'10", 190 lb
  await page.fill('#wz-age', '34'); await page.selectOption('#wz-sex', 'male'); await page.fill('#wz-ft', '5'); await page.fill('#wz-in', '10'); await page.fill('#wz-w', '190'); await page.selectOption('#wz-act', 'light');
  await page.click('[data-act="wz-next"]');
  await page.waitForSelector('[data-act="wz-goal"]');
  // step 2: weight goal too low, pace options capped, waist goal inputs
  await page.click('[data-act="wz-goal"][data-g="lose_weight"]'); await page.click('[data-act="wz-goal"][data-g="reduce_waist"]');
  await page.fill('#wz-t-lose_weight', '110');
  const opts = await page.locator('#wz-pace-lose_weight option').allTextContents();
  ok(opts.length >= 2 && !opts.some((o) => /^2 lb/.test(o)) && opts.some((o) => /^1\.5 lb/.test(o)), 'pace options stop at the safe cap for 190 lb (no 2 lb)', opts.join(' | '));
  ok(/Lowest allowed for your height: \d+ lb/.test(await text(page)), 'lowest allowed weight is shown near the target');
  ok(await page.locator('#wz-wc').count() === 1 && await page.locator('#wz-wt').count() === 1, 'waist goal shows waist now / target inputs');
  ok(/belly button/.test(await text(page)) && /Lowest allowed target: \d+(\.\d)? in/.test(await text(page)), 'waist measuring hint and floor are shown');
  await page.fill('#wz-wc', '42'); await page.fill('#wz-wt', '36');
  await shot(page, 'setup-goals-390'); ok(await noH(page), 'setup goals: no horizontal scroll');
  await page.click('[data-act="wz-next"]'); await page.waitForSelector('#wz-days'); await page.click('[data-act="wz-next"]'); await page.waitForSelector('#wz-routine');
  await page.fill('#wz-routine', 'Nothing yet'); await page.click('[data-act="wz-next"]'); await page.waitForSelector('[data-act="wz-finish"]');
  await page.click('[data-act="wz-finish"]'); await page.waitForTimeout(1200);
  const e1 = await page.textContent('[role="alert"]').catch(() => '');
  ok(/lowest allowed is \d+ lb \(BMI 18\.5\)/.test(e1), 'unsafe weight target refused with the lowest allowed weight in lb', e1);
  await shot(page, 'setup-refused-390');
  // fix target, under-18 note check on step 1 is covered below
  for (let i = 0; i < 4; i++) await page.click('[data-act="wz-back"]');
  await page.fill('#wz-age', '16'); await page.click('[data-act="wz-next"]'); await page.waitForSelector('[data-act="wz-goal"]');
  ok(/Under 18: weight-loss goals are not available/.test(await text(page)), 'under-18: weight-loss goals explained');
  await page.click('[data-act="wz-back"]'); await page.fill('#wz-age', '34'); await page.click('[data-act="wz-next"]'); await page.waitForSelector('[data-act="wz-goal"]');
  await page.fill('#wz-t-lose_weight', '170');
  for (let i = 0; i < 3; i++) await page.click('[data-act="wz-next"]');
  await page.waitForSelector('[data-act="wz-finish"]'); await page.click('[data-act="wz-finish"]');
  await page.waitForSelector('[data-act="tab"][data-tab="plan"]', { timeout: 170000 }); await page.waitForTimeout(1500);
  ok(true, 'plan built (one real Sonnet call)');
  // seed data for the visible numbers
  const today = new Date(); const d = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(today.getTime() - n * 864e5));   // the page and server use Eastern dates
  for (let i = 0; i < 4; i++) { await api('POST', '/api/nutrition/entries', { date: d(i), meal: 'lunch', name: 'Chicken and rice', servings: 1, serving: 'plate', per: { calories: 700, protein: 45, carbs: 80, fat: 15 } }); await api('POST', '/api/nutrition/entries', { date: d(i), meal: 'dinner', name: 'Pasta', servings: 1, serving: 'bowl', per: { calories: 600, protein: 25, carbs: 100, fat: 20 } }); }
  await api('POST', '/api/nutrition/workouts', { date: d(0), name: 'Lift', type: 'strength', minutes: 60 });
  await api('POST', '/api/nutrition/waists', { date: d(14), cm: 107 }); await api('POST', '/api/nutrition/waists', { date: d(0), cm: 104.5 }); await api('POST', '/api/nutrition/weights', { date: d(14), kg: 87.5 });
  // long plan text: store a long summary and check Show more
  const f = path.join(DATA, 'nutrition', user + '.json'); const js = JSON.parse(fs.readFileSync(f, 'utf8'));
  const longTxt = 'This is a sentence about how your plan keeps what works and changes a little. '.repeat(24) + 'THE END OF THE PLAN TEXT.';
  js.reviews.last.summary = longTxt; fs.writeFileSync(f, JSON.stringify(js));
  await page.goto(B + '/nutrition'); await page.waitForSelector('[data-act="tab"][data-tab="plan"]'); await page.click('[data-act="tab"][data-tab="plan"]'); await page.waitForTimeout(1500);
  ok(!(await text(page)).includes('THE END OF THE PLAN TEXT') && (await page.locator('[data-act="more"]').count()) >= 1, 'long plan text starts collapsed with Show more');
  await page.click('[data-act="more"][data-k^="rev-"]'); await page.waitForTimeout(300);
  ok((await text(page)).includes('THE END OF THE PLAN TEXT.'), 'Show more reveals the whole plan text to its last word');
  await shot(page, 'plan-390'); ok(await noH(page), 'plan tab: no horizontal scroll');
  const t = await text(page);
  ok(/About .* a week .*→ about/.test(t) || /Log a few days of food/.test(t), 'weight goal shows pace and estimated date (or asks for logs)');
  ok(/Waist|waist/.test(t) && /42 in/.test(t) && /104\.5|41\.1 in/.test(t.replace(/\s+/g, ' ')) , 'waist goal shows start → now progress', t.match(/Reduce waist[^]{0,200}/));
  await page.click('[data-act="help"][data-k="target"]'); ok(/calorie target is your daily goal/.test(await text(page)), "target 'What's this?' expands");
  await page.click('[data-act="help"][data-k="macros"]'); ok(/Protein helps you keep/.test(await text(page)), "macros 'What's this?' expands");
  // goal editor refusals (UI)
  await page.click('[data-act="goal-new"]'); await page.waitForSelector('#g-type'); await page.selectOption('#g-type', 'lose_weight'); await page.fill('#g-target', '100');
  await page.click('[data-act="gs-save"]'); await page.waitForTimeout(800);
  ok(/lowest allowed is \d+ lb/.test(await page.textContent('[data-act="gs-bg"]')), 'goal editor refuses a weight below BMI 18.5 and says the lowest allowed (sheet stays open)');
  await page.fill('#g-target', '170'); await page.fill('#g-deadline', d(-7)); await page.click('[data-act="gs-save"]'); await page.waitForTimeout(800);
  ok(/earliest safe date is \d{4}-\d{2}-\d{2}/.test(await page.textContent('[data-act="gs-bg"]')), 'goal editor refuses a too-fast deadline and suggests the earliest safe date');
  await shot(page, 'goal-refused-390');
  await page.selectOption('#g-type', 'reduce_waist').catch(() => {});
  await page.click('[data-act="gs-close"]');
  // Today: energy balance
  await page.click('[data-act="tab"][data-tab="today"]'); await page.waitForTimeout(800);
  const tt = await text(page);
  ok(/About [\d,]+ kcal (under|over) your burn so far/.test(tt) && /Daily burn \(maintenance\) about/.test(tt) && /from 1 workout/.test(tt), 'Today shows the deficit in plain words with the burn breakdown', tt.match(/Energy balance[^]{0,300}/));
  await page.click('[data-act="help"][data-k="deficit"]'); ok(/means eating less than your body burns/.test(await text(page)), "deficit 'What's this?' expands");
  await page.click('[data-act="help"][data-k="burn"]'); ok(/Your burn is about how many calories/.test(await text(page)), "burn 'What's this?' expands");
  await shot(page, 'today-390'); ok(await noH(page), 'today: no horizontal scroll');
  // History: pace card and waist log
  await page.click('[data-act="tab"][data-tab="history"]'); await page.waitForTimeout(1500);
  ok(/Your pace/.test(await text(page)) && /a day (under|over) your burn/.test(await text(page)) && /a week/.test(await text(page)), 'History shows the weekly deficit and what it means per week');
  await page.fill('#wa-val', '41'); await page.click('form[data-form="waist"] button'); await page.waitForTimeout(1200);
  const wl = (await api('GET', '/api/nutrition/waists')).json;
  ok(wl.length >= 2 && wl.some((x) => Math.abs(x.cm - 104.1) < 0.2), 'waist logged in inches, stored as cm', JSON.stringify(wl.map((x) => x.cm)));
  ok(/How to measure/.test(await text(page)) && (await page.locator('svg[aria-label="Waist trend"]').count()) === 1, 'waist log has a how-to and a trend chart');
  await shot(page, 'history-waist-390'); ok(await noH(page), 'history: no horizontal scroll');
  // Profile: pace cap, version label
  await page.click('[data-act="tab"][data-tab="profile"]'); await page.waitForTimeout(800);
  const rateOpts = await page.locator('#pf-rate option').allTextContents();
  ok(!rateOpts.some((o) => /^2 lb/.test(o)) && /max for you/.test(await text(page)), 'Profile pace list stops at the safe cap', rateOpts.join('|'));
  ok(/Nutrition 1\.0\.1/.test(await text(page)), 'version label 1.0.1 at the foot of Profile');
  await shot(page, 'profile-390'); ok(await noH(page), 'profile: no horizontal scroll');
  const pr = await api('PUT', '/api/nutrition/profile', { goal: 'lose', rateKgPerWeek: 1 });
  ok(pr.status === 400 && /safe pace/.test(pr.json.error), 'API refuses a faster-than-safe pace', JSON.stringify(pr.json));
  await ctx.close();
  // desktop pass
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errors.push('desk: ' + e.message));
  await login(p2); await p2.goto(B + '/nutrition'); await p2.waitForSelector('[data-act="tab"][data-tab="plan"]');
  for (const tb of ['today', 'plan', 'history', 'profile']) { await p2.click(`[data-act="tab"][data-tab="${tb}"]`); await p2.waitForTimeout(1000); await shot(p2, `${tb}-1280`); ok(await noH(p2), `desktop ${tb}: no horizontal scroll`); }
  await p2.click('[data-act="tab"][data-tab="today"]'); await p2.waitForTimeout(500);
  ok(/under your burn|over your burn/.test(await text(p2)), 'desktop Today shows the energy balance');
  await ctx2.close();
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  try { fs.rmSync(f, { force: true }); } catch (e) {}
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
