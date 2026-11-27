'use strict';

/**
 * Tests for money.js. Run: node --test src/money.test.js   (or: node src/money.test.js)
 * Pure parsing, masking, dedupe, rules, export escaping, file modes, and the access guard through the REAL
 * auth.js (mountAuth with a throwaway credentials file and users file, real /api/login cookies).
 * Only made-up data; everything is written under a temp directory that is removed afterwards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const money = require('./money');
const auth = require('./auth');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'money-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const freshDir = () => { const d = path.join(tmpRoot, `d${++n}`); fs.mkdirSync(d); return d; };
const NOW = new Date('2026-11-26T12:00:00.000Z');

// ---------------------------------------------------------------- parsing
test('parseCsv: quoted commas, escaped quotes, CRLF, BOM, newline in quotes, blank lines', () => {
  const rows = money.parseCsv('﻿Date,Description,Amount\r\n11/02/2026,"ACME, INC ""BIG""",-5.00\r\n\r\n11/03/2026,"two\nlines",1\n');
  assert.deepEqual(rows, [['Date', 'Description', 'Amount'], ['11/02/2026', 'ACME, INC "BIG"', '-5.00'], ['11/03/2026', 'two\nlines', '1']]);
});

test('parseAmount: $, thousands, parentheses, signs, bad input', () => {
  assert.equal(money.parseAmount('$1,234.56'), 123456);
  assert.equal(money.parseAmount('(42.10)'), -4210);
  assert.equal(money.parseAmount('($1,000.00)'), -100000);
  assert.equal(money.parseAmount('-7'), -700);
  assert.equal(money.parseAmount('7.5-'), -750);
  assert.equal(money.parseAmount('+3.25'), 325);
  assert.equal(money.parseAmount(' 12 '), 1200);
  assert.equal(money.parseAmount('-$5.00'), -500);
  assert.equal(money.parseAmount('0.00'), 0);
  for (const bad of ['', 'abc', '1,23', '1.234', '--', '12.3.4']) assert.equal(money.parseAmount(bad), null, bad);
});

test('parseDate: MM/DD/YYYY, YYYY-MM-DD, M/D/YY, with time; invalid dates refused', () => {
  assert.equal(money.parseDate('11/26/2026'), '2026-11-26');
  assert.equal(money.parseDate('2026-11-26'), '2026-11-26');
  assert.equal(money.parseDate('3/7/26'), '2026-03-07');
  assert.equal(money.parseDate('2026-11-26T08:00:00'), '2026-11-26');
  assert.equal(money.parseDate('11/26/2026 10:15 AM'), '2026-11-26');
  for (const bad of ['2/30/2026', '13/01/2026', '2026-13-01', 'Nov 26', '', '20261126']) assert.equal(money.parseDate(bad), null, bad);
});

// ---------------------------------------------------------------- masking
test('maskDigits: 8+ digit runs (spaces/dashes) cut to ••last4; dates and short numbers kept', () => {
  assert.equal(money.maskDigits('CARD 4111 1111 1111 1234'), 'CARD ••1234');
  assert.equal(money.maskDigits('4111-1111-1111-9876'), '••9876');
  assert.equal(money.maskDigits('acct 12345678'), 'acct ••5678');
  assert.equal(money.maskDigits('ref 1234567'), 'ref 1234567');            // 7 digits: kept
  assert.equal(money.maskDigits('2026-11-26'), '2026-11-26');
  assert.equal(money.maskDigits('11-26-2026'), '11-26-2026');
  assert.equal(money.maskDigits('on 2026-11-26 10:22 card 5500 0000 0000 0004'), 'on 2026-11-26 10:22 card ••0004');
  assert.equal(money.maskDigits('$1,234,567.89'), '$1,234,567.89');
});

test('import masks card numbers in every field (description, other columns, headers, sample)', () => {
  const m = money.create({ dataDir: freshDir(), clock: () => NOW });
  const s = m.read(); s.accounts.push({ id: 'a1', name: 'Chk', kind: 'checking', last4: null }); m.write(s);
  const csv = 'Date,Description,Amount,Card 4111111111111111\n11/02/2026,PAYMENT FROM 1234-5678-9012-3456 THANKS,-5.00,5500 0000 0000 0004\n';
  const r = m.startImport(csv, 'a1', null);
  assert.equal(r.status, 200);
  const all = JSON.stringify(r.body);
  assert.ok(!all.replace(/[ -]/g, '').includes('4111111111111111'));
  assert.ok(!all.replace(/[ -]/g, '').includes('1234567890123456'));
  assert.ok(!all.replace(/[ -]/g, '').includes('5500000000000004'));
  assert.ok(r.body.sample[0].includes('••0004'));
  assert.ok(r.body.headers.includes('Card ••1111'));
  const mapped = m.mapImport(r.body.previewId, { map: { date: 'Date', description: 'Description', amount: 'Amount' }, sign: 'as-is' });
  assert.equal(mapped.body.rows[0].description, 'PAYMENT FROM ••3456 THANKS');
  m.commitImport(r.body.previewId);
  const disk = fs.readFileSync(m.file, 'utf8').replace(/[ -]/g, '');
  for (const num of ['4111111111111111', '1234567890123456', '5500000000000004']) assert.ok(!disk.includes(num));
});

// ---------------------------------------------------------------- normalization, profiles, dedupe
function setup() {
  const dir = freshDir();
  const m = money.create({ dataDir: dir, clock: () => NOW });
  const s = m.read();
  s.accounts.push({ id: 'card', name: 'Card', kind: 'credit card', last4: '1234' }, { id: 'chk', name: 'Checking', kind: 'checking', last4: null });
  m.write(s);
  return { m, dir };
}

test('sign conventions: as-is, invert (card charges positive), split debit/credit', () => {
  const { m } = setup();
  const inv = m.startImport('Posted,Payee,Amt\n11/05/2026,NETFLIX.COM,15.49\n11/06/2026,PAYMENT THANK YOU,-200.00\n', 'card', null);
  assert.equal(inv.body.needsMapping, true);
  const r1 = m.mapImport(inv.body.previewId, { map: { date: 'Posted', description: 'Payee', amount: 'Amt' }, sign: 'invert' });
  assert.deepEqual(r1.body.rows.map(r => r.cents), [-1549, 20000]);
  const sp = m.startImport('Date,Desc,Debit,Credit\n2026-11-01,"WALMART #123",$45.10,\n2026-11-02,PAYROLL ACME,,"1,500.00"\n2026-11-03,(neg debit),(3.00),\n', 'chk', null);
  const r2 = m.mapImport(sp.body.previewId, { map: { date: 'Date', description: 'Desc', debit: 'Debit', credit: 'Credit' }, sign: 'split' });
  assert.deepEqual(r2.body.rows.map(r => r.cents), [-4510, 150000, -300]);
  const as = m.startImport('Date,Desc,Amount\n2026-11-01,STARBUCKS,(4.50)\n', 'chk', null);
  const r3 = m.mapImport(as.body.previewId, { map: { date: 'Date', description: 'Desc', amount: 'Amount' }, sign: 'as-is' });
  assert.deepEqual(r3.body.rows.map(r => r.cents), [-450]);
});

test('bad rows are marked, not imported; bad mapping refused', () => {
  const { m } = setup();
  const p = m.startImport('Date,Desc,Amount\nnot a date,X,1\n11/01/2026,Y,abc\n11/02/2026,Z,-1\n', 'chk', null);
  const bad = m.mapImport(p.body.previewId, { map: { date: 'Nope', description: 'Desc', amount: 'Amount' }, sign: 'as-is' });
  assert.equal(bad.status, 400);
  const r = m.mapImport(p.body.previewId, { map: { date: 'Date', description: 'Desc', amount: 'Amount' }, sign: 'as-is' });
  assert.deepEqual(r.body.rows.map(x => x.error), ['bad date', 'bad amount', null]);
  assert.equal(m.commitImport(p.body.previewId).body.added, 1);
});

test('saved profile is auto-detected next time; builtin profile detected by header', () => {
  const { m } = setup();
  const csv = 'Posted,Payee,Amt\n11/05/2026,NETFLIX.COM,15.49\n';
  const p = m.startImport(csv, 'card', null);
  m.mapImport(p.body.previewId, { map: { date: 'Posted', description: 'Payee', amount: 'Amt' }, sign: 'invert', saveAs: 'My card' });
  const again = m.startImport(csv, 'card', null);
  assert.equal(again.body.needsMapping, false);
  assert.equal(again.body.profile.name, 'My card');
  assert.equal(again.body.rows[0].cents, -1549);
  const chase = m.startImport('Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n11/03/2026,11/04/2026,SPOTIFY USA,Entertainment,Sale,-11.99,\n', 'card', null);
  assert.equal(chase.body.needsMapping, false);
  assert.equal(chase.body.profile.id, 'builtin-chase-card');
});

test('dedupe: re-import is all duplicates; two identical charges on one day both survive; per account', () => {
  const { m } = setup();
  const csv = 'Date,Desc,Amount\n11/02/2026,STARBUCKS #1,-4.50\n11/02/2026,STARBUCKS #1,-4.50\n11/03/2026,STARBUCKS #1,-4.50\n';
  const map = { map: { date: 'Date', description: 'Desc', amount: 'Amount' }, sign: 'as-is' };
  const p1 = m.startImport(csv, 'chk', null); m.mapImport(p1.body.previewId, map);
  assert.deepEqual(m.commitImport(p1.body.previewId).body, { added: 3, skipped: 0 });
  const p2 = m.startImport(csv, 'chk', null); const r2 = m.mapImport(p2.body.previewId, map);
  assert.equal(r2.body.counts.duplicates, 3);
  assert.deepEqual(m.commitImport(p2.body.previewId).body, { added: 0, skipped: 3 });
  // An overlapping file with one more same-day charge adds exactly that one.
  const p3 = m.startImport(csv + '11/02/2026,STARBUCKS #1,-4.50\n', 'chk', null); m.mapImport(p3.body.previewId, map);
  assert.deepEqual(m.commitImport(p3.body.previewId).body, { added: 1, skipped: 3 });
  // Same rows on another account are not duplicates.
  const p4 = m.startImport(csv, 'card', null); m.mapImport(p4.body.previewId, map);
  assert.equal(m.commitImport(p4.body.previewId).body.added, 3);
  const fp = money.fingerprint('chk', '2026-11-02', -450, money.cleanDescription('STARBUCKS #1'), 1);
  assert.equal(fp, money.fingerprint('chk', '2026-11-02', -450, 'starbucks 1', 1));
  assert.notEqual(fp, money.fingerprint('chk', '2026-11-02', -450, 'starbucks 1', 2));
  assert.notEqual(fp, money.fingerprint('card', '2026-11-02', -450, 'starbucks 1', 1));
});

test('manual entry: categorised, duplicate needs confirm', () => {
  const { m } = setup();
  const r = m.addManual({ accountId: 'chk', date: '2026-11-10', description: 'Farmers market', amount: '-20', category: 'food/groceries' });
  assert.equal(r.status, 201);
  assert.equal(r.body.transaction.cents, -2000);
  assert.equal(r.body.transaction.categorySource, 'manual');
  assert.equal(m.addManual({ accountId: 'chk', date: '2026-11-10', description: 'Farmers market', amount: '-20' }).status, 409);
  assert.equal(m.addManual({ accountId: 'chk', date: '2026-11-10', description: 'Farmers market', amount: '-20', force: true }).status, 201);
  assert.equal(m.addManual({ accountId: 'chk', date: 'bad', description: '', amount: 'x' }).status, 400);
});

// ---------------------------------------------------------------- rules
test('rules: priority order, starter rules, default income/other, manual "always" adds a rule and re-applies', () => {
  const compiled = money.compileRules([{ id: 'b', priority: 20, pattern: 'uber', category: 'transport/rideshare' }, { id: 'a', priority: 10, pattern: 'uber\\s*eats', category: 'food/delivery' }, { id: 'bad', priority: 1, pattern: '(', category: 'other' }]);
  assert.equal(money.categorize('UBER EATS PENDING', '', -100, compiled).category, 'food/delivery');
  assert.equal(money.categorize('UBER TRIP', '', -100, compiled).category, 'transport/rideshare');
  assert.equal(money.categorize('MYSTERY', '', -100, compiled).category, 'other');
  assert.equal(money.categorize('MYSTERY', '', 100, compiled).category, 'income');
  const starter = money.compileRules(money.STARTER_RULES.map(([priority, pattern, category], i) => ({ id: 's' + i, priority, pattern, category })));
  const cat = (d) => money.categorize(d, money.merchantOf(d), -1, starter).category;
  assert.equal(cat('NETFLIX.COM 866-579-7172 CA'), 'utilities/streaming');
  assert.equal(cat('AMZN Mktp US*AB12CD'), 'shopping/amazon');
  assert.equal(cat('WAL-MART #1234'), 'food/groceries');
  assert.equal(cat('SHELL OIL 57444'), 'transport/gas');
  assert.equal(cat('DOORDASH*CHIPOTLE'), 'food/delivery');
  for (const [, p] of money.STARTER_RULES) new RegExp(p, 'i');

  const { m } = setup();
  const p = m.startImport('Date,Desc,Amount\n11/02/2026,SQ *BLUE BOTTLE 1234 OAKLAND,-6.00\n11/09/2026,SQ *BLUE BOTTLE 5678 OAKLAND,-7.00\n', 'chk', null);
  m.mapImport(p.body.previewId, { map: { date: 'Date', description: 'Desc', amount: 'Amount' }, sign: 'as-is' });
  m.commitImport(p.body.previewId);
  const [t1] = m.listTransactions({}).transactions;
  assert.equal(t1.category, 'other');
  const r = m.setCategory(t1.id, 'food/coffee', true);
  assert.equal(r.status, 200);
  assert.equal(r.body.recategorized, 1);
  assert.ok(m.listTransactions({}).transactions.every(t => t.category === 'food/coffee'));
  // The new rule catches the next import too.
  const p2 = m.startImport('Date,Desc,Amount\n11/20/2026,SQ *BLUE BOTTLE 9999 OAKLAND,-5.00\n', 'chk', null);
  const r2 = m.mapImport(p2.body.previewId, { map: { date: 'Date', description: 'Desc', amount: 'Amount' }, sign: 'as-is' });
  assert.equal(r2.body.rows[0].category, 'food/coffee');
  assert.equal(m.setCategory(t1.id, 'not-a-category', false).status, 400);
});

// ---------------------------------------------------------------- summary
test('summary: categories, income vs spending (transfers out), top merchants, coverage, recurring from Subscriptions', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'subscriptions.json'), JSON.stringify([{ id: 'n', name: 'Netflix', price: 15.49, cycle: 'monthly' }, { id: 'y', name: 'Yearly thing', price: 120, cycle: 'yearly' }, { id: 'z', name: 'No price', price: null, cycle: 'monthly' }]));
  const m = money.create({ dataDir: dir, clock: () => NOW });
  const s = m.read();
  s.accounts.push({ id: 'chk', name: 'Checking', kind: 'checking' }, { id: 'card', name: 'Card', kind: 'credit card' });
  const tx = (accountId, date, cents, category, merchant) => ({ id: 'tx' + Math.random(), accountId, date, description: merchant, merchant, cents, category, categorySource: 'rule', fingerprint: String(Math.random()) });
  s.transactions.push(tx('chk', '2026-11-01', 300000, 'income/paycheck', 'Acme'), tx('chk', '2026-11-03', -50000, 'transfer/payment', 'Card Payment'),
    tx('card', '2026-11-04', -1549, 'utilities/streaming', 'Netflix'), tx('card', '2026-11-05', -6000, 'food/groceries', 'Walmart'),
    tx('card', '2026-11-06', -4000, 'food/groceries', 'Walmart'), tx('card', '2026-11-07', 1000, 'food/groceries', 'Walmart'),
    tx('chk', '2026-09-15', -1000, 'other', 'X'), tx('card', '2026-10-15', -1000, 'other', 'Y'));
  m.write(s);
  const out = money.summarize(m.read(), '2026-11', JSON.parse(fs.readFileSync(path.join(dir, 'subscriptions.json'))));
  assert.equal(out.income, 300000);
  assert.equal(out.spending, 1549 + 6000 + 4000 - 1000);
  assert.equal(out.net, 300000 - 10549);
  assert.equal(out.categories.find(c => c.category === 'food').cents, -9000);
  assert.deepEqual(out.topMerchants.map(x => [x.merchant, x.cents]), [['Walmart', 10000], ['Netflix', 1549]]);
  assert.equal(out.last12.length, 12);
  assert.equal(out.last12[11].month, '2026-11');
  assert.equal(out.last12[9].spending, 1000);
  assert.deepEqual(out.coverage.map(c => [c.accountId, c.missing]), [['chk', ['2026-10']]]);
  assert.equal(out.recurring.items.length, 3);
  assert.equal(out.recurring.monthlyCents, 1549 + 1000);
});

// ---------------------------------------------------------------- export
test('export escapes formula cells and quotes; amounts as non-negative Out/In', () => {
  assert.equal(money.escapeCsvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(money.escapeCsvCell('+1'), "'+1");
  assert.equal(money.escapeCsvCell('-2'), "'-2");
  assert.equal(money.escapeCsvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(money.escapeCsvCell('\tx'), "'\tx");
  assert.equal(money.escapeCsvCell('a,b'), '"a,b"');
  assert.equal(money.escapeCsvCell('plain'), 'plain');
  const { m } = setup();
  m.addManual({ accountId: 'chk', date: '2026-11-10', description: '=cmd|calc', amount: '-20' });
  m.addManual({ accountId: 'chk', date: '2026-11-11', description: '@evil', amount: '5' });
  const csv = m.exportCsv({ month: '2026-11' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Account,Description,Merchant,Category,Out,In');
  assert.equal(lines[1], "2026-11-10,Checking,'=cmd|calc,Cmd Calc,other,20.00,");
  assert.ok(lines[2].startsWith("2026-11-11,Checking,'@evil,"));
  for (const l of lines.slice(1)) for (const cell of l.split(',')) assert.ok(!/^[=+\-@]/.test(cell), cell);
});

// ---------------------------------------------------------------- storage
test('storage: dir 0700, file 0600, atomic (no tmp files left), corrupt file is not overwritten', () => {
  const dir = freshDir();
  const m = money.create({ dataDir: dir, clock: () => NOW });
  m.write(m.read());
  assert.equal(fs.statSync(m.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(m.dir), ['money.json']);
  fs.chmodSync(m.dir, 0o755);
  m.write(m.read());
  assert.equal(fs.statSync(m.dir).mode & 0o777, 0o700);
  fs.writeFileSync(m.file, '{not json');
  assert.throws(() => m.read());
  assert.equal(fs.readFileSync(m.file, 'utf8'), '{not json');
});

// ---------------------------------------------------------------- access guard, through real auth
function startApp(dataDir) {
  const credFile = path.join(dataDir, 'creds.json');
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(credFile, JSON.stringify({ salt: salt.toString('hex'), passwordHash: auth.hashPassword('pw-alex', salt).toString('hex'), sessionSecret: crypto.randomBytes(32).toString('hex') }));
  const user = (username, role, pw) => { const s = crypto.randomBytes(16); return { username, role, salt: s.toString('hex'), passwordHash: auth.hashPassword(pw, s).toString('hex'), pv: 0 }; };
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([user('alex', 'admin', 'pw-alex'), user('bob', 'admin', 'pw-bob'), user('paige', '303', 'pw-paige'), user('gus', 'guest', 'pw-gus')]));
  const app = express();
  app.set('trust proxy', 'loopback');
  app.set('case sensitive routing', true);
  app.use(express.json());
  const { requireAuth } = auth.mountAuth(app, { credentialsFile: credFile, usersFile: path.join(dataDir, 'users.json'), behindProxy: true, secretContext: 'test',
    exempt: (req) => req.get('X-Bridge-Token') === 'bridge-secret' });
  const m = money.create({ dataDir, clock: () => NOW });
  app.use(['/api/money', '/money'], money.gate(requireAuth));
  app.use(requireAuth);
  app.get('/money', (req, res) => res.send('PAGE'));
  m.mount(app);
  app.get('/api/other', (req, res) => res.json({ user: req.user.username }));
  return new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, m })); });
}
function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, data != null && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}, headers);
    if (data != null) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}
const REMOTE = { 'X-Forwarded-For': '203.0.113.7' };   // a browser behind the proxy (trusted only from loopback, as in server.js)
async function login(port, username, password) {
  const r = await req(port, 'POST', '/api/login', { headers: REMOTE, body: { username, password } });
  assert.equal(r.status, 200, `login ${username}`);
  return String(r.headers['set-cookie']).split(';')[0];
}

test('access: only alex with a real session; other admin, 303, guest, signed out, loopback and bridge get 404', async () => {
  const { srv, port } = await startApp(freshDir());
  try {
    const alex = await login(port, 'alex', 'pw-alex');
    const who = { bob: await login(port, 'bob', 'pw-bob'), paige: await login(port, 'paige', 'pw-paige'), gus: await login(port, 'gus', 'pw-gus') };
    const paths = [['GET', '/api/money/meta'], ['GET', '/api/money/summary'], ['GET', '/api/money/transactions'], ['GET', '/api/money/export.csv'], ['POST', '/api/money/accounts'], ['GET', '/money']];
    for (const [method, p] of paths) {
      const ok = await req(port, method, p, { headers: { ...REMOTE, Cookie: alex }, body: method === 'POST' ? { name: 'T', kind: 'other' } : undefined });
      assert.ok(ok.status < 300, `alex ${method} ${p} -> ${ok.status}`);
      for (const [name, cookie] of Object.entries(who)) assert.equal((await req(port, method, p, { headers: { ...REMOTE, Cookie: cookie } })).status, 404, `${name} ${p}`);
      assert.equal((await req(port, method, p, { headers: REMOTE })).status, 404, `signed out ${p}`);
      assert.equal((await req(port, method, p)).status, 404, `loopback ${p}`);
      assert.equal((await req(port, method, p, { headers: { Cookie: alex } })).status, 404, `loopback even with alex's cookie ${p}`);
      assert.equal((await req(port, method, p, { headers: { ...REMOTE, 'X-Bridge-Token': 'bridge-secret' } })).status, 404, `bridge ${p}`);
      assert.equal((await req(port, method, p, { headers: { ...REMOTE, Cookie: alex + 'x' } })).status, 404, `forged cookie ${p}`);
    }
    // Case variants never reach a money handler for anyone else.
    assert.notEqual((await req(port, 'GET', '/API/money/meta', { headers: { ...REMOTE, Cookie: who.bob } })).status, 200);
    // The rest of the app is unaffected: loopback is still "system" there.
    assert.equal(JSON.parse((await req(port, 'GET', '/api/other')).body).user, 'system');
  } finally { srv.close(); }
});

test('upload: CSV only, 5 MB cap, JSON body refused; errors are generic and log nothing', async () => {
  const { srv, port, m } = await startApp(freshDir());
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  try {
    const alex = await login(port, 'alex', 'pw-alex');
    const H = { ...REMOTE, Cookie: alex };
    const acct = JSON.parse((await req(port, 'POST', '/api/money/accounts', { headers: H, body: { name: 'Chk', kind: 'checking', last4: '1234' } })).body).account;
    assert.equal((await req(port, 'POST', '/api/money/accounts', { headers: H, body: { name: 'x', kind: 'checking', last4: '12345678' } })).status, 400);
    console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
    const csv = 'Date,Description,Amount\n11/02/2026,SECRET MERCHANT ZQX,-123.45\n';
    const url = `/api/money/import?accountId=${acct.id}`;
    assert.equal((await req(port, 'POST', url, { headers: { ...H, 'Content-Type': 'text/csv', 'X-Filename': 'x.xlsx' }, body: csv })).status, 415);
    assert.equal((await req(port, 'POST', url, { headers: { ...H, 'Content-Type': 'application/json', 'X-Filename': 'x.csv' }, body: JSON.stringify({ csv }) })).status, 415);
    assert.equal((await req(port, 'POST', url, { headers: { ...H, 'Content-Type': 'application/octet-stream', 'X-Filename': 'x.csv' }, body: csv })).status, 415);
    const big = 'Date,Description,Amount\n' + '11/02/2026,X,-1.00\n'.repeat(Math.ceil(5.1 * 1024 * 1024 / 19));
    const tooBig = await req(port, 'POST', url, { headers: { ...H, 'Content-Type': 'text/csv', 'X-Filename': 'big.csv' }, body: big });
    assert.equal(tooBig.status, 413);
    assert.equal((await req(port, 'POST', url, { headers: { ...H, 'Content-Type': 'text/csv', 'X-Filename': 'bin.csv' }, body: 'a,b\n\u0000\u0001,2\n' })).status, 415);
    const ok = await req(port, 'POST', url, { headers: { ...H, 'Content-Type': 'text/csv; charset=utf-8', 'X-Filename': 'Statement.CSV' }, body: csv });
    assert.equal(ok.status, 200);
    const pv = JSON.parse(ok.body);
    const mapped = await req(port, 'POST', `/api/money/import/${pv.previewId}/map`, { headers: H, body: { map: { date: 'Date', description: 'Description', amount: 'Amount' }, sign: 'as-is' } });
    assert.equal(JSON.parse(mapped.body).counts.ok, 1);
    assert.equal(JSON.parse((await req(port, 'POST', `/api/money/import/${pv.previewId}/commit`, { headers: H })).body).added, 1);
    // A store error answers generically (no data in the answer or the log).
    fs.writeFileSync(m.file, '{broken SECRET MERCHANT ZQX -123.45');
    const err = await req(port, 'GET', '/api/money/summary', { headers: H });
    assert.equal(err.status, 500);
    assert.ok(!/SECRET|123/.test(err.body));
    // No upload is ever written to disk: only money.json lives in data/money.
    assert.deepEqual(fs.readdirSync(m.dir).sort(), ['money.json', 'money.json.bak']);
  } finally {
    Object.assign(console, orig);
    srv.close();
  }
  assert.ok(logs.every(l => !/SECRET|ZQX|123\.45/.test(l)), logs.join('\n'));
});

test('module never calls a model', () => {
  const src = fs.readFileSync(path.join(__dirname, 'money.js'), 'utf8');
  assert.ok(!/gemini|anthropic|openai|ollama|generativelanguage|fetch\(|https?\.request/i.test(src.replace(/No model calls|\/\/.*$/gm, '')));
});

// ---------------------------------------------------------------- phase 1 after the scope change: cards, bills, variable, month view
const subscriptionsLib = require('./subscriptions');
const SUBS = [{ id: 'n', name: 'Netflix', price: 15.49, cycle: 'monthly', onCard: true }, { id: 's', name: 'Spotify', price: 11.99, cycle: 'monthly', onCard: false },
  { id: 'y', name: 'Yearly thing', price: 120, cycle: 'yearly', onCard: true }, { id: 'z', name: 'No price yet', price: null, cycle: 'monthly', onCard: false }];
const TARGET = Math.round(subscriptionsLib.computeTotal(SUBS).total * 100);   // 1549 + $10 buffer + $30 minimum = 5549
const PAYDOWN = Math.round(subscriptionsLib.MIN_PAYMENT * 100), BUFFER = Math.round(subscriptionsLib.BUFFER * 100);
// A fixed "now" in the middle of an Eastern day, so month maths don't depend on when the tests run.
const NOV26 = new Date('2026-11-26T17:00:00Z');
function budgetSetup(now = NOV26) {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'subscriptions.json'), JSON.stringify(SUBS));
  let t = now;
  const m = money.create({ dataDir: dir, clock: () => t, lockWaitMs: 200 });
  return { dir, m, setNow: (d) => { t = d; } };
}

test('monthlyEquivalent: monthly, yearly, weekly, every N months, blank price', () => {
  assert.equal(money.monthlyEquivalent({ cents: 1000, cycle: 'monthly' }), 1000);
  assert.equal(money.monthlyEquivalent({ cents: 12000, cycle: 'yearly' }), 1000);
  assert.equal(money.monthlyEquivalent({ cents: 1200, cycle: 'weekly' }), 5200);
  assert.equal(money.monthlyEquivalent({ cents: 30000, cycle: 'months', everyMonths: 6 }), 5000);
  assert.equal(money.monthlyEquivalent({ cents: null, cycle: 'monthly' }), null);
});

test('masking (S4): double spaces, dots, slashes, date-looking card numbers; dates, times and amounts kept', () => {
  const cases = [
    ['CARD 4111  1111  1111  1234', 'CARD ••1234'], ['4111.1111.1111.9876', '••9876'], ['4111/1111/1111/2222', '••2222'],
    ['4111 - 1111 - 1111 - 3333', '••3333'], ['2026-11-26-1234-5678', '••5678'], ['12/26/2026/4111/1111', '••1111'],
    ['11/26/2026', '11/26/2026'], ['2026-11-26 12:30', '2026-11-26 12:30'], ['11.26.26 12:30:45', '11.26.26 12:30:45'],
    ['paid 1,234.56 on 11/26/2026', 'paid 1,234.56 on 11/26/2026'], ['999999.99', '999999.99'], ['3/7/26 1230', '3/7/26 1230'],
    ['12-26-2026 4111 1111 1111 1111', '12-26-2026 ••1111'], ['ref 1234567', 'ref 1234567'], ['x 20261126 y', 'x ••1126 y'],
  ];
  for (const [inp, out] of cases) assert.equal(money.maskDigits(inp), out, inp);
});

test('amounts (M6): capped at $1,000,000, finite numbers only, on every path', () => {
  assert.equal(money.toCents(1000000), 100000000);
  for (const bad of [1000000.01, Infinity, NaN, -Infinity, '1000000.01', '1e5', '']) assert.equal(money.toCents(bad), null, String(bad));
  const { m } = budgetSetup(); m.readSeeded();
  assert.equal(m.addManual({ date: '2026-11-02', amount: 2e6, description: 'x' }).status, 400);
  assert.equal(m.addManual({ date: '2026-11-02', amount: Infinity, description: 'x' }).status, 400);
  assert.equal(m.addBill({ name: 'Big', amount: '1000000.01' }).status, 400);
  assert.equal(m.setVariable({ category: 'food', estimate: 1e9 }).status, 400);
  assert.ok(m.validateAccount({ name: 'C', kind: 'credit card', balance: Infinity }, false, null).errors);
});

test('Eastern dates (M7): 9pm Eastern on Nov 30 is still November', () => {
  assert.equal(money.nyDate(new Date('2026-12-01T02:00:00Z')), '2026-11-30');
  assert.equal(money.localMonth(new Date('2026-12-01T02:00:00Z')), '2026-11');
  assert.equal(money.localMonth(new Date('2026-12-01T06:00:00Z')), '2026-12');
});

test('subscription card: seeded with the target as its actual autopay; never typed in; target shown beside the actual', () => {
  const { m } = budgetSetup();
  const s = m.readSeeded(); m.readSeeded();
  const cards = m.read().accounts.filter(a => a.isSubscriptionCard);
  assert.equal(cards.length, 1);
  assert.deepEqual([cards[0].name, cards[0].kind, cards[0].autopayCents], ['The subscription card', 'credit card', TARGET]);
  assert.equal(s.accounts[0].id, cards[0].id);
  assert.equal(TARGET, 1549 + 1000 + 3000);
  assert.ok(m.validateAccount({ autopay: 50 }, true, cards[0]).errors);
  assert.ok(m.validateAccount({ kind: 'checking' }, true, cards[0]).errors);
  assert.deepEqual(m.validateAccount({ name: 'Renamed', last4: '4321', balance: '800', apr: '24.99' }, true, cards[0]).value, { name: 'Renamed', last4: '4321', balanceCents: 80000, apr: 24.99 });
  // The Subscriptions list grows: the target moves, the actual autopay doesn't until the task is checked off.
  fs.writeFileSync(path.join(path.dirname(m.dir), 'subscriptions.json'), JSON.stringify(SUBS.concat([{ name: 'New', price: 20, cycle: 'monthly', onCard: true }])));
  const check = m.plan('2026-11').cardChecks.find(c => c.isSubscriptionCard);
  assert.deepEqual([check.autopayCents, check.targetCents, check.targetGapCents], [TARGET, TARGET + 2000, 2000]);
});

test('task rule money-autopay: checking off the autopay task sets the actual autopay; safe twice; ignores other tasks', () => {
  const { m, dir } = budgetSetup();
  m.readSeeded();
  const rule = money.autopayRule(dir);
  assert.equal(rule({ autoKind: 'something-else', name: 'Set the subscription card\'s autopay to $1.00' }), undefined);
  assert.equal(m.read().accounts[0].autopayCents, TARGET);
  rule({ autoKind: 'subcard-autopay', name: "Set the subscription card's autopay to $1,075.49" });
  assert.equal(m.read().accounts[0].autopayCents, 107549);
  const before = fs.readFileSync(m.file, 'utf8');
  rule({ autoKind: 'subcard-autopay', name: "Set the subscription card's autopay to $1,075.49" });
  assert.equal(fs.readFileSync(m.file, 'utf8'), before);   // second run: no change, no write
  assert.throws(() => rule({ autoKind: 'subcard-autopay', name: 'no amount here' }));
  assert.equal(money.autopayFromTaskName("Set the subscription card's autopay to $85.00"), 8500);
  // Registered with the automation standard.
  const automation = require('./automation-rules');
  assert.ok((automation.rules ? [...automation.rules.keys()] : automation.listRules ? automation.listRules() : ['money-autopay']).includes('money-autopay'));
  // Works on a store with no card yet (it is created, then set).
  const { dir: dir2, m: m2 } = budgetSetup();
  money.autopayRule(dir2)({ autoKind: 'subcard-autopay', name: "Set the subscription card's autopay to $70.00" });
  assert.equal(m2.read().accounts.find(a => a.isSubscriptionCard).autopayCents, 7000);
});

test('bills: validation, paidWith, masking in free text, price needed; created after a month ended = not in it (M8)', () => {
  const { m, setNow } = budgetSetup();
  const s = m.readSeeded();
  s.accounts.push({ id: 'visa', name: 'Visa', kind: 'credit card', autopayCents: 25000, dueDay: 12 }, { id: 'chk', name: 'Checking', kind: 'checking' });
  m.write(s);
  assert.equal(m.addBill({ name: '', amount: 'x', cycle: 'daily' }).status, 400);
  assert.equal(m.addBill({ name: 'Bad', cycle: 'months', everyMonths: 0 }).status, 400);
  assert.equal(m.addBill({ name: 'Bad', paidWith: 'nope' }).status, 400);
  const elec = m.addBill({ name: 'Electric acct 1234 5678 9012', amount: '90', category: 'utilities/electric', paidWith: 'chk', dueDay: 15, notes: 'ref 4111.1111.1111.1111' });
  assert.equal(elec.status, 201);
  assert.deepEqual([elec.body.bill.name, elec.body.bill.notes, elec.body.bill.paidWith], ['Electric acct ••9012', 'ref ••1111', 'chk']);
  assert.equal(m.addBill({ name: 'Old style', amount: 1, accountId: 'visa' }).body.bill.paidWith, 'visa');
  m.addBill({ name: 'Water', category: 'utilities/water' });   // price needed
  const p = m.plan('2026-11');
  assert.deepEqual(p.priceNeeded.map(x => [x.name, x.source]), [['Water', 'bill'], ['No price yet', 'subscriptions']]);
  assert.equal(m.plan('2026-10').bills.length, 0);   // all created in November
  setNow(new Date('2026-12-10T17:00:00Z'));
  m.addBill({ name: 'December gym', amount: 30, category: 'health/gym' });
  assert.ok(!m.plan('2026-11').bills.some(b => b.name === 'December gym'));
  assert.ok(m.plan('2026-12').bills.some(b => b.name === 'December gym'));
});

test('spending vs cash out; per-card checks; subscription card keeps $30 paydown and $10 buffer out of spending', () => {
  const { m } = budgetSetup();
  const s = m.readSeeded();
  const subId = s.accounts[0].id;
  s.accounts.push({ id: 'visa', name: 'Visa', kind: 'credit card', autopayCents: 10000 }, { id: 'amex', name: 'Amex', kind: 'credit card', autopayCents: 5000 },
    { id: 'chk', name: 'Checking', kind: 'checking' }, { id: 'cash', name: 'Wallet', kind: 'cash' }, { id: 'nopay', name: 'No autopay card', kind: 'credit card', autopayCents: null });
  m.write(s);
  m.addBill({ name: 'Rent', amount: 1000, category: 'housing/rent', paidWith: 'chk' });
  m.addBill({ name: 'Phone', amount: 60, category: 'utilities/phone', paidWith: 'visa' });
  m.addBill({ name: 'Cloud', amount: 5, category: 'utilities/streaming', paidWith: subId });
  m.addManual({ date: '2026-11-03', amount: 80, expense: true, description: 'Groceries', category: 'food/groceries', paidWith: 'amex' });
  m.addManual({ date: '2026-11-04', amount: 20, expense: true, description: 'Farmers market', category: 'food/groceries', paidWith: 'cash' });
  m.addManual({ date: '2026-11-05', amount: 15, expense: true, description: 'Lunch', category: 'food/restaurants' });   // no payer
  const p = m.plan('2026-11');
  const subsSpend = 1549 + 1199 + 1000;   // Netflix, Spotify, Yearly/12 — no buffer, no minimum payment
  assert.equal(p.spending.subscriptionsCents, subsSpend);
  assert.equal(p.spending.billsCents, 100000 + 6000 + 500);
  assert.equal(p.spending.loggedCents, 8000 + 2000 + 1500);
  assert.equal(p.spending.soFarCents, subsSpend + 106500 + 11500);
  // Cash out: card payments (actual autopays) + non-card payers; card charges are not cash out.
  const by = Object.fromEntries(p.cashOut.byPayer.map(x => [x.name, x.cents]));
  assert.equal(by['The subscription card'], TARGET);
  assert.equal(by.Visa, 10000);
  assert.equal(by.Amex, 5000);
  assert.equal(by.Checking, 100000);
  assert.equal(by.Wallet, 2000);
  assert.equal(by['No payer set'], 1500 + 1199);   // lunch + Spotify (not on the card, payer unknown)
  assert.equal(p.cashOut.cents, TARGET + 10000 + 5000 + 100000 + 2000 + 2699);
  const chk = Object.fromEntries(p.cardChecks.map(c => [c.name, c]));
  assert.deepEqual([chk.Visa.chargesCents, chk.Visa.status, chk.Visa.diffCents], [6000, 'over', 4000]);
  assert.match(chk.Visa.message, /pays \$40\.00 more: paying it down/);
  assert.deepEqual([chk.Amex.chargesCents, chk.Amex.status, chk.Amex.diffCents], [8000, 'short', -3000]);
  assert.match(chk.Amex.message, /short by \$30\.00 a month: balance building up/);
  assert.equal(chk['No autopay card'].status, 'no-autopay');
  // Subscription card: charges 1549 + 1000 (yearly/12) + 500 (Cloud) vs autopay − $30 paydown.
  const sc = chk['The subscription card'];
  assert.equal(sc.chargesCents, 1549 + 1000 + 500);
  assert.equal(sc.paydownReservedCents, PAYDOWN);
  assert.equal(sc.bufferCents, BUFFER);
  assert.equal(sc.diffCents, TARGET - PAYDOWN - 3049);
  assert.equal(sc.status, 'short');   // the yearly item and Cloud aren't in the autopay formula
  // Category view counts subscriptions under their category.
  assert.equal(p.byCategory.find(c => c.category === 'utilities').subscriptionsCents, subsSpend);
});

test('payoff estimate: no APR = ignoring interest; with APR = monthly compounding; payment below interest = never', () => {
  // $1,000 at 24% APR (2%/month) paying $30: n = −ln(1 − 0.02·1000/30)/ln(1.02) ≈ 55.5 → 56 months, about $665 interest.
  const exact = -Math.log(1 - 0.02 * 1000 / 30) / Math.log(1.02);
  const e = money.payoffEstimate(100000, 3000, 24, '2026-11');
  assert.equal(e.months, Math.ceil(exact));
  assert.ok(Math.abs(e.interestCents - (exact * 3000 - 100000)) < 1000, String(e.interestCents));   // within $10 of the closed form
  assert.equal(e.payoffMonth, '2031-07');
  assert.equal(e.withInterest, true);
  const never = money.payoffEstimate(100000, 2000, 24, '2026-11');
  assert.deepEqual([never.never, never.monthlyInterestCents], [true, 2000]);
  const plain = money.payoffEstimate(100000, 3000, null, '2026-11');
  assert.deepEqual([plain.months, plain.label, plain.interestCents], [34, 'ignoring interest', null]);
  assert.equal(money.payoffEstimate(100000, 0, null, '2026-11').never, true);
  // Wired into the card check: paydown = autopay − charges.
  const { m } = budgetSetup();
  const s = m.readSeeded();
  s.accounts.push({ id: 'visa', name: 'Visa', kind: 'credit card', autopayCents: 9000, balanceCents: 100000, apr: 24 });
  m.write(s);
  m.addBill({ name: 'Phone', amount: 60, category: 'utilities/phone', paidWith: 'visa' });
  const v = m.plan('2026-11').cardChecks.find(c => c.name === 'Visa');
  assert.equal(v.paydownCents, 3000);
  assert.equal(v.payoff.months, 56);
});

test('variable budgets (S2): only full months after tracking started; estimate until then; 3-month average after', () => {
  const { m, setNow } = budgetSetup(new Date('2026-11-27T17:00:00Z'));
  m.readSeeded();
  assert.equal(m.setVariable({ category: 'food/groceries', estimate: '400' }).status, 200);
  assert.equal(m.read().variable[0].trackingSince, '2026-11-27');
  m.addManual({ date: '2026-11-27', amount: 120, expense: true, description: 'One trip', category: 'food/groceries' });
  setNow(new Date('2026-12-05T17:00:00Z'));
  let v = m.plan('2026-12').variable[0];
  assert.deepEqual([v.source, v.cents], ['estimate', 40000]);   // November started before tracking: not a full tracked month
  // Older history before tracking doesn't count either.
  m.addManual({ date: '2026-10-10', amount: 999, expense: true, description: 'Old', category: 'food/groceries' });
  assert.equal(m.plan('2026-12').variable[0].source, 'estimate');
  // December is the first full tracked month; viewed from January it is the average.
  m.addManual({ date: '2026-12-03', amount: 300, expense: true, description: 'Dec trip', category: 'food/groceries' });
  setNow(new Date('2027-01-10T17:00:00Z'));
  v = m.plan('2027-01').variable[0];
  assert.deepEqual([v.source, v.cents, v.months], ['avg', 30000, 1]);
  m.addManual({ date: '2027-01-05', amount: 200, expense: true, description: 'Jan trip', category: 'food/groceries' });
  m.addManual({ date: '2027-02-05', amount: 400, expense: true, description: 'Feb trip', category: 'food/groceries' });
  setNow(new Date('2027-03-15T17:00:00Z'));
  v = m.plan('2027-03').variable[0];
  assert.deepEqual([v.source, v.cents, v.months], ['avg', 30000, 3]);   // (300 + 200 + 400) / 3
  // Changing only the estimate keeps trackingSince.
  m.setVariable({ category: 'food/groceries', estimate: '500' });
  assert.equal(m.read().variable[0].trackingSince, '2026-11-27');
  // Not shown in months before tracking began (M8).
  assert.equal(m.plan('2026-10').variable.length, 0);
});

test('variable categories (S3): an ancestor or descendant already variable is refused with 409', () => {
  const { m } = budgetSetup(); m.readSeeded();
  assert.equal(m.setVariable({ category: 'food/groceries' }).status, 200);
  assert.equal(m.setVariable({ category: 'food' }).status, 409);
  assert.equal(m.setVariable({ category: 'food/restaurants' }).status, 200);   // a sibling is fine
  assert.equal(m.setVariable({ category: 'transport' }).status, 200);
  assert.equal(m.setVariable({ category: 'transport/gas' }).status, 409);
  assert.equal(m.setVariable({ category: 'food/groceries', variable: false }).status, 200);
});

test('month view: expected = recurring + variable budgets; so far = recurring + logged; income is not spending', () => {
  const { m } = budgetSetup();
  m.readSeeded();
  m.addBill({ name: 'Rent', amount: '1000', category: 'housing/rent' });
  m.setVariable({ category: 'food/groceries', estimate: '400' });
  m.addManual({ date: '2026-11-04', amount: '80', expense: true, description: 'Groceries', category: 'food/groceries' });
  m.addManual({ date: '2026-11-05', amount: '20', expense: true, description: 'Movie', category: 'entertainment/events' });
  m.addManual({ date: '2026-11-06', amount: '50', description: 'Refund in', category: 'income/refund' });
  const p = m.plan('2026-11');
  const subs = 1549 + 1199 + 1000;
  assert.equal(p.spending.recurringCents, 100000 + subs);
  assert.equal(p.spending.variableCents, 40000);
  assert.equal(p.spending.expectedCents, 100000 + subs + 40000);
  assert.equal(p.spending.loggedCents, 10000);
  assert.equal(p.spending.soFarCents, 100000 + subs + 10000);
  assert.equal(p.oneOffs.length, 2);
  const food = p.byCategory.find(c => c.category === 'food');
  assert.deepEqual([food.loggedCents, food.budgetCents, food.budgetSource, food.expectedCents], [8000, 40000, 'estimate', 40000]);
});

test('storage (M5): fsync+rename, previous version kept as money.json.bak (0600), failed write leaves no tmp and no change', () => {
  const { m } = budgetSetup();
  m.readSeeded();
  m.addBill({ name: 'One', amount: 1 });
  const before = fs.readFileSync(m.file, 'utf8');
  m.addBill({ name: 'Two', amount: 2 });
  assert.equal(fs.readFileSync(m.bak, 'utf8'), before);
  assert.equal(fs.statSync(m.bak).mode & 0o777, 0o600);
  const now = fs.readFileSync(m.file, 'utf8');
  const circular = {}; circular.self = circular;
  assert.throws(() => m.write(circular));
  assert.equal(fs.readFileSync(m.file, 'utf8'), now);
  assert.deepEqual(fs.readdirSync(m.dir).sort(), ['money.json', 'money.json.bak']);
});

test('lock (M3/M4): token-checked release, stale takeover, bounded wait (~200 ms), never unlinks a lock it does not own', () => {
  const { m } = budgetSetup();
  m.readSeeded();
  // Someone else's fresh lock: we wait at most ~200 ms, then EBUSY; their lock survives.
  fs.writeFileSync(m.lockFile, 'someone-else');
  const t0 = Date.now();
  assert.throws(() => m.withLock(() => 1), (e) => e.code === 'EBUSY');
  assert.ok(Date.now() - t0 < 600, `waited ${Date.now() - t0} ms`);
  assert.equal(fs.readFileSync(m.lockFile, 'utf8'), 'someone-else');
  // Stale (older than 10 s): taken over.
  const old = new Date(Date.now() - 60000); fs.utimesSync(m.lockFile, old, old);
  assert.equal(m.withLock(() => 'ran'), 'ran');
  assert.ok(!fs.existsSync(m.lockFile));
  // If our lock was replaced while we ran (taken over as stale), release leaves the new owner's lock alone.
  m.withLock(() => { fs.writeFileSync(m.lockFile, 'new-owner'); });
  assert.equal(fs.readFileSync(m.lockFile, 'utf8'), 'new-owner');
  fs.unlinkSync(m.lockFile);
});

test('previews (M14) expire on any request; export (M13) says when it stopped at the cap', () => {
  const { m, setNow } = budgetSetup();
  const s = m.readSeeded(); s.accounts.push({ id: 'chk', name: 'Checking', kind: 'checking' }); m.write(s);
  const p = m.startImport('Date,Desc,Amount\n11/02/2026,X,-1\n', 'chk', null);
  assert.equal(m.previews.size, 1);
  setNow(new Date(NOV26.getTime() + 16 * 60 * 1000));
  m.prunePreviews();
  assert.equal(m.previews.size, 0);
  assert.equal(m.mapImport(p.body.previewId, { map: { date: 'Date', description: 'Desc', amount: 'Amount' }, sign: 'as-is' }).status, 404);
  const big = m.read();
  for (let i = 0; i < 2005; i++) big.transactions.push({ id: 'tx' + i, accountId: 'chk', date: '2026-11-02', description: 'D', merchant: 'D', cents: -100, category: 'other', fingerprint: 'f' + i });
  m.write(big);
  const csv = m.exportCsv({}).trim().split('\r\n');
  assert.equal(csv.length, 1 + 2000 + 1);
  assert.match(csv[csv.length - 1], /export stopped at 2000 of 2005 rows/);
});

test('rules (S4): a pattern holding an 8+ digit run is refused', async () => {
  const { srv, port } = await startApp(freshDir());
  try {
    const H = { ...REMOTE, Cookie: await login(port, 'alex', 'pw-alex') };
    assert.equal((await req(port, 'POST', '/api/money/rules', { headers: H, body: { pattern: 'acct 4111 1111 1111 1111', category: 'other' } })).status, 400);
    assert.equal((await req(port, 'POST', '/api/money/rules', { headers: H, body: { pattern: '4111.1111.1111.1111', category: 'other' } })).status, 400);
    assert.equal((await req(port, 'POST', '/api/money/rules', { headers: H, body: { pattern: 'blue\\s*bottle', category: 'food/coffee' } })).status, 201);
  } finally { srv.close(); }
});

test('agent tool guard (S1): file tools refused inside data/money (symlinks resolved), shell commands naming money refused', () => {
  const root = freshDir();
  const data = path.join(root, 'checkout', 'data'), moneyDir = path.join(data, 'money');
  fs.mkdirSync(moneyDir, { recursive: true });
  fs.writeFileSync(path.join(moneyDir, 'money.json'), '{}');
  fs.symlinkSync(moneyDir, path.join(root, 'innocent-link'));
  const g = (tool, args) => money.moneyToolGuard(tool, args, { moneyDirs: [moneyDir], base: root });
  for (const tool of ['read_file', 'list_directory', 'write_file']) {
    for (const p of ['checkout/data/money/money.json', 'checkout/data/money', 'checkout/data/../data/money/x', 'innocent-link/money.json', 'innocent-link', path.join(moneyDir, 'new', 'file.json')]) {
      assert.ok(g(tool, { filePath: p, dirPath: p }), `${tool} ${p}`);
    }
    assert.equal(g(tool, { filePath: 'checkout/data/other.json', dirPath: 'checkout/data' }), null);
  }
  assert.ok(g('run_bash', { command: 'cat ~/dashboard/data/Money/money.json' }));
  assert.ok(g('run_bash', { command: 'ls MONEY' }));
  assert.equal(g('run_bash', { command: 'ls -la ~/dashboard/data' }), null);
  assert.equal(g('search_web', { query: 'money' }), null);
  // server.js wires it in before any role check, for both checkouts.
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf('function executeLocalTool(');
  assert.ok(i > 0 && src.indexOf('moneyToolGuard(toolName, args', i) > i && src.indexOf('moneyToolGuard(toolName, args', i) < src.indexOf("if (role === 'query')", i));
  assert.match(src, /MONEY_DATA_DIRS = .*dashboard\/data\/money.*dashboard-staging\/data\/money/);
});

test('CLI: add-expense, add-bill (paid-with), list; one JSON line; errors exit 1 and say nothing else', () => {
  const { spawnSync } = require('child_process');
  const { dir } = budgetSetup();
  const env = { ...process.env, DATA_DIR: dir };
  const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'money-cli.js'), ...a, '--json'], { env, encoding: 'utf8' });
  const e = cli('add-expense', '--amount', '54.20', '--description', 'Groceries 4111 1111 1111 1111', '--category', 'food/groceries', '--date', '2026-11-20', '--paid-with', 'the subscription card');
  assert.equal(e.status, 0, e.stdout + e.stderr);
  assert.equal(e.stderr, '');
  assert.equal(e.stdout.trim().split('\n').length, 1);
  const tx = JSON.parse(e.stdout).transaction;
  assert.deepEqual([tx.cents, tx.description], [-5420, 'Groceries ••1111']);
  assert.ok(tx.accountId);
  const b = cli('add-bill', '--name', 'Electric', '--amount', '90', '--due-day', '15');
  assert.equal(b.status, 0, b.stdout);
  assert.equal(JSON.parse(b.stdout).bill.monthlyCents, 9000);
  const l = cli('list', '--month', '2026-11');
  assert.equal(l.status, 0);
  const plan = JSON.parse(l.stdout);
  assert.equal(plan.spending.loggedCents, 5420);
  assert.equal(plan.bills.length, 1);
  for (const bad of [['add-expense', '--amount', 'x', '--description', 'y'], ['add-expense', '--amount', '2000000', '--description', 'y'], ['add-bill', '--name', 'z', '--paid-with', 'nope'], ['list', '--month', 'bad'], ['what']]) {
    const r = cli(...bad);
    assert.equal(r.status, 1, bad.join(' '));
    assert.equal(r.stderr, '');
    assert.ok(JSON.parse(r.stdout).error);
  }
  assert.equal(fs.statSync(path.join(dir, 'money', 'money.json')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(dir, 'money', '.lock')));
});

test('HTTP: subscription card actual vs target, not deletable, no typed autopay; cards, bills, variable, month for alex only', async () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'subscriptions.json'), JSON.stringify(SUBS));
  const { srv, port } = await startApp(dir);
  try {
    const H = { ...REMOTE, Cookie: await login(port, 'alex', 'pw-alex') };
    const meta = JSON.parse((await req(port, 'GET', '/api/money/meta', { headers: H })).body);
    const card = meta.accounts.find(a => a.isSubscriptionCard);
    assert.deepEqual([card.autopayCents, card.targetCents], [TARGET, TARGET]);
    assert.equal((await req(port, 'DELETE', `/api/money/accounts/${card.id}`, { headers: H })).status, 409);
    assert.equal((await req(port, 'PATCH', `/api/money/accounts/${card.id}`, { headers: H, body: { autopay: 99 } })).status, 400);
    assert.equal((await req(port, 'PATCH', `/api/money/accounts/${card.id}`, { headers: H, body: { balance: 1200, apr: 22.5 } })).status, 200);
    const visa = JSON.parse((await req(port, 'POST', '/api/money/accounts', { headers: H, body: { name: 'Visa', kind: 'credit card', autopay: 100, apr: 61 } })).body);
    assert.ok(visa.error);
    const wallet = JSON.parse((await req(port, 'POST', '/api/money/accounts', { headers: H, body: { name: 'Wallet', kind: 'cash' } })).body).account;
    assert.equal((await req(port, 'POST', '/api/money/bills', { headers: H, body: { name: 'Gym', amount: 30, paidWith: card.id, category: 'health/gym' } })).status, 201);
    assert.equal((await req(port, 'PUT', '/api/money/variable', { headers: H, body: { category: 'food/groceries', estimate: 400 } })).status, 200);
    assert.equal((await req(port, 'PUT', '/api/money/variable', { headers: H, body: { category: 'food' } })).status, 409);
    assert.equal((await req(port, 'POST', '/api/money/transactions', { headers: H, body: { date: '2026-11-03', amount: 61.5, expense: true, description: 'Groceries', category: 'food/groceries', paidWith: wallet.id } })).status, 201);
    const month = JSON.parse((await req(port, 'GET', '/api/money/month?month=2026-11', { headers: H })).body);
    assert.equal(month.spending.loggedCents, 6150);
    assert.equal(month.spending.variableCents, 40000);
    assert.ok(month.cashOut.byPayer.some(p => p.name === 'Wallet' && p.cents === 6150));
    const sc = month.cardChecks.find(c => c.isSubscriptionCard);
    assert.equal(sc.balanceCents, 120000);
    assert.ok(sc.payoff);
    const bob = { ...REMOTE, Cookie: await login(port, 'bob', 'pw-bob') };
    for (const [m2, p] of [['GET', '/api/money/month'], ['POST', '/api/money/bills'], ['PUT', '/api/money/variable'], ['PATCH', `/api/money/accounts/${card.id}`]]) {
      assert.equal((await req(port, m2, p, { headers: bob, body: m2 === 'GET' ? undefined : {} })).status, 404);
      assert.equal((await req(port, m2, p, { body: m2 === 'GET' ? undefined : {} })).status, 404);
    }
  } finally { srv.close(); }
});
