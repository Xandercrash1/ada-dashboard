// Invite and reset links (Alex, 2026-11-09: "Plan — Roles (Admin, 303, Guest).md" § Profile creation).
// Only an admin makes a link. It works once and expires after 48 hours. The person
// picks their own username, display name and password, so no password passes
// through Alex. A reset link sets a new password for one existing account.
// data/invites.json (600) keeps only a hash of each token; the link itself is
// shown to the admin once.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 48 * 3600 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;           // used/expired entries are kept 30 days, then pruned
const INVITE_ROLES = ['303', 'guest'];           // admins are never made by link
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function create({ dataDir, users, baseUrl, pageFile, now = () => Date.now() }) {
  const file = path.join(dataDir, 'invites.json');
  const read = () => { try { const l = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(l) ? l : []; } catch (e) { return []; } };
  const write = (list) => {
    const t = now();
    const kept = list.filter(x => !(x.usedAt || x.revokedAt || x.expiresAt < t) || (x.expiresAt + KEEP_MS > t));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const live = (x) => x && !x.usedAt && !x.revokedAt && x.expiresAt > now();
  const pub = (x) => ({ id: x.id, kind: x.kind, role: x.role || null, username: x.username || null, by: x.by, createdAt: new Date(x.createdAt).toISOString(), expiresAt: new Date(x.expiresAt).toISOString() });
  const findLive = (token) => TOKEN_RE.test(String(token || '')) ? read().find(x => x.tokenHash === hash(token) && live(x)) || null : null;
  const make = (fields) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    const entry = { id: 'inv-' + crypto.randomBytes(6).toString('hex'), tokenHash: hash(token), createdAt: t, expiresAt: t + TTL_MS, ...fields };
    let list = read();
    // A new reset link replaces any earlier one for the same account.
    if (entry.kind === 'reset') list = list.map(x => (x.kind === 'reset' && x.username === entry.username && live(x)) ? { ...x, revokedAt: t } : x);
    list.push(entry); write(list);
    return { ...pub(entry), url: `${baseUrl}/invite/${token}` };
  };

  // Failed lookups per IP: a token can't be guessed, but nobody gets to try.
  const misses = new Map();
  const tooMany = (ip) => { const m = misses.get(ip); return !!m && m.n >= 20 && now() - m.at < 10 * 60 * 1000; };
  const miss = (ip) => { const m = misses.get(ip); const t = now(); misses.set(ip, (!m || t - m.at > 10 * 60 * 1000) ? { n: 1, at: t } : { n: m.n + 1, at: m.at }); };
  const gone = (res) => res.status(404).json({ error: 'This link has expired or was already used. Ask for a new one.' });

  function mountPublic(app, { getClientIp }) {
    app.get('/invite/:token', (req, res) => { res.set('Referrer-Policy', 'no-referrer'); res.sendFile(pageFile); });
    app.get('/api/invite/:token', (req, res) => {
      res.set('Referrer-Policy', 'no-referrer');
      const ip = getClientIp(req);
      if (tooMany(ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
      const x = findLive(req.params.token);
      if (!x) { miss(ip); return gone(res); }
      res.json({ kind: x.kind, role: x.role || null, username: x.username || null, expiresAt: new Date(x.expiresAt).toISOString() });
    });
    app.post('/api/invite/:token', (req, res) => {
      const ip = getClientIp(req);
      if (tooMany(ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
      const x = findLive(req.params.token);
      if (!x) { miss(ip); return gone(res); }
      const b = req.body || {};
      try {
        let username;
        if (x.kind === 'reset') {
          const u = users.find(x.username);
          if (!u || u.disabled) return gone(res);
          users.update(x.username, { password: b.password });    // ends that account's sessions
          username = x.username;
        } else {
          username = users.create({ username: b.username, password: b.password, role: x.role, displayName: b.displayName }).username;
        }
        // Mark used only after success: a taken username or short password can be fixed and resent.
        write(read().map(y => y.id === x.id ? { ...y, usedAt: now(), usedBy: username } : y));
        res.json({ ok: true, username });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
  }

  // Behind requireAuth; authorizeRole lets only admins reach these.
  function mountAdmin(app, { isAdminReq, ownerName }) {
    const adminOnly = (req, res) => { if (isAdminReq(req)) return false; res.status(403).json({ error: 'Not available for your account.' }); return true; };
    app.get('/api/invites', (req, res) => { if (adminOnly(req, res)) return; res.json(read().filter(live).map(pub)); });
    app.post('/api/invites', (req, res) => {
      if (adminOnly(req, res)) return;
      const role = req.body && req.body.role;
      if (!INVITE_ROLES.includes(role)) return res.status(400).json({ error: 'Role must be 303 or guest.' });
      res.status(201).json(make({ kind: 'invite', role, by: ownerName(req) }));
    });
    app.post('/api/users/:username/reset-link', (req, res) => {
      if (adminOnly(req, res)) return;
      const u = users.find(req.params.username);
      if (!u) return res.status(404).json({ error: 'No such user.' });
      if (u.disabled) return res.status(400).json({ error: 'Enable the account first.' });
      res.status(201).json(make({ kind: 'reset', username: u.username, by: ownerName(req) }));
    });
    app.delete('/api/invites/:id', (req, res) => {
      if (adminOnly(req, res)) return;
      const list = read(); const x = list.find(y => y.id === req.params.id && live(y));
      if (!x) return res.status(404).json({ error: 'No such link.' });
      write(list.map(y => y.id === x.id ? { ...y, revokedAt: now() } : y));
      res.json({ ok: true });
    });
  }
  return { mountPublic, mountAdmin, TTL_MS };
}
module.exports = { create };
