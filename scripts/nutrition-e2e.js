// Browser + API check of the Nutrition tab on STAGING (VPS headless Chromium). Creates temporary
// zz-nut-* accounts and removes their nutrition files at the end (restore users.json yourself; see the end of the script).
// Usage: PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node scripts/nutrition-e2e.js <screenshot dir> [--coach]
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/ubuntu/ops/browser/node_modules/playwright');
const B = 'http://127.0.0.1:3001', OUT = process.argv[2];
const REAL_COACH = process.argv.includes('--coach');
const DATA = path.join(__dirname, '../data');
const PW = 'nut-pass-' + Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c || x === undefined ? '' : String(x).slice(0, 300)); };
const A = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const ymd = (d) => d.toISOString().slice(0, 10);
const users = ['zz-nut-a', 'zz-nut-b'];
fs.mkdirSync(OUT, { recursive: true });

async function mkUser(name, role) {
  const inv = (await A('POST', '/api/invites', { role })).json;
  const r = await fetch(B + '/api/invite/' + inv.url.split('/').pop(), { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.130', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PW, displayName: name }) });
  return r.ok;
}
async function client(name, ip) {
  let cookie = '';
  const r0 = await fetch(B + '/api/login', { method: 'POST', headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PW }) });
  cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  return async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json', Cookie: cookie }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
}
async function login(page, name, ip) {
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
  await page.goto(B + '/login'); await page.waitForSelector('#username');
  await page.fill('#username', name); await page.fill('#password', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#submit-btn')]);
  await page.waitForTimeout(3000);
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  ok(await mkUser(users[0], '303'), '303 test user a created'); ok(await mkUser(users[1], '303'), '303 test user b created');
  const guest = 'zz-nut-g'; ok(await mkUser(guest, 'guest'), 'guest test user created');
  const a = await client(users[0], '203.0.113.131'), b = await client(users[1], '203.0.113.132'), g = await client(guest, '203.0.113.133');
  ok((await g('GET', '/api/nutrition/day')).status === 403, 'guest: 403 on the API');
  // seed user a: profile + 20 days
  await a('PUT', '/api/nutrition/profile', { units: 'imperial', age: 34, sex: 'female', heightCm: 168, weightKg: 70, activity: 'light', goal: 'lose', rateKgPerWeek: 0.45 });
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const d = ymd(new Date(now.getTime() - i * 864e5)); if (i % 6 === 5) continue;
    await a('POST', '/api/nutrition/entries', { date: d, meal: 'breakfast', name: 'Oatmeal with berries', servings: 1, serving: '1 bowl', per: { calories: 320, protein: 12, carbs: 54, fat: 6, fiber: 8, sugar: 12, sodium: 120 } });
    await a('POST', '/api/nutrition/entries', { date: d, meal: 'lunch', name: 'Chicken salad', servings: 1, serving: '1 plate', per: { calories: 450 + (i % 5) * 60, protein: 38, carbs: 22, fat: 20, fiber: 6, sugar: 8, sodium: 780 } });
    await a('POST', '/api/nutrition/entries', { date: d, meal: 'dinner', name: 'Salmon, rice and greens', servings: 1, serving: '1 plate', per: { calories: 620, protein: 40, carbs: 60, fat: 22, fiber: 7, sugar: 5, sodium: 650 } });
    if (i % 3 === 0) await a('POST', '/api/nutrition/entries', { date: d, meal: 'snack', name: 'Greek yogurt', servings: 1.5, serving: '1 cup', per: { calories: 130, protein: 17, carbs: 9, fat: 2, fiber: 0, sugar: 8, sodium: 70 } });
    if (i % 4 === 0) await a('POST', '/api/nutrition/weights', { date: d, kg: 70 - (20 - i) * -0.05 });
  }
  ok((await b('GET', '/api/nutrition/day')).json.entries.length === 0, 'user b sees none of a\'s entries');
  ok((await b('GET', '/api/nutrition/history')).json.days.every((d) => !d.logged), 'user b history empty');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const tabShot = async (page, w, who, name) => { await page.screenshot({ path: `${OUT}/${who}-${w}-${name}.png`, fullPage: true }); };

  for (const [who, w] of [['user', 390], ['user', 1280], ['admin', 390], ['admin', 1280]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(who + w + ': ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/cdn|net::|favicon|Failed to load resource|telemetry/.test(m.text())) errors.push(who + w + ' console: ' + m.text()); });
    if (who === 'user') await login(page, users[0], '203.0.113.131'); else { await page.goto(B + '/'); await page.waitForTimeout(3000); }
    await page.evaluate(() => switchTab('nutrition')); await page.waitForTimeout(1800);
    if (await page.locator('[data-act="wz-skip"]').count()) await page.click('[data-act="wz-skip"]');   // first-time setup is covered by nutrition-r2-e2e.js
    await page.waitForTimeout(500);
    const visBtn = await page.locator(w < 768 ? '#mob-btn-nutrition' : '#tab-btn-nutrition').isVisible();
    ok(visBtn, `${who}@${w}: Nutrition tab button visible`);
    ok(await page.locator('#nutrition-root').isVisible(), `${who}@${w}: view shown`);
    if (who === 'user') {
      const body = await page.textContent('#nutrition-root');
      ok(/Chicken salad/.test(body) && /left|over/.test(body), 'user: today shows foods and calories left');
    }
    await tabShot(page, w, who, 'today');
    ok(await noHScroll(page), `${who}@${w}: no horizontal scroll (today)`);
    // add food through the sheet, with USDA search (admin only to keep seed data for a)
    if (who === 'admin') {
      await page.click('[data-act="add"][data-meal="breakfast"]'); await page.waitForSelector('#nf-q');
      await page.fill('#nf-q', 'banana'); await page.click('[data-act="search"]');
      await page.waitForSelector('[data-act="pick"]', { timeout: 30000 }).catch(() => {});
      const got = await page.locator('[data-act="pick"]').count();
      ok(got > 0, 'admin: USDA search returned results', got);
      if (got) { await page.locator('[data-act="pick"]').first().click(); await page.waitForTimeout(300); ok(Number(await page.inputValue('#nf-calories')) > 0, 'admin: picking a result fills calories'); }
      else { await page.fill('#nf-name', 'Banana (manual)'); await page.fill('#nf-calories', '105'); await page.fill('#nf-protein', '1.3'); }
      await tabShot(page, w, who, 'sheet');
      ok(await noHScroll(page), `admin@${w}: no horizontal scroll (sheet)`);
      await page.click('[data-act="save-entry"]'); await page.waitForTimeout(1000);
      ok(/anana/.test(await page.textContent('#nutrition-root')), 'admin: food added to the log');
      // edit then delete
      await page.locator('[data-act="edit"]').first().click(); await page.fill('#nf-servings', '2'); await page.click('[data-act="save-entry"]'); await page.waitForTimeout(800);
      await page.locator('[data-act="edit"]').first().click(); page.once('dialog', (d) => d.accept()); await page.click('[data-act="del-entry"]'); await page.waitForTimeout(800);
      ok(!/anana/.test(await page.textContent('#nutrition-root')), 'admin: food edited and deleted');
    }
    for (const t of ['history', 'coach', 'profile']) {
      await page.click(`[data-act="tab"][data-tab="${t}"]`); await page.waitForTimeout(1200);
      await tabShot(page, w, who, t);
      ok(await noHScroll(page), `${who}@${w}: no horizontal scroll (${t})`);
    }
    if (who === 'user' && w === 390) {
      // profile: edit pace and save, targets recalculated
      await page.fill('#po-calories', '1700'); await page.click('form[data-form="profile"] button.w-full'); await page.waitForTimeout(1000);
      ok(/Saved/.test(await page.textContent('#nutrition-root')), 'user: profile saved');
      const p = (await a('GET', '/api/nutrition/profile')).json;
      ok(p.targets.calories === 1700 && p.profile.units === 'imperial', 'user: override stored, imperial kept', p.targets);
      await page.click('[data-act="tab"][data-tab="history"]'); await page.waitForTimeout(800);
      await page.fill('#w-val', '153'); await page.click('form[data-form="weight"] button'); await page.waitForTimeout(1000);
      ok((await a('GET', '/api/nutrition/weights')).json.some((x) => Math.abs(x.kg - 69.4) < 0.2), 'user: weigh-in logged in lb and stored as kg');
      await tabShot(page, w, who, 'history-weight');
    }
    if (who === 'user' && REAL_COACH && w === 390) {
      await page.click('[data-act="tab"][data-tab="coach"]'); await page.waitForTimeout(800);
      await page.fill('#nut-input', 'In two or three sentences: what is one simple way I can hit my protein target?');
      await page.click('form[data-form="coach"] button');
      await page.waitForSelector('#nut-chat .prose', { timeout: 150000 }).catch(() => {});
      const txt = await page.textContent('#nut-chat');
      ok(/protein/i.test(txt) && (await page.locator('#nut-chat .prose').count()) > 0, 'coach: real Sonnet reply shown', txt.slice(-200));
      ok(/19 of 20/.test(await page.textContent('#nut-limit')), 'coach: remaining count shown (19 of 20)', await page.textContent('#nut-limit'));
      await page.once('dialog', (d) => d.accept('Protein tip')); await page.click('[data-act="saveplan"][data-type="diet"]'); await page.waitForTimeout(1200);
      ok(/Protein tip/.test(await page.textContent('#nutrition-root')), 'coach: reply saved as a plan');
      await tabShot(page, w, who, 'coach-chat');
      await page.click('[data-act="toggle-plan"]'); await page.waitForTimeout(400); await tabShot(page, w, who, 'coach-plan');
      page.once('dialog', (d) => d.accept()); await page.click('[data-act="del-plan"]'); await page.waitForTimeout(800);
      ok((await a('GET', '/api/nutrition/plans')).json.length === 0, 'coach: plan deleted');
    }
    await ctx.close();
  }
  // guest: no tab
  { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage(); await login(page, guest, '203.0.113.133');
    ok(!(await page.locator('#mob-btn-nutrition').isVisible()) && !(await page.locator('#tab-btn-nutrition').isVisible()), 'guest: no Nutrition tab');
    await page.evaluate(() => switchTab('nutrition')); await page.waitForTimeout(800);
    ok(!(await page.locator('#nutrition-root').isVisible()), 'guest: switchTab(nutrition) lands on Home');
    await page.screenshot({ path: `${OUT}/guest-390-home.png` }); await ctx.close(); }
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();

  // clean up
  for (const u of [...users, guest]) { try { fs.rmSync(path.join(DATA, 'nutrition', u + '.json'), { force: true }); } catch (e) {} }
  console.log('Nutrition files removed. The zz-nut-* accounts have no delete endpoint: restore staging data/users.json from a copy taken before the run, then pm2 restart ada-dashboard-staging (the user store caches it).');
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
