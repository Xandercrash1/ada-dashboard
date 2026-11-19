// Nutrition 1.0.1: logging from chat (cards, portion buttons, Undo, Edit) and the daily-burn breakdown. STAGING only.
// One real Sonnet call (a common item). Portion buttons and the breakdown use a fixture. Temporary zz-r4l-* 303 account.
// Usage: PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node scripts/nutrition-r4-log-e2e.js <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/ubuntu/ops/browser/node_modules/playwright');
const B = 'http://127.0.0.1:3001', OUT = process.argv[2];
const DATA = path.join(__dirname, '../data');
const PW = 'r4l-pass-' + Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c || x === undefined ? '' : String(x).slice(0, 400)); };
const A = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const user = 'zz-r4l-a', IP = '203.0.113.171';
fs.mkdirSync(OUT, { recursive: true });
let cookie = '';
async function api(m, p, b) { if (!cookie) { const r0 = await fetch(B + '/api/login', { method: 'POST', headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW }) }); cookie = (r0.headers.get('set-cookie') || '').split(';')[0]; } const r = await fetch(B + p, { method: m, headers: { 'X-Forwarded-For': IP, 'Content-Type': 'application/json', Cookie: cookie }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }
const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page, n) => page.screenshot({ path: `${OUT}/r4-${n}.png`, fullPage: true });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
async function login(page) {
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': IP });
  await page.goto(B + '/login'); await page.waitForSelector('#username');
  await page.fill('#username', user); await page.fill('#password', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#submit-btn')]);
  await page.waitForTimeout(2500);
}
(async () => {
  const inv = (await A('POST', '/api/invites', { role: '303' })).json;
  ok((await fetch(B + '/api/invite/' + inv.url.split('/').pop(), { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.170', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PW, displayName: 'R4L' }) })).ok, 'temporary 303 user');
  // set up without the AI plan call
  const su = await api('PUT', '/api/nutrition/setup', { generate: false, profile: { units: 'imperial', age: 34, sex: 'male', heightCm: 178, weightKg: 90, activity: 'light' }, goals: [{ type: 'general_health' }], answers: { goalsText: '', experience: 'beginner', daysPerWeek: 3, minutes: 45, equipment: 'home', limits: '', routine: '', diet: '' } });
  ok(su.status === 202, 'setup saved without a plan call');
  // fixture: a coach-logged estimate with its chat message and change entry
  const f = path.join(DATA, 'nutrition', user + '.json'); const js = JSON.parse(fs.readFileSync(f, 'utf8'));
  js.entries.push({ id: 'fx1', date: today, meal: 'dinner', name: 'Butter chicken', servings: 1, serving: '1 restaurant portion', per: { calories: 650, protein: 35, carbs: 18, fat: 48, fiber: 2, sugar: 6, sodium: 1100 }, source: 'estimate', at: new Date().toISOString(), loggedBy: 'coach', logBase: { servings: 1 } });
  js.changes.unshift({ id: 'chfx1', at: new Date().toISOString(), kind: 'log', who: 'ai', summary: 'Logged to Dinner: Butter chicken (650 kcal, estimate)', reason: '', old: null, new: null, undone: false, undo: { field: 'log:fx1', ref: { list: 'entries', id: 'fx1' } } });
  js.chat = [{ role: 'user', content: 'I had butter chicken from a local Indian place', at: new Date().toISOString() }, { role: 'coach', content: 'I logged a typical restaurant portion of butter chicken as a rough estimate, about 650 kcal. Did you have rice or naan with it?', at: new Date().toISOString(), changeIds: [], logged: [{ changeId: 'chfx1', kind: 'food', refId: 'fx1', date: today, meal: 'dinner', label: 'Butter chicken', estimate: true, source: 'estimate', summary: 'Logged to Dinner: Butter chicken (650 kcal, estimate)' }] }];
  fs.writeFileSync(f, JSON.stringify(js));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/cdn|net::|favicon|Failed to load resource|telemetry/.test(m.text())) errors.push('console: ' + m.text()); });
  await login(page);
  await page.goto(B + '/nutrition'); await page.waitForSelector('[data-act="tab"][data-tab="coach"]');
  // daily burn breakdown on Today
  await page.click('[data-act="tab"][data-tab="today"]'); await page.waitForTimeout(800);
  let t = await page.textContent('#nutrition-root');
  ok(/Daily burn \(maintenance\) about [\d,]+ kcal/.test(t), 'Today labels the number "Daily burn (maintenance)"');
  ok(!/resting/i.test(t), 'resting burn is not shown until the explanation is opened');
  await page.click('[data-act="help"][data-k="burn"]'); t = await page.textContent('#nutrition-root');
  ok(/Resting burn is what you would burn lying still all day/.test(t) && /Resting burn [\d,]+ × activity 1\.\d+ = daily burn [\d,]+ (− deficit|\+ surplus) [\d,]+ = target [\d,]+ kcal\./.test(t), 'the breakdown shows resting × activity = daily burn − deficit = target', t.match(/Resting burn[^]{0,200}/));
  await shot(page, 'burn-breakdown-390'); ok(await noH(page), 'breakdown: no horizontal scroll');
  // coach cards from the fixture
  await page.click('[data-act="tab"][data-tab="coach"]'); await page.waitForSelector('[data-log-card]');
  const card = page.locator('[data-log-card="chfx1"]');
  ok(/Butter chicken/.test(await card.textContent()) && /650 kcal/.test(await card.textContent()) && /estimate/.test(await card.textContent()), 'chat card shows the logged item with kcal and the estimate badge');
  const servings = async () => (await api('GET', '/api/nutrition/day')).json.entries.find((e) => e.id === 'fx1').servings;
  await card.locator('[data-act="log-portion"][data-f="1.33"]').click(); await page.waitForTimeout(900);
  ok(await servings() === 1.33 && /865|864/.test(await card.textContent()), 'Larger makes it ×1.33 (card kcal updates)', await card.textContent());
  ok(await card.locator('[data-act="log-portion"][data-f="1.33"]').getAttribute('aria-pressed') === 'true', 'Larger shows as selected');
  await card.locator('[data-act="log-portion"][data-f="0.75"]').click(); await page.waitForTimeout(900);
  ok(await servings() === 0.75, 'Smaller makes it ×0.75');
  await card.locator('[data-act="log-portion"][data-f="1"]').click(); await page.waitForTimeout(900);
  ok(await servings() === 1, 'Typical puts it back');
  await shot(page, 'coach-log-fixture-390'); ok(await noH(page), 'coach cards: no horizontal scroll');
  await card.locator('[data-act="log-edit"]').click(); await page.waitForSelector('#nf-name');
  ok(await page.inputValue('#nf-name') === 'Butter chicken', 'Edit opens the food sheet');
  await page.click('[data-act="sheet-close"]'); await page.waitForTimeout(300);
  await card.locator('[data-act="log-undo"]').click(); await page.waitForTimeout(1500);
  ok(/Removed from your log/.test(await page.textContent('[data-log-card="chfx1"]')) && !(await api('GET', '/api/nutrition/day')).json.entries.some((e) => e.id === 'fx1'), 'Undo removes it and the card says so');
  // real Sonnet call: a common item
  await page.fill('#nut-input', 'I just ate a banana and one slice of whole wheat toast.'); await page.click('form[data-form="coach"] button');
  await page.waitForFunction(() => document.querySelectorAll('[data-log-card]').length >= 2, null, { timeout: 150000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const cards = await page.locator('[data-log-card]').count();
  const day = (await api('GET', '/api/nutrition/day')).json;
  ok(cards >= 2 && day.entries.length >= 1, 'real Sonnet call logged the items and showed cards', `${cards} cards, ${day.entries.map((e) => e.name + ' ' + e.total.calories + ' ' + e.source).join('; ')}`);
  console.log('LOGGED:', day.entries.map((e) => `${e.meal}:${e.name} ${e.total.calories}kcal ${e.source}`).join(' | '));
  ok((await api('GET', '/api/nutrition/coach')).json.limit.left === 19, 'logging used only the one chat message (19 of 20 left)');
  await page.locator('[data-log-card]').last().scrollIntoViewIfNeeded();
  await shot(page, 'coach-log'); ok(await noH(page), 'coach after logging: no horizontal scroll');
  const newCard = page.locator('[data-log-card]:has([data-act="log-undo"])').first();
  if (await newCard.count()) { await newCard.locator('[data-act="log-undo"]').click(); await page.waitForTimeout(1500); ok((await api('GET', '/api/nutrition/day')).json.entries.length < day.entries.length, 'Undo on a real logged item removes it'); }
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errors.push('desk: ' + e.message));
  await login(p2); await p2.goto(B + '/nutrition'); await p2.waitForSelector('[data-act="tab"][data-tab="coach"]'); await p2.click('[data-act="tab"][data-tab="coach"]'); await p2.waitForTimeout(1200);
  await shot(p2, 'coach-log-1280'); ok(await noH(p2), 'desktop coach: no horizontal scroll');
  await ctx2.close();
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  try { fs.rmSync(f, { force: true }); } catch (e) {}
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
