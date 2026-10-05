'use strict';

/**
 * Tests for devices.js (One Ada P2-2). No framework, plain assertions:
 *   node src/devices.test.js
 * Exits non-zero on first failure. Uses a temp dir; never touches ~/.ssh.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const devices = require('./devices');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-test-'));
const keysFile = path.join(tmp, 'authorized_keys');
let n = 0;
const ok = (name) => { n++; console.log('ok', n, name); };

// a real ed25519 public key, generated fresh
function genKey() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]);
  return 'ssh-ed25519 ' + blob.toString('base64');
}
const K1 = genKey(), K2 = genKey();
const b64 = (k) => k.split(' ')[1];

// ---- parseEd25519: accepts
assert.ok(devices.parseEd25519(K1).fingerprint.startsWith('SHA256:'));
assert.strictEqual(devices.parseEd25519(K1 + ' ada-adatwo').b64, b64(K1));
assert.strictEqual(devices.parseEd25519('  ' + K1 + '  ').b64, b64(K1));
ok('parse accepts a plain key, with comment, with whitespace');

// ---- parseEd25519: injection and junk rejected
const bad = [
  `command="rm -rf ~" ${K1}`,                // options prefix
  `from="*" ${K1}`,
  `${K1}\nssh-ed25519 ${b64(K2)} evil`,      // second line smuggled
  `${K1}\r`,
  `${K1} two words`,                         // extra field
  `${K1}\0`,
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== x',
  'ssh-ed25519 ' + 'A'.repeat(68),           // right length, wrong blob
  'ssh-ed25519 ' + b64(K1).slice(0, 60),
  '', null, 42, { a: 1 },
];
for (const k of bad) assert.throws(() => devices.parseEd25519(k), undefined, JSON.stringify(k));
ok('parse rejects options, newlines, extra fields, rsa, bad blobs, non-strings');

// ---- hostname
assert.strictEqual(devices.sanitizeHostname('AdaTwo'), 'adatwo');
assert.strictEqual(devices.sanitizeHostname('my host;rm -rf/'), 'myhostrm-rf');
assert.throws(() => devices.sanitizeHostname(';;;'));
ok('hostname sanitized');

// ---- keys file: static lines are never touched
const STATIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStaticMacKeyStaticMacKeyStaticMacKeyXX alex@The-Macbook.lan\nssh-rsa AAAAB3Nza vps-agent';
fs.writeFileSync(keysFile, STATIC, { mode: 0o600 });   // no trailing newline on purpose
assert.strictEqual(devices.addKey(keysFile, { b64: b64(K1), hostname: 'adatwo' }), true);
assert.strictEqual(devices.addKey(keysFile, { b64: b64(K1), hostname: 'adatwo' }), false);   // idempotent
devices.addKey(keysFile, { b64: b64(K2), hostname: 'adaone' });
let txt = fs.readFileSync(keysFile, 'utf8');
assert.ok(txt.startsWith(STATIC + '\n'), 'static lines intact, newline added');
assert.strictEqual(txt.split('\n').filter((l) => l.includes(b64(K1))).length, 1);
assert.ok(txt.includes(`ssh-ed25519 ${b64(K1)} ada-adatwo\n`));
assert.strictEqual(fs.statSync(keysFile).mode & 0o777, 0o600);
ok('addKey appends once, keeps static lines, mode 600');

assert.strictEqual(devices.removeKey(keysFile, { b64: b64(K1) }), 1);
txt = fs.readFileSync(keysFile, 'utf8');
assert.ok(txt.startsWith(STATIC + '\n') && !txt.includes(b64(K1)) && txt.includes(b64(K2)));
assert.strictEqual(fs.statSync(keysFile).mode & 0o777, 0o600);
ok('removeKey removes only that ada- line, keeps mode');

// a matching blob WITHOUT an ada- comment (a hand-added line) is never removed
fs.appendFileSync(keysFile, `ssh-ed25519 ${b64(K1)} hand-added\n`);
assert.strictEqual(devices.removeKey(keysFile, { b64: b64(K1) }), 0);
assert.ok(fs.readFileSync(keysFile, 'utf8').includes(`${b64(K1)} hand-added`));
ok('removeKey never touches a non-ada line, even with the same key');
assert.strictEqual(devices.addKey(keysFile, { b64: b64(K1), hostname: 'adatwo' }), false);
ok('addKey does not duplicate a key that is already present by hand');
fs.writeFileSync(keysFile, STATIC + '\n', { mode: 0o600 });   // reset for the service tests

// ---- service: token, enroll, poll, decide
(async () => {
  const mails = [];
  const svc = devices.create({ dataDir: tmp, isLive: false, keysFile, baseUrl: 'https://example.test/', mail: async (m) => { mails.push(m); return { ok: true }; } });
  const { token } = svc.mintToken();

  let r = await svc.enroll({ token: 'nope', hostname: 'adatwo', pubkey: K1, ip: '1.1.1.1' });
  assert.strictEqual(r.status, 401);
  r = await svc.enroll({ token, hostname: 'adatwo', pubkey: `command="x" ${K1}`, ip: '1.1.1.1' });
  assert.strictEqual(r.status, 400);
  ok('enroll rejects a bad token and a bad key (key checked first: token not burned)');

  r = await svc.enroll({ token, hostname: 'AdaTwo', pubkey: K1, ip: '1.1.1.1' });
  assert.strictEqual(r.status, 201);
  const { id, pollSecret } = r.body;
  assert.strictEqual(mails.length, 1);
  assert.ok(mails[0].text.includes(`https://example.test/devices/confirm/${id}`));
  assert.ok(mails[0].text.includes(r.body.fingerprint));
  r = await svc.enroll({ token, hostname: 'adatwo', pubkey: K2, ip: '1.1.1.1' });
  assert.strictEqual(r.status, 401);
  ok('enroll succeeds once, emails the confirm link, token is single-use');

  assert.strictEqual(svc.poll(id, 'wrong').status, 404);
  assert.strictEqual(svc.poll(id, pollSecret).body.status, 'pending');
  assert.strictEqual(svc.poll(id, pollSecret).body.sshHost, undefined);
  ok('poll needs the secret; pending reveals no host');

  assert.strictEqual(svc.decide(id, 'revoke').status, 409);
  assert.strictEqual(svc.decide(id, 'approve').status, 200);
  assert.strictEqual(svc.poll(id, pollSecret).body.status, 'approved');
  assert.strictEqual(svc.poll(id, pollSecret).body.sshUser, 'ubuntu');
  assert.ok(fs.readFileSync(keysFile, 'utf8').includes(`ssh-ed25519 ${b64(K1)} ada-adatwo`));
  assert.strictEqual(svc.decide(id, 'approve').status, 409);
  ok('approve writes the key once; poll reports approved');

  assert.strictEqual(svc.decide(id, 'revoke').status, 200);
  assert.ok(!fs.readFileSync(keysFile, 'utf8').includes(`${b64(K1)} ada-adatwo`));
  assert.ok(fs.readFileSync(keysFile, 'utf8').startsWith(STATIC + '\n'));
  ok('revoke removes it; static lines intact');

  // expired token
  const d = svc._store.read(); const t2 = svc.mintToken();
  const d2 = svc._store.read(); d2.tokens.forEach((t) => { t.expiresAt = Date.now() - 1; }); fs.writeFileSync(path.join(tmp, 'devices.json'), JSON.stringify(d2));
  r = await svc.enroll({ token: t2.token, hostname: 'x', pubkey: K2, ip: '2.2.2.2' });
  assert.strictEqual(r.status, 401);
  ok('expired token rejected');

  // rate limit per IP
  let last;
  for (let i = 0; i < 11; i++) last = await svc.enroll({ token: 'x', hostname: 'x', pubkey: K2, ip: '9.9.9.9' });
  assert.strictEqual(last.status, 429);
  ok('rate limited after 10 attempts/hour per IP');

  // no secrets in the stored file beyond hashes
  const raw = fs.readFileSync(path.join(tmp, 'devices.json'), 'utf8');
  assert.ok(!raw.includes(pollSecret) && !raw.includes(token));
  ok('store holds only hashes of tokens and poll secrets');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`all ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
