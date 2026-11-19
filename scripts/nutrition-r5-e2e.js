// Nutrition 1.0.2 browser check on STAGING: tap a bar to see where a nutrient came from; a coach log turn states the page's totals.
// One real Sonnet call. Temporary zz-r5-* 303 account; restore staging data/users.json afterwards.
// Usage: PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node scripts/nutrition-r5-e2e.js <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/ubuntu/ops/browser/node_modules/playwright');
const B = 'http://127.0.0.1:3001', OUT = process.argv[2];
const DATA = path.join(__dirname, '../data');
const PW = 'r5-pass-' + Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c || x === undefined ? '' : String(x).slice(0, 400)); };
const A = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const user = 'zz-r5-a', IP = '203.0.113.181';
fs.mkdirSync(OUT, { recursive: true });
let cookie = '';
async function api(m, p, b) { if (!cookie) { const r0 = await fetch(B + '/api/login', { method: 'POST', headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW }) }); cookie = (r0.headers.get('set-cookie') || '').split(';')[0]; } const r = await fetch(B + p, { method: m, headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json', Cookie: cookie }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }
const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page, n) => page.screenshot({ path: `${OUT}/r5-${n}.png`, fullPage: true });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
async function login(page) {
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': IP });
  await page.goto(B + '/login'); await page.waitForSelector('#username');
  await page.fill('#username', user); await page.fill('#password', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#submit-btn')]);
  await page.waitForTimeout(2500);
}
async function checkBreakdown(page, w) {
  const day = (await api('GET', '/api/nutrition/day')).json;
  await page.click('[data-act="tab"][data-tab="today"]'); await page.waitForTimeout(600);
  ok(await page.locator('[data-breakdown]').count() === 0, `@${w}: breakdowns start collapsed`);
  await page.click('[data-act="nut"][data-k="protein"]'); await page.waitForSelector('[data-breakdown="protein"]');
  const bd = page.locator('[data-breakdown="protein"]'); const txt = await bd.textContent();
  const first = await bd.locator('li').first().textContent();
  ok(/Chicken/.test(first) && /60 g/.test(first) && /% of today/.test(first), `@${w}: protein lists the biggest source first with grams and share`, first);
  const names = await bd.locator('li .text-sm.truncate').allTextContents();
  ok(names.join(',') === day.breakdown.protein.map((r) => r.name).join(','), `@${w}: order matches the server's largest-first list`, names.join(','));
  const shares = (await bd.locator('li').allTextContents()).map((x) => Number((/(\d+(\.\d)?)% of today/.exec(x) || [])[1])).reduce((a, b) => a + b, 0);
  ok(Math.abs(shares - 100) < 0.6, `@${w}: shares add up to 100%`, shares);
  ok(new RegExp(`protein.*${Math.round(day.breakdown.kcalShare.protein.grams)} g × 4 kcal = ${Math.round(day.breakdown.kcalShare.protein.kcal)} kcal.*${day.breakdown.kcalShare.protein.pct}%`, 'i').test(txt) && /Fat has 9 kcal per gram, while protein and carbs have 4/.test(txt), `@${w}: percent of calories with the 4 vs 9 kcal line`, txt);
  if (w === 390) { await shot(page, 'breakdown-390'); } else { await shot(page, 'breakdown-1280'); }
  ok(await noH(page), `@${w}: no horizontal scroll with a breakdown open`);
  await page.click('[data-act="nut"][data-k="fat"]'); await page.waitForSelector('[data-breakdown="fat"]');
  ok(await page.locator('[data-breakdown]').count() === 1 && /oil/i.test(await page.locator('[data-breakdown="fat"] li').first().textContent()), `@${w}: opening another bar closes the first; fat is led by the oil`);
  await page.click('[data-act="nut"][data-k="fat"]'); await page.waitForTimeout(300);
  ok(await page.locator('[data-breakdown]').count() === 0, `@${w}: tapping again collapses it`);
  await page.click('[data-act="nut"][data-k="calories"]'); await page.waitForSelector('[data-breakdown="calories"]');
  ok(/kcal/.test(await page.locator('[data-breakdown="calories"] li').first().textContent()) && !/× 4 kcal/.test(await page.locator('[data-breakdown="calories"]').textContent()), `@${w}: the calorie ring opens a food list in kcal`);
  await page.click('[data-act="nut"][data-k="calories"]');
  await page.focus('[data-act="nut"][data-k="sodium"]'); await page.keyboard.press('Enter'); await page.waitForSelector('[data-breakdown="sodium"]');
  ok(true, `@${w}: works from the keyboard (Enter)`); await page.keyboard.press('Enter');
}
(async () => {
  const inv = (await A('POST', '/api/invites', { role: '303' })).json;
  ok((await fetch(B + '/api/invite/' + inv.url.split('/').pop(), { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.180', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW, displayName: 'R5' }) })).ok, 'temporary 303 user');
  ok((await api('PUT', '/api/nutrition/setup', { generate: false, profile: { units: 'imperial', age: 34, sex: 'male', heightCm: 178, weightKg: 90, activity: 'light' }, goals: [{ type: 'general_health' }], answers: { goalsText: '', experience: 'beginner', daysPerWeek: 3, minutes: 45, equipment: 'home', limits: '', routine: '', diet: '' } })).status === 202, 'setup saved (no plan call)');
  const mk = (name, servings, per, meal) => api('POST', '/api/nutrition/entries', { date: today, meal, name, servings, serving: '1 portion', per });
  await mk('Chicken breast', 2, { calories: 200, protein: 30, carbs: 0, fat: 5, sodium: 300 }, 'lunch'); await mk('Rice', 1, { calories: 200, protein: 4, carbs: 44, fat: 1, sodium: 10 }, 'lunch');
  await mk('Olive oil', 1, { calories: 120, protein: 0, carbs: 0, fat: 14, sodium: 0 }, 'dinner'); await mk('Yogurt', 1, { calories: 150, protein: 8, carbs: 10, fat: 2, sodium: 80 }, 'snack');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/cdn|net::|favicon|Failed to load resource|telemetry/.test(m.text())) errors.push('console: ' + m.text()); });
  await login(page); await page.goto(B + '/nutrition'); await page.waitForSelector('[data-act="tab"][data-tab="today"]');
  await checkBreakdown(page, 390);
  // a coach log turn: the totals line must match the page
  await page.click('[data-act="tab"][data-tab="coach"]'); await page.waitForSelector('#nut-input');
  await page.fill('#nut-input', 'I just ate two hard boiled eggs.'); await page.click('form[data-form="coach"] button');
  await page.waitForFunction(() => /Today now:/.test(document.body.textContent), null, { timeout: 150000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const chat = await page.textContent('#nut-chat');
  const day = (await api('GET', '/api/nutrition/day')).json;
  const m = /Today now:\s*(\d+) kcal eaten of (\d+).*?protein (\d+) of (\d+) g.*?carbs (\d+) of (\d+) g.*?fat (\d+) of (\d+) g/.exec(chat);
  ok(!!m, 'the reply ends with the page-rendered "Today now" line', chat.slice(-400));
  if (m) {
    ok(Number(m[1]) === Math.round(day.totals.calories) && Number(m[3]) === Math.round(day.totals.protein) && Number(m[5]) === Math.round(day.totals.carbs) && Number(m[7]) === Math.round(day.totals.fat), 'its numbers equal the page totals (server rounding)', `${m.slice(1).join('/')} vs ${JSON.stringify(day.totals)}`);
    await page.click('[data-act="tab"][data-tab="today"]'); await page.waitForTimeout(800);
    const todayTxt = await page.textContent('#nutrition-root');
    ok(todayTxt.includes(`${m[3]} / ${m[4]} g`) && todayTxt.includes(`${m[1]}`), 'the Today tab shows the same protein and calories', todayTxt.slice(0, 300));
  }
  console.log('CHAT:', chat.slice(-500).replace(/\s+/g, ' '));
  await page.click('[data-act="tab"][data-tab="coach"]'); await page.waitForTimeout(600); await page.locator('#nut-chat').evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await shot(page, 'coach-totals-390'); ok(await noH(page), 'coach with totals: no horizontal scroll');
  await page.click('[data-act="tab"][data-tab="profile"]'); await page.waitForTimeout(600);
  ok(/Nutrition 1\.0\.2/.test(await page.textContent('#nutrition-root')), 'version label 1.0.2');
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errors.push('desk: ' + e.message));
  await login(p2); await p2.goto(B + '/nutrition'); await p2.waitForSelector('[data-act="tab"][data-tab="today"]');
  await checkBreakdown(p2, 1280);
  await ctx2.close();
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  try { fs.rmSync(path.join(DATA, 'nutrition', user + '.json'), { force: true }); } catch (e) {}
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
