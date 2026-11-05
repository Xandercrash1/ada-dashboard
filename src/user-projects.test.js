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
