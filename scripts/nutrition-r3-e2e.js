// Round 3 browser check on STAGING: Nutrition as a registered page (Home tile, Lifestyle project hub, direct link, no nav button).
// Run scripts/register-nutrition-page.js against staging data first. Creates temporary zz-r3-* accounts.
// Usage: PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node scripts/nutrition-r3-e2e.js <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/ubuntu/ops/browser/node_modules/playwright');
const B = 'http://127.0.0.1:3001', OUT = process.argv[2];
const DATA = path.join(__dirname, '../data');
const PW = 'r3-pass-' + Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c || x === undefined ? '' : String(x).slice(0, 300)); };
const A = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
fs.mkdirSync(OUT, { recursive: true });
const U = { a: ['zz-r3-a', '303', '203.0.113.151'], g: ['zz-r3-g', 'guest', '203.0.113.152'] };
async function mk(name, role) { const inv = (await A('POST', '/api/invites', { role })).json; const r = await fetch(B + '/api/invite/' + inv.url.split('/').pop(), { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.150', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PW, displayName: name }) }); return r.ok; }
async function apiAs(name, ip, p) { const r0 = await fetch(B + '/api/login', { method: 'POST', headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PW }) }); const cookie = (r0.headers.get('set-cookie') || '').split(';')[0]; const r = await fetch(B + p, { headers: { 'X-Forwarded-For': ip, Cookie: cookie } }); return { status: r.status, json: await r.json().catch(() => null) }; }
async function login(page, name, ip, from) {
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
  if (from) await page.goto(B + from); else await page.goto(B + '/login');
  await page.waitForSelector('#username');
  await page.fill('#username', name); await page.fill('#password', PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#submit-btn')]);
  await page.waitForTimeout(3000);
}
const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const tile = (page) => page.locator('.h-tile', { hasText: 'Nutrition' });
const shot = (page, n) => page.screenshot({ path: `${OUT}/r3-${n}.png`, fullPage: true });
(async () => {
  ok(await mk(...U.a.slice(0, 2)) , '303 test user'); ok(await mk(...U.g.slice(0, 2)), 'guest test user');
  const pa = (await apiAs(U.a[0], U.a[2], '/api/pages')).json.pages.find((p) => p.id === 'nutrition');
  ok(pa && pa.kind === 'builtin' && pa.project === 'lifestyle', '303 sees the registry entry via /api/pages', JSON.stringify(pa));
  ok(!(await apiAs(U.g[0], U.g[2], '/api/pages')).json.pages.some((p) => p.id === 'nutrition'), 'guest does not see it in /api/pages');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const ctxPage = async (w) => { const c = await browser.newContext({ viewport: { width: w, height: 844 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return [c, p]; };
  for (const w of [390, 1280]) {
    for (const who of ['admin', 'user']) {
      const [c, p] = await ctxPage(w);
      if (who === 'user') await login(p, U.a[0], U.a[2]); else { await p.goto(B + '/'); await p.waitForTimeout(3000); }
      await p.waitForSelector('.h-tile');
      ok(await tile(p).count() === 1, `${who}@${w}: Nutrition tile under Your pages`);
      ok((await p.locator('#tab-btn-nutrition, #mob-btn-nutrition').count()) === 0, `${who}@${w}: no Nutrition button in the nav`);
      await shot(p, `home-${who}-${w}`);
      await tile(p).first().click(); await p.waitForTimeout(1500);
      ok(await p.locator('#nutrition-root').isVisible(), `${who}@${w}: tile opens Nutrition`);
      ok(new URL(p.url()).pathname === '/nutrition', `${who}@${w}: address bar shows /nutrition`, p.url());
      if (w === 390) await shot(p, `opened-${who}-${w}`);
      ok(await noH(p), `${who}@${w}: no horizontal scroll`);
      await p.evaluate(() => switchTab('home')); await p.waitForTimeout(500);
      ok(new URL(p.url()).pathname === '/', `${who}@${w}: leaving Nutrition restores the address`);
      await c.close();
    }
  }
  // guest
  { const [c, p] = await ctxPage(390); await login(p, U.g[0], U.g[2]); await p.waitForTimeout(1000);
    ok(await tile(p).count() === 0, 'guest: no Nutrition tile'); await shot(p, 'home-guest-390');
    await p.goto(B + '/nutrition'); await p.waitForTimeout(2500);
    ok(new URL(p.url()).pathname === '/' && !(await p.locator('#nutrition-root').isVisible()), 'guest: /nutrition sends them Home', p.url());
    await c.close(); }
  // direct link while signed out: login, then back to /nutrition
  { const [c, p] = await ctxPage(390);
    await p.context().setExtraHTTPHeaders({ 'X-Forwarded-For': U.a[2] });
    await p.goto(B + '/nutrition'); await p.waitForSelector('#username');
    ok(new URL(p.url()).pathname === '/login' && new URL(p.url()).searchParams.get('redirect') === '/nutrition', 'signed out: /nutrition goes to login with a way back', p.url());
    await p.fill('#username', U.a[0]); await p.fill('#password', PW);
    await Promise.all([p.waitForURL((u) => u.pathname === '/nutrition', { timeout: 15000 }), p.click('#submit-btn')]);
    await p.waitForTimeout(3500);
    ok(await p.locator('#nutrition-root').isVisible(), 'after login the link lands on the Nutrition view');
    await shot(p, 'direct-link-390');
    await p.goto(B + '/nutrition'); await p.waitForTimeout(3000);
    ok(await p.locator('#nutrition-root').isVisible(), 'signed in: pasting /nutrition opens Nutrition (also after reload)');
    await p.goto(B + '/#nutrition'); await p.waitForTimeout(3000);
    ok(await p.locator('#nutrition-root').isVisible(), '/#nutrition opens it too');
    await c.close(); }
  // Projects tab (admin): Lifestyle hub lists Nutrition
  { const [c, p] = await ctxPage(1280); await p.goto(B + '/#projects/lifestyle'); await p.waitForTimeout(4000);
    const link = p.locator('[data-open-page="nutrition"]');
    ok(await link.count() === 1, 'Projects tab: Lifestyle hub lists Nutrition');
    await shot(p, 'projects-lifestyle-1280');
    if (await link.count()) { await link.click(); await p.waitForTimeout(1500); ok(await p.locator('#nutrition-root').isVisible(), 'the hub link opens Nutrition'); }
    await c.close(); }
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
