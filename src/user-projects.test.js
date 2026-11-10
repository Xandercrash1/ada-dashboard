const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanFields, parseSite, replaceText, SITE_CSP } = require('./user-projects');

test('cleanFields strips scripts and bad links from what an account sends', () => {
  const out = cleanFields({
    html: '<h2 onclick="x()">Hi</h2><script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src=x onerror=y>',
    links: [{ label: 'ok', url: 'https://example.com' }, { label: 'bad', url: 'javascript:alert(1)' }],
    owner: 'someone-else',
  });
  assert.strictEqual(out.html.includes('script'), false);
  assert.strictEqual(out.html.includes('onclick'), false);
  assert.strictEqual(out.html.includes('img'), false);
  assert.deepStrictEqual(out.links, [{ label: 'ok', url: 'https://example.com' }]);
  assert.strictEqual('owner' in out, false);
});

test('parseSite accepts a whole document and rejects anything else', () => {
  const wrap = (result) => JSON.stringify({ result });
  assert.ok(parseSite(wrap('```html\n<!doctype html><html><body>Hi</body></html>\n```')).startsWith('<!doctype'));
  assert.throws(() => parseSite(wrap('Sure, here you go')));
  assert.throws(() => parseSite(wrap('<!doctype html><html><body>cut off')));
});

test('sites are always served sandboxed, with no network and no same-origin', () => {
  assert.ok(SITE_CSP.startsWith('sandbox allow-scripts'));
  assert.ok(!SITE_CSP.includes('allow-same-origin'));
  assert.ok(SITE_CSP.includes("default-src 'none'"));
});

test('replaceText edits source wording and refuses when it cannot tell which', () => {
  assert.strictEqual(replaceText('<h1>Road Trip</h1>', 'Road Trip', 'Big Trip', 0), '<h1>Big Trip</h1>');
  assert.strictEqual(replaceText('<p>Tom &amp; Jo\n  go</p>', 'Tom & Jo go', 'A <b>', 0), '<p>A &lt;b&gt;</p>');
  assert.strictEqual(replaceText('<p>Dana</p><p>Dana</p>', 'Dana', 'Lee', 1), '<p>Dana</p><p>Lee</p>');
  assert.strictEqual(replaceText('<p>Dana</p>', 'Nobody', 'Lee', 0), null);
  assert.strictEqual(replaceText('<script>var a="Hi";</script>', 'Hi', 'It\'s', 0), '<script>var a="It\\\'s";</script>');
});

test('a page tied to a vault project gets its notes, and only an admin can tie one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  const prompts = [];
  const site = JSON.stringify({ result: '<!doctype html><html><body>Hi</body></html>' });
  const { create } = require('./user-projects');
  const mod = create({ dataDir: dir, run: async (x) => { prompts.push(x); return site; }, projectContext: (s) => (s === 'n8n' ? { slug: 'n8n', name: 'N8N', notes: 'Runs at https://n8n.example' } : null) });
  const routes = {};
  const app = {}; ['get', 'post', 'patch', 'delete'].forEach((m) => { app[m] = (u, f) => { routes[`${m} ${u}`] = f; }; });
  let admin = true;
  mod.mount(app, { ownerName: () => 'alex', isAdminReq: () => admin });
  const call = async (key, params, body) => {
    let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return out; } };
    await routes[key]({ params, body }, res);
    return out;
  };
  admin = false;
  assert.strictEqual((await call('post /api/user-projects', {}, { name: 'P', kind: 'splash', project: 'n8n' })).code, 400);
  admin = true;
  assert.strictEqual((await call('post /api/user-projects', {}, { name: 'P', kind: 'splash', project: 'nope' })).code, 400);
  const made = (await call('post /api/user-projects', {}, { name: 'P', kind: 'splash', project: 'n8n' })).body;
  assert.strictEqual(made.project, 'n8n');
  await call('post /api/user-projects/:id/draft', { id: made.id }, { about: 'put a link to n8n' });
  assert.ok(prompts[0].includes('https://n8n.example'));
  const patched = (await call('patch /api/user-projects/:id', { id: made.id }, { project: 'other' })).body;
  assert.strictEqual(patched.project, 'n8n');
  const plain = (await call('post /api/user-projects', {}, { name: 'Q', kind: 'splash' })).body;
  await new Promise((r) => setTimeout(r, 20));
  await call('post /api/user-projects/:id/draft', { id: plain.id }, { about: 'a page' });
  assert.ok(!prompts[1].includes('project-notes'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('project notes leave out lines that could hold a credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(dir, 'Projects/Demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Projects/REGISTRY.md'), '| Project | Home |\n|---|---|\n| Demo (`Projects/Demo/`) | repo |\n');
  fs.writeFileSync(path.join(dir, 'Projects/Demo/memory.md'), 'Runs at https://demo.example\nadmin password: hunter2\nAPI key is abc at https://keys.example/path?k=abc\n');
  const c = require('./projects').create({ vault: dir }).context('demo');
  assert.ok(c && c.notes.includes('https://demo.example'));
  assert.ok(!c.notes.includes('hunter2') && !c.notes.includes('k=abc') && !c.notes.includes('/path'));
  assert.ok(c.notes.includes('https://keys.example'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('older versions can be listed and restored as a draft, and a bad name is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  const mod = require('./user-projects').create({ dataDir: dir, run: async () => '' });
  const routes = {};
  const app = {}; ['get', 'post', 'patch', 'delete'].forEach((m) => { app[m] = (u, f) => { routes[`${m} ${u}`] = f; }; });
  let who = 'alex';
  const user = () => ({ username: who, role: who === 'alex' ? 'admin' : '303' });
  mod.mount(app, { ownerName: () => who, isAdminReq: (req) => req.user.role === 'admin' });
  const call = async (key, params, body) => {
    let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return out; } };
    await routes[key]({ params, body, query: {}, user: user() }, res);
    return out;
  };
  const page = (n) => `<!doctype html><html><body>${n}</body></html>`;
  const p = (await call('post /api/user-projects', {}, { name: 'P', kind: 'splash' })).body;
  for (const n of ['one', 'two']) {
    await call('post /api/user-projects/:id/html', { id: p.id }, { html: page(n) });
    await call('post /api/user-projects/:id/save', { id: p.id }, {});
    await new Promise((r) => setTimeout(r, 5));
  }
  const list = (await call('get /api/user-projects/:id/versions', { id: p.id })).body;
  assert.strictEqual(list.length, 2);
  assert.ok(list[0].name > list[1].name);
  const restored = (await call('post /api/user-projects/:id/versions/:name/restore', { id: p.id, name: list[1].name })).body;
  assert.strictEqual(restored.drafts, 1);
  const draftDir = path.join(dir, 'user-project-sites', p.id, 'drafts');
  assert.ok(fs.readFileSync(path.join(draftDir, fs.readdirSync(draftDir)[0]), 'utf8').includes('one'));
  assert.strictEqual((await call('post /api/user-projects/:id/versions/:name/restore', { id: p.id, name: '../../user-projects.json' })).code, 404);
  who = 'someone-else';
  assert.strictEqual((await call('get /api/user-projects/:id/versions', { id: p.id })).code, 404);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-admins get 3 site builds a day, a failed build is handed back, admins have no limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  let fail = false;
  const mod = require('./user-projects').create({ dataDir: dir, run: async () => { if (fail) throw new Error('boom'); return JSON.stringify({ result: '<!doctype html><html><body>ok</body></html>' }); } });
  const routes = {};
  const app = {}; ['get', 'post', 'patch', 'delete'].forEach((m) => { app[m] = (u, f) => { routes[`${m} ${u}`] = f; }; });
  let user = { username: 'ann', role: '303' };
  mod.mount(app, { ownerName: () => user.username, isAdminReq: (req) => req.user.role === 'admin' });
  const call = async (key, params, body) => {
    let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return out; } };
    await routes[key]({ params, body, query: {}, user }, res);
    return out;
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const p = (await call('post /api/user-projects', {}, { name: 'P', kind: 'splash' })).body;
  const build = () => call('post /api/user-projects/:id/draft', { id: p.id }, { about: 'a bakery' });
  fail = true;
  assert.strictEqual((await build()).code, 202); await settle();   // fails, so it doesn't count
  fail = false;
  for (let i = 0; i < 3; i++) { assert.strictEqual((await build()).code, 202); await settle(); }
  const no = await build();
  assert.strictEqual(no.code, 429);
  assert.ok(/3 site builds/.test(no.body.error));
  user = { username: 'alex', role: 'admin' };
  const q = (await call('post /api/user-projects', {}, { name: 'Q', kind: 'splash' })).body;
  for (let i = 0; i < 5; i++) { assert.strictEqual((await call('post /api/user-projects/:id/draft', { id: q.id }, { about: 'x' })).code, 202); await settle(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ai-limits: Eastern days, saved to disk, admins unlimited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
  let now = new Date('2026-11-11T04:30:00Z');   // 11:30pm Eastern on the 10th
  const L = require('./ai-limits');
  const mk = () => L.create({ dataDir: dir, limits: { designer: 2, site: 1 }, clock: () => now });
  const ann = { username: 'ann', role: '303' };
  let a = mk();
  assert.ok(a.take(ann, 'designer')); assert.ok(a.take(ann, 'designer')); assert.ok(!a.take(ann, 'designer'));
  a = mk();   // a restart keeps the count
  assert.ok(!a.take(ann, 'designer'));
  assert.deepStrictEqual(a.left(ann).designer, { used: 2, limit: 2, left: 0 });
  assert.ok(a.take({ username: 'alex', role: 'admin' }, 'designer'));
  assert.deepStrictEqual(a.left({ username: 'alex', role: 'admin' }), { unlimited: true });
  now = new Date('2026-11-11T05:01:00Z');   // past midnight Eastern
  assert.ok(a.take(ann, 'designer'));
  a.refund(ann, 'designer');
  assert.strictEqual(a.left(ann).designer.used, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
