'use strict';

/**
 * devices.js — One Ada device enrollment (Plan — One Ada.md § 4, P2-2).
 *
 * A new machine joins Ada by getting its own SSH key onto this box, approved by
 * Alex from an email. Flow:
 *   1. Alex (logged in) mints a single-use enrollment token on the start-up page.
 *   2. The joining session POSTs {token, hostname, pubkey} to /api/devices/enroll
 *      (token-authenticated: mounted BEFORE requireAuth).
 *   3. Alex gets an email; the link opens /devices/confirm/:id, which requires an
 *      admin login. A stolen email alone approves nothing.
 *   4. On Approve, the key is appended to the keys file; the session, polling
 *      /api/devices/enroll/:id, sees "approved" and tests ssh.
 *
 * THE SECURITY-CRITICAL PART is the authorized_keys write. Only a bare
 * `ssh-ed25519 <base64>` is accepted — decoded and re-checked — and the line is
 * rebuilt by the server with its own `ada-<host>` comment, so no client text
 * (options like command=/from=, newlines, extra fields) ever reaches the file.
 * Code only ever removes lines whose comment starts `ada-` AND whose key blob
 * matches; the static keys (the Mac, vps-agent) are never touched.
 *
 * The keys file is per instance: only LIVE (port 3000) writes ~/.ssh/authorized_keys;
 * staging writes a scratch file. Override with DEVICE_KEYS_FILE.
 *
 * Not a sandbox: like the rest of the app (see the /api/staging/promote note),
 * anything already running as `ubuntu` could write authorized_keys directly.
 * This adds a path, not a privilege.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sendMail } = require('./mailer');

const TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 5;
const ENROLL_LIMIT_PER_HOUR = 10;   // per client IP, failed or not
const COMMENT_PREFIX = 'ada-';

// ---------------------------------------------------------------- validation

/**
 * Parses a public key line. Returns { b64, fingerprint } or throws.
 * Accepts ONLY "ssh-ed25519 <68 base64 chars>" with an optional client comment,
 * which is discarded. The blob is decoded and its internal structure verified.
 */
function parseEd25519(input) {
  if (typeof input !== 'string') throw new Error('pubkey must be a string');
  if (/[\r\n\0]/.test(input)) throw new Error('pubkey must be a single line');
  const line = input.trim();
  if (line.length > 300) throw new Error('pubkey too long');
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [\x21-\x7e]{1,100})?$/.exec(line);
  if (!m) throw new Error('only a plain "ssh-ed25519 AAAA… [comment]" key is accepted');
  const blob = Buffer.from(m[1], 'base64');
  if (blob.length !== 51) throw new Error('bad ed25519 key length');
  if (blob.readUInt32BE(0) !== 11 || blob.toString('ascii', 4, 15) !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32) {
    throw new Error('malformed ed25519 key blob');
  }
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { b64: m[1], fingerprint };
}

/** Lowercases and restricts to [a-z0-9-]; throws if nothing usable remains. */
function sanitizeHostname(input) {
  const h = String(input || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!h) throw new Error('hostname required');
  return h;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = (bytes) => crypto.randomBytes(bytes).toString('base64url');
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- keys file

function keyBlobOf(line) {
  const m = /^\s*(?:\S+\s+)?ssh-ed25519\s+([A-Za-z0-9+/=]+)/.exec(line);   // tolerant read; we never rewrite foreign lines
  return m ? m[1] : null;
}
function commentOf(line) {
  const parts = line.trim().split(/\s+/);
  return parts.length >= 3 ? parts.slice(2).join(' ') : '';
}

function withLock(file, fn) {
  const lock = file + '.ada-lock';
  let fd;
  for (let i = 0; i < 50; i++) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // a lock older than 30 s is stale (a crashed writer)
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch {}
      const until = Date.now() + 20; while (Date.now() < until) {}   // brief spin; writes are tiny and rare
    }
  }
  if (fd === undefined) throw new Error('keys file is locked');
  try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}

/** Appends the device's key line unless that key blob is already present. Returns true if written. */
function addKey(file, { b64, hostname }) {
  return withLock(file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split('\n').some((l) => keyBlobOf(l) === b64)) return false;
    const line = `ssh-ed25519 ${b64} ${COMMENT_PREFIX}${hostname}\n`;
    const sep = cur.length && !cur.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, sep + line, { mode: 0o600 });
    return true;
  });
}

/** Removes ONLY lines with an ada- comment AND this key blob. Returns lines removed. */
function removeKey(file, { b64 }) {
  return withLock(file, () => {
    if (!fs.existsSync(file)) return 0;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const keep = lines.filter((l) => !(keyBlobOf(l) === b64 && commentOf(l).startsWith(COMMENT_PREFIX)));
    const removed = lines.length - keep.length;
    if (!removed) return 0;
    const foreign = (ls) => ls.filter((l) => l.trim() && !commentOf(l).startsWith(COMMENT_PREFIX)).join('\n');
    if (foreign(keep) !== foreign(lines)) throw new Error('refusing to rewrite: a non-ada line would change');
    const mode = fs.statSync(file).mode & 0o777;
    const tmp = `${file}.ada-tmp-${process.pid}`;
    fs.writeFileSync(tmp, keep.join('\n'), { mode });
    fs.renameSync(tmp, file);
    return removed;
  });
}

// ---------------------------------------------------------------- store

function createStore(file) {
  const empty = () => ({ devices: [], tokens: [] });
  const read = () => {
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { devices: d.devices || [], tokens: d.tokens || [] }; }
    catch (e) { if (e.code === 'ENOENT') return empty(); throw e; }
  };
  const write = (d) => {
    const now = Date.now();
    d.tokens = d.tokens.filter((t) => !t.usedAt && t.expiresAt > now);   // spent and expired tokens are dropped
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return { read, write };
}

const publicView = (d) => ({
  id: d.id, hostname: d.hostname, fingerprint: d.fingerprint, status: d.status,
  requestedAt: d.requestedAt, decidedAt: d.decidedAt || null, requestIp: d.requestIp || null,
});

// ---------------------------------------------------------------- service

/**
 * create({ dataDir, isLive, baseUrl, keysFile?, mail? }) → { mountPublic(app), mountAdmin(app, { isAdminReq }), ... }
 * `mail` is injectable for tests; defaults to the Resend mailer.
 */
function create(opts) {
  const store = createStore(path.join(opts.dataDir, 'devices.json'));
  const keysFile = opts.keysFile || process.env.DEVICE_KEYS_FILE
    || (opts.isLive ? path.join(os.homedir(), '.ssh/authorized_keys') : path.join(os.homedir(), 'ops/test-authorized_keys'));
  const mail = opts.mail || sendMail;
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const hits = new Map();   // ip → [timestamps], enrollment rate limit

  function rateLimited(ip) {
    const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
    list.push(now); hits.set(ip, list);
    return list.length > ENROLL_LIMIT_PER_HOUR;
  }

  function mintToken() {
    const token = randomId(24), d = store.read();
    d.tokens.push({ hash: sha256(token), expiresAt: Date.now() + TOKEN_TTL_MS });
    store.write(d);
    return { token, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString() };
  }

  async function enroll({ token, hostname, pubkey, ip }) {
    if (rateLimited(ip || 'unknown')) return { status: 429, body: { error: 'Too many enrollment attempts; try again later.' } };
    let key, host;
    try { key = parseEd25519(pubkey); host = sanitizeHostname(hostname); }
    catch (e) { return { status: 400, body: { error: e.message } }; }
    const d = store.read(), now = Date.now(), h = sha256(token || '');
    const t = d.tokens.find((x) => safeEqualHex(x.hash, h));
    if (!t || t.usedAt || t.expiresAt <= now) return { status: 401, body: { error: 'Enrollment token invalid, used or expired. Generate a new one on the start-up page.' } };
    t.usedAt = now;   // burned before anything else can fail
    if (d.devices.filter((x) => x.status === 'pending').length >= MAX_PENDING) { store.write(d); return { status: 429, body: { error: 'Too many pending devices; approve or deny some first.' } }; }
    const pollSecret = randomId(24);
    const dev = {
      id: randomId(12), hostname: host, b64: key.b64, fingerprint: key.fingerprint, status: 'pending',
      pollHash: sha256(pollSecret), requestedAt: new Date(now).toISOString(), requestIp: ip || null,
    };
    d.devices.push(dev);
    store.write(d);
    const link = `${baseUrl}/devices/confirm/${dev.id}`;
    const sent = await mail({
      subject: `Ada: approve new device "${host}"?`,
      text: [
        `A machine is asking to join Ada with SSH access to the VPS.`, ``,
        `Device:      ${host}`, `Fingerprint: ${key.fingerprint}`, `From IP:     ${ip || 'unknown'}`, `Requested:   ${dev.requestedAt}`, ``,
        `Approve or deny (requires your dashboard login):`, link, ``,
        `If you didn't start a device setup just now, click Deny.`,
      ].join('\n'),
    });
    return { status: 201, body: { id: dev.id, pollSecret, fingerprint: key.fingerprint, hostname: host, status: 'pending', emailSent: !!sent.ok } };
  }

  function poll(id, secret) {
    const dev = store.read().devices.find((x) => x.id === id);
    if (!dev || !safeEqualHex(dev.pollHash, sha256(secret || ''))) return { status: 404, body: { error: 'Unknown enrollment.' } };
    return { status: 200, body: { status: dev.status, hostname: dev.hostname, fingerprint: dev.fingerprint, ...(dev.status === 'approved' ? { sshHost: '158.69.211.140', sshUser: 'ubuntu' } : {}) } };
  }

  function decide(id, action) {
    const d = store.read(), dev = d.devices.find((x) => x.id === id);
    if (!dev) return { status: 404, body: { error: 'Unknown device.' } };
    const now = new Date().toISOString();
    if (action === 'approve') {
      if (dev.status !== 'pending') return { status: 409, body: { error: `Device is ${dev.status}, not pending.` } };
      addKey(keysFile, { b64: dev.b64, hostname: dev.hostname });
      dev.status = 'approved'; dev.decidedAt = now;
    } else if (action === 'deny') {
      if (dev.status !== 'pending') return { status: 409, body: { error: `Device is ${dev.status}, not pending.` } };
      dev.status = 'denied'; dev.decidedAt = now;
    } else if (action === 'revoke') {
      if (dev.status !== 'approved') return { status: 409, body: { error: `Device is ${dev.status}, not approved.` } };
      removeKey(keysFile, { b64: dev.b64 });
      dev.status = 'revoked'; dev.decidedAt = now;
    } else return { status: 400, body: { error: 'Unknown action.' } };
    store.write(d);
    return { status: 200, body: publicView(dev) };
  }

  function confirmPage(dev) {
    const pending = dev.status === 'pending';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve device · Ada</title><style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px;display:flex;justify-content:center}
.card{max-width:520px;width:100%;background:#181b22;border:1px solid #2a2f3a;border-radius:12px;padding:24px}
dt{color:#9aa3b2;font-size:13px;margin-top:12px}dd{margin:2px 0 0;font-family:ui-monospace,monospace;word-break:break-all}
.row{display:flex;gap:12px;margin-top:24px}button{flex:1;padding:12px;border-radius:8px;border:0;font-size:15px;cursor:pointer}
#ok{background:#2f9e5b;color:#fff}#no{background:#3a3f4b;color:#fff}#msg{margin-top:16px}</style></head><body><div class="card">
<h2 style="margin-top:0">${pending ? 'Approve this device?' : 'Device ' + esc(dev.status)}</h2>
<dl><dt>Device</dt><dd>${esc(dev.hostname)}</dd><dt>Key fingerprint</dt><dd>${esc(dev.fingerprint)}</dd>
<dt>Requested</dt><dd>${esc(dev.requestedAt)} from ${esc(dev.requestIp || 'unknown')}</dd></dl>
${pending ? `<p>Approving gives this machine SSH access to the VPS as <code>ubuntu</code>. Revoke it any time from the device list.</p>
<div class="row"><button id="ok">Approve</button><button id="no">Deny</button></div>` : ''}<div id="msg"></div></div>
<script>
async function act(a){
  const r = await fetch('/api/devices/${encodeURIComponent(dev.id)}/' + a, { method: 'POST', headers: { 'X-Device-Confirm': '1' } });
  const b = await r.json().catch(() => ({}));
  document.getElementById('msg').textContent = r.ok ? ('Done: device is ' + b.status + '. The setup session will continue on its own.') : ('Error: ' + (b.error || r.status));
  if (r.ok) document.querySelectorAll('button').forEach(x => x.disabled = true);
}
const ok = document.getElementById('ok'), no = document.getElementById('no');
if (ok) ok.onclick = () => act('approve'); if (no) no.onclick = () => act('deny');
</script></body></html>`;
  }

  /** Token-authenticated routes. MUST be mounted BEFORE requireAuth. */
  function mountPublic(app) {
    app.post('/api/devices/enroll', async (req, res) => {
      const b = req.body || {};
      const r = await enroll({ token: b.token, hostname: b.hostname, pubkey: b.pubkey, ip: req.ip });
      res.status(r.status).json(r.body);
    });
    app.get('/api/devices/enroll/:id', (req, res) => {
      const r = poll(req.params.id, req.query.s);
      res.status(r.status).json(r.body);
    });
  }

  /** Admin routes. Mount AFTER requireAuth + the role wall (which already 403s pages users on /api/*). */
  function mountAdmin(app, { isAdminReq }) {
    const adminOnly = (req, res, next) => (isAdminReq(req) ? next() : res.status(403).json({ error: 'Not available for your account.' }));
    // A custom header blocks cross-site POSTs (same pattern as X-Promote-Confirm).
    const confirmHeader = (req, res, next) => (req.get('X-Device-Confirm') === '1' ? next() : res.status(400).json({ error: 'Missing X-Device-Confirm header.' }));
    app.post('/api/devices/enroll-token', adminOnly, confirmHeader, (req, res) => res.json(mintToken()));
    app.get('/api/devices', adminOnly, (req, res) => res.json(store.read().devices.map(publicView)));
    app.post('/api/devices/:id/:action(approve|deny|revoke)', adminOnly, confirmHeader, (req, res) => {
      try { const r = decide(req.params.id, req.params.action); res.status(r.status).json(r.body); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });
    // Not under /api/, so the role wall lets pages users through: the admin check here is the real gate.
    app.get('/devices/confirm/:id', (req, res) => {
      if (!isAdminReq(req)) return res.status(403).send('Not available for your account.');
      const dev = store.read().devices.find((x) => x.id === req.params.id);
      if (!dev) return res.status(404).send('Unknown device.');
      res.set('Content-Type', 'text/html; charset=utf-8').send(confirmPage(dev));
    });
  }

  return { mountPublic, mountAdmin, mintToken, enroll, poll, decide, keysFile, _store: store };
}

module.exports = { create, parseEd25519, sanitizeHostname, addKey, removeKey, COMMENT_PREFIX };
