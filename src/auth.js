/**
 * auth.js — drop-in session-cookie authentication for the Ada Operations Hub
 * dashboard.
 *
 * Zero external dependencies. Uses only Node's built-in `crypto` module:
 *   - scrypt for password hashing (slow, memory-hard, no extra package)
 *   - timingSafeEqual for constant-time comparisons
 *   - a signed, opaque session token (HMAC-SHA256) so sessions need no
 *     server-side store and survive nothing crossing the wire but a cookie
 *
 * See README.md in this directory for the full design rationale, and
 * `Integration Spec.md` for exactly how to wire this into server.js.
 *
 * ---------------------------------------------------------------------
 * WHERE THE CREDENTIALS FILE LIVES (read this before deploying)
 * ---------------------------------------------------------------------
 * `deploy.sh` rsyncs the *entire* `dashboard/` folder (minus node_modules
 * and .git) from the Mac to the VPS. Anything placed inside that folder,
 * including a "hidden" dotfile, gets copied back and forth on every
 * deploy and could be accidentally committed if the tree is ever put
 * under git. So the credentials file (password hash + session secret)
 * is NOT read from inside `dashboard/` by default.
 *
 * Resolution order (first that exists wins):
 *   1. AUTH_CREDENTIALS_FILE env var, if set
 *   2. /home/ubuntu/.ada-dashboard-auth.json   (VPS — outside the synced tree)
 *   3. <repo-root>/../.ada-dashboard-auth.json (local dev fallback, i.e.
 *      one level above `dashboard/`, still outside the synced folder)
 *
 * If none of these exist, mountAuth() will throw with a clear message
 * instead of silently running unauthenticated.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------
// Credentials file location
// ---------------------------------------------------------------------

function resolveCredentialsPath() {
  if (process.env.AUTH_CREDENTIALS_FILE) {
    return process.env.AUTH_CREDENTIALS_FILE;
  }
  const vpsPath = '/home/ubuntu/.ada-dashboard-auth.json';
  if (fs.existsSync(vpsPath)) return vpsPath;

  // Local dev fallback: one directory above wherever this file's caller's
  // dashboard root is. We assume auth.js is required from server.js at
  // dashboard/src/server.js, so __dirname there is dashboard/src. We can't
  // know that from here, so the fallback is resolved relative to CWD's
  // parent-of-dashboard convention: <Antigravity>/.ada-dashboard-auth.json
  const localFallback = path.join(__dirname, '..', '.ada-dashboard-auth.json');
  return localFallback;
}

function loadCredentials(credPath) {
  if (!fs.existsSync(credPath)) {
    throw new Error(
      `[auth.js] No credentials file found at "${credPath}". ` +
      `Run "node auth.js --setup" (see README.md) to create one, or set ` +
      `AUTH_CREDENTIALS_FILE to point at an existing one.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  if (!raw.passwordHash || !raw.salt || !raw.sessionSecret) {
    throw new Error(`[auth.js] Credentials file at "${credPath}" is missing required fields.`);
  }
  return raw;
}

// ---------------------------------------------------------------------
// Password hashing (scrypt) + constant-time verification
// ---------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
}

function verifyPassword(password, saltHex, hashHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = hashPassword(password, salt);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------
// Session token: opaque, signed, stateless.
// Format: base64url(payload).base64url(hmac)
// payload = JSON { iat: <ms>, exp: <ms> }
// ---------------------------------------------------------------------

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function signToken(payloadObj, secret) {
  const payload = b64url(JSON.stringify(payloadObj));
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest();
  const sig = b64url(hmac);
  return `${payload}.${sig}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest();
  const expectedSig = b64url(expectedHmac);

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let obj;
  try {
    obj = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!obj || typeof obj.exp !== 'number' || Date.now() > obj.exp) return null;
  return obj;
}

// ---------------------------------------------------------------------
// Cookie helpers (no dependency — express doesn't parse cookies by
// default without cookie-parser, so we do the minimal parse ourselves)
// ---------------------------------------------------------------------

const COOKIE_NAME = 'ada_session';

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function isRequestOverTLS(req) {
  // Trust req.secure (set correctly if `app.set('trust proxy', ...)` is
  // configured and Caddy sets X-Forwarded-Proto) OR a direct TLS socket.
  if (req.secure) return true;
  const xfProto = req.headers['x-forwarded-proto'];
  if (xfProto && xfProto.split(',')[0].trim() === 'https') return true;
  return false;
}

function buildCookieHeader(token, req) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isRequestOverTLS(req)) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function buildClearCookieHeader(req) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (isRequestOverTLS(req)) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------
// Brute-force resistance: fixed-window lockout, in-memory (per process).
//
// This is a PER-KEY limiter — the key is normally the client's IP, but it
// is only ever as good as the key it's given. If the app sits behind a
// reverse proxy (Caddy, in production) and Express isn't told to trust
// it, every request's "IP" collapses to the proxy's own loopback address
// and this limiter becomes, in effect, ONE global counter shared by every
// visitor on the internet — see checkTrustProxyConfig() below, which
// exists specifically to catch that misconfiguration before it ships.
// ---------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

function createRateLimiter(maxAttempts = MAX_ATTEMPTS, lockoutMs = LOCKOUT_MS) {
  // Map<key, { count, firstAttemptAt, lockedUntil }>
  const attempts = new Map();

  function isLocked(key) {
    const rec = attempts.get(key);
    if (!rec) return false;
    if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
    if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
      attempts.delete(key);
      return false;
    }
    return false;
  }

  function recordFailure(key) {
    const now = Date.now();
    let rec = attempts.get(key);
    if (!rec || now - rec.firstAttemptAt > lockoutMs) {
      rec = { count: 0, firstAttemptAt: now, lockedUntil: null };
    }
    rec.count += 1;
    if (rec.count >= maxAttempts) {
      rec.lockedUntil = now + lockoutMs;
    }
    attempts.set(key, rec);
  }

  function recordSuccess(key) {
    attempts.delete(key);
  }

  function remainingLockMs(key) {
    const rec = attempts.get(key);
    if (!rec || !rec.lockedUntil) return 0;
    return Math.max(0, rec.lockedUntil - Date.now());
  }

  return { isLocked, recordFailure, recordSuccess, remainingLockMs };
}

// ---------------------------------------------------------------------
// Global backstop limiter — a SEPARATE, coarser counter shared across
// every client, independent of IP/key. Rationale (added after dispatcher
// review, 2026-08-26):
//
// Per-IP limiting alone is not immune to a DISTRIBUTED attempt — a
// botnet, or simply an attacker rotating through a handful of IPs/proxies,
// can stay under any single IP's threshold indefinitely while still
// hammering the login endpoint at volume. A global backstop trades a
// small amount of availability (a genuine, sustained, distributed attack
// will eventually lock Alex out too, briefly) for closing that gap: the
// threshold is set high enough (30 failures / 5 min) that it will not
// fire during normal single-user use — even a bad case of fat-fingering
// the password repeatedly won't reach it — but will fire well before a
// scripted attempt gets through any meaningful fraction of a real
// password's keyspace.
//
// This does NOT replace the per-IP limiter, which is still the first
// line of defense and the only one that isolates a single bad actor
// without affecting anyone else. It is deliberately a backstop, not the
// primary control.
// ---------------------------------------------------------------------

const GLOBAL_MAX_ATTEMPTS = 30;
const GLOBAL_LOCKOUT_MS = 2 * 60 * 1000; // 2 minutes

function createGlobalLimiter(maxAttempts = GLOBAL_MAX_ATTEMPTS, lockoutMs = GLOBAL_LOCKOUT_MS) {
  return createRateLimiter(maxAttempts, lockoutMs);
}

const GLOBAL_KEY = '__global__';

// ---------------------------------------------------------------------
// requireAuth middleware
// ---------------------------------------------------------------------

function makeRequireAuth(getSecret) {
  return function requireAuth(req, res, next) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    const session = token ? verifyToken(token, getSecret()) : null;
    if (!session) {
      // Distinguish API calls (JSON 401) from page loads (redirect to /login)
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    }
    req.session = session;
    next();
  };
}

// ---------------------------------------------------------------------
// 'trust proxy' check — this is the load-bearing safety check the
// dispatcher's review caught missing. Without app.set('trust proxy', ...)
// configured correctly, behind Caddy in production:
//
//   1. req.secure is always false, so the session cookie NEVER gets the
//      Secure flag, even when Alex is genuinely on HTTPS.
//   2. req.ip is always the proxy's own address (127.0.0.1) for EVERY
//      visitor, so the per-IP brute-force limiter above collapses into a
//      single counter shared by the whole internet — anyone can lock
//      Alex out of his own dashboard with 5 bad requests. This is a
//      denial-of-service dressed up as a security feature.
//
// This must be caught loudly, not left as a passing code comment (which
// is exactly the state the dispatcher found and flagged).
// ---------------------------------------------------------------------

function isTrustProxyConfigured(app) {
  const setting = app.get('trust proxy');
  // Express's default is `false`. Any other value (a number of hops, a
  // string like 'loopback', a boolean true, a custom function) counts as
  // configured — we are not in the business of judging whether the VALUE
  // is correct for this deployment, only whether it was set at all.
  return setting !== false && setting !== undefined;
}

function trustProxyWarningText() {
  return [
    '',
    '========================================================================',
    '[auth.js] WARNING: Express "trust proxy" is not configured.',
    '',
    'If this server is running behind a reverse proxy (Caddy, in production',
    'on the VPS), this means:',
    '  1. The session cookie will NEVER get the Secure flag, even over real',
    '     HTTPS, because req.secure is always false without this setting.',
    '  2. req.ip is always the PROXY\'S OWN address for every visitor, which',
    '     collapses the per-IP brute-force lockout into ONE GLOBAL counter.',
    '     Anyone on the internet can lock Alex out with 5 bad requests.',
    '',
    'Fix: before calling mountAuth(app), add (matching the number of proxy',
    'hops in front of this process — Caddy reverse-proxying directly to',
    'this process on the same VPS is exactly one hop):',
    '',
    "    app.set('trust proxy', 1);",
    '',
    'See Integration Spec.md for the exact placement. If this process is',
    'NOT behind any proxy (e.g. local development), this warning is safe',
    'to ignore — or pass { behindProxy: false } to mountAuth() to silence it.',
    '========================================================================',
    '',
  ].join('\n');
}

/**
 * Checks the app's trust-proxy configuration and either throws, warns, or
 * says nothing, depending on `behindProxy`:
 *   - behindProxy === true  -> REQUIRED. Throws if not configured. Use
 *     this in production (see Integration Spec.md).
 *   - behindProxy === false -> Not behind a proxy (e.g. local dev). No
 *     warning either way.
 *   - behindProxy === undefined (default) -> Unknown. Warns loudly if not
 *     configured, but does not throw, since a bare `node server.js` run
 *     locally with no proxy in front of it is a legitimate case this
 *     module can't distinguish from a misconfigured production deploy.
 */
function checkTrustProxyConfig(app, behindProxy) {
  const configured = isTrustProxyConfigured(app);
  if (configured) return;

  if (behindProxy === true) {
    throw new Error(
      '[auth.js] mountAuth() was called with { behindProxy: true } but ' +
      "Express \"trust proxy\" is not set. Call app.set('trust proxy', 1) " +
      '(or the correct hop count) BEFORE calling mountAuth(app). Refusing ' +
      'to start with a config that would silently collapse the per-IP ' +
      'brute-force lockout into a single global one. See Integration Spec.md.'
    );
  }
  if (behindProxy === false) {
    return; // explicitly not behind a proxy — nothing to warn about
  }
  // behindProxy left unspecified: warn, don't crash.
  console.warn(trustProxyWarningText());
}

// Detects the live symptom of the misconfiguration on an actual incoming
// request — an X-Forwarded-For header is present (meaning something IS
// proxying this request) but trust proxy still isn't configured, so
// Express is ignoring it. Logged once per process to avoid log-flooding
// under exactly the attack this is warning about.
let liveMismatchWarned = false;
function warnIfLiveProxyMismatch(req, app) {
  if (liveMismatchWarned) return;
  if (isTrustProxyConfigured(app)) return;
  if (req.headers['x-forwarded-for']) {
    liveMismatchWarned = true;
    console.error(
      '[auth.js] ERROR: received a request with an X-Forwarded-For header ' +
      'while "trust proxy" is unconfigured. This process IS behind a proxy ' +
      'and the per-IP brute-force lockout is currently a GLOBAL lockout ' +
      "shared by every visitor. Fix: app.set('trust proxy', 1) before " +
      'mountAuth(app). (This message will not repeat.)'
    );
  }
}

function getClientIp(req) {
  // req.ip is Express's own computed value — correct automatically once
  // 'trust proxy' is configured (see above). Fall back to the raw socket
  // address only if req.ip is somehow unavailable.
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------
// mountAuth(app, options)
// ---------------------------------------------------------------------

function mountAuth(app, options = {}) {
  const credPath = options.credentialsFile || resolveCredentialsPath();
  const creds = loadCredentials(credPath);
  const limiter = createRateLimiter(options.maxAttempts, options.lockoutMs);
  const globalLimiter = createGlobalLimiter(options.globalMaxAttempts, options.globalLockoutMs);
  const loginHtmlPath = options.loginHtmlFile || path.join(__dirname, 'login.html');

  checkTrustProxyConfig(app, options.behindProxy);

  const getSecret = () => creds.sessionSecret;
  const requireAuth = makeRequireAuth(getSecret);

  // GET /login — serve the login page itself (must stay reachable logged out)
  app.get('/login', (req, res) => {
    res.sendFile(loginHtmlPath);
  });

  // POST /api/login — check password, set cookie
  // (relies on express.json() already being mounted globally in server.js,
  // ahead of this call — see Integration Spec.md)
  app.post('/api/login', (req, res) => {
    warnIfLiveProxyMismatch(req, app);
    const ip = getClientIp(req);

    if (globalLimiter.isLocked(GLOBAL_KEY)) {
      const waitMs = globalLimiter.remainingLockMs(GLOBAL_KEY);
      return res.status(429).json({
        error: `Too many failed attempts across all clients. Try again in ${Math.ceil(waitMs / 1000)}s.`,
      });
    }

    if (limiter.isLocked(ip)) {
      const waitMs = limiter.remainingLockMs(ip);
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(waitMs / 1000)}s.`,
      });
    }

    const password = req.body && req.body.password;
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Password required.' });
    }

    const ok = verifyPassword(password, creds.salt, creds.passwordHash);
    if (!ok) {
      limiter.recordFailure(ip);
      globalLimiter.recordFailure(GLOBAL_KEY);
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    limiter.recordSuccess(ip);
    globalLimiter.recordSuccess(GLOBAL_KEY);
    const now = Date.now();
    const token = signToken({ iat: now, exp: now + SESSION_TTL_MS }, getSecret());
    res.setHeader('Set-Cookie', buildCookieHeader(token, req));
    res.json({ ok: true });
  });

  // POST /api/logout — clear cookie
  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', buildClearCookieHeader(req));
    res.json({ ok: true });
  });

  return { requireAuth };
}

// ---------------------------------------------------------------------
// CLI setup helper: `node auth.js --setup` writes a fresh credentials file.
// ---------------------------------------------------------------------

function setupCli() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const targetArg = process.argv.find(a => a.startsWith('--out='));
  const outPath = targetArg
    ? targetArg.slice('--out='.length)
    : path.join(__dirname, '..', '.ada-dashboard-auth.json');

  rl.question('New dashboard password: ', (password) => {
    rl.close();
    if (!password || password.length < 8) {
      console.error('Password must be at least 8 characters. Aborting.');
      process.exit(1);
    }
    const salt = crypto.randomBytes(16);
    const hash = hashPassword(password, salt);
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    const out = {
      passwordHash: hash.toString('hex'),
      salt: salt.toString('hex'),
      sessionSecret,
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), { mode: 0o600 });
    console.log(`Credentials written to ${outPath} (mode 600).`);
    console.log('Keep this file OUTSIDE the dashboard/ folder that deploy.sh rsyncs.');
  });
}

if (require.main === module && process.argv.includes('--setup')) {
  setupCli();
}

module.exports = {
  mountAuth,
  resolveCredentialsPath,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseCookies,
  isTrustProxyConfigured,
  getClientIp,
  COOKIE_NAME,
  SESSION_TTL_MS,
};
