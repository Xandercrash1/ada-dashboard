'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { create, scrub, routeShape } = require('./error-report');

test('scrub masks emails, ids, numbers and long quoted text', () => {
  const s = scrub('Cannot save "a very long recipe name that someone typed in" for bob@example.com, task-1795583325113-06mp, 1234567');
  assert.ok(!s.includes('bob@example.com'));
  assert.ok(!s.includes('a very long recipe'));
  assert.ok(!s.includes('1795583325113'));
  assert.ok(s.includes('(email)') && s.includes('task-(id)'));
});

test('routeShape keeps the area and masks the rest when there is no route pattern', () => {
  assert.strictEqual(routeShape({ path: '/api/todo/tasks/task-1795583325113-06mp/complete' }), '/api/todo/tasks/:id');
  assert.strictEqual(routeShape({ baseUrl: '/api/kitchen', route: { path: '/items/:id' }, path: '/items/x1' }), '/api/kitchen/items/:id');
});

function serve(app) {
  return new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
}

test('a 500 answer and a browser error are both recorded, with no names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errrep-'));
  const er = create({ dataDir: dir });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { username: 'someone', role: 'admin' }; next(); });
  app.use(er.capture);
  app.get('/api/boom/:id', (req, res) => res.status(500).json({ error: 'Kaboom while reading 99999' }));
  app.get('/api/fine', (req, res) => res.json({ ok: true }));
  er.mount(app);
  const s = await serve(app); const base = `http://127.0.0.1:${s.address().port}`;
  try {
    await fetch(base + '/api/boom/abc123');
    await fetch(base + '/api/fine');
    const r = await fetch(base + '/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x is undefined', source: base + '/app.js', line: 12, page: '/kitchen?x=1' }) });
    assert.strictEqual(r.status, 204);
    await new Promise((res) => setTimeout(res, 50));
    const lines = fs.readFileSync(er.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 2);
    const server = lines.find((l) => l.kind === 'server');
    assert.deepStrictEqual([server.method, server.route, server.status, server.role], ['GET', '/api/boom/:id', 500, 'admin']);
    assert.ok(server.message.includes('Kaboom') && !server.message.includes('99999'));
    const client = lines.find((l) => l.kind === 'client');
    assert.deepStrictEqual([client.source, client.line, client.page], ['/app.js', 12, '/kitchen']);
    assert.ok(!JSON.stringify(lines).includes('someone'));
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('browser reports are limited to 30 a minute', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errrep-'));
  const er = create({ dataDir: dir });
  const app = express(); app.use(express.json()); er.mount(app);
  const s = await serve(app); const base = `http://127.0.0.1:${s.address().port}`;
  try {
    let last;
    for (let i = 0; i < 31; i++) last = await fetch(base + '/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'e' + i }) });
    assert.strictEqual(last.status, 429);
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
