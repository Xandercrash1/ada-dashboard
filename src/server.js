const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { mountAuth } = require('./auth');
const todoEngine = require('./todo-engine');
const todoStore = require('./todo-store');
const todoValidate = require('./todo-validate');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Authentication (added 2026-08-26). ORDERING BELOW IS LOAD-BEARING. ---
// See Auth Module/Integration Spec.md. Two things break silently if reordered:
//   1. `trust proxy` MUST precede mountAuth. Behind Caddy every request appears
//      to come from 127.0.0.1, which would collapse auth.js's per-IP lockout into
//      one global lockout — anyone could lock Alex out with 5 bad requests.
//   2. requireAuth MUST precede express.static, or index.html is served to
//      anonymous visitors before any auth check runs.
// 'loopback', NOT 1: a hop count trusts X-Forwarded-For from ANY socket, so a
// direct request to :3000 carrying "X-Forwarded-For: 127.0.0.1" got req.ip ==
// 127.0.0.1 and walked through auth.js's loopback exemption (verified
// 2026-09-23). Trusting only loopback sockets keeps Caddy's real client IP
// (Caddy connects from 127.0.0.1) while spoofed headers from outside are ignored.
app.set('trust proxy', 'loopback');
app.use(cors());
app.use(express.json({ limit: '50mb' }));              // must precede mountAuth: /api/login reads req.body
const { requireAuth, users: userStore } = mountAuth(app, {
  usersFile: path.join(__dirname, '../data/users.json'),   // per instance: live and staging have separate accounts
  loginHtmlFile: path.join(__dirname, '../public/login.html'),
  behindProxy: true,                  // throws at startup if trust proxy is unset
});
app.use(requireAuth);                 // everything below requires a session
app.use((req, res, next) => authorizeRole(req, res, next));   // role wall (fb-1790201502191), defined below
app.use(express.static(path.join(__dirname, '../public')));
const MEDIA_DIR = path.join(__dirname, '../data/media');
app.use('/media', express.static(MEDIA_DIR));

// Directories
const DATA_DIR = path.join(__dirname, '../data');
const PLANS_DIR = path.join(__dirname, '../plans');
const SCRIPTS_DIR = path.join(__dirname, '../scripts');

[DATA_DIR, PLANS_DIR, MEDIA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'agent_sessions.json');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled_prompts.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const HOMEPAGE_FILE = path.join(DATA_DIR, 'homepage.json');
const PAGES_REGISTRY_FILE = path.join(DATA_DIR, 'pages.json');
const PAGES_DIR = path.join(DATA_DIR, 'pages');
if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR);
// Designer page-document registry: which dashboard pages have a
// designer-editable live document. Designer sessions record which page they
// are bound to (session.page) and the role's write walls point at that page's
// document — add an entry here (plus a page renderer) to bring the Designer
// to another page. Only the Home page has one today.

// A missing file is normal (first run — nothing has been written yet) and
// returns []. A file that EXISTS but fails to parse is data corruption, and
// silently returning [] there is how a bad byte turns into total data loss —
// the caller would go on to write that empty array straight back to disk.
// So a parse failure on an existing file THROWS instead of swallowing.
function readJsonStoreOrThrow(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Refusing to load "${filePath}" — it exists but is not valid JSON (${parseErr.message}). Not overwriting it.`);
  }
}

function readTasks() {
  return readJsonStoreOrThrow(TASKS_FILE);
}
function writeTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}
function readSessions() {
  return readJsonStoreOrThrow(SESSIONS_FILE);
}
function writeSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}
function readScheduled() {
  return readJsonStoreOrThrow(SCHEDULED_FILE);
}
function writeScheduled(items) {
  fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(items, null, 2));
}

// Atomic JSON writes: write a temp file, then rename over the target, so a
// concurrent reader never sees a half-written file. (A partial read made
// readHomepage fall back to DEFAULTS, which an editor could then save over the
// real page.)
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
// Per-page version history (fb-1790206467728): before a page document is
// overwritten, the previous version is kept in data/history/<page>/ — at most
// one snapshot per 5 minutes per page, newest 40 kept.
const HISTORY_DIR = path.join(__dirname, '../data/history');
const HISTORY_EVERY_MS = 5 * 60 * 1000;
const HISTORY_KEEP = 40;
function snapshotBeforeWrite(pageId, file, by) {
  try {
    if (!fs.existsSync(file)) return;
    const dir = path.join(HISTORY_DIR, pageId);
    fs.mkdirSync(dir, { recursive: true });
    const list = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).sort();
    const last = list.length ? parseInt(list[list.length - 1], 10) : 0;
    if (Date.now() - last < HISTORY_EVERY_MS) return;
    const raw = fs.readFileSync(file, 'utf8');
    JSON.parse(raw);                                  // never keep a broken file as history
    fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify({ by: by || null, doc: JSON.parse(raw) }));
    list.slice(0, Math.max(0, list.length + 1 - HISTORY_KEEP)).forEach(f => fs.rmSync(path.join(dir, f), { force: true }));
  } catch (e) { console.error('[history] snapshot failed:', e.message); }
}
function readPagesRegistry() {
  return readJsonStoreOrThrow(PAGES_REGISTRY_FILE);
}
function writePagesRegistry(pages) {
  writeFileAtomic(PAGES_REGISTRY_FILE, JSON.stringify(pages, null, 2));
}
function getPageDocPath(pageId) {
  if (pageId === 'home') return HOMEPAGE_FILE;
  return path.join(PAGES_DIR, `${pageId}.json`);
}

// Ensure registry exists
if (!fs.existsSync(PAGES_REGISTRY_FILE)) {
  writePagesRegistry([]);
}

function readFeedback() {
  return readJsonStoreOrThrow(FEEDBACK_FILE);
}
function writeFeedback(items) {
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(items, null, 2));
}

// --- Notifications store (fb-1787765370485) ---------------------------------
// A small ring buffer of events the UI should surface even when nobody was
// watching the chat: job errors, scheduled-prompt outcomes, agent roadblocks,
// and anything an agent or tool POSTs to /api/notifications. Newest first,
// capped so the file can never grow without bound. Failures to record a
// notification are logged and swallowed — a notification must never take
// down the thing it is reporting on.
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const NOTIFICATIONS_MAX = 200;
const NOTIFICATION_LEVELS = ['info', 'success', 'warn', 'error'];
function readNotifications() {
  return readJsonStoreOrThrow(NOTIFICATIONS_FILE);
}
function writeNotifications(items) {
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(items, null, 2));
}
function pushNotification({ level = 'info', title, body = '', source = 'system', link = null, dedupeKey = null }) {
  try {
    if (!title) return null;
    const items = readNotifications();
    // dedupeKey: an unread notification with the same key is refreshed in
    // place instead of duplicated (a scheduled prompt failing five times in a
    // row should be one line, not five).
    if (dedupeKey) {
      const dup = items.find(n => n.dedupeKey === dedupeKey && !n.read);
      if (dup) {
        dup.body = String(body || '').slice(0, 600);
        dup.count = (dup.count || 1) + 1;
        dup.updatedAt = new Date().toISOString();
        writeNotifications(items);
        return dup;
      }
    }
    const n = {
      id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      level: NOTIFICATION_LEVELS.includes(level) ? level : 'info',
      title: String(title).slice(0, 160),
      body: String(body || '').slice(0, 600),
      source,
      link,
      read: false,
      createdAt: new Date().toISOString(),
      dedupeKey
    };
    items.unshift(n);
    if (items.length > NOTIFICATIONS_MAX) items.length = NOTIFICATIONS_MAX;
    writeNotifications(items);
    return n;
  } catch (err) {
    console.error('[notify] failed to record notification:', err.message);
    return null;
  }
}
// An agent reply that is really a question for Alex. Heuristic on purpose —
// a false positive is one dismissable banner; a false negative is the status
// quo. Tune from real transcripts, not from imagination.
const ROADBLOCK_RE = /\b(roadblock|blocked on|i(?:'m| am) blocked|cannot proceed|can't proceed|unable to proceed|need(?:s)? (?:your )?(?:input|approval|permission|decision|confirmation|clarification)|waiting (?:on|for) (?:you|your)|please (?:confirm|advise|clarify))\b/i;
// Negated mentions ("didn't need your input", "no longer blocked") are not
// roadblocks, and a phrase buried in a completion report is weaker than one
// at the end of the reply or inside a question (fb-1789013839634).
const ROADBLOCK_NEGATION_RE = /\b(?:did ?n[o']t|does ?n[o']t|do ?n[o']t|no longer|not|never|without|wasn't|isn't|wouldn't)\s+(?:\w+\s+){0,2}(?:need|needs|wait|waiting|blocked|block)\b[^.!?\n]*/gi;
function looksLikeRoadblock(text) {
  if (!text) return false;
  const cleaned = String(text).replace(ROADBLOCK_NEGATION_RE, ' ');
  if (!ROADBLOCK_RE.test(cleaned)) return false;
  // Strong signal: a question, or the phrase in the closing third of the reply.
  const sentences = cleaned.split(/(?<=[.!?])\s+|\n+/);
  if (sentences.some(sn => /\?\s*$/.test(sn) && ROADBLOCK_RE.test(sn))) return true;
  // Closing third, but never less than the last 240 chars — a short reply
  // is all "closing".
  const cut = Math.max(0, Math.min(Math.floor(cleaned.length * 2 / 3), cleaned.length - 240));
  return ROADBLOCK_RE.test(cleaned.slice(cut));
}
function notifyJobOutcome(job, session, agentMsg, errorInfo) {
  if (session && session.owner && !isAdminUserName(session.owner)) return;   // a pages user's Designer (fb-1790201502191)
  const name = (session && session.name) || job.sessionId;
  const link = { tab: 'server', sub: 'agents', sessionId: job.sessionId };
  if (errorInfo) {
    pushNotification({ level: 'error', source: 'agent', title: `${name}: turn failed`, body: errorInfo.message || errorInfo.errorType || 'Unknown error', link, dedupeKey: `job-error:${job.sessionId}` });
    return;
  }
  const text = (agentMsg && agentMsg.text) || '';
  if (looksLikeRoadblock(text)) {
    pushNotification({ level: 'warn', source: 'agent', title: `${name} needs your input`, body: text.slice(0, 300), link, dedupeKey: `roadblock:${job.sessionId}` });
  }
}

// Classify a Gemini API failure so the UI can decide whether to offer queuing.
// 'auth' covers the expired/invalid OAuth access token ("no token") case.
function classifyGeminiError(httpStatus, errObj) {
  const status = (errObj && errObj.status) || '';
  // 503/UNAVAILABLE is transient overload, NOT quota. Reported as quota until
  // 2026-08-26, which sent Alex hunting a billing problem that did not exist.
  if (httpStatus === 503 || status === 'UNAVAILABLE' || /experiencing high demand|overloaded/i.test((errObj && errObj.message) || '')) {
    return { errorType: 'overload', message: 'The Gemini model is temporarily overloaded upstream (not a quota problem). Retrying shortly, or switching models, usually clears it.' };
  }
  if (httpStatus === 429 || status === 'RESOURCE_EXHAUSTED') {
    return { errorType: 'quota', message: 'Gemini quota exceeded for this API key — Google rejected the request (HTTP 429). Free-tier Pro models have almost no allowance; Flash and Flash Lite recover faster. The Claude engine is unaffected.' };
  }
  if (httpStatus === 401 || httpStatus === 403 || status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED') {
    return { errorType: 'auth', message: 'Gemini authentication failed — the access token is missing, invalid, or expired.' };
  }
  // Request too large. Should now be unreachable — enforceContentsBudget caps
  // every outgoing request — but if it ever fires again it must say so plainly
  // instead of hiding inside a generic 400, because the fix is a different one
  // (lower GEMINI_MAX_REQUEST_CHARS) than for any other error here.
  if (/token count|too many tokens|exceeds the maximum|input token|request payload size|too large/i.test((errObj && errObj.message) || '')) {
    return {
      errorType: 'too_large',
      message: 'The request exceeded the model\'s size limit even after the context budget was applied. Lower GEMINI_MAX_REQUEST_CHARS in src/server.js, or split the work into several smaller prompts with schedule_prompt.'
    };
  }
  return { errorType: 'other', message: (errObj && errObj.message) || `Gemini API error (HTTP ${httpStatus || '???'}).` };
}

// --- MODEL REGISTRY (Model Selection Contract §1) ---
// Server owns this; the UI never hardcodes model ids beyond its own emergency
// fallback. `antigravity-flash` and `claude-heavy` MUST keep these exact ids —
// existing entries in data/agent_sessions.json and data/scheduled_prompts.json
// already carry them.
const MODEL_REGISTRY = [
  {
    id: 'llama3.2-local', label: 'Local — Llama 3.2 3B',
    engine: 'ollama', apiModel: 'llama3.2:3b',
    tier: 'fast', default: false,
    description: 'Local CPU inference via Ollama. 100% free. Slower (5-10t/s). File-writes and bash are disabled, but scheduling and messaging are allowed for autonomous research.'
  },
  {
    id: 'gemma2-local', label: 'Local — Gemma 2 2B',
    engine: 'ollama', apiModel: 'gemma2:2b',
    tier: 'fast', default: false,
    description: 'Local CPU inference via Ollama. File-writes and bash are disabled, but scheduling and messaging are allowed for autonomous research.'
  },
  {
    id: 'gpt-4o', label: 'ChatGPT 4o',
    engine: 'openai', apiModel: 'gpt-4o',
    tier: 'deep', default: false,
    description: 'OpenAI\'s flagship multimodal model. Fast and highly capable.'
  },
  {
    id: 'gpt-4o-mini', label: 'ChatGPT 4o-Mini',
    engine: 'openai', apiModel: 'gpt-4o-mini',
    tier: 'fast', default: false,
    description: 'Extremely cheap fast reasoning model from OpenAI.'
  },
  {
    id: 'antigravity-flash', label: 'Antigravity — Gemini Flash Lite',
    engine: 'gemini', apiModel: 'gemini-flash-lite-latest',
    tier: 'fast', default: true,
    description: 'Fastest and cheapest. Good for lookups and quick server questions.'
  },
  {
    id: 'gemini-flash', label: 'Gemini Flash',
    engine: 'gemini', apiModel: 'gemini-flash-latest',
    tier: 'balanced', default: false, unavailable: true,
    description: '⚠️ Unreliable on the current free-tier key — verified hanging with no response 2026-08-26. Prefer Flash Lite.'
  },
  {
    id: 'gemini-pro', label: 'Gemini Pro',
    engine: 'gemini', apiModel: 'gemini-pro-latest',
    tier: 'deep', default: false, unavailable: true,
    description: '⛔ UNAVAILABLE on this key: free-tier Pro quota is limit:0, not merely exhausted. Needs billing enabled. Verified 2026-08-26.'
  },
  {
    id: 'claude-heavy', label: 'Fable (Claude Code)',
    engine: 'claude', apiModel: 'claude-fable-5',
    tier: 'balanced', default: false,
    description: 'Full Claude Code CLI in auto mode, pinned to Claude Fable 5 (Anthropic\'s most capable model). Slower, most capable.'
  },
  {
    id: 'claude-haiku', label: 'Claude Haiku',
    engine: 'claude', apiModel: 'claude-haiku-4-5-20251001',
    tier: 'fast', default: false,
    description: 'Fast, lightweight Claude model.'
  },
  {
    id: 'claude-sonnet', label: 'Claude Sonnet',
    engine: 'claude', apiModel: 'claude-sonnet-5',
    tier: 'balanced', default: false,
    description: 'Balanced Claude model — capable and reasonably fast.'
  },
  {
    id: 'claude-opus', label: 'Claude Opus 4.8',
    engine: 'claude', apiModel: 'claude-opus-4-8',
    tier: 'deep', default: false,
    description: 'Anthropic\'s most capable Opus-tier model. Slower, best for hard questions and system architecture.'
  }
];

function getModelById(id) {
  return MODEL_REGISTRY.find(m => m.id === id) || null;
}
function getDefaultModel() {
  return MODEL_REGISTRY.find(m => m.default) || MODEL_REGISTRY[0];
}

// Ordered list of model ids worth retrying with after `failedModelId` fails.
// Other-engine models come first — if one Gemini model is rate-limited, another
// Gemini model very likely is too, so offering one first would be a false promise.
function suggestedModelsFor(failedModelId) {
  const failed = getModelById(failedModelId);
  const others = MODEL_REGISTRY.filter(m => m.id !== failedModelId);
  const otherEngine = failed ? others.filter(m => m.engine !== failed.engine) : others;
  const sameEngine = failed ? others.filter(m => m.engine === failed.engine) : [];
  return [...otherEngine, ...sameEngine].map(m => m.id);
}

// Substrings the Claude Code CLI's own docs point to for detecting rate-limit /
// usage-cap failures (verified 2026-08-26 via `strings` on the installed CLI
// binary's embedded docs — there is no dedicated JSON `subtype` for this, so
// text matching against stderr/result is the real signal). Never invented.
const CLAUDE_QUOTA_PATTERNS = [
  /usage limit reached/i,
  /rate limit/i,
  /rate.?limited/i,
  /overloaded/i,
  /\b529\b/,
  /credit balance too low/i,
  /RESOURCE_EXHAUSTED/i,
  /\b429\b/
];
function isClaudeQuotaError(text) {
  const t = text || '';
  return CLAUDE_QUOTA_PATTERNS.some(p => p.test(t));
}

// Builds a full §3 error-shape object. `canQueue` is preserved from the
// pre-existing behavior the front-end already reads (data.errorInfo.canQueue
// gates the queue-on-failure modal for every failure, not just quota ones).
function buildErrorInfo(engine, modelId, errorType, message, recoverable) {
  return {
    errorType,
    engine,
    model: modelId,
    message,
    recoverable: !!recoverable,
    suggestedModels: recoverable ? suggestedModelsFor(modelId) : [],
    canQueue: true
  };
}

// --- 1. SYSTEM TELEMETRY API ---
app.get('/api/system', (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(1);
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  exec("df -k / | tail -1 | awk '{print $2, $3, $4, $5}'", (dfErr, dfStdout) => {
    let diskStats = { totalGB: '72.0', usedGB: '5.3', freeGB: '66.7', percent: '8%' };
    if (!dfErr && dfStdout.trim()) {
      const parts = dfStdout.trim().split(/\s+/);
      if (parts.length >= 4) {
        const total = (parseInt(parts[0], 10) / (1024 * 1024)).toFixed(1);
        const used = (parseInt(parts[1], 10) / (1024 * 1024)).toFixed(1);
        const free = (parseInt(parts[2], 10) / (1024 * 1024)).toFixed(1);
        diskStats = { totalGB: total, usedGB: used, freeGB: free, percent: parts[3] };
      }
    }

    exec("tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created_string}' 2>/dev/null || true", (tmuxErr, tmuxStdout) => {
      const sessions = [];
      if (!tmuxErr && tmuxStdout.trim()) {
        tmuxStdout.trim().split('\n').forEach(line => {
          if (line) {
            const [name, windows, created] = line.split('|');
            sessions.push({ name, windows: parseInt(windows, 10) || 1, created: created || 'Active' });
          }
        });
      }

      res.json({
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: os.uptime(),
        uptimeFormatted: formatUptime(os.uptime()),
        memory: {
          totalGB: (totalMem / (1024 ** 3)).toFixed(2),
          usedGB: (usedMem / (1024 ** 3)).toFixed(2),
          freeGB: (freeMem / (1024 ** 3)).toFixed(2),
          percent: memUsagePercent
        },
        cpu: {
          cores: cpus.length,
          model: cpus[0] ? cpus[0].model : 'Intel Core Processor (4 vCPUs)',
          load1m: loadAvg[0].toFixed(2),
          load5m: loadAvg[1].toFixed(2),
          load15m: loadAvg[2].toFixed(2)
        },
        disk: diskStats,
        tmuxSessions: sessions
      });
    });
  });
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d > 0 ? d + 'd ' : ''}${h}h ${m}m`;
}

// --- 2. TASKS & PLANNER API ---
// --- Staging health (added 2026-08-26) --------------------------------------
// Staging sat `errored` with 153 restarts for about an hour and NOTHING
// surfaced it — the only way to find out was to run `pm2 list` by hand. An
// invisible failure is one nobody fixes, so the dashboard now reports it.
//
// Deliberately tolerant: every branch resolves to a state string rather than
// throwing. This endpoint exists to report that something is broken, so it
// must not be the thing that breaks.
app.get('/api/staging/status', (req, res) => {
  const STAGING_URL = 'http://127.0.0.1:3001/api/system';
  execFile('pm2', ['jlist'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (pmErr, pmOut) => {
    let pm = { status: 'unknown', restarts: null };
    if (!pmErr) {
      try {
        const proc = JSON.parse(pmOut).find(p => p.name === 'ada-dashboard-staging');
        pm = proc
          ? { status: proc.pm2_env.status, restarts: proc.pm2_env.restart_time }
          : { status: 'not-registered', restarts: null };
      } catch (e) {
        pm = { status: 'unparseable', restarts: null };
      }
    }

    // curl rather than fetch: a dead port must come back as a status code we
    // can report ("000"), not an exception that has to be caught and mapped.
    execFile('bash', ['-c', `curl -s -o /dev/null -w '%{http_code}' -m 5 ${STAGING_URL} || true`],
      { timeout: 9000 }, (cErr, cOut) => {
        const httpCode = (cOut || '').trim() || '000';
        // 401 is HEALTHY: auth is on, so an unauthenticated probe being
        // rejected proves the app is up and serving. Only 200/401 mean up.
        const healthy = httpCode === '200' || httpCode === '401';

        let lastError = null;
        if (!healthy) {
          try {
            const log = fs.readFileSync('/home/ubuntu/.pm2/logs/ada-dashboard-staging-error.log', 'utf8');
            const lines = log.trim().split('\n').filter(Boolean);
            lastError = lines.slice(-12).join('\n').slice(-1200) || null;
          } catch (e) { /* no log yet — not an error in itself */ }
        }

        res.json({
          healthy,
          httpCode,
          pm2Status: pm.status,
          restarts: pm.restarts,
          lastError,
          checkedAt: new Date().toISOString(),
          hint: healthy
            ? 'Staging is up and serving on :3001.'
            : 'Staging is DOWN. Any work staged there is untested. Run: bash ~/ops/stage-check.sh'
        });
      });
  });
});

// POST /api/staging/promote — backs the human-clicked "Push to Live" button.
//
// SECURITY MODEL (read before changing): requireAuth (global, mounted above)
// already requires a valid signed session cookie, so only a logged-in browser
// reaches this handler. The custom X-Promote-Confirm header additionally blocks
// cross-site POSTs — a cross-origin <form> cannot set custom headers, and the
// open CORS policy will not attach the credentialed session cookie to a
// cross-origin request, so requireAuth would reject it anyway.
//
// What this does NOT do: defend against a malicious process on THIS box. The
// agent runs as user `ubuntu`, can read the session secret in
// ~/.ada-dashboard-auth.json (forge a cookie), and can already exec
// ~/ops/promote.sh directly. App-layer auth cannot stop that — the only real
// control is OS privilege separation (run the agent as a separate low-priv
// user). This endpoint therefore adds NO new capability an agent lacked; it
// just gives the human a button. Do not mistake it for an agent sandbox.
// Shared by the dashboard button endpoint below and the scheduler's
// pre-approved deploy path (fb-1788201858978). promote.sh self-detaches
// (setsid nohup) and returns in <1s, then runs the real validate → snapshot →
// sync → restart → auto-rollback on its own, so callers never wait across the
// dashboard restart. Only the LIVE instance may promote: the staging server
// runs this same file, and a staging-side auto-deploy would ship whatever
// half-finished work happens to be in the staging tree.
function startPromotion(triggerLabel) {
  if (String(PORT) !== '3000') {
    console.log(`[promote] SKIPPED (${triggerLabel}): this is not the live instance (port ${PORT})`);
    return { started: false, skipped: 'not-live-instance' };
  }
  console.log(`[promote] starting promotion (${triggerLabel})`);
  execFile('bash', ['/home/ubuntu/ops/promote.sh'], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) console.error('[promote] launch error:', err.message, (stderr || '').trim());
    else console.log('[promote]', (stdout || '').trim());
  });
  // Feedback lifecycle Step 3: the promote trigger is the completion signal —
  // a human click, or a pre-approval the human gave when scheduling.
  try {
    const closed = closeStagedFeedbackOnPromote(new Date().toISOString());
    if (closed.length) console.log('[promote] auto-closed staged feedback:', closed.join(', '));
  } catch (e) {
    console.error('[promote] feedback auto-close failed:', e.message);
  }
  return { started: true };
}

app.post('/api/staging/promote', (req, res) => {
  if (req.get('X-Promote-Confirm') !== '1') {
    return res.status(403).json({ error: 'Refused: promotion must be initiated from the dashboard button.' });
  }
  const result = startPromotion('dashboard button');
  if (!result.started) {
    return res.status(409).json({ error: `Promotion refused: ${result.skipped}` });
  }
  return res.status(202).json({
    ok: true,
    message: 'Promotion started. The dashboard will restart shortly; live auto-rolls back if unhealthy.'
  });
});

app.get('/api/tasks', (req, res) => res.json(readTasks()));
app.post('/api/tasks', (req, res) => {
  const { title, category, priority, status, dueDate, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const tasks = readTasks();
  const newTask = {
    id: `task-${Date.now()}`,
    title: title.trim(),
    category: category || 'General',
    priority: priority || 'Medium',
    status: status || 'today',
    dueDate: dueDate || new Date().toISOString().split('T')[0],
    notes: (notes || '').trim(),
    createdAt: new Date().toISOString()
  };

  tasks.unshift(newTask);
  writeTasks(tasks);
  res.status(201).json(newTask);
});

app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const tasks = readTasks();
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return res.status(404).json({ error: 'Task not found' });

  tasks[index] = { ...tasks[index], ...req.body, updatedAt: new Date().toISOString() };
  writeTasks(tasks);
  res.json(tasks[index]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  let tasks = readTasks();
  tasks = tasks.filter(t => t.id !== id);
  writeTasks(tasks);
  res.json({ success: true });
});

// --- 2B. HOMEPAGE LIVE DOCUMENT API (fb-1787801162107) ---
// The Home tab (announcement banner + widget cards) renders itself from
// data/homepage.json instead of hardcoded HTML. data/ is excluded from
// promote.sh's rsync in BOTH directions, so this file is a live content layer
// that agents can rewrite on the fly — no code deploy, no server restart; the
// browser picks changes up on the next refresh. Reads are un-cached
// (fs.readFileSync per request) for the same reason.
// Writes are sanitized field-by-field so a malformed agent edit degrades to
// defaults instead of blanking the homepage; a corrupt file on disk likewise
// falls back to defaults on read rather than 500ing the Home tab.
// Design doc: plans/homepage-live-document.md.

const HOMEPAGE_ACCENTS = ['indigo', 'purple', 'emerald', 'rose', 'amber', 'sky'];
// Widget surface styles the Web Components understand (mirrors the Widget
// Inspector's Theme dropdown in public/index.html).
const HOMEPAGE_THEMES = ['transparent', 'glass', 'solid', 'neon', 'gradient'];
const HOMEPAGE_MAX_WIDGETS = 24;

const DEFAULT_HOMEPAGE = {
  version: 1,
  updatedAt: null,
  updatedBy: null,
  announcement: {
    title: 'House Updates & News',
    text: 'Welcome to the new server dashboard! The Trip Planning hub is currently on the roadmap for collaborative packing lists and event scheduling.',
    icon: 'fa-sparkles',
    visible: true
  },
  // Built-in Home sections the designer can switch off to replace with its
  // own widgets: the Quick Stats grid and the Favorite Tools quick links.
  sections: { stats: true, quickLinks: true },
  widgets: []
};

// --- Page Builder v2 (fb-1790201502141): page sections + design tokens ---
// `pageSections` (NOT `sections` — that key already holds the built-in Home
// toggles {stats, quickLinks}) is an ordered list of full-width blocks. A
// `grid` section holds widgets (w.section = its id; unassigned widgets go to
// the first grid). A page without pageSections renders exactly as before.
const PAGE_SECTION_TYPES = ['hero', 'features', 'grid', 'gallery', 'pricing', 'cta', 'text', 'footer', 'header',
  'split', 'testimonials', 'faq', 'team', 'stats', 'logos', 'steps', 'video', 'map', 'contact'];
// Props that end up inside CSS url(...) or <img src>: http(s) or /media only,
// no quotes/parens/whitespace (fb-1790206467677).
const SAFE_IMAGE_URL_RE = /^(https?:\/\/[^\s"'()<>\\]{1,400}|\/media\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,120})$/;
const SECTION_STYLE_RULES = {
  'sec-bg': /^(alt|brand|gradient|image)$/, 'sec-width': /^(contained|full)$/, 'sec-pad': /^(s|m|l|xl)$/,
  'sec-anchor': /^[a-z][a-z0-9-]{0,39}$/
};
const PAGE_SECTIONS_MAX = 30;

// List props (feature cards, plans, images, links) are one string, one item
// per line. Agents naturally send arrays — of strings or of objects — so those
// are converted to the line format instead of silently dropped
// (fb-1790201502182: gpt-4o-mini's first page lost every list this way).
const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && typeof o[k] !== 'object') return String(o[k]).trim(); return ''; };
const LIST_ITEM_FORMAT = {
  items: (o) => { const icon = (pick(o, ['icon']).match(/fa-[a-z0-9-]+/g) || []).filter(c => !/^fa-(solid|regular|brands|light)$/.test(c))[0] || ''; return [icon, pick(o, ['title', 'name', 'heading']), pick(o, ['text', 'description', 'body', 'subtitle'])].filter((v, i) => v || i === 1).join(' | '); },
  plans: (o) => { const feats = Array.isArray(o.features) ? o.features.map(String).join('; ') : pick(o, ['features', 'description']); return [(o.featured || o.highlight || o.popular ? '*' : '') + pick(o, ['name', 'title']), pick(o, ['price', 'cost']), feats, pick(o, ['button', 'cta', 'buttonLabel', 'label']), pick(o, ['link', 'href', 'url'])].join(' | '); },
  images: (o) => [pick(o, ['src', 'url', 'image', 'href']), pick(o, ['caption', 'alt', 'title'])].join(' | '),
  links: (o) => [pick(o, ['label', 'text', 'title', 'name']), pick(o, ['url', 'href', 'link'])].join(' | ')
};
function coercePropValue(key, v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const fmt = LIST_ITEM_FORMAT[key];
    return v.slice(0, 24).map(x => (x && typeof x === 'object') ? (fmt ? fmt(x) : Object.values(x).filter(y => typeof y !== 'object').join(' | ')) : String(x ?? '')).map(l => l.replace(/\n/g, ' ').trim()).filter(Boolean).join('\n');
  }
  return null;
}

function sanitizePageSections(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  const seen = new Set();
  for (const sec of raw.slice(0, PAGE_SECTIONS_MAX)) {
    if (!sec || typeof sec !== 'object' || !PAGE_SECTION_TYPES.includes(sec.type)) continue;
    let id = (typeof sec.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sec.id)) ? sec.id : `sec-${Date.now()}-${out.length}`;
    if (seen.has(id)) id = `${id.slice(0, 56)}-${out.length}`;
    seen.add(id);
    const props = {};
    if (sec.props && typeof sec.props === 'object' && !Array.isArray(sec.props)) {
      for (const [k, v] of Object.entries(sec.props).slice(0, 30)) {
        // Props become HTML attributes: never event handlers or attributes that
        // restyle/re-identify the element.
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(k) || /^on/.test(k) || ['style', 'id', 'class', 'is', 'slot'].includes(k)) continue;
        const cv = coercePropValue(k, v);
        if (cv === null) continue;
        if ((k === 'image' || k === 'logo' || k === 'sec-bg-image') && cv && !SAFE_IMAGE_URL_RE.test(cv.trim())) continue;
        if (SECTION_STYLE_RULES[k] && !SECTION_STYLE_RULES[k].test(cv)) continue;
        props[k] = cv.slice(0, 5000);
      }
    }
    const clean = { id, type: sec.type, props };
    if (sec.hidden === true) clean.hidden = true;
    out.push(clean);
  }
  return out;
}

// Values end up in CSS custom properties, so they are validated tightly:
// hex colours, a font-family character set with no ; ( ) or url, and enums.
const TOKEN_RULES = {
  preset: /^[a-z0-9-]{1,32}$/,
  fontHeading: /^[A-Za-z0-9 ,'"-]{1,120}$/,
  fontBody: /^[A-Za-z0-9 ,'"-]{1,120}$/,
  scale: /^(compact|normal|large)$/,
  density: /^(compact|normal|airy)$/,
  radius: /^(none|sm|md|lg|xl)$/,
  brand: /^#[0-9a-fA-F]{3,8}$/,
  surface: /^#[0-9a-fA-F]{3,8}$/,
  text: /^#[0-9a-fA-F]{3,8}$/,
  muted: /^#[0-9a-fA-F]{3,8}$/,
};
function sanitizeTokens(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [k, re] of Object.entries(TOKEN_RULES)) {
    if (typeof raw[k] === 'string' && re.test(raw[k])) out[k] = raw[k];
  }
  return Object.keys(out).length ? out : undefined;
}

// Page SEO settings (fb-1790206467753): plain text, safe image URLs, a flag.
function sanitizePageMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const txt = (v, n) => typeof v === 'string' ? v.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) : '';
  const out = {};
  if (txt(raw.title, 70)) out.title = txt(raw.title, 70);
  if (txt(raw.description, 170)) out.description = txt(raw.description, 170);
  if (typeof raw.image === 'string' && SAFE_IMAGE_URL_RE.test(raw.image.trim())) out.image = raw.image.trim();
  if (typeof raw.favicon === 'string' && SAFE_IMAGE_URL_RE.test(raw.favicon.trim())) out.favicon = raw.favicon.trim();
  if (raw.index === true) out.index = true;
  return Object.keys(out).length ? out : undefined;
}

// Custom-page docs keep their free-form widgets, but the Page Builder fields
// go through the same sanitizers as the homepage (fb-1790201502182). Returns
// what was dropped so the Designer can be told.
function sanitizePageDocFields(doc) {
  const report = [];
  if (!doc || typeof doc !== 'object') return { doc: { widgets: [] }, report: ['document was not an object'] };
  if ('pageSections' in doc) {
    const before = Array.isArray(doc.pageSections) ? doc.pageSections : [];
    const ps = sanitizePageSections(doc.pageSections) || [];
    if (ps.length < before.length) report.push(`dropped ${before.length - ps.length} section(s) with an unknown type or bad shape (allowed types: ${PAGE_SECTION_TYPES.join(', ')})`);
    before.forEach((b, i) => {
      const kept = ps.find(x => x.id === b.id) || null;
      if (kept && b && b.props && typeof b.props === 'object') {
        const lost = Object.keys(b.props).filter(k => !(k in kept.props));
        if (lost.length) report.push(`section ${kept.id}: dropped props ${lost.join(', ')}`);
      }
    });
    if (ps.length) doc.pageSections = ps; else delete doc.pageSections;
  }
  if ('tokens' in doc) {
    const tk = sanitizeTokens(doc.tokens);
    const lost = doc.tokens && typeof doc.tokens === 'object' ? Object.keys(doc.tokens).filter(k => !tk || !(k in tk)) : [];
    if (lost.length) report.push(`tokens: dropped invalid ${lost.join(', ')}`);
    if (tk) doc.tokens = tk; else delete doc.tokens;
  }
  if ('meta' in doc) { const mt = sanitizePageMeta(doc.meta); if (mt) doc.meta = mt; else delete doc.meta; }
  if (!Array.isArray(doc.widgets)) doc.widgets = [];
  doc.widgets.forEach(w => { if (w && w.section !== undefined && !(typeof w.section === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(w.section))) { delete w.section; report.push(`widget ${w.id}: invalid section id removed`); } });
  return { doc, report };
}

// Section + widget catalog for agent prompts, generated from the components'
// own `static configSchema` so the Designer can never drift from the code
// (the hand-written list once told it lib= for photo-frame; the attribute is
// library=). Cached by the components directory's mtimes.
const vm = require('vm');
let componentCatalogCache = { key: '', value: { sections: [], widgets: [] } };
function extractArrayLiteral(src, start) {
  let depth = 0, inStr = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function readComponentCatalog() {
  const dir = path.join(__dirname, '../public/components');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch (e) { return componentCatalogCache.value; }
  const key = files.map(f => { try { return f + fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { return f; } }).join('|');
  if (key === componentCatalogCache.key) return componentCatalogCache.value;
  const out = { sections: [], widgets: [] };
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    const def = /customElements\.define\(\s*['"]([a-z0-9-]+)['"]/.exec(src);
    const at = src.indexOf('static configSchema');
    if (!def || at === -1) continue;
    const lit = extractArrayLiteral(src, src.indexOf('[', at));
    let schema = null;
    try { schema = vm.runInNewContext('(' + lit + ')', {}, { timeout: 50 }); } catch (e) { continue; }
    if (!Array.isArray(schema)) continue;
    const tag = def[1];
    if (tag.startsWith('ada-section-')) out.sections.push({ type: tag.slice('ada-section-'.length), tag, schema });
    else out.widgets.push({ tag, schema });
  }
  componentCatalogCache = { key, value: out };
  return out;
}
function describeSchemaField(f) {
  const opts = Array.isArray(f.options) ? ' one of ' + f.options.map(o => Array.isArray(o) ? o[0] : o).join('|') : '';
  const dflt = f.default ? ` (default ${JSON.stringify(String(f.default)).slice(0, 80)})` : '';
  return `${f.attr} — ${f.label}${opts}${dflt}`;
}

// Whitelist + cap a single widget; null if unsalvageable (dropped, not fatal).
function sanitizeHomepageWidget(w, index) {
  if (!w || typeof w !== 'object') return null;
  const clean = {
    id: typeof w.id === 'string' && w.id ? w.id.slice(0, 64) : `widget-${index}`,
    title: typeof w.title === 'string' ? w.title.slice(0, 120) : '',
    icon: typeof w.icon === 'string' && w.icon ? w.icon.slice(0, 64) : 'fa-cube',
    accent: HOMEPAGE_ACCENTS.includes(w.accent) ? w.accent : 'indigo',
    // theme/size were silently dropped here before 2026-09-09, which is why
    // the inspector had to read them back off the html attributes. Kept now
    // so page-level presets (fb-1788928004000) survive a round trip.
    theme: HOMEPAGE_THEMES.includes(w.theme) ? w.theme : undefined,
    size: typeof w.size === 'string' && w.size ? w.size.slice(0, 8) : undefined,
    cols: typeof w.cols === 'number' ? Math.max(1, Math.min(6, w.cols)) : undefined,
    rows: typeof w.rows === 'number' ? Math.max(1, w.rows) : undefined,
    // Card-body HTML. Deliberately NOT stripped: it comes only from Alex or
    // his agents through the authenticated API / server filesystem, which is
    // the same trust level as the agents' bash access. Length-capped only.
    html: typeof w.html === 'string' ? w.html.slice(0, 20000) : '',
    hidden: w.hidden === true
  };
  if (typeof w.section === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(w.section)) clean.section = w.section;
  // Per-widget settings a component persists itself (e.g. <ada-todo> section
  // toggles). Was silently dropped here, so they never survived a homepage
  // save or an import. Plain object, size-capped.
  if (w.config && typeof w.config === 'object' && !Array.isArray(w.config)) {
    try { if (JSON.stringify(w.config).length <= 4000) clean.config = JSON.parse(JSON.stringify(w.config)); } catch (e) { /* unserializable -> drop */ }
  }
  if (w.link && typeof w.link === 'object') {
    const link = {};
    if (typeof w.link.label === 'string') link.label = w.link.label.slice(0, 80);
    if (typeof w.link.tab === 'string' && w.link.tab) link.tab = w.link.tab.slice(0, 40);
    else if (typeof w.link.href === 'string' && w.link.href) link.href = w.link.href.slice(0, 500);
    if (link.tab || link.href) clean.link = link;
  }
  if (!clean.title && !clean.html) return null;
  return clean;
}

function sanitizeHomepage(raw) {
  const doc = JSON.parse(JSON.stringify(DEFAULT_HOMEPAGE));
  if (!raw || typeof raw !== 'object') return doc;
  if (typeof raw.updatedAt === 'string') doc.updatedAt = raw.updatedAt;
  if (typeof raw.updatedBy === 'string') doc.updatedBy = raw.updatedBy.slice(0, 80);
  if (raw.announcement && typeof raw.announcement === 'object') {
    const a = raw.announcement;
    if (typeof a.title === 'string') doc.announcement.title = a.title.slice(0, 120);
    if (typeof a.text === 'string') doc.announcement.text = a.text.slice(0, 2000);
    if (typeof a.icon === 'string' && a.icon) doc.announcement.icon = a.icon.slice(0, 64);
    if (a.visible === false) doc.announcement.visible = false;
  }
  if (raw.sections && typeof raw.sections === 'object') {
    if (raw.sections.stats === false) doc.sections.stats = false;
    if (raw.sections.quickLinks === false) doc.sections.quickLinks = false;
  }
  if (Array.isArray(raw.widgets)) {
    doc.widgets = raw.widgets
      .slice(0, HOMEPAGE_MAX_WIDGETS)
      .map(sanitizeHomepageWidget)
      .filter(Boolean);
  }
  // Page-level theme preset (fb-1788928004000). Absent/null = per-widget custom.
  if (raw.pageTheme && typeof raw.pageTheme === 'object') {
    const pt = {};
    if (typeof raw.pageTheme.preset === 'string' && raw.pageTheme.preset) pt.preset = raw.pageTheme.preset.slice(0, 32);
    if (HOMEPAGE_THEMES.includes(raw.pageTheme.theme)) pt.theme = raw.pageTheme.theme;
    if (HOMEPAGE_ACCENTS.includes(raw.pageTheme.accent)) pt.accent = raw.pageTheme.accent;
    if (Object.keys(pt).length) doc.pageTheme = pt;
  }
  const ps = sanitizePageSections(raw.pageSections);
  if (ps && ps.length) doc.pageSections = ps;
  const tk = sanitizeTokens(raw.tokens);
  if (tk) doc.tokens = tk;
  if (raw.glanceTheme && typeof raw.glanceTheme === 'object') {
    doc.glanceTheme = {
      theme: HOMEPAGE_THEMES.includes(raw.glanceTheme.theme) ? raw.glanceTheme.theme : 'glass',
      accent: HOMEPAGE_ACCENTS.includes(raw.glanceTheme.accent) ? raw.glanceTheme.accent : 'indigo'
    };
  }
  return doc;
}

function readHomepage() {
  try {
    if (!fs.existsSync(HOMEPAGE_FILE)) return sanitizeHomepage(null);
    return sanitizeHomepage(JSON.parse(fs.readFileSync(HOMEPAGE_FILE, 'utf8')));
  } catch (err) {
    console.error('[homepage] homepage.json unreadable, serving defaults:', err.message);
    return sanitizeHomepage(null);
  }
}

// `path` is included so the UI can hand a designer agent the exact file for
// THIS tree (staging vs live serve different data dirs).
app.get('/api/homepage', (req, res) => {
  res.json({ ...readHomepage(), path: HOMEPAGE_FILE });
});

// Partial update: send `announcement` and/or `widgets`; omitted keys keep
// their current value. Used by the banner edit modal; agents usually edit
// the file directly instead.
app.put('/api/homepage', (req, res) => {
  const current = readHomepage();
  const { announcement, widgets, sections, updatedBy, pageTheme, glanceTheme, expectedUpdatedAt, pageSections, tokens } = req.body || {};
  // Optimistic concurrency (fb-1789015021701): a client that says which
  // version it loaded is refused if the page moved on since. Callers that
  // send nothing (agents, older clients) keep last-write-wins.
  if (expectedUpdatedAt && current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
    return res.status(409).json({ error: 'stale', message: 'This page changed elsewhere since you loaded it.', updatedAt: current.updatedAt, updatedBy: current.updatedBy });
  }
  if (announcement !== undefined && (typeof announcement !== 'object' || announcement === null)) {
    return res.status(400).json({ error: 'announcement must be an object' });
  }
  if (widgets !== undefined && !Array.isArray(widgets)) {
    return res.status(400).json({ error: 'widgets must be an array' });
  }
  if (sections !== undefined && (typeof sections !== 'object' || sections === null)) {
    return res.status(400).json({ error: 'sections must be an object' });
  }
  const merged = sanitizeHomepage({
    ...current,
    ...(announcement !== undefined ? { announcement: { ...current.announcement, ...announcement } } : {}),
    ...(sections !== undefined ? { sections: { ...current.sections, ...sections } } : {}),
    ...(widgets !== undefined ? { widgets } : {}),
    // Explicit null clears the preset (sanitizeHomepage drops a null).
    ...(pageTheme !== undefined ? { pageTheme } : {}),
    ...(glanceTheme !== undefined ? { glanceTheme } : {}),
    ...(pageSections !== undefined ? { pageSections } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: typeof updatedBy === 'string' && updatedBy ? updatedBy : 'dashboard'
  });
  snapshotBeforeWrite('home', HOMEPAGE_FILE, ownerName(req));
  writeFileAtomic(HOMEPAGE_FILE, JSON.stringify(merged, null, 2));
  res.json({ ...merged, path: HOMEPAGE_FILE });
});

// --- 3. SCRIPTS & AUTOMATION API ---
// Single source of truth for the runnable-script registry. Shared by the
// Tools tab, the /api/scripts/run 404 hint, and the widget docs injected
// into agent prompts (so agents only ever reference real script ids).
function readScriptRegistry() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scripts.json'), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

app.get('/api/scripts', (req, res) => {
  res.json(readScriptRegistry());
});

app.post('/api/scripts/run', (req, res) => {
  const { id, customArgs } = req.body;
  
  const scriptList = readScriptRegistry();

  const selected = scriptList.find(s => s.id === id);
  // The available list turns a dead-end error into a self-correcting one —
  // an agent-authored widget that guesses a script id shows the real ids
  // right in its output box (seen in the designer chat, 2026-09-02).
  if (!selected) return res.status(404).json({ error: `Unknown script ID "${id}"`, available: scriptList.map(s => s.id) });

  // Map the new schema to the old executor logic
  selected.rawCmd = selected.command;
  

  const startTime = Date.now();
  if (selected.rawCmd) {
    exec(selected.rawCmd, (err, stdout, stderr) => {
      const durationMs = Date.now() - startTime;
      res.json({ success: !err, stdout: stdout || '', stderr: stderr || (err ? err.message : ''), durationMs });
    });
  } else {
    const args = customArgs && customArgs.length ? customArgs : (selected.defaultArgs || []);
    const scriptWorkingDir = path.dirname(selected.file);
    const proc = spawn(selected.cmd, [selected.file, ...args], { cwd: scriptWorkingDir });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => stdout += data.toString());
    proc.stderr.on('data', data => stderr += data.toString());

    proc.on('close', code => {
      const durationMs = Date.now() - startTime;
      res.json({ success: code === 0, exitCode: code, stdout, stderr, durationMs });
    });

    proc.on('error', err => res.json({ success: false, error: err.message, stdout, stderr }));
  }
});

// --- 4. INTERACTIVE SERVER TERMINAL CONSOLE API ---

// GET /api/glance - Priority Scoring Engine for At-A-Glance
app.get('/api/glance', (req, res) => {
  try {
    const os = require('os');
    const loadAvg = os.loadavg()[0]; // 1 minute load average
    const cpus = os.cpus().length;
    const loadPercent = (loadAvg / cpus) * 100;
    
    if (loadPercent > 80) {
      return res.json({ text: `System Load Critical (${loadPercent.toFixed(1)}%)`, icon: "fa-triangle-exclamation", color: "rose" });
    }
    
    const todosPath = path.join(DATA_DIR, 'todo.json');
    if (fs.existsSync(todosPath)) {
      const todos = JSON.parse(fs.readFileSync(todosPath, 'utf8'));
      const pending = todos.filter(t => !t.completed);
      if (pending.length > 0) {
        return res.json({ text: `Next up: ${pending[0].text}`, icon: "fa-calendar-check", color: "amber" });
      }
    }
    
    const hourStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    const hour = parseInt(hourStr, 10);
    let greeting = 'Good evening';
    let icon = 'fa-moon';
    let color = 'indigo';
    if (hour < 12 && hour >= 4) { greeting = 'Good morning'; icon = 'fa-sun'; color = 'amber'; }
    else if (hour >= 12 && hour < 18) { greeting = 'Good afternoon'; icon = 'fa-cloud-sun'; color = 'sky'; }
    
    let weatherStr = "All systems nominal.";
    if (global.cachedWeather && global.cachedWeather.time > Date.now() - 3600000) {
      weatherStr = `It's currently ${global.cachedWeather.temp}°F and ${global.cachedWeather.desc}.`;
    } else {
      // Async fetch to cache for next time so we don't block this request
      fetch('https://wttr.in/Windham,ME?format=j1').then(r => r.json()).then(data => {
        global.cachedWeather = {
          time: Date.now(),
          temp: data.current_condition[0].temp_F,
          desc: (data.current_condition[0].weatherDesc[0].value || '').trim().toLowerCase()
        };
      }).catch(() => {});
    }
    
    const who = (req.user && req.user.role !== 'admin' && req.user.username) ? req.user.username[0].toUpperCase() + req.user.username.slice(1) : 'Alex';
    return res.json({ text: `${greeting}, ${who}. ${weatherStr}`, icon, color });
  } catch (err) {
    return res.json({ text: "At a glance unavailable", icon: "fa-circle-exclamation", color: "gray" });
  }
});

app.post('/api/terminal/exec', (req, res) => {
  const { command } = req.body;
  if (!command || !command.trim()) return res.status(400).json({ error: 'Command required' });

  const startTime = Date.now();
  // 300s (contract §1) — interactive console, a person is waiting.
  exec(command, { cwd: '/home/ubuntu', timeout: 300000 }, (err, stdout, stderr) => {
    const durationMs = Date.now() - startTime;
    res.json({
      success: !err,
      exitCode: err ? err.code : 0,
      stdout: stdout || '',
      stderr: stderr || (err ? err.message : ''),
      durationMs
    });
  });
});


// --- ROLES: limited 'pages' accounts (fb-1790201502191) ---------------------
const PAGES_USER_DESIGNER_MODEL = 'gpt-4o-mini';
// Alex is 'admin'. Household members get role 'pages': their own pages (plus
// shared ones and Home, read-only), the Page Builder and a Designer for their
// own pages — nothing else. DENY BY DEFAULT: authorizeRole lists the only
// routes a pages user can reach; every handler below additionally filters by
// owner. Loopback/local tools resolve to a 'system' admin in auth.js.
const isAdminReq = (req) => !req.user || req.user.role === 'admin';
const ownerName = (req) => (!req.user || req.user.username === 'system') ? 'alex' : req.user.username;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function pageEntry(id) { return readPagesRegistry().find(pg => pg.id === id) || null; }
function pageVisibleTo(user, id) {
  if (id === 'home') return true;
  const pg = pageEntry(id);
  return !!pg && ((pg.owner || 'alex') === user.username || pg.shared === true);
}
function pageOwnedBy(user, id) {
  const pg = id !== 'home' && pageEntry(id);
  return !!pg && (pg.owner || 'alex') === user.username;
}
function isAdminUserName(name) {
  const u = userStore && userStore.find(name || 'alex');
  return !name || name === 'alex' || (u && u.role === 'admin');
}
function templateVisibleTo(user, t) { return !!t && ((t.owner || 'alex') === user.username || isAdminUserName(t.owner)); }
function sessionOwnedBy(user, s) { return !!s && s.owner === user.username; }

// What a pages user may SAVE. Their pages are opened by Alex too, in his admin
// session, and w.html is injected raw — so a pages user never stores HTML:
// only one allow-listed custom element with its declared attributes, and ids,
// icons and links restricted to characters that cannot break out of the
// onclick/class attributes the renderer builds them into.
const SAFE_WIDGET_TAGS = {
  'ada-clock': ['format', 'font'], 'ada-analog-clock': [], 'ada-countdown': ['target', 'title'],
  'ada-timer': ['minutes', 'title'], 'ada-stopwatch': ['title'], 'ada-greeting': ['name'],
  'ada-weather': [], 'ada-photo-frame': ['library', 'interval']
};
function restrictWidgetHtml(html) {
  const m = /^\s*<(ada-[a-z-]+)((?:\s+[a-z][a-z0-9-]*="[^"<>]*")*)\s*>\s*<\/\1>\s*$/.exec(String(html || ''));
  if (!m || !SAFE_WIDGET_TAGS[m[1]]) return '';
  const allowed = new Set([...SAFE_WIDGET_TAGS[m[1]], 'theme', 'accent']);
  const attrs = [...m[2].matchAll(/([a-z][a-z0-9-]*)="([^"<>]*)"/g)]
    .filter(([, k, v]) => allowed.has(k) && /^[^;(){}<>"\\]{0,200}$/.test(v))
    .map(([, k, v]) => `${k}="${v}"`);
  return `<${m[1]}${attrs.length ? ' ' + attrs.join(' ') : ''}></${m[1]}>`;
}
function restrictWidget(w, i) {
  const base = sanitizeHomepageWidget(w, i);
  if (!base) return null;
  const out = JSON.parse(JSON.stringify(base));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(out.id)) out.id = `widget-${Date.now()}${i}`;
  if (!/^fa-[a-z0-9-]{1,40}$/.test(out.icon || '')) out.icon = 'fa-cube';
  out.title = String(out.title || '').replace(/[<>]/g, '').slice(0, 80);
  if (out.link) {
    const l = {};
    if (out.link.tab && /^[a-z0-9-]{1,40}$/.test(out.link.tab)) l.tab = out.link.tab;
    else if (out.link.href && /^https?:\/\/[^\s"'<>()\\]{1,400}$/.test(out.link.href)) l.href = out.link.href;
    if (out.link.label) l.label = String(out.link.label).replace(/[<>]/g, '').slice(0, 60);
    if (l.tab || l.href) out.link = l; else delete out.link;
  }
  if (out.size && !['1x1', '2x1', '2x2', 'full'].includes(out.size)) delete out.size;
  delete out.config;
  const hadHtml = !!(out.html && out.html.trim());
  out.html = restrictWidgetHtml(out.html);
  if (hadHtml && !out.html) return null;         // not an allowed widget: drop it, don't leave an empty card
  return (out.html || out.title) ? out : null;
}
function restrictPageDoc(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const { doc, report } = sanitizePageDocFields({ pageSections: src.pageSections, tokens: src.tokens, meta: src.meta, widgets: [] });
  const out = { widgets: (Array.isArray(src.widgets) ? src.widgets : []).slice(0, 60).map(restrictWidget).filter(Boolean) };
  if (doc.pageSections) out.pageSections = doc.pageSections;
  if (doc.tokens) out.tokens = doc.tokens;
  if (doc.meta) out.meta = doc.meta;
  const themed = sanitizeHomepage({ pageTheme: src.pageTheme, glanceTheme: src.glanceTheme });
  if (themed.pageTheme) out.pageTheme = themed.pageTheme;
  if (src.glanceTheme && themed.glanceTheme) out.glanceTheme = themed.glanceTheme;
  const dropped = (Array.isArray(src.widgets) ? src.widgets.length : 0) - out.widgets.length;
  if (dropped > 0) report.push(`dropped ${dropped} widget(s) that are not allowed on this account`);
  return { doc: out, report };
}

function authorizeRole(req, res, next) {
  if (isAdminReq(req)) return next();
  const u = req.user, m = req.method, p = req.path;
  const deny = () => res.status(403).json({ error: 'Not available for your account.' });
  if (!p.startsWith('/api/')) return (m === 'GET' || m === 'HEAD') ? next() : deny();   // the app shell, components, media files
  let mm;
  if (p === '/api/me' && m === 'GET') return next();
  if (p === '/api/me/password' && m === 'POST') return next();
  if (p === '/api/pages' && (m === 'GET' || m === 'POST')) return next();
  if ((mm = /^\/api\/pages\/([^/]+)\/content$/.exec(p))) {
    if (m === 'GET') return pageVisibleTo(u, mm[1]) ? next() : deny();
    if (m === 'POST') return pageOwnedBy(u, mm[1]) ? next() : deny();
  }
  if ((mm = /^\/api\/pages\/([^/]+)$/.exec(p)) && (m === 'DELETE' || m === 'PATCH')) return pageOwnedBy(u, mm[1]) ? next() : deny();
  if ((mm = /^\/api\/pages\/([^/]+)\/publish$/.exec(p)) && (m === 'POST' || m === 'DELETE')) return pageOwnedBy(u, mm[1]) ? next() : deny();
  if ((mm = /^\/api\/pages\/([^/]+)\/history(?:\/(\d+)(\/restore)?)?$/.exec(p))) {
    if (m === 'GET' && !mm[3]) return pageOwnedBy(u, mm[1]) ? next() : deny();
    if (m === 'POST' && mm[3]) return pageOwnedBy(u, mm[1]) ? next() : deny();
  }
  if (p === '/api/sites' && (m === 'GET' || m === 'POST')) return next();
  if ((mm = /^\/api\/sites\/([^/]+)(?:\/publish)?$/.exec(p)) && ['PATCH', 'DELETE', 'POST'].includes(m)) {
    const site = readSites().find(x => x.id === mm[1]);
    return (site && site.owner === u.username) ? next() : deny();
  }
  if ((mm = /^\/api\/pages\/([^/]+)\/images(?:\/[^/]+)?$/.exec(p))) {
    if (m === 'GET') return pageVisibleTo(u, mm[1]) ? next() : deny();
    if (m === 'POST' || m === 'DELETE') return pageOwnedBy(u, mm[1]) ? next() : deny();
  }
  if (p === '/api/homepage' && m === 'GET') return next();
  if (p === '/api/templates' && (m === 'GET' || m === 'POST')) return next();
  if ((mm = /^\/api\/templates\/([^/]+)$/.exec(p))) {
    const t = readTemplate(mm[1]);
    if (m === 'GET') return templateVisibleTo(u, t) ? next() : deny();
    if (m === 'DELETE') return (t && t.owner === u.username) ? next() : deny();
  }
  if (p === '/api/widgets/sanitize' && m === 'POST') return next();
  if (m === 'GET' && ['/api/weather', '/api/glance', '/api/media/libraries', '/api/media/files', '/api/agent/models'].includes(p)) return next();
  if (p === '/api/agent/sessions' && (m === 'GET' || m === 'POST')) return next();
  if ((mm = /^\/api\/agent\/sessions\/([^/]+)(?:\/(chat|job))?$/.exec(p))) {
    if (!sessionOwnedBy(u, readSessions().find(x => x.id === mm[1]))) return deny();
    if ((!mm[2] && (m === 'GET' || m === 'DELETE')) || (mm[2] === 'chat' && m === 'POST') || (mm[2] === 'job' && m === 'GET')) return next();
    return deny();
  }
  if ((mm = /^\/api\/agent\/jobs\/([^/]+)$/.exec(p)) && m === 'GET') {
    const job = jobs.get(mm[1]);
    return (job && sessionOwnedBy(u, readSessions().find(x => x.id === job.sessionId))) ? next() : deny();
  }
  return deny();
}

app.get('/api/me', (req, res) => res.json({ username: ownerName(req), role: isAdminReq(req) ? 'admin' : 'pages' }));
app.post('/api/me/password', (req, res) => {
  const name = ownerName(req);
  const { current, next: nextPw } = req.body || {};
  if (!userStore || !userStore.verify(name, String(current || ''))) return res.status(400).json({ error: 'Current password is incorrect.' });
  try { userStore.update(name, { password: nextPw }); res.json({ ok: true, relogin: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Users admin (admin only — authorizeRole never lets a pages user reach these)
app.get('/api/users', (req, res) => res.json(userStore ? userStore.list() : []));
app.post('/api/users', (req, res) => {
  try { res.status(201).json(userStore.create({ username: req.body && req.body.username, password: req.body && req.body.password, role: 'pages' })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/users/:username', (req, res) => {
  const { password, disabled } = req.body || {};
  if (req.params.username === ownerName(req) && disabled) return res.status(400).json({ error: 'You cannot disable your own account.' });
  try { res.json(userStore.update(req.params.username, { password, disabled })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- PUBLISHING to Cloudflare Pages (fb-1790206467643) -----------------------
// A published page is a standalone static site on Cloudflare — visitors never
// touch this server. Credentials live OUTSIDE the tree (shared by live and
// staging), mode 600, and the token is never sent back to a browser.
const PUBLISH_CREDS_FILE = '/home/ubuntu/.ada-cloudflare.json';
const WRANGLER_BIN = '/home/ubuntu/ops/wrangler/node_modules/.bin/wrangler';
const PUBLISH_TMP = '/home/ubuntu/ops/publish-tmp';
function readPublishCreds() {
  try { const c = JSON.parse(fs.readFileSync(PUBLISH_CREDS_FILE, 'utf8')); return (c && c.accountId && c.token) ? c : null; } catch (e) { return null; }
}
async function cfApi(creds, method, pathPart, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathPart}`, {
    method, headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000)
  });
  let j = null; try { j = await res.json(); } catch (e) {}
  return { status: res.status, ok: res.ok && j && j.success !== false, json: j };
}
const cfErr = (r) => ((r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}`);

app.get('/api/publish/settings', (req, res) => {
  const c = readPublishCreds();
  res.json({ configured: !!c, accountId: c ? c.accountId : '', tokenSet: !!(c && c.token), updatedAt: c ? c.updatedAt : null });
});
app.put('/api/publish/settings', (req, res) => {
  const { accountId, token } = req.body || {};
  const prev = readPublishCreds() || {};
  const acc = typeof accountId === 'string' ? accountId.trim() : '';
  if (!/^[a-f0-9]{32}$/.test(acc)) return res.status(400).json({ error: 'The Account ID is 32 hexadecimal characters.' });
  const tok = (typeof token === 'string' && token.trim()) ? token.trim() : prev.token;
  if (!tok || !/^[A-Za-z0-9_-]{30,200}$/.test(tok)) return res.status(400).json({ error: 'Paste the API token (it looks like a long string of letters, digits, - and _).' });
  fs.writeFileSync(PUBLISH_CREDS_FILE, JSON.stringify({ accountId: acc, token: tok, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.chmodSync(PUBLISH_CREDS_FILE, 0o600);
  res.json({ configured: true, accountId: acc, tokenSet: true });
});
app.post('/api/publish/test', async (req, res) => {
  const c = readPublishCreds();
  if (!c) return res.status(400).json({ ok: false, error: 'Not configured yet.' });
  try {
    const v = await cfApi(c, 'GET', '/user/tokens/verify');
    if (!v.ok) return res.json({ ok: false, error: 'Cloudflare rejected the token: ' + cfErr(v) });
    const pr = await cfApi(c, 'GET', `/accounts/${c.accountId}/pages/projects`);
    if (!pr.ok) return res.json({ ok: false, error: 'Token works but cannot use Pages on that account: ' + cfErr(pr) });
    res.json({ ok: true, projects: (pr.json.result || []).length });
  } catch (e) { res.json({ ok: false, error: 'Could not reach Cloudflare: ' + e.message }); }
});

// What a published page may contain. The export is built in the browser, so
// the server re-checks it: static markup only.
function validatePublishHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return 'Nothing to publish.';
  if (html.length > 3 * 1024 * 1024) return 'The page is too large to publish (3 MB max).';
  if (/<script\b/i.test(html)) return 'Published pages may not contain scripts.';
  // The only frames allowed are the ones the video/map sections build from a
  // parsed id: YouTube (privacy mode), Vimeo and Google Maps (fb-1790206467703).
  const ALLOWED_IFRAME = /<iframe src="(?:https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{6,20}|https:\/\/player\.vimeo\.com\/video\/\d{4,12}|https:\/\/www\.google\.com\/maps\?q=[^"<>]{1,600}&amp;output=embed)"(?: (?:title="[^"<>]{0,120}"|loading="lazy"|allow="[a-z; -]{0,160}"|allowfullscreen(?:="")?|referrerpolicy="[a-z-]{0,40}"|style="[a-z0-9:;%. -]{0,80}"))*><\/iframe>/gi;
  const withoutAllowed = html.replace(ALLOWED_IFRAME, '');
  if (/<(iframe|object|embed|form|base)\b/i.test(withoutAllowed)) return 'Published pages may only embed YouTube, Vimeo or Google Maps (from the video and map sections) — no other frames, embeds or forms.';
  // Inside tags only: escaped text such as "&lt;img onerror=…&gt;" is harmless words.
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) return 'Published pages may not contain event handlers.';
  if (/(href|src)\s*=\s*["']?\s*(javascript|data|vbscript):/i.test(html)) return 'Published pages may not contain script links.';
  // Accessibility (fb-1790206467753): every image needs a description.
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter(t => !/\salt="[^"]*\S[^"]*"/i.test(t));
  if (noAlt.length) return `${noAlt.length} image${noAlt.length === 1 ? ' needs' : 's need'} a description before publishing (gallery captions, image descriptions, team names, logo names).`;
  return null;
}

// Bundle a set of pages into dir: /media images copied to assets/, page:<id>
// links rewritten to the site's file names (or '#'), noindex + headers + 404.
function bundlePublishDir(dir, filesByName, pageLinkMap, warnings, opts) {
  const o = opts || {};
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  for (const [fileName, raw] of Object.entries(filesByName)) {
    let html = raw;
    html = html.replace(/(["'(;])\/media\/([A-Za-z0-9_-]{1,64})\/([^"')&\s?#]{1,200})/g, (m0, q, lib, file) => {
      const clean = path.basename(decodeURIComponent(file));
      const src = path.join(MEDIA_DIR, lib, clean);
      if (!src.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(src)) { warnings.push(`image not found: /media/${lib}/${clean}`); return m0; }
      const dest = `${lib}-${clean}`.replace(/[^A-Za-z0-9._-]/g, '_');
      fs.copyFileSync(src, path.join(dir, 'assets', dest));
      return `${q}assets/${dest}`;
    });
    if (/\/media\//.test(html)) warnings.push(`${fileName}: some images could not be bundled`);
    html = html.replace(/href="page:([a-z0-9-]{1,64})"/g, (m0, pid) => {
      if (pageLinkMap && pageLinkMap[pid]) return `href="${pageLinkMap[pid]}"`;
      warnings.push(`${fileName}: link to page "${pid}" is not part of what was published`);
      return 'href="#"';
    });
    const dashLinks = [...new Set((html.match(/href="\/(?!\/)[^"]*"/g) || []).map(x => x.slice(6, -1)))];
    if (dashLinks.length) warnings.push(`${fileName}: links that point at the dashboard (visitors cannot open them): ${dashLinks.slice(0, 8).join(', ')}`);
    // Social previews need absolute image URLs.
    if (o.siteUrl) html = html.replace(/(<meta (?:property="og:image"|name="twitter:image") content=")assets\//g, `$1${o.siteUrl}/assets/`);
    html = html.replace(/<meta name="generator"[^>]*>\n?/i, '');
    if (!o.allowIndex) html = html.replace('<meta name="viewport"', '<meta name="robots" content="noindex, nofollow">\n<meta name="viewport"');
    fs.writeFileSync(path.join(dir, fileName), html);
  }
  fs.writeFileSync(path.join(dir, '404.html'), '<!DOCTYPE html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title><p style="font-family:system-ui;padding:2rem">Not found.</p>');
  fs.writeFileSync(path.join(dir, '_headers'), `/*\n${o.allowIndex ? '' : '  X-Robots-Tag: noindex, nofollow\n'}  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n`);
}
async function deployToPages(c, project, dir, isNew) {
  if (isNew) {
    const cr = await cfApi(c, 'POST', `/accounts/${c.accountId}/pages/projects`, { name: project, production_branch: 'main' });
    if (!cr.ok) throw new Error('Could not create the Cloudflare project: ' + cfErr(cr));
  }
  const out = await new Promise((resolve) => {
    execFile(WRANGLER_BIN, ['pages', 'deploy', dir, '--project-name', project, '--branch', 'main', '--commit-dirty=true'], {
      cwd: PUBLISH_TMP, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: '/home/ubuntu', CLOUDFLARE_API_TOKEN: c.token, CLOUDFLARE_ACCOUNT_ID: c.accountId, WRANGLER_SEND_METRICS: 'false', CI: '1' }
    }, (err, stdout, stderr) => resolve({ err, text: `${stdout || ''}\n${stderr || ''}` }));
  });
  if (out.err) throw new Error('Deploy failed: ' + out.text.replace(new RegExp(c.token, 'g'), '***').trim().split('\n').slice(-4).join(' '));
  return `https://${project}.pages.dev`;
}
const projectNameFor = (title) => `${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page'}-${crypto.randomBytes(4).toString('hex')}`;

// --- SITES: several pages published together (fb-1790206467703) -------------
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
function readSites() { try { const x = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); return Array.isArray(x) ? x : []; } catch (e) { return []; } }
function writeSites(list) { writeFileAtomic(SITES_FILE, JSON.stringify(list, null, 2)); }
function cleanSiteInput(req, body, prev) {
  const pagesAll = readPagesRegistry();
  const mine = (id) => { const pg = pagesAll.find(x => x.id === id); return pg && (isAdminReq(req) || (pg.owner || 'alex') === req.user.username); };
  const out = { ...(prev || {}) };
  if (typeof body.name === 'string') out.name = body.name.replace(/[<>]/g, '').trim().slice(0, 60);
  if (Array.isArray(body.pages)) out.pages = [...new Set(body.pages.filter(x => typeof x === 'string' && PAGE_ID_RE.test(x) && mine(x)))].slice(0, 20);
  if (typeof body.home === 'string') out.home = body.home;
  if (typeof body.sharedChrome === 'boolean') out.sharedChrome = body.sharedChrome;
  if (!out.pages || !out.pages.length) throw new Error('Pick at least one of your pages.');
  if (!out.pages.includes(out.home)) out.home = out.pages[0];
  if (!out.name) throw new Error('Give the site a name.');
  return out;
}
app.get('/api/sites', (req, res) => {
  const all = readSites();
  res.json(isAdminReq(req) ? all : all.filter(x => x.owner === req.user.username));
});
app.post('/api/sites', (req, res) => {
  try {
    const site = cleanSiteInput(req, req.body || {}, { id: 'site-' + Date.now(), owner: ownerName(req), sharedChrome: true, createdAt: new Date().toISOString() });
    const all = readSites(); all.push(site); writeSites(all);
    res.status(201).json(site);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/sites/:id', (req, res) => {
  const all = readSites(); const i = all.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'No such site' });
  try { all[i] = cleanSiteInput(req, req.body || {}, all[i]); writeSites(all); res.json(all[i]); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/sites/:id', async (req, res) => {
  const all = readSites(); const site = all.find(x => x.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'No such site' });
  const c = readPublishCreds();
  if (site.published && c) { const r = await cfApi(c, 'DELETE', `/accounts/${c.accountId}/pages/projects/${site.published.project}`); if (!r.ok && r.status !== 404) return res.status(502).json({ error: 'Cloudflare refused: ' + cfErr(r) }); }
  writeSites(all.filter(x => x.id !== site.id));
  res.json({ ok: true });
});
app.post('/api/sites/:id/publish', async (req, res) => {
  const all = readSites(); const site = all.find(x => x.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'No such site' });
  const c = readPublishCreds();
  if (!c) return res.status(400).json({ error: 'Publishing is not set up yet — Alex adds the Cloudflare details under Server → Publishing.' });
  const files = (req.body && req.body.pages) || {};
  const linkMap = {}; const byName = {};
  for (const pid of site.pages) {
    const name = pid === site.home ? 'index.html' : `${pid}.html`;
    // Cloudflare serves /about from about.html and 308-redirects about.html, so link to the clean URL.
    linkMap[pid] = pid === site.home ? './' : pid;
    if (typeof files[pid] !== 'string') return res.status(400).json({ error: `Missing the export of page "${pid}".` });
    const bad = validatePublishHtml(files[pid]);
    if (bad) return res.status(400).json({ error: `${pid}: ${bad}` });
    byName[name] = files[pid];
  }
  const warnings = [];
  const project = (site.published && site.published.project) || projectNameFor(site.name);
  const dir = path.join(PUBLISH_TMP, project);
  try {
    bundlePublishDir(dir, byName, linkMap, warnings, { siteUrl: `https://${project}.pages.dev`, allowIndex: req.body.index === true });
    const url = await deployToPages(c, project, dir, !(site.published && site.published.project));
    site.published = { project, url, publishedAt: new Date().toISOString(), by: ownerName(req) };
    writeSites(all);
    res.json({ ok: true, url, project, warnings: [...new Set(warnings)] });
  } catch (e) { res.status(502).json({ error: e.message, warnings: [...new Set(warnings)] }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
app.delete('/api/sites/:id/publish', async (req, res) => {
  const all = readSites(); const site = all.find(x => x.id === req.params.id);
  if (!site || !site.published) return res.status(404).json({ error: 'This site is not published.' });
  const c = readPublishCreds();
  if (!c) return res.status(400).json({ error: 'Publishing is not set up.' });
  const r = await cfApi(c, 'DELETE', `/accounts/${c.accountId}/pages/projects/${site.published.project}`);
  if (!r.ok && r.status !== 404) return res.status(502).json({ error: 'Cloudflare refused: ' + cfErr(r) });
  delete site.published; writeSites(all);
  res.json({ ok: true });
});

app.post('/api/pages/:id/publish', async (req, res) => {
  const id = req.params.id;
  const c = readPublishCreds();
  if (!c) return res.status(400).json({ error: 'Publishing is not set up yet — Alex adds the Cloudflare details under Server → Publishing.' });
  const pages = readPagesRegistry();
  const pg = pages.find(x => x.id === id);
  if (!pg) return res.status(404).json({ error: 'Only custom pages can be published.' });
  const bad = validatePublishHtml(req.body && req.body.html);
  if (bad) return res.status(400).json({ error: bad });
  const warnings = [];
  const project = (pg.published && pg.published.project) || projectNameFor(pg.title || id);
  const dir = path.join(PUBLISH_TMP, project);
  try {
    bundlePublishDir(dir, { 'index.html': req.body.html }, null, warnings, { siteUrl: `https://${project}.pages.dev`, allowIndex: req.body.index === true });
    await deployToPages(c, project, dir, !(pg.published && pg.published.project));
    const url = `https://${project}.pages.dev`;
    pg.published = { project, url, publishedAt: new Date().toISOString(), by: ownerName(req) };
    writePagesRegistry(pages);
    res.json({ ok: true, url, project, warnings: [...new Set(warnings)] });
  } catch (e) {
    res.status(502).json({ error: e.message, warnings: [...new Set(warnings)] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

app.delete('/api/pages/:id/publish', async (req, res) => {
  const pages = readPagesRegistry();
  const pg = pages.find(x => x.id === req.params.id);
  if (!pg || !pg.published) return res.status(404).json({ error: 'This page is not published.' });
  const c = readPublishCreds();
  if (!c) return res.status(400).json({ error: 'Publishing is not set up.' });
  const r = await cfApi(c, 'DELETE', `/accounts/${c.accountId}/pages/projects/${pg.published.project}`);
  if (!r.ok && r.status !== 404) return res.status(502).json({ error: 'Cloudflare refused: ' + cfErr(r) });
  delete pg.published;
  writePagesRegistry(pages);
  res.json({ ok: true });
});

// --- PAGE HISTORY (fb-1790206467728) -----------------------------------------
const historyPageOk = (id) => id === 'home' || PAGE_ID_RE.test(id);
app.get('/api/pages/:id/history', (req, res) => {
  const id = req.params.id;
  if (!historyPageOk(id)) return res.status(400).json({ error: 'Invalid page' });
  const dir = path.join(HISTORY_DIR, id);
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).sort().reverse().map(f => {
    let meta = {};
    try { const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); meta = { by: v.by, sections: (v.doc.pageSections || []).length, widgets: (v.doc.widgets || []).length }; } catch (e) {}
    return { ver: f.replace('.json', ''), at: new Date(parseInt(f, 10)).toISOString(), ...meta };
  });
  res.json(list);
});
app.get('/api/pages/:id/history/:ver', (req, res) => {
  const { id, ver } = req.params;
  if (!historyPageOk(id) || !/^\d{10,16}$/.test(ver)) return res.status(400).json({ error: 'Invalid' });
  const f = path.join(HISTORY_DIR, id, `${ver}.json`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(f, 'utf8')).doc);
});
app.post('/api/pages/:id/history/:ver/restore', (req, res) => {
  const { id, ver } = req.params;
  if (!historyPageOk(id) || !/^\d{10,16}$/.test(ver)) return res.status(400).json({ error: 'Invalid' });
  if (id === 'home' && !isAdminReq(req)) return res.status(403).json({ error: 'Not available for your account.' });
  const f = path.join(HISTORY_DIR, id, `${ver}.json`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
  const old = JSON.parse(fs.readFileSync(f, 'utf8')).doc;
  const target = id === 'home' ? HOMEPAGE_FILE : getPageDocPath(id);
  // The version being replaced is always kept, so a restore can be undone.
  try {
    const dir = path.join(HISTORY_DIR, id); fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(target)) fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify({ by: ownerName(req) + ' (before restore)', doc: JSON.parse(fs.readFileSync(target, 'utf8')) }));
  } catch (e) {}
  let doc;
  if (id === 'home') doc = sanitizeHomepage({ ...old, updatedAt: new Date().toISOString(), updatedBy: ownerName(req) });
  else { doc = isAdminReq(req) ? sanitizePageDocFields(old).doc : restrictPageDoc(old).doc; doc.updatedAt = new Date().toISOString(); }
  writeFileAtomic(target, JSON.stringify(doc, null, 2));
  res.json({ ok: true, updatedAt: doc.updatedAt });
});

// --- PAGE IMAGES (fb-1790206467677) ------------------------------------------
// Per-page uploads in media/page-<id>/, normalised with sharp (EXIF rotation,
// max 2400px, WebP). Served from /media like other media (login required), and
// Publish copies them into the static bundle.
const pageImagesDir = (id) => path.join(MEDIA_DIR, `page-${id}`);
app.get('/api/pages/:id/images', (req, res) => {
  const id = req.params.id;
  if (id !== 'home' && !PAGE_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid page' });
  const dir = pageImagesDir(id);
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir).filter(f => /\.(webp|png|jpe?g|gif|svg)$/i.test(f)).map(f => {
    const st = fs.statSync(path.join(dir, f));
    return { file: f, path: `/media/page-${id}/${f}`, bytes: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => b.at.localeCompare(a.at));
  res.json(list);
});
app.post('/api/pages/:id/images', async (req, res) => {
  const id = req.params.id;
  if (id !== 'home' && !PAGE_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid page' });
  if (id === 'home' && !isAdminReq(req)) return res.status(403).json({ error: 'Not available for your account.' });
  const { filename, dataUrl } = req.body || {};
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'Upload a PNG, JPEG, WebP or GIF image.' });
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'Image is larger than 20 MB.' });
  const base = String(filename || 'image').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
  const name = `${base}-${crypto.randomBytes(3).toString('hex')}.webp`;
  try {
    const sharp = require('sharp');
    const dir = pageImagesDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const info = await sharp(buf, { animated: false }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(dir, name));
    res.status(201).json({ file: name, path: `/media/page-${id}/${name}`, width: info.width, height: info.height, bytes: info.size });
  } catch (e) {
    res.status(400).json({ error: 'Could not read that image: ' + e.message });
  }
});
app.delete('/api/pages/:id/images/:file', (req, res) => {
  const { id, file } = req.params;
  if ((id !== 'home' && !PAGE_ID_RE.test(id)) || !/^[a-z0-9-]{1,60}\.(webp|png|jpe?g|gif)$/i.test(file)) return res.status(400).json({ error: 'Invalid' });
  const f = path.join(pageImagesDir(id), file);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(f);
  res.json({ ok: true });
});

// --- PAGES API ---
app.get('/api/pages', (req, res) => {
  const all = readPagesRegistry().map(pg => ({ ...pg, owner: pg.owner || 'alex', shared: pg.shared === true }));
  res.json({ pages: isAdminReq(req) ? all : all.filter(pg => pg.owner === req.user.username || pg.shared) });
});

// Share / rename (owner or admin).
app.patch('/api/pages/:id', (req, res) => {
  const pages = readPagesRegistry();
  const pg = pages.find(x => x.id === req.params.id);
  if (!pg) return res.status(404).json({ error: 'Page not found' });
  if (typeof req.body.shared === 'boolean') pg.shared = req.body.shared;
  if (typeof req.body.title === 'string' && req.body.title.trim()) pg.title = req.body.title.replace(/[<>]/g, '').trim().slice(0, 60);
  writePagesRegistry(pages);
  res.json({ ...pg, owner: pg.owner || 'alex', shared: pg.shared === true });
});

app.post('/api/pages', (req, res) => {
  const { id, templateId } = req.body;
  // Ids become file names and titles/icons are rendered into the tab bar:
  // validated for everyone (fb-1790201502191).
  const title = typeof req.body.title === 'string' ? req.body.title.replace(/[<>]/g, '').trim().slice(0, 60) : '';
  const icon = /^fa-[a-z0-9-]{1,40}$/.test(req.body.icon || '') ? req.body.icon : 'fa-file';
  if (!id || !title) return res.status(400).json({ error: 'Missing id or title' });
  if (!PAGE_ID_RE.test(id)) return res.status(400).json({ error: 'Page id: lowercase letters, digits and dashes only' });
  if (id === 'home' || id === 'server' || id === 'todo') return res.status(400).json({ error: 'Reserved id' });
  
  const pages = readPagesRegistry();
  if (pages.some(p => p.id === id)) return res.status(400).json({ error: 'Page ID already exists' });

  // Optional starting content (fb-1789015021674). Resolved BEFORE the page is
  // registered so a bad template id cannot leave a half-created page behind.
  let startDoc = { widgets: [] };
  if (templateId) {
    const tpl = readTemplate(templateId);
    if (!tpl || (!isAdminReq(req) && !templateVisibleTo(req.user, tpl))) return res.status(400).json({ error: 'Template not found' });
    startDoc = { ...(isAdminReq(req) ? tpl.doc : restrictPageDoc(tpl.doc).doc), updatedAt: new Date().toISOString() };
  }
  
  pages.push({ id, title, icon, owner: ownerName(req), shared: false });
  writePagesRegistry(pages);
  
  const docPath = getPageDocPath(id);
  if (!fs.existsSync(docPath) || templateId) {
    writeFileAtomic(docPath, JSON.stringify(startDoc, null, 2));
  }
  
  res.json({ success: true, page: { id, title, icon, owner: ownerName(req), shared: false } });
});

app.get('/api/pages/:id/content', (req, res) => {
  const id = req.params.id;
  // Sanitized on READ too (fb-1790201502182): the Designer's Claude engine
  // writes the file directly, bypassing every write-path check.
  if (id === 'home') return res.json(readHomepage());
  const docPath = getPageDocPath(id);
  if (!fs.existsSync(docPath)) return res.json({ widgets: [] });
  res.json(sanitizePageDocFields(readJsonStoreOrThrow(docPath)).doc);
});


app.delete('/api/pages/:id', (req, res) => {
  const id = req.params.id;
  if (id === 'home' || id === 'server' || id === 'todo') return res.status(400).json({ error: 'Cannot delete built-in pages' });
  
  let pages = readPagesRegistry();
  if (!pages.some(p => p.id === id)) return res.status(404).json({ error: 'Page not found' });
  
  pages = pages.filter(p => p.id !== id);
  writePagesRegistry(pages);
  
  const docPath = getPageDocPath(id);
  if (fs.existsSync(docPath)) {
    // Optionally delete the JSON file, or just leave it orphaned. We'll delete it to be clean.
    fs.unlinkSync(docPath);
  }
  
  res.json({ success: true });
});

// Update page content directly (if UI wants to modify without agent)
app.post('/api/pages/:id/content', (req, res) => {
  const id = req.params.id;
  const docPath = getPageDocPath(id);
  try {
    const { expectedUpdatedAt, ...doc } = req.body || {};
    // Same optimistic check as PUT /api/homepage (fb-1789015021701).
    if (expectedUpdatedAt && fs.existsSync(docPath)) {
      let current = null;
      try { current = readJsonStoreOrThrow(docPath); } catch (e) { current = null; }
      if (current && current.updatedAt && current.updatedAt !== expectedUpdatedAt) {
        return res.status(409).json({ error: 'stale', message: 'This page changed elsewhere since you loaded it.', updatedAt: current.updatedAt, updatedBy: current.updatedBy });
      }
    }
    let saveDoc = doc;
    if (!isAdminReq(req)) saveDoc = restrictPageDoc(doc).doc;   // pages users never store raw HTML
    else sanitizePageDocFields(saveDoc);
    saveDoc.updatedAt = new Date().toISOString();
    snapshotBeforeWrite(id, docPath, ownerName(req));
    writeFileAtomic(docPath, JSON.stringify(saveDoc, null, 2));
    res.json({ success: true, updatedAt: saveDoc.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- WIDGET IMPORT & PAGE TEMPLATES (fb-1789015021674) ---
// A pasted widget goes through the SAME whitelist as a saved homepage widget
// (sanitizeHomepageWidget: theme/accent whitelisted, html length-capped), then
// gets a fresh id so it can never collide with one already on the page.
app.post('/api/widgets/sanitize', (req, res) => {
  const w = req.body && req.body.widget;
  const clean = isAdminReq(req) ? sanitizeHomepageWidget(w, 0) : restrictWidget(w, 0);
  if (!clean) return res.status(400).json({ error: isAdminReq(req) ? 'Not a widget — it needs at least a title or html.' : 'That widget is not available on your account.' });
  clean.id = 'widget-' + Date.now() + Math.floor(Math.random() * 1000);
  res.json({ widget: JSON.parse(JSON.stringify(clean)) }); // drops undefined keys
});

// Templates: data/templates/<tpl-epoch-ms>.json = { id, name, createdAt,
// sourcePage, doc: { widgets, pageTheme?, glanceTheme? } }. Widget ids are
// kept as-is: only one page renders at a time, and DocBody [widget: id]
// shortcodes point at them.
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const TEMPLATE_ID_RE = /^tpl-\d{10,16}$/;
const TEMPLATE_MAX_WIDGETS = 100;

function sanitizeTemplateDoc(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const widgets = (Array.isArray(src.widgets) ? src.widgets : [])
    .slice(0, TEMPLATE_MAX_WIDGETS).map(sanitizeHomepageWidget).filter(Boolean)
    .map(w => JSON.parse(JSON.stringify(w)));
  const themed = sanitizeHomepage({ pageTheme: src.pageTheme, glanceTheme: src.glanceTheme });
  const doc = { widgets };
  if (themed.pageTheme) doc.pageTheme = themed.pageTheme;
  const ps = sanitizePageSections(src.pageSections);
  if (ps && ps.length) doc.pageSections = ps;
  const tk = sanitizeTokens(src.tokens);
  if (tk) doc.tokens = tk;
  if (src.glanceTheme && themed.glanceTheme) doc.glanceTheme = themed.glanceTheme;
  return doc;
}

function readTemplate(id) {
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return null;
  const file = path.join(TEMPLATES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

app.get('/api/templates', (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATES_DIR)) return res.json([]);
    const list = fs.readdirSync(TEMPLATES_DIR)
      .filter(f => TEMPLATE_ID_RE.test(f.replace(/\.json$/, '')))
      .map(f => readTemplate(f.replace(/\.json$/, '')))
      .filter(Boolean)
      .map(t => ({ id: t.id, name: t.name, owner: t.owner || 'alex', kind: t.kind || 'page', createdAt: t.createdAt, sourcePage: t.sourcePage, widgetCount: (t.doc.widgets || []).length, sectionType: t.kind === 'section' ? ((t.doc.pageSections || [])[0] || {}).type : undefined }))
      .filter(t => !req.query.kind || t.kind === req.query.kind)
      .filter(t => isAdminReq(req) || templateVisibleTo(req.user, t))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/templates/:id', (req, res) => {
  const t = readTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

app.post('/api/templates', (req, res) => {
  const { name, doc, sourcePage } = req.body || {};
  // kind 'section' (Page Builder v2 phase 2, fb-1790201502161): one reusable
  // section, listed in the Section Library instead of New Page.
  const kind = req.body && req.body.kind === 'section' ? 'section' : 'page';
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  if (!cleanName) return res.status(400).json({ error: 'Template name required' });
  const cleanDoc = isAdminReq(req) ? sanitizeTemplateDoc(doc) : restrictPageDoc(doc).doc;
  if (!cleanDoc.widgets.length && !(cleanDoc.pageSections || []).length) return res.status(400).json({ error: 'This page has no widgets or sections to save' });
  if (kind === 'section' && (cleanDoc.widgets.length || (cleanDoc.pageSections || []).length !== 1 || cleanDoc.pageSections[0].type === 'grid')) {
    return res.status(400).json({ error: 'A section template is exactly one non-grid section' });
  }
  const t = {
    id: 'tpl-' + Date.now(),
    name: cleanName,
    owner: ownerName(req),
    kind,
    createdAt: new Date().toISOString(),
    sourcePage: typeof sourcePage === 'string' ? sourcePage.slice(0, 64) : null,
    doc: cleanDoc
  };
  try {
    if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR);
    writeFileAtomic(path.join(TEMPLATES_DIR, `${t.id}.json`), JSON.stringify(t, null, 2));
    res.status(201).json({ id: t.id, name: t.name, kind, createdAt: t.createdAt, sourcePage: t.sourcePage, widgetCount: cleanDoc.widgets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', (req, res) => {
  if (!readTemplate(req.params.id)) return res.status(404).json({ error: 'Template not found' });
  fs.unlinkSync(path.join(TEMPLATES_DIR, `${req.params.id}.json`));
  res.json({ success: true });
});


// --- 5. INTERACTIVE AGENT SESSIONS & CONVERSATION ENGINE ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'https://gemini-proxy.lagasse-alex.workers.dev';

// --- Gemini request-size budget (added 2026-08-26) --------------------------
// Flash Lite kept dying mid-task ("This operation was aborted" after 4 tool
// calls, live in the "Bug Reports" session). The cause is NOT one oversized
// tool result — individual results were already capped (bash 3000 chars,
// read_file 8000). The cause is ACCUMULATION: `contents` grows by two entries
// every tool turn and the WHOLE array is re-sent on every call. At
// MAX_TOOL_TURNS=120 that is a quadratic amount of text, so a turn doing real
// work marches its request body upward until the proxy stalls on it and the
// 300s timeout fires. Nothing anywhere bounded the request itself.
//
// These constants bound the REQUEST, which is the thing that was unbounded.
// They cap the model's copy of the conversation only — `toolExecutions` (what
// the dashboard shows Alex) always keeps the full untruncated output.
const GEMINI_MAX_REQUEST_CHARS = 120000;    // hard ceiling on one serialized request body
const GEMINI_MAX_HISTORY_CHARS = 2000;      // per prior chat message pulled in as context
// Matches read_file's own 8000-char cap on purpose. Setting this LOWER would
// silently halve how much of a file the model can see — a correctness
// regression traded for a size problem that the cumulative budget below
// already solves properly (it keeps recent results whole and compacts only
// old ones). Per-result capping exists here to stop one pathological result
// (a 50MB bash dump) from blowing the request on its own, not to ration
// normal reads.
const GEMINI_MAX_TOOL_RESULT_CHARS = 8000;  // per tool result as it enters `contents`
const GEMINI_KEEP_RECENT_ROUNDS = 6;        // newest N tool rounds are never compacted
const GEMINI_EVICTED_STUB = '[older tool output was dropped to keep this request within the model context budget — re-run the tool if you still need this output]';

// Shrink a string to `max` chars keeping the HEAD and the TAIL. Cutting only
// one end reliably threw away the half that mattered: the head says what the
// thing was, the tail usually holds the conclusion.
function truncateForModel(text, max) {
  const t = String(text == null ? '' : text);
  if (t.length <= max) return t;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return `${t.slice(0, head)}\n[... ${t.length - max} chars truncated ...]\n${t.slice(t.length - tail)}`;
}

// Cap ONE tool result before it enters `contents`. Operates on a copy — the
// caller keeps the full-fidelity original for the UI.
function capToolResultForModel(result) {
  if (result == null) return result;
  if (typeof result === 'string') return truncateForModel(result, GEMINI_MAX_TOOL_RESULT_CHARS);
  if (typeof result !== 'object') return result;

  const out = Array.isArray(result) ? [] : {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v === 'string') {
      out[k] = truncateForModel(v, GEMINI_MAX_TOOL_RESULT_CHARS);
    } else if (Array.isArray(v) && v.length > 200) {
      // list_directory on a node_modules tree is thousands of entries.
      out[k] = v.slice(0, 200).concat([`[... ${v.length - 200} more entries ...]`]);
    } else {
      out[k] = v;
    }
  }
  // A result with many separately-capped fields can still be huge in aggregate.
  const serialized = JSON.stringify(out);
  if (serialized.length > GEMINI_MAX_TOOL_RESULT_CHARS * 2) {
    return { truncated: true, content: truncateForModel(serialized, GEMINI_MAX_TOOL_RESULT_CHARS * 2) };
  }
  return out;
}

// Force `contents` under GEMINI_MAX_REQUEST_CHARS, MUTATING it in place, and
// return what it had to do so the caller can log it.
//
// The hard constraint the whole function is built around: Gemini rejects a
// `functionCall` that is not followed by its `functionResponse`. So we may
// never remove one half of a round. Stage 1 rewrites response CONTENT in place
// (entry count unchanged, pairing trivially safe); only if that is not enough
// does stage 2 remove whole rounds, always both entries together.
function enforceContentsBudget(contents) {
  const sizeOf = () => JSON.stringify(contents).length;
  const before = sizeOf();
  const stats = { before, after: before, compacted: 0, droppedRounds: 0 };
  if (before <= GEMINI_MAX_REQUEST_CHARS) return stats;

  const hasResponse = (c) => !!(c && c.parts && c.parts.some(p => p.functionResponse));
  const hasCall = (c) => !!(c && c.parts && c.parts.some(p => p.functionCall));

  // --- Stage 1: blank the oldest tool RESULTS, keeping the newest rounds
  // intact. Blanking a result the model is still reasoning about would just
  // make it re-run the call it already ran, so the recent window is protected.
  const responseIdx = [];
  contents.forEach((c, i) => { if (hasResponse(c)) responseIdx.push(i); });
  const evictable = responseIdx.slice(0, Math.max(0, responseIdx.length - GEMINI_KEEP_RECENT_ROUNDS));
  for (const i of evictable) {
    if (sizeOf() <= GEMINI_MAX_REQUEST_CHARS) break;
    const part = contents[i].parts.find(p => p.functionResponse);
    if (!part) continue;
    const resp = part.functionResponse.response;
    if (resp && resp.content === GEMINI_EVICTED_STUB) continue; // already compacted
    part.functionResponse = {
      name: part.functionResponse.name,
      response: { name: part.functionResponse.name, content: GEMINI_EVICTED_STUB }
    };
    stats.compacted++;
  }

  // --- Stage 2: still over. Remove whole oldest rounds — the model turn
  // holding the functionCall AND the user turn holding its functionResponse,
  // spliced together. Index 0 is the user's original request and is never
  // touched; without it the model loses what it was asked to do.
  while (sizeOf() > GEMINI_MAX_REQUEST_CHARS) {
    const remainingRounds = contents.filter(hasCall).length;
    if (remainingRounds <= GEMINI_KEEP_RECENT_ROUNDS) break;
    const i = contents.findIndex((c, idx) => idx > 0 && hasCall(c) && hasResponse(contents[idx + 1]));
    if (i === -1) break;
    contents.splice(i, 2);
    stats.droppedRounds++;
  }

  // --- Stage 3: still over, so the weight is in plain text turns (a long
  // pasted prompt, or the model's own verbose narration). Squeeze the oldest
  // text, never the last two entries the model is answering from.
  if (sizeOf() > GEMINI_MAX_REQUEST_CHARS) {
    for (let i = 0; i < contents.length - 2 && sizeOf() > GEMINI_MAX_REQUEST_CHARS; i++) {
      const parts = contents[i] && contents[i].parts;
      if (!parts) continue;
      parts.forEach(p => {
        if (typeof p.text === 'string' && p.text.length > 800) p.text = truncateForModel(p.text, 800);
      });
    }
  }

  // --- Stage 4, last resort. Everything above deliberately refuses to touch
  // the recent working window, and nothing above trims functionCall ARGUMENTS
  // — which are the model's own output and can be large (a write_file call
  // carries the entire file body). Six protected write_file rounds can
  // therefore still exceed the cap with nothing above willing to act, and an
  // over-budget request is the precise failure this function exists to
  // prevent. So the recent-window protection yields to the ceiling, never the
  // other way round: better a forgetful request than an unsendable one.
  if (sizeOf() > GEMINI_MAX_REQUEST_CHARS) {
    // Shrink call arguments first — cheaper than losing a whole round. This
    // scans EVERY entry including the newest, unlike every stage above: with a
    // single round whose args alone dwarf the cap there is nothing older to
    // trim and nothing left to drop, so exempting the recent entries left the
    // request oversized (caught by test-stage4). Trimming the newest call args
    // is safe — that call has already executed, and it is its RESULT the model
    // reasons forward from, not the arguments it already sent.
    for (let i = 0; i < contents.length && sizeOf() > GEMINI_MAX_REQUEST_CHARS; i++) {
      const parts = (contents[i] && contents[i].parts) || [];
      parts.forEach(p => {
        if (!p.functionCall || !p.functionCall.args) return;
        for (const [k, v] of Object.entries(p.functionCall.args)) {
          if (typeof v === 'string' && v.length > 1000) p.functionCall.args[k] = truncateForModel(v, 1000);
        }
      });
    }
    // Still over: drop oldest rounds past the keep-recent guard, down to a
    // floor of one, so the request is bounded no matter what it contains.
    while (sizeOf() > GEMINI_MAX_REQUEST_CHARS) {
      if (contents.filter(hasCall).length <= 1) break;
      const i = contents.findIndex((c, idx) => idx > 0 && hasCall(c) && hasResponse(contents[idx + 1]));
      if (i === -1) break;
      contents.splice(i, 2);
      stats.droppedRounds++;
    }
  }

  stats.after = sizeOf();
  return stats;
}

// Tool Declarations for Gemini Function Calling
const AGENT_TOOLS_DECLARATION = [
  {
    functionDeclarations: [
      {
        name: 'search_web',
        description: 'Perform a web search using DuckDuckGo to get links and snippets.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Search query.' }
          },
          required: ['query']
        }
      },
      {
        name: 'run_bash',
        description: 'Execute a bash command on the Ubuntu VPS host in /home/ubuntu. Use for diagnostics, searching code, git, PM2, and checking logs.',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: { type: 'STRING', description: 'The exact bash shell command line string to execute.' }
          },
          required: ['command']
        }
      },
      {
        name: 'read_file',
        description: 'Read contents of a file on the VPS. Shared plans are located in /home/ubuntu/dashboard/plans/',
        parameters: {
          type: 'OBJECT',
          properties: {
            filePath: { type: 'STRING', description: 'Absolute or relative path to the file to read.' }
          },
          required: ['filePath']
        }
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a file on the VPS with content.',
        parameters: {
          type: 'OBJECT',
          properties: {
            filePath: { type: 'STRING', description: 'Path of the file to write.' },
            content: { type: 'STRING', description: 'Complete content to write to the file.' }
          },
          required: ['filePath', 'content']
        }
      },
      {
        name: 'list_directory',
        description: 'List contents of a directory on the server (e.g. /home/ubuntu/dashboard/plans/).',
        parameters: {
          type: 'OBJECT',
          properties: {
            dirPath: { type: 'STRING', description: 'Path to directory to list.' }
          },
          required: ['dirPath']
        }
      },
      {
        name: 'feedback',
        description: 'List, update, or delete items in the feedback store (bug reports, feature requests, improvements, chores, and ideas filed via the dashboard feedback box). Priority order — work items in this order: bug > improvement > feature > chore > idea. Use action "create" to report a new ticket (requires type, title, body). Use action "list" to read items (optionally filtered; archived items — done/wont-do for over 24h — are hidden by default, pass filterStatus to see them), action "update" to set status/processedBy/notes on an item as you work it (this is how you record progress — do NOT delete an item you have processed), or action "delete" only to remove a mistaken entry. AFTER ACTING ON AN ITEM, YOU MUST CLOSE IT OUT: call action "update" with status set to "done" (or "wont-do" if you decided against it), processedBy set to who you are, and notes set to a one-line account of what you actually did or why you didn\'t. An item you fixed but left as "new" will be picked up and worked again by the next agent — closing it out is what makes it stop.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', description: 'One of: list, create, update, delete.' },
            filterType: { type: 'STRING', description: 'Optional, for action=list. One of: bug, improvement, feature, chore, idea.' },
            filterStatus: { type: 'STRING', description: 'Optional, for action=list. One of: new, in-progress, done, wont-do.' },
            id: { type: 'STRING', description: 'Required for update/delete — the feedback item id, e.g. fb-1787724518069.' },
            status: { type: 'STRING', description: 'For action=update. One of: new, in-progress, done, wont-do.' },
            processedBy: { type: 'STRING', description: 'For action=update. Free text identifying you (the agent) as the one working this item.' },
            notes: { type: 'STRING', description: 'For action=update. Closing note — what you did, or why not.' },
            title: { type: 'STRING', description: 'For action=create. The title of the ticket.' },
            body: { type: 'STRING', description: 'For action=create. Detailed description of the bug or feature.' }
          },
          required: ['action']
        }
      },
      {
        name: 'schedule_prompt',
        description: 'Queue a prompt to be sent to an AI agent session later — either automatically at a specific time or held for the user to approve manually in the dashboard. Use this to defer work, retry after a rate limit, or set up a follow-up task.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: { type: 'STRING', description: 'The full prompt text to send to the agent later.' },
            runAt: { type: 'STRING', description: 'Optional ISO 8601 timestamp for when to auto-run. Omit to hold the prompt for manual approval in the UI.' },
            frequencyMinutes: { type: 'INTEGER', description: 'Optional. If set (min 10, max 129600), the prompt becomes a recurring task that automatically re-queues itself this many minutes after each successful run.' },
            targetSessionId: { type: 'STRING', description: 'Optional agent session id to send to. Defaults to the current session.' },
            reason: { type: 'STRING', description: 'Short note on why this prompt is being scheduled.' }
          },
          required: ['prompt']
        }
      },
      {
        name: 'send_message',
        description: 'Post a message straight into a dashboard chat, right now, without waiting for your turn to end. Alex sees it within a few seconds. Use it to (a) report progress partway through a long task so the work is visible instead of silent, (b) deliver a finished piece of a job before you start the next piece, or (c) tell Alex what you are about to queue before you call schedule_prompt. This is the tool that makes splitting a big task up work: post the result of part 1, queue part 2, and end your turn — instead of trying to do everything in one oversized context and losing all of it. Keep each message short; it is a chat message, not a report.',
        parameters: {
          type: 'OBJECT',
          properties: {
            text: { type: 'STRING', description: 'The message text to post. Markdown is rendered. Keep it to a few sentences.' },
            targetSessionId: { type: 'STRING', description: 'Optional agent session id to post into. Defaults to the session you are running in.' }
          },
          required: ['text']
        }
      }
    ]
  }
];

function executeLocalTool(toolName, args, role, sessionId) {
  return new Promise((resolve) => {
    if (role === 'query') {
      if (toolName === 'write_file') {
        return resolve({ error: 'Permission Denied: System Inspector is in Read-Only mode and cannot write files.' });
      }
      if (toolName === 'search_web') {
      const q = encodeURIComponent(args.query || '');
      exec(`curl -s "https://html.duckduckgo.com/html/?q=${q}" | grep -oE '<a class="result__snippet[^>]*>.*</a>' | sed 's/<[^>]*>//g'`, { timeout: 15000 }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve({ results: "No results found or search failed." });
        const results = stdout.split('\n').filter(l => l.trim()).slice(0, 5).join('\n\n');
        resolve({ results });
      });
    } else if (toolName === 'run_bash') {
        const cmd = (args.command || '').trim().toLowerCase();
        if (cmd.startsWith('rm ') || cmd.includes('rm -') || cmd.startsWith('reboot') || cmd.startsWith('shutdown') || cmd.startsWith('kill ') || cmd.startsWith('sudo ')) {
          return resolve({ error: 'Permission Denied: Destructive commands blocked in Read-Only mode.' });
        }
      }
      // Feedback contract §4 — query (read-only) may list/read feedback but
      // must never PATCH or DELETE it. Mirrors the write_file block above.
      if (toolName === 'feedback' && args.action && args.action !== 'list') {
        return resolve({ error: 'Permission Denied: System Inspector is in Read-Only mode and cannot modify feedback.' });
      }
    }

    // Designer containment (fb-1787801162107 follow-up): the Designer role is
    // containerized to its page document. It may READ anything for context,
    // but its only writable surface is the homepage live document, and it gets
    // no shell at all — this is the enforced wall that makes "let a cheap
    // model mess around with the page" safe: worst case it ruins
    // homepage.json, which the server's sanitizer + defaults fallback already
    // survive. Enforced here (not just instructed) for every engine that
    // routes tools through this executor (Gemini, Ollama, OpenAI).
    if (role === 'designer') {
      // The wall follows the session's page binding (session.page), so a
      // designer opened on one page can never write another page's document.
      const designerSess = readSessions().find(s => s.id === sessionId);
      const pageId = (designerSess && designerSess.page) || 'home';
      const pageDoc = getPageDocPath(pageId);
      // A Designer working for a pages user (fb-1790201502191) reads only its
      // own page and the component sources, has no tickets and no scheduler,
      // and its writes go through the restricted sanitizer.
      const forPagesUser = !!(designerSess && designerSess.owner && !isAdminUserName(designerSess.owner));
      if (forPagesUser) {
        const componentsDir = path.join(__dirname, '../public/components');
        const inAllowed = (fp) => { const t = path.resolve('/home/ubuntu', fp || ''); return t === pageDoc || t === componentsDir || t.startsWith(componentsDir + path.sep); };
        if ((toolName === 'read_file' || toolName === 'list_directory') && !inAllowed(args.filePath || args.dirPath || args.path)) {
          return resolve({ error: `Permission Denied: on this account the Designer can read only its page (${pageDoc}) and the component library (${componentsDir}).` });
        }
        if (!['read_file', 'list_directory', 'write_file', 'search_web', 'send_message'].includes(toolName)) {   // allow-list
          return resolve({ error: 'Permission Denied: not available on this account.' });
        }
        if (toolName === 'send_message') args.targetSessionId = sessionId;   // never into someone else's chat
      }
      if (toolName === 'run_bash') {
        return resolve({ error: `Permission Denied: the Designer is containerized to its page document and cannot run shell commands. Edit ${pageDoc} with write_file instead.` });
      }
      if (toolName === 'write_file') {
        const target = path.resolve('/home/ubuntu', args.filePath || '');
        if (target !== pageDoc) {
          return resolve({ error: `Permission Denied: the Designer may only write its page document: ${pageDoc}. Read access elsewhere is fine.` });
        }
        // Validated section JSON only (fb-1790201502182): refuse non-JSON,
        // run the same sanitizer the UI's saves go through, and tell the
        // agent exactly what was dropped so it can correct itself.
        let parsed;
        try { parsed = JSON.parse(args.content); } catch (e) {
          return resolve({ error: `Not written: the page document must be valid JSON (${e.message}). Nothing was changed.` });
        }
        let report = [];
        if (forPagesUser) {
          ({ doc: parsed, report } = restrictPageDoc(parsed));
          parsed.updatedAt = new Date().toISOString();
        } else if (pageId === 'home') {
          const before = JSON.stringify(parsed);
          parsed = sanitizeHomepage({ ...parsed, updatedAt: new Date().toISOString(), updatedBy: 'designer' });
          if ((parsed.pageSections || []).length !== (JSON.parse(before).pageSections || []).length) report.push('some sections were dropped (unknown type or bad shape)');
        } else {
          ({ doc: parsed, report } = sanitizePageDocFields(parsed));
          parsed.updatedAt = new Date().toISOString();
        }
        args.content = JSON.stringify(parsed, null, 2);
        args.__designerReport = report.length ? report : ['ok — passed the sanitizer unchanged'];
      }
      if (toolName === 'feedback' && args.action && args.action !== 'list') {
        return resolve({ error: 'Permission Denied: the Designer role does not manage feedback tickets.' });
      }
    }

    if (toolName === 'search_web') {
      const q = encodeURIComponent(args.query || '');
      exec(`curl -s "https://html.duckduckgo.com/html/?q=${q}" | grep -oE '<a class="result__snippet[^>]*>.*</a>' | sed 's/<[^>]*>//g'`, { timeout: 15000 }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve({ results: "No results found or search failed." });
        const results = stdout.split('\n').filter(l => l.trim()).slice(0, 5).join('\n\n');
        resolve({ results });
      });
    } else if (toolName === 'run_bash') {
      // 900s (contract §1) — an agent doing real server work needs to run
      // builds and installs. Still bounded: one tool call inside a turn, not
      // the turn itself (the turn/Claude CLI has no wall-clock limit at all).
      exec(args.command, { cwd: '/home/ubuntu', timeout: 900000 }, (err, stdout, stderr) => {
        resolve({
          command: args.command,
          exitCode: err ? err.code : 0,
          stdout: (stdout || '').trim().slice(0, 3000),
          stderr: (stderr || (err ? err.message : '')).trim().slice(0, 1000)
        });
      });
    } else if (toolName === 'read_file') {
      const target = path.resolve('/home/ubuntu', args.filePath);
      fs.readFile(target, 'utf8', (err, data) => {
        if (err) return resolve({ error: err.message });
        resolve({ filePath: target, content: data.slice(0, 8000) });
      });
    } else if (toolName === 'write_file') {
      const target = path.resolve('/home/ubuntu', args.filePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFile(target, args.content, 'utf8', (err) => {
        if (err) return resolve({ error: err.message });
        const written = { success: true, filePath: target, bytesWritten: Buffer.byteLength(args.content) };
        if (args.__designerReport) written.sanitizer = args.__designerReport;

        // --- Write-time syntax gate (added 2026-08-26) ----------------------
        // A .js file that does not parse cannot boot. Writing one silently is
        // exactly how staging spent an hour crash-looping through 153 restarts:
        // the agent that wrote the broken line got back a cheerful
        // `success: true` and moved on believing it had finished.
        //
        // promote.sh already ran this identical check — but only at PROMOTE
        // time, long after the responsible agent had stopped. Running it here
        // costs ~50ms and turns a silent, hour-long failure into an immediate
        // one the agent cannot miss.
        //
        // The file is deliberately NOT reverted: the agent needs to see its own
        // work in order to fix it, and a silent rollback would be its own
        // confusing bug. Detection here, containment in stage-check.sh.
        if (!/\.(js|cjs|mjs)$/i.test(target)) return resolve(written);
        execFile('node', ['--check', target], (checkErr, _stdout, checkStderr) => {
          if (!checkErr) return resolve({ ...written, syntaxCheck: 'passed' });
          resolve({
            ...written,
            syntaxCheck: 'FAILED',
            error:
              'SYNTAX ERROR: the file was written but does NOT parse, so it cannot run. ' +
              'Fix it before doing anything else, and do NOT report this work as finished. ' +
              'Node reported:\n' + String(checkStderr || checkErr.message || '').slice(0, 800)
          });
        });
      });
    } else if (toolName === 'list_directory') {
      const target = path.resolve('/home/ubuntu', args.dirPath || '.');
      fs.readdir(target, (err, files) => {
        if (err) return resolve({ error: err.message });
        resolve({ dirPath: target, files });
      });
    } else if (toolName === 'schedule_prompt') {
      const promptText = (args.prompt || '').trim();
      if (!promptText) return resolve({ error: 'prompt is required to schedule.' });
      const sessions = readSessions();
      const targetId = args.targetSessionId || sessionId;
      const session = sessions.find(s => s.id === targetId);
      if (!session) return resolve({ error: `No agent session found with id ${targetId}` });
      const scheduled = readScheduled();
      const item = {
        id: `sched-${Date.now()}`,
        sessionId: targetId,
        sessionName: session.name,
        prompt: promptText,
        model: session.model,     // contract §5 — carries the target session's model at queue time
        runAt: args.runAt || null,
        frequencyMinutes: args.frequencyMinutes ? Math.max(10, Math.min(129600, parseInt(args.frequencyMinutes, 10))) : null,
        status: 'pending',
        source: 'agent',
        reason: args.reason || null,
        attempts: 0,
        createdAt: new Date().toISOString(),
        result: null
      };
      scheduled.unshift(item);
      writeScheduled(scheduled);
      resolve({
        success: true,
        scheduledId: item.id,
        runAt: item.runAt,
        message: `Prompt queued for session "${session.name}"${item.runAt ? ' to auto-run at ' + item.runAt : ' (awaiting manual approval in the dashboard)'}.`
      });
    } else if (toolName === 'send_message') {
      // Async chat: append a message to a session mid-turn. Uses
      // appendMessageFreshly (a fresh read-modify-write) rather than the job's
      // in-memory `session`, because the job holds that object for minutes —
      // writing through it would clobber anything else that touched the store
      // in the meantime, including earlier send_message calls in this same turn.
      const text = (args.text || '').trim();
      if (!text) return resolve({ error: 'text is required to send a message.' });
      const targetId = args.targetSessionId || sessionId;
      const ok = appendMessageFreshly(targetId, {
        role: 'agent',
        text,
        timestamp: new Date().toISOString(),
        async: true,                    // marks it as unprompted, so the UI can badge it
        fromSessionId: sessionId || null
      });
      if (!ok) return resolve({ error: `No agent session found with id ${targetId}. The session may have been deleted.` });
      // Wording matters more than it looks. This first read "Continue working,
      // or end your turn." and Flash Lite took the second option every time:
      // it posted one message, stopped, and then CLAIMED it had done the rest.
      // A tool result that offers stopping as an option gets a weak model to
      // stop. Never end a tool result with permission to quit.
      resolve({
        success: true,
        targetSessionId: targetId,
        message: 'Posted. This does NOT end your turn and it does NOT complete your task — it only made one update visible to Alex. Go straight to the next step now. If steps remain, do them; only stop once every step is genuinely finished or queued with schedule_prompt.'
      });
    } else if (toolName === 'feedback') {
      try {
        const action = (args.action || '').trim();
        if (action === 'list') {
          let items = readFeedback();
          items = decorateArchived(items, todoEngine.now().getTime());
          if (args.filterType) items = items.filter(i => i.type === args.filterType);
          if (args.filterStatus) {
            items = items.filter(i => i.status === args.filterStatus); // explicit status -> archived included too, same reasoning as the HTTP route
          } else {
            items = items.filter(i => !i.archived); // an agent working the list wants LIVE items, not last week's
          }
          items = sortFeedbackNewestFirst(items);
          resolve({ count: items.length, priorityOrder: FEEDBACK_TYPE_IDS, items });
        } else if (action === 'create') {
          if (!args.filterType || !args.title) return resolve({ error: 'filterType (as type) and title are required for action=create' });
          const items = readFeedback();
          const now = new Date().toISOString();
          const newItem = {
            id: 'fb-' + Date.now(),
            type: args.filterType,
            title: (args.title || '').trim(),
            body: args.body || '',
            status: 'new',
            createdAt: now,
            updatedAt: now,
            processedAt: null,
            processedBy: null,
            notes: null
          };
          items.unshift(newItem);
          writeFeedback(items);
          resolve({ success: true, item: newItem });
        } else if (action === 'update') {
          if (!args.id) return resolve({ error: 'id is required for action=update' });
          const items = readFeedback();
          const idx = items.findIndex(i => i.id === args.id);
          if (idx === -1) return resolve({ error: `No feedback item with id ${args.id}` });
          const result = applyFeedbackUpdate(items[idx], { status: args.status, processedBy: args.processedBy, notes: args.notes });
          if (result.error) return resolve({ error: result.error });
          writeFeedback(items);
          resolve({ success: true, item: items[idx] });
        } else if (action === 'delete') {
          if (!args.id) return resolve({ error: 'id is required for action=delete' });
          const items = readFeedback();
          const filtered = items.filter(i => i.id !== args.id);
          if (filtered.length === items.length) return resolve({ error: `No feedback item with id ${args.id}` });
          writeFeedback(filtered);
          resolve({ success: true });
        } else {
          resolve({ error: `Unknown feedback action "${action}". Use list, update, or delete.` });
        }
      } catch (err) {
        resolve({ error: err.message });
      }
    } else {
      resolve({ error: `Unknown tool: ${toolName}` });
    }
  });
}

// Model registry (Model Selection Contract §1)
app.get('/api/agent/models', (req, res) => res.json({ models: MODEL_REGISTRY }));

// Get all agent sessions
// Admin views default to admin-owned sessions: other people's chats are theirs,
// and their text never reaches the admin UI's markdown renderer.
app.get('/api/agent/sessions', (req, res) => {
  const all = readSessions();
  if (!isAdminReq(req)) return res.json(all.filter(x => x.owner === req.user.username));
  res.json(req.query.all === '1' ? all : all.filter(x => isAdminUserName(x.owner)));
});

// Create new agent session
app.post('/api/agent/sessions', (req, res) => {
  let { name, role, model, emoji } = req.body;
  if (!isAdminReq(req)) {
    // A pages user may only open a Designer on a page they own, on a model
    // whose tools run through executeLocalTool (the Claude CLI can read any file).
    const pg = req.body && req.body.page;
    if (role !== 'designer' || !pageOwnedBy(req.user, pg)) return res.status(403).json({ error: 'You can open a Designer only on your own pages.' });
    model = PAGES_USER_DESIGNER_MODEL;
    name = `${(pageEntry(pg) || {}).title || pg} Designer`;
    emoji = undefined;
  }
  const sessions = readSessions();
  const sessionRole = role || 'debugger';
  // Validated against the registry; unknown/missing ids fall back to the
  // default with a warning rather than erroring (contract §2).
  let sessionModel = model || getDefaultModel().id;
  let modelWarning = null;
  if (!getModelById(sessionModel)) {
    modelWarning = `Unknown model "${sessionModel}" — falling back to default "${getDefaultModel().id}".`;
    sessionModel = getDefaultModel().id;
  }

  const roleNames = {
    debugger: 'Server Debugger',
    query: 'System Inspector',
    automator: 'Automation Scripter',
    architect: 'System Architect',
    designer: 'Page Designer',
    pm: 'Project Manager'
  };

  const initialGreetings = {
    debugger: 'Debugger online with full Read/Write and Bash execution access. How can I help you inspect, fix, or build on the server?',
    query: 'System Inspector online in Read-Only mode. Ready to inspect system states, query logs, or analyze files safely.',
    automator: 'Automation Scripter online. Ready to create Python scripts, test data scrapers, and configure cron workflows.',
    architect: 'System Architect online. When designing architecture, I save full execution plans into /home/ubuntu/dashboard/plans/ for other agents to read and implement.',
    designer: 'Designer here! I\'m containerized to this page — I can add widgets, rework the banner, hide or rebuild the stat boxes, and wire cards to your tools. Nothing I do can break the server. What should we change?',
    pm: 'Project Manager online. I manage the feedback.json roadmap and ticket list. How can I help you prioritize or organize your work?'
  };

  // The Designer is a high-frequency, low-stakes role (its writes are walled
  // to the page document), so it defaults to the cheapest fast model instead
  // of the registry default. An explicit model in the request still wins, and
  // the model can be switched later like any session.
  if (sessionRole === 'designer' && !model && getModelById('gpt-4o-mini')) {
    sessionModel = 'gpt-4o-mini'; // fb-1788040125569: ChatGPT mini over flash-lite
  }

  // Designer sessions are bound to one page for their whole life — the write
  // walls and role prompt follow this binding. Unknown pages fall back to
  // 'home' rather than erroring (same forgiving posture as unknown models).
  const requestedPage = (req.body || {}).page;
  const sessionPage = (sessionRole === 'designer')
    ? (typeof requestedPage === 'string' && (requestedPage === 'home' || readPagesRegistry().some(p => p.id === requestedPage)) ? requestedPage : 'home')
    : undefined;

  const newSession = {
    id: `session-${Date.now()}`,
    name: name || roleNames[sessionRole] || 'Agent',
    role: sessionRole,
    ...(sessionPage ? { page: sessionPage } : {}),
    model: sessionModel,
    ...(emoji && emoji.trim() ? { emoji: emoji.trim() } : {}),
    owner: ownerName(req),
    createdAt: new Date().toISOString(),
    messages: [
      {
        role: 'agent',
        text: initialGreetings[sessionRole] || 'Hello! How can I assist you on the server today?',
        timestamp: new Date().toISOString()
      }
    ]
  };

  // Feedback lifecycle Step 1 (plans/feedback_lifecycle_automation.md):
  // a session spawned from a feedback card carries feedbackId; link the two
  // and flip the item to in-progress atomically with session creation, so it
  // happens even if the browser goes away right after. Unknown/stale id is
  // ignored — session creation must never fail over a dead ticket. Items
  // already done/wont-do are linked but NOT reopened.
  const feedbackId = isAdminReq(req) ? (req.body || {}).feedbackId : undefined;   // pages users never touch tickets
  if (feedbackId) {
    const items = readFeedback();
    const item = items.find(i => i.id === feedbackId);
    if (item) {
      newSession.feedbackId = feedbackId;
      item.sessionId = newSession.id;
      if (item.status === 'new' || item.status === 'in-progress') {
        const modelLabel = (getModelById(sessionModel) || {}).label || sessionModel;
        applyFeedbackUpdate(item, { status: 'in-progress', processedBy: `${newSession.name} (${modelLabel})` });

app.patch('/api/agent/sessions/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const sessions = readSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  if (updates.model !== undefined) {
    if (!getModelById(updates.model)) {
      return res.status(400).json({ error: 'Unknown model' });
    }
    session.model = updates.model;
  }
  if (updates.name !== undefined) session.name = updates.name;
  
  writeSessions(sessions);
  res.json(session);
});

      } else {
        item.updatedAt = new Date().toISOString();
      }
      writeFeedback(items);
    }
  }

  sessions.unshift(newSession);
  writeSessions(sessions);
  // modelWarning is response-only (not persisted to disk) — additive field, existing
  // callers that ignore it see the exact same session shape as before.
  res.status(201).json(modelWarning ? { ...newSession, modelWarning } : newSession);
});

// Change a session's model permanently (contract §2). Unknown id -> 400.
app.post('/api/agent/sessions/:id/model', (req, res) => {
  const { model } = req.body;
  if (!model || !getModelById(model)) {
    return res.status(400).json({ error: `Unknown model id "${model}". See GET /api/agent/models.` });
  }
  const sessions = readSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.model = model;
  writeSessions(sessions);
  res.json(session);
});

// Get specific session
app.get('/api/agent/sessions/:id', (req, res) => {
  const sessions = readSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Delete session
app.delete('/api/agent/sessions/:id', (req, res) => {
  let sessions = readSessions();
  sessions = sessions.filter(s => s.id !== req.params.id);
  writeSessions(sessions);
  res.json({ success: true });
});

// Clear session chat history
app.post('/api/agent/sessions/:id/clear', (req, res) => {
  const sessions = readSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.messages = [
    {
      role: 'agent',
      text: 'Conversation history cleared. Ready for your next instruction.',
      timestamp: new Date().toISOString()
    }
  ];
  writeSessions(sessions);
  res.json(session);
});

const CLAUDE_NO_STDIN_PATTERN = /No conversation found with session ID/i;

// --- Job registry (Agent Jobs & Cancellation Contract §1-4, added 2026-08-26) ---
// In-memory only — jobs do not survive a restart, which is correct, because the
// child process/fetch does not either. `jobs`: jobId -> job. `sessionActiveJob`:
// sessionId -> jobId, present ONLY while that job is `running` (contract §2's
// one-running-job-per-session gate). `jobsBySession`: sessionId -> most recent
// jobId regardless of status, so a reconnecting client can find its work again
// via GET /api/agent/sessions/:id/job even after the job finished.
const jobs = new Map();
const sessionActiveJob = new Map();
const jobsBySession = new Map();

// ── DURABLE JOBS & RESTART RESUME (2026-08-26) ───────────────────────────────
// An in-flight LLM turn CANNOT survive a restart: the Claude child is killed and
// the Gemini request dies. So "persistent" means the JOB RECORD survives on disk
// and is re-dispatched on boot with recovered context — never that the original
// generation continues. Anything else would be fiction.
//
// Twice on 2026-08-26 an agent ran promote.sh while its own job was running
// inside the dashboard being restarted; the job, the child process and the reply
// all vanished with no explanation.
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

// Factory so the resume path builds an identical control object (2026-08-26).
// `progress` is the live narration channel: a long run that shows only a spinner
// is indistinguishable from a hang, which is what made a stalled agent look busy.
function makeJobCtrl() {
  // shows only a spinner is indistinguishable from a hang — which is precisely
  // what made a stalled agent look like a working one.
return {
    toolExecutions: [], cancelled: false, kill: null,
    progress: [],
    onProgress(text) {
      if (!text) return;
      const last = this.progress[this.progress.length - 1];
      if (last && last.text === text) return;           // don't repeat identical narration
      this.progress.push({ at: new Date().toISOString(), text: String(text).slice(0, 400) });
      if (this.progress.length > 60) this.progress.shift();
    },
    onTool(t) {
      const label = t && t.name === 'run_bash' && t.args && t.args.command
        ? `$ ${String(t.args.command).split('\n')[0].slice(0, 120)}`
        : `${t && t.name}`;
      this.onProgress(label);
    }
  };
}

function persistJobs() {
  try {
    const out = [...jobs.values()].map(j => ({
      id: j.id, sessionId: j.sessionId, status: j.status, prompt: j.prompt,
      model: j.model, engine: j.engine, startedAt: j.startedAt, finishedAt: j.finishedAt,
      toolExecutions: j.toolExecutions || [], progress: j.progress || [],
      resumeCount: j.resumeCount || 0, interruptedAt: j.interruptedAt || null,
      interruptReason: j.interruptReason || null,
      resumedAsJobId: j.resumedAsJobId || null, resumedFromJobId: j.resumedFromJobId || null,
      result: j.result || null, errorInfo: j.errorInfo || null
    })).slice(-60);
    const tmp = JOBS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, JOBS_FILE);        // atomic
  } catch (e) { /* best effort — never break a turn over bookkeeping */ }
}

function loadJobsFromDisk() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return [];
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) || [];
  } catch (e) { return []; }
}

// Shutdown: mark anything running as interrupted and flush SYNCHRONOUSLY.
let shuttingDown = false;
function handleShutdown() {
  if (shuttingDown) return; shuttingDown = true;
  try {
    for (const j of jobs.values()) {
      if (j.status === 'running') {
        j.status = 'interrupted';
        j.interruptedAt = new Date().toISOString();
        j.interruptReason = 'dashboard restart';
      }
    }
    persistJobs();
  } catch (e) { /* never block shutdown */ }
  process.exit(0);
}
process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

// Rate guard: an agent's own action is the likeliest cause of a restart, so
// auto-resume can recreate the restart forever. Cap it hard.
const resumeTimestamps = [];
function resumeRateExceeded() {
  const now = Date.now();
  while (resumeTimestamps.length && now - resumeTimestamps[0] > 5 * 60 * 1000) resumeTimestamps.shift();
  return resumeTimestamps.length >= 3;
}

function buildResumePrompt(oldJob) {
  const tools = (oldJob.toolExecutions || []).slice(-12).map(t => {
    const cmd = t.args && t.args.command ? String(t.args.command).split('\n')[0].slice(0, 120) : JSON.stringify(t.args || {}).slice(0, 120);
    return `  - ${t.name}: ${cmd}`;
  }).join('\n') || '  (none recorded)';
  return [
    '⚠️ SYSTEM NOTICE — your previous turn was INTERRUPTED by a dashboard restart at ' + (oldJob.interruptedAt || 'an unknown time') + '.',
    '',
    'THE RESTART HAS NOW COMPLETED AND THE SERVER IS HEALTHY. You are running on the restarted instance.',
    '',
    'This is a NEW turn with recovered context — your previous generation did not continue, it was killed mid-flight.',
    '',
    'Tool calls you had already made before the interruption:',
    tools,
    '',
    'BEFORE DOING ANYTHING ELSE: verify the ACTUAL current state on disk. Some of those calls may have completed, some may have half-completed, and some may not have run at all. A half-applied edit is the dangerous case — check the files rather than assuming either that nothing landed or that everything did.',
    '',
    '⛔ THAT LIST IS NOT A COMPLETE RECORD. For Claude-engine turns it shows a single `claude_code_cli` entry and NONE of the individual file edits made inside it, so it tells you almost nothing about what actually landed. Treat it as a hint, never as evidence.',
    '',
    '⛔ DO NOT CLAIM ANY CHANGE "ALREADY LANDED" UNLESS YOU JUST RAN A COMMAND THIS TURN THAT PROVES IT, AND YOU QUOTE THAT COMMAND\'S REAL OUTPUT. Assume nothing survived. This exact failure happened live on 2026-08-26: a resumed turn announced that its fix "had already landed" and said it had confirmed this by diffing live against staging — while those two files were byte-identical, so the diff it described could not have existed. It then closed the bug report. The bug was fixed nowhere. Inventing a verification is far worse than reporting that you are unsure.',
    '',
    'Also re-check that the tree you are working in still contains the work you expect. A staging tree can be reset from live between turns, which silently deletes unpromoted changes.',
    '',
    'Then continue the original request below, or report clearly what is already done and what remains.',
    '',
    '--- ORIGINAL REQUEST ---',
    oldJob.prompt || ''
  ].join('\n');
}

// Boot: recover interrupted jobs and resume them once the server is healthy.
function recoverInterruptedJobs() {
  const disk = loadJobsFromDisk();

  // Rehydrate EVERY disk job into the in-memory Map first. persistJobs() writes
  // from memory, so without this a restart silently erased every job it did not
  // resume — losing history and 404-ing any client still polling an old jobId,
  // which is the very disappearance this feature exists to prevent.
  for (const j of disk) {
    if (!jobs.has(j.id)) jobs.set(j.id, { ...j, _ctrl: null });
  }

  // Rebuild the session -> newest-job index too. Without this, after any restart
  // GET /api/agent/sessions/:id/job 404s for every pre-restart session, and the
  // UI drops its progress bubble with no explanation — the exact disappearance
  // this feature exists to fix, reintroduced one layer down.
  const newestBySession = new Map();
  for (const j of disk) {
    const prev = newestBySession.get(j.sessionId);
    if (!prev || new Date(j.startedAt).getTime() >= new Date(prev.startedAt).getTime()) {
      newestBySession.set(j.sessionId, j);
    }
  }
  for (const [sid, j] of newestBySession) {
    if (!jobsBySession.has(sid)) jobsBySession.set(sid, j.id);
  }

  const interrupted = disk.filter(j => j.status === 'interrupted' && !j.resumedAsJobId);
  if (!interrupted.length) { persistJobs(); return; }

  const sessions = readSessions();
  let sessionsChanged = false;

  for (const oldJob of interrupted) {
    const session = sessions.find(x => x.id === oldJob.sessionId);
    if (!session) continue;

    const tooManyResumes = (oldJob.resumeCount || 0) >= 2;
    const rateHit = resumeRateExceeded();

    if (tooManyResumes || rateHit) {
      session.messages.push({
        role: 'agent',
        timestamp: new Date().toISOString(),
        toolExecutions: oldJob.toolExecutions || [],
        errorType: 'interrupted',
        text: tooManyResumes
          ? '⚠️ This turn was interrupted by a dashboard restart more than once, so I am **not** resuming it automatically — repeated auto-resume risks a restart loop. Nothing here completed. Re-send the request if you still want it.'
          : '⚠️ This turn was interrupted by a dashboard restart. **Auto-resume has been suspended** because too many resumes happened in a short window, which usually means something is restarting the server repeatedly. Nothing here completed.'
      });
      sessionsChanged = true;
      // Terminal: stop it being reconsidered on every future boot.
      const dead = jobs.get(oldJob.id) || { ...oldJob };
      dead.status = 'error';
      dead.interruptReason = tooManyResumes ? 'resume cap reached' : 'auto-resume suspended (rate guard)';
      jobs.set(oldJob.id, dead);
      continue;
    }

    resumeTimestamps.push(Date.now());
    session.messages.push({
      role: 'agent',
      timestamp: new Date().toISOString(),
      toolExecutions: [],
      errorType: 'interrupted',
      text: '⚠️ My previous turn was interrupted by a dashboard restart. The restart has completed and the server is healthy — **resuming automatically now**, and I will verify what actually landed before continuing.'
    });
    sessionsChanged = true;

    // Re-dispatch as a new job on the same session.
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const modelInfo = getModelById(oldJob.model) || getDefaultModel();
    const ctrl = makeJobCtrl();
    const newJob = {
      id: jobId, sessionId: oldJob.sessionId, status: 'running',
      prompt: oldJob.prompt, model: modelInfo.id, engine: modelInfo.engine,
      startedAt: new Date().toISOString(), finishedAt: null,
      toolExecutions: ctrl.toolExecutions, progress: ctrl.progress,
      resumeCount: (oldJob.resumeCount || 0) + 1,
      interruptedAt: null, interruptReason: null,
      resumedFromJobId: oldJob.id, resumedAsJobId: null,
      result: null, errorInfo: null, _ctrl: ctrl
    };
    // Keep the old record so a client polling it can follow the chain forward.
    const stale = { ...oldJob, resumedAsJobId: jobId, _ctrl: null };
    jobs.set(oldJob.id, stale);
    jobs.set(jobId, newJob);
    sessionActiveJob.set(oldJob.sessionId, jobId);
    jobsBySession.set(oldJob.sessionId, jobId);

    const freshSession = readSessions().find(x => x.id === oldJob.sessionId) || session;
    runJobInBackground(newJob, freshSession, buildResumePrompt(oldJob), modelInfo.id, ctrl);
  }

  if (sessionsChanged) writeSessions(sessions);
  persistJobs();
}

function serializeJob(job) {
  const startMs = new Date(job.startedAt).getTime();
  const elapsedMs = job.finishedAt
    ? (new Date(job.finishedAt).getTime() - startMs)
    : (Date.now() - startMs);
  return {
    id: job.id,
    sessionId: job.sessionId,
    status: job.status,
    prompt: job.prompt,
    model: job.model,
    engine: job.engine,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs,
    toolExecutions: job.toolExecutions || [],
    // Live narration (added 2026-08-26). Omitted from the first version of this
    // serializer, so the UI polled a field the server never sent — the progress
    // array existed on the job object and simply never reached the client.
    progress: job.progress || [],
    resumeCount: job.resumeCount || 0,
    interruptedAt: job.interruptedAt || null,
    interruptReason: job.interruptReason || null,
    resumedAsJobId: job.resumedAsJobId || null,
    resumedFromJobId: job.resumedFromJobId || null,
    result: job.result,
    // Alias of `result` — the existing UI code already reads `data.agentMsg`
    // from the old synchronous /chat response (contract §3: "includes agentMsg
    // ... in the shape the UI already handles"). Kept identical to `result`
    // rather than a second source of truth.
    agentMsg: job.result,
    errorInfo: job.errorInfo
  };
}

// Runs `claude` via execFile (never through a shell — array args means no injection risk from
// prompt content: backticks, `$(...)`, quotes, etc. are all inert). Resolves with
// { err, stdout, stderr }; never throws.
// `ctrl` (optional) — job-control object { toolExecutions, cancelled, kill }. When
// provided, `ctrl.kill` is set to a function that SIGTERMs the child and SIGKILLs
// it after 5s if still alive (contract §3 cancel semantics). Omitted entirely by
// the scheduled-prompt queue, which has no cancel button — behavior for that
// caller is unchanged.
function execClaude(args, ctrl) {
  return new Promise((resolve) => {
    // NOT `child.killed` — verified live (2026-08-26) that Node sets `.killed`
    // to true as soon as `.kill()` successfully SENDS a signal, regardless of
    // whether the process actually exits. A child that traps SIGTERM (as the
    // Claude CLI wrapper is documented to, a few lines below) would report
    // `.killed === true` immediately and the SIGKILL fallback would never
    // fire — the exact "cancel that doesn't actually kill the process" bug
    // this mechanism exists to prevent. `finished` is only set once the
    // execFile callback itself runs, i.e. the process has genuinely exited.
    let finished = false;
    const child = execFile(
      'claude',
      args,
      // No `timeout` — contract §1: Claude has NO wall-clock limit. It runs
      // until it finishes, errors, or is cancelled via ctrl.kill(). maxBuffer
      // raised from 10MB: a 15-minute pass produces far more output than the
      // short passes this was originally sized for.
      { cwd: '/home/ubuntu', maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        finished = true;
        resolve({ err, stdout: stdout || '', stderr: stderr || '' });
      }
    );
    // No interactive input to send — end stdin immediately (equivalent of `< /dev/null`,
    // but via the array/exec form so it doesn't touch a shell).
    if (child.stdin) child.stdin.end();
    if (ctrl) {
      ctrl.kill = () => {
        try { child.kill('SIGTERM'); } catch (e) { /* already dead */ }
        setTimeout(() => {
          if (finished) return; // exited cleanly within the grace period
          try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
        }, 5000);
      };
    }
  });
}

// Runs one turn through the Claude Code CLI. Session-aware (via --resume), role-aware
// (query role runs genuinely read-only — verified empirically, not just instructed), and
// never surfaces a raw err.message or merged stderr into the chat.
// `ctrl` (optional, added 2026-08-26) — job-control object { toolExecutions,
// cancelled, kill }. Passed through to execClaude so a job's DELETE handler can
// kill the child process. Trailing and optional: the scheduled-prompt queue
// calls this with its original argument count and sees identical behavior
// (contract §4 — signature kept effectively unchanged for that caller).
function geminiToOpenAITools(geminiToolsDecl) {
  if (!geminiToolsDecl || !geminiToolsDecl[0] || !geminiToolsDecl[0].functionDeclarations) return [];
  return geminiToolsDecl[0].functionDeclarations.map(fd => {
    const convertType = (schema) => {
      if (!schema) return schema;
      const s = { ...schema };
      if (s.type) s.type = s.type.toLowerCase();
      if (s.properties) {
        for (const k in s.properties) s.properties[k] = convertType(s.properties[k]);
      }
      if (s.items) s.items = convertType(s.items);
      return s;
    };
    return {
      type: 'function',
      function: { name: fd.name, description: fd.description, parameters: convertType(fd.parameters) }
    };
  });
}

// --- Ollama model auto-pull (fb-1787942756993) ---
// A chat against a not-yet-downloaded local model used to dead-end with a raw
// 404 from Ollama. The 404 handler in runOllamaOpenAITurn now kicks off a
// background pull (deduped here — concurrent chats against the same missing
// model share one download) and the reply embeds an <ada-widget> gauge that
// polls /api/ollama/pull-status for live progress.
const ollamaPulls = new Map(); // apiModel -> { status, percent, error, startedAt }

function startOllamaPull(model) {
  const existing = ollamaPulls.get(model);
  if (existing && existing.status === 'downloading') return existing;
  const entry = { status: 'downloading', percent: 0, error: null, startedAt: new Date().toISOString() };
  ollamaPulls.set(model, entry);
  (async () => {
    try {
      const res = await fetch('http://127.0.0.1:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true })
      });
      if (!res.ok || !res.body) throw new Error(`pull request failed (HTTP ${res.status})`);
      // NDJSON stream: one status object per line. Layers reset completed/total
      // as they start, so percent can step back briefly — the big weights layer
      // dominates, which makes it an honest progress signal overall.
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error(j.error);
          if (typeof j.total === 'number' && typeof j.completed === 'number' && j.total > 0) {
            entry.percent = Math.round((j.completed / j.total) * 100);
          }
          if (j.status === 'success') { entry.status = 'done'; entry.percent = 100; }
        }
      }
      if (entry.status !== 'done') { entry.status = 'done'; entry.percent = 100; }
      console.log(`[ollama] pull complete: ${model}`);
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message;
      console.error(`[ollama] pull failed: ${model}: ${e.message}`);
    }
  })();
  return entry;
}

app.get('/api/ollama/pull-status', (req, res) => {
  const model = String(req.query.model || '');
  const entry = ollamaPulls.get(model);
  if (!entry) return res.json({ model, status: 'none', percent: 0 });
  res.json({ model, ...entry });
});

async function runOllamaOpenAITurn(session, promptText, systemInstruction, modelId, apiModel, ctrl, engine) {
  const toolExecutions = (ctrl && ctrl.toolExecutions) || [];
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  const apiUrl = engine === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'http://127.0.0.1:11434/api/chat';
  
  if (engine === 'openai' && !OPENAI_API_KEY) {
    return { agentMsg: { role: 'agent', text: '⚠️ OPENAI_API_KEY is not set in the environment. Please add it to PM2 or .env.', timestamp: new Date().toISOString(), toolExecutions, errorType: 'auth' }, errorInfo: null };
  }

  let allowedTools = AGENT_TOOLS_DECLARATION;
  if (modelId === 'gemma2-local' || modelId === 'llama3.2-local') {
    allowedTools = allowedTools.filter(t => !['run_bash', 'write_file'].includes(t.name));
  }
  let tools = geminiToOpenAITools(allowedTools);
  const messages = [{ role: 'system', content: systemInstruction }];
  session.messages.slice(-6).forEach(msg => {
    if (msg.role === 'user' || msg.role === 'agent') {
      messages.push({ role: msg.role === 'agent' ? 'assistant' : 'user', content: truncateForModel(msg.text || '', GEMINI_MAX_HISTORY_CHARS) });
    }
  });
  if (messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: truncateForModel(promptText || 'Continue.', GEMINI_MAX_HISTORY_CHARS) });
  }

  const MAX_TOOL_TURNS = 120;
  let turns = 0;
  let hitGuard = false;
  let finalResponseText = '';

  while (true) {
    if (ctrl && ctrl.cancelled) break;
    
    const reqBody = { model: apiModel, messages, stream: false };
    if (tools) reqBody.tools = tools;
    const headers = { 'Content-Type': 'application/json' };
    if (engine === 'openai') headers['Authorization'] = `Bearer ${OPENAI_API_KEY}`;
    
    let resData;
    // Contract §3: point ctrl.kill at the in-flight request so the job's DELETE
    // handler can abort it. Without this, cancel only lands between turns — and
    // with stream:false Ollama generates the ENTIRE completion before returning,
    // so a cancelled job kept burning CPU for minutes (observed 2026-08-28).
    // Aborting the fetch closes the connection, which makes Ollama stop generating.
    const ac = new AbortController();
    if (ctrl) ctrl.kill = () => ac.abort();
    try {
      const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(reqBody), signal: ac.signal });
      if (!res.ok) {
        const errText = await res.text();
        // Missing local model: auto-pull instead of surfacing a raw 404
        // (fb-1787942756993). The gauge widget gives the downloading state.
        if (engine === 'ollama' && res.status === 404 && /not found/i.test(errText)) {
          const pull = startOllamaPull(apiModel);
          const enc = encodeURIComponent(apiModel);
          const text = pull.status === 'error'
            ? `⚠️ The local model **${apiModel}** isn't downloaded, and the automatic pull failed: ${pull.error}. Check that Ollama is running and has disk space, then try again.`
            : `⏳ The local model **${apiModel}** isn't downloaded on the VPS yet, so I've started pulling it automatically. The download continues in the background — live progress:\n\n<ada-widget type="gauge" label="Downloading ${apiModel}" endpoint="/api/ollama/pull-status?model=${enc}" path="percent" unit="%" refresh="3" accent="sky"></ada-widget>\n\nRe-send your message once it reaches 100%.`;
          return { agentMsg: { role: 'agent', text, timestamp: new Date().toISOString(), toolExecutions, errorType: 'model-downloading' }, errorInfo: null };
        }
        // Some local models (e.g. gemma2:2b) reject any request carrying a
        // tools array. Drop tools and retry the turn as plain chat — found
        // while e2e-testing the auto-pull path on 2026-09-02.
        if (engine === 'ollama' && res.status === 400 && /does not support tools/i.test(errText) && tools) {
          tools = null;
          continue;
        }
        return { agentMsg: { role: 'agent', text: `⚠️ API error (${res.status}): ${errText}`, timestamp: new Date().toISOString(), toolExecutions, errorType: 'api' }, errorInfo: null };
      }
      resData = await res.json();
    } catch (e) {
      // A user cancel aborts this fetch; fall through to the normal cancelled
      // exit instead of reporting a phantom network error.
      if (ctrl && ctrl.cancelled) break;
      return { agentMsg: { role: 'agent', text: `⚠️ Connection failed: ${e.message}`, timestamp: new Date().toISOString(), toolExecutions, errorType: 'network' }, errorInfo: null };
    }
    
    const reply = engine === 'openai' ? resData.choices[0].message : resData.message;
    if (!reply) break;
    
    messages.push(reply);
    
    if (reply.content) {
      finalResponseText += (finalResponseText ? '\n' : '') + reply.content;
      if (ctrl && typeof ctrl.onProgress === 'function') ctrl.onProgress(reply.content);
    }
    
    if (!reply.tool_calls || reply.tool_calls.length === 0) break;
    
    if (turns >= MAX_TOOL_TURNS) { hitGuard = true; break; }
    turns++;
    
    for (const tcall of reply.tool_calls) {
      if (ctrl && ctrl.cancelled) break;
      const functionCall = tcall.function;
      let args = {};
      try { args = JSON.parse(functionCall.arguments); } catch (e) { /* ignore parse error */ }
      
      const toolResult = await executeLocalTool(functionCall.name, args || {}, session.role, session.id);
      toolExecutions.push({ name: functionCall.name, args, result: toolResult });
      if (ctrl && typeof ctrl.onTool === 'function') ctrl.onTool({ name: functionCall.name, args, result: toolResult });
      
      const cappedRes = typeof toolResult === 'string' ? capToolResultForModel(toolResult) : capToolResultForModel(JSON.stringify(toolResult));
      messages.push({ role: 'tool', tool_call_id: tcall.id, name: functionCall.name, content: cappedRes });
    }
  }

  if (hitGuard) finalResponseText += `\n\n[Antigravity system] I stopped after ${turns} tool calls without finishing — this task is NOT complete.`;
  
  return { agentMsg: { role: 'agent', text: finalResponseText || 'Task processed.', timestamp: new Date().toISOString(), toolExecutions }, errorInfo: null };
}

async function runOllamaTurn(session, promptText, systemInstruction, modelId, apiModel, ctrl) {
  return runOllamaOpenAITurn(session, promptText, systemInstruction, modelId, apiModel, ctrl, 'ollama');
}

async function runOpenAITurn(session, promptText, systemInstruction, modelId, apiModel, ctrl) {
  return runOllamaOpenAITurn(session, promptText, systemInstruction, modelId, apiModel, ctrl, 'openai');
}

async function runClaudeHeavyTurn(session, promptText, systemInstruction, modelId, apiModel, ctrl) {
  const buildArgs = (resumeId) => {
    let effectivePrompt = promptText;
    // Fix fb-1787766376993: If switching to Claude from another model, it has no resumeId, 
    // so it loses all context. We must manually inject the last few turns into the prompt.
    if (!resumeId && session.messages && session.messages.length > 0) {
      const historyContext = session.messages.slice(-6).map(m => `${m.role.toUpperCase()}:\n${m.text}`).join('\n\n');
      effectivePrompt = `[Previous Conversation Context]\n${historyContext}\n\n[New Request]\n${promptText}`;
    }
    const args = ['-p', effectivePrompt, '--output-format', 'json', '--append-system-prompt', systemInstruction];
    if (resumeId) args.push('--resume', resumeId);
    // apiModel is null/undefined for claude-heavy — CLI default, unchanged from prior behavior.
    if (apiModel) args.push('--model', apiModel);
    if (session.role === 'query') {
      // Read-only role: do NOT pass --dangerously-skip-permissions. Verified 2026-08-26 that
      // without it, Claude Code's own non-interactive sandbox auto-denies both the Write tool
      // and Bash-based writes/redirection (permission_denials populated, no file created either
      // way) — this is an enforced wall, not a hoped-for instruction. --disallowedTools is
      // added as declared defense-in-depth on top of that.
      args.push('--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit');
    } else if (session.role === 'designer') {
      // Designer containment on the Claude engine: same mechanism as query —
      // WITHOUT --dangerously-skip-permissions, Claude Code's non-interactive
      // sandbox auto-denies any tool not explicitly pre-approved (verified
      // 2026-08-26 for the query role). We pre-approve Write/Edit ONLY on the
      // page document, so a powerful model can be swapped in and still can't
      // touch code, config, or the shell.
      args.push('--disallowedTools', 'Bash,NotebookEdit');
      // Permission-rule syntax: absolute paths need the '//' prefix
      // (Write(//abs/path)); a single '/' is treated as settings-relative and
      // matches nothing — verified empirically 2026-08-27, the designer was
      // denied its own page document until this was fixed.
      const designerDoc = getPageDocPath(session.page || 'home');
      args.push('--allowedTools', `Write(/${designerDoc}),Edit(/${designerDoc})`);
    } else {
      args.push('--dangerously-skip-permissions');
    }
    return args;
  };

  if (ctrl && typeof ctrl.onProgress === 'function') {
    ctrl.onProgress(`Claude (${modelId}) started — this can run for many minutes on a large task.`);
  }
  let { err, stdout, stderr } = await execClaude(buildArgs(session.claudeSessionId), ctrl);

  // A stored session id can go stale (VPS restart, session pruning, etc.). Detect the specific
  // "no conversation found" failure and retry once fresh, rather than surfacing it as an error.
  // Skip the retry if cancellation was already requested — don't spawn new work after a kill.
  if (!stdout && CLAUDE_NO_STDIN_PATTERN.test(stderr) && !(ctrl && ctrl.cancelled)) {
    session.claudeSessionId = null;
    ({ err, stdout, stderr } = await execClaude(buildArgs(null), ctrl));
  }

  // Shared with the caller's job-control object when present, so a job's
  // recorded toolExecutions reflect this turn even if the promise below never
  // gets to return normally (e.g. it was killed and the wrapper overrides the
  // result with a cancellation message built from this same array).
  const toolExecutions = (ctrl && ctrl.toolExecutions) || [];

  // Node sets err.killed when a process is killed (by us, via ctrl.kill(), since
  // there is no more automatic wall-clock timeout — contract §1). err.signal is
  // NOT reliably 'SIGTERM' here — the Claude CLI is itself a wrapper that traps
  // the signal and exits with code 143 (empirically confirmed 2026-08-26), so
  // signal comes back null. err.killed alone is the correct, verified check.
  // This message is a fallback only: the normal cancellation path is the job
  // wrapper checking job.status === 'cancelled' and overriding this entirely.
  if (err && err.killed) {
    const agentMsg = {
      role: 'agent',
      text: `⚠️ The Claude process was terminated before completing.`,
      timestamp: new Date().toISOString(),
      toolExecutions,
      errorType: 'timeout'
    };
    return { agentMsg, errorInfo: buildErrorInfo('claude', modelId, 'timeout', 'Claude Code CLI process was killed before completing.', false) };
  }

  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch (e) { /* not JSON — handled below */ }

  if (!parsed) {
    const errText = (stderr || (err && err.message) || 'Claude Code CLI produced no output.').trim().slice(0, 2000);
    const isQuota = isClaudeQuotaError(errText) || isClaudeQuotaError(stderr);
    const agentMsg = {
      role: 'agent',
      text: `⚠️ Claude Code CLI error: ${errText}`,
      timestamp: new Date().toISOString(),
      toolExecutions,
      errorType: isQuota ? 'quota' : 'other'
    };
    const errorInfo = isQuota
      ? buildErrorInfo('claude', modelId, 'quota', 'Claude usage/rate limit reached. The prompt was not answered.', true)
      : buildErrorInfo('claude', modelId, 'other', errText, false);
    return { agentMsg, errorInfo };
  }

  if (parsed.session_id) session.claudeSessionId = parsed.session_id;

  const responseText = (parsed.result || '').trim();
  toolExecutions.push({ name: 'claude_code_cli', args: { prompt: promptText }, result: { stdout: responseText } });

  if (parsed.is_error) {
    const errText = (responseText || 'Claude Code CLI reported an error with no message.').slice(0, 2000);
    const isQuota = isClaudeQuotaError(errText);
    const agentMsg = {
      role: 'agent',
      text: `⚠️ ${errText}`,
      timestamp: new Date().toISOString(),
      toolExecutions,
      errorType: isQuota ? 'quota' : 'other'
    };
    const errorInfo = isQuota
      ? buildErrorInfo('claude', modelId, 'quota', 'Claude usage/rate limit reached. The prompt was not answered.', true)
      : buildErrorInfo('claude', modelId, 'other', errText, false);
    return { agentMsg, errorInfo };
  }

  const agentMsg = {
    role: 'agent',
    text: responseText || 'Claude executed the task successfully.',
    timestamp: new Date().toISOString(),
    toolExecutions
  };
  return { agentMsg, errorInfo: null };
}

// Core agent turn — runs one prompt through Claude or Gemini and returns the resulting
// agent message plus (on failure) an errorInfo object. Shared by live chat and the
// scheduled-prompt queue. Does NOT mutate session.messages; the caller records messages.
// `modelIdOverride` — when set, this turn runs with that model instead of the
// session's stored one (per-turn override, contract §2). Does not mutate
// session.model; the caller decides whether to persist it.

// Global sliding window for dynamic Gemini API rate pacing.
// Google AI Studio Free Tier has a strict 15 Requests Per Minute limit.
// We record the timestamp of every outgoing request. If we are about to make
// our 15th request within 60 seconds, we pause just long enough to stay under.
const geminiRequestTimestamps = [];
const GEMINI_RPM_LIMIT = 14; // Target 14 to leave a 1-request safety buffer
const GEMINI_RPM_WINDOW_MS = 60000;

async function paceGeminiRequest(ctrl) {
  const now = Date.now();
  // Clear timestamps older than the 60s window
  while (geminiRequestTimestamps.length > 0 && now - geminiRequestTimestamps[0] > GEMINI_RPM_WINDOW_MS) {
    geminiRequestTimestamps.shift();
  }
  
  if (geminiRequestTimestamps.length >= GEMINI_RPM_LIMIT) {
    const oldest = geminiRequestTimestamps[0];
    const waitTime = GEMINI_RPM_WINDOW_MS - (now - oldest) + 500; // Add 500ms padding
    if (waitTime > 0) {
      console.log(`[Pacing] Gemini RPM limit approaching (${geminiRequestTimestamps.length} calls in last 60s). Sleeping ${Math.round(waitTime/1000)}s...`);
      if (ctrl && typeof ctrl.onProgress === 'function') {
        ctrl.onProgress(`⏳ Pacing API calls to respect rate limits. Waiting ${Math.round(waitTime/1000)}s...`);
      }
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
  
  geminiRequestTimestamps.push(Date.now());
}

// `ctrl` (optional, added 2026-08-26 for Agent Jobs & Cancellation Contract) —

// job-control object { toolExecutions, cancelled, kill }. Trailing and
// optional, so the scheduled-prompt queue (which calls this with 3 args, no
// ctrl) sees byte-for-byte identical behavior — contract §4.
async function runAgentTurn(session, promptText, modelIdOverride, ctrl) {
  const effectiveModelId = modelIdOverride || session.model || getDefaultModel().id;
  const modelInfo = getModelById(effectiveModelId) || getDefaultModel();
  // Live script registry for the widget docs below — rebuilt every turn so
  // agents always see the real ids (the designer invented "test-action" on
  // 2026-09-02 because the prompt only showed syntax, not valid values).
  const scriptRegistryNote = readScriptRegistry().map(s => `${s.id} (${s.name})`).join(', ') || 'none registered';
    // PROMOTE_ACTION_TOKEN (module scope, declared with the feedback
    // lifecycle helpers below) is deliberately NOT inline backticks inside
    // the template literal below, so the token can never again break
    // server.js by prematurely closing the sharedMemoryContext template
    // string — the SyntaxError that took down staging on 2026-08-27.
    const sharedMemoryContext = `You are Antigravity, an intelligent autonomous server management assistant on Ubuntu 26.04 VPS (158.69.211.140).
CURRENT SYSTEM TIME: ${new Date().toISOString()} (UTC) / ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} (EST). Always use this real-time clock when determining dates or targets.
CRITICAL RULES:
1. ALWAYS provide a complete, clear, helpful conversational answer in Markdown explaining your findings, answers, or actions.
2. Never output only tool calls or short generic phrases like 'Task processed'. Speak directly, concisely, and clearly to Alex.
3. If you run tools to investigate something, summarize what you found and answer the user's question directly.
4. Server setup: Node.js Express dashboard on PM2 ('ada-dashboard') with Caddy proxy on :80 and :443. Dual engine supports Antigravity Gemini Flash and Claude Code. Shared plans are in /home/ubuntu/dashboard/plans/.
5. To promote changes from staging (port 3001) to live (port 3000), YOU CANNOT RUN promote.sh YOURSELF.\n6. An audit is strictly in order after each update to ensure that the server continues to run properly.
First, verify your changes work on staging using \`bash ~/ops/stage-check.sh\`.
Second, use git to add, commit, and push your changes to GitHub from the staging directory (\`git commit -am "..." && git push origin main\`).
Finally, tell Alex what you built, and include the exact string ${PROMOTE_ACTION_TOKEN} in your message. The UI will render this as a clickable button that pulls the latest main branch from GitHub into the Live server.
6. A feedback store exists at /home/ubuntu/dashboard/data/feedback.json. Work items in priority order: bug > improvement > feature > chore > idea. If using Gemini, use the 'feedback' tool. If using Claude, read and modify the JSON file directly via bash. ALWAYS set status="done", processedBy="your name", and notes="what you did" when finishing an item.
7. ASYNC COMMUNICATION & AUTONOMY: You can send messages to the chat asynchronously without ending your turn by POSTing to http://127.0.0.1:${PORT}/api/agent/sessions/<your-session-id>/messages with body {"text": "your message", "role": "agent"}. (Gemini can also use the 'send_message' tool).
8. SCHEDULING & DEFERRING WORK: You can queue tasks to run autonomously later by POSTing to http://127.0.0.1:${PORT}/api/agent/scheduled with body {"sessionId": "<your-session-id>", "prompt": "task description", "runAt": "ISO8601-timestamp", "frequencyMinutes": <optional-integer-minutes>, "source": "agent", "model": "<model-id>"}. (Gemini can also use the 'schedule_prompt' tool). Set frequencyMinutes (10 to 129600) to make it recurring. This allows you to split large tasks, retry after rate limits, or run background loops. The preApproveDeploy flag on scheduled items is reserved for Alex via the dashboard Scheduler tab — agents must NEVER set it; the server strips it from non-manual sources.
9. HOMEPAGE LIVE DOCUMENT: The dashboard Home tab (announcement banner + widget cards) renders entirely from the JSON file at ${HOMEPAGE_FILE}. Schema: { announcement: {title, text, icon, visible}, sections: {stats, quickLinks} (booleans to hide the built-in stat boxes / quick links), widgets: [{id, title, icon (FontAwesome class like fa-chart-line), accent (indigo|purple|emerald|rose|amber|sky), html (trusted HTML for the card body; may embed live stats via <span data-home-stat="todo|jobs|cpu|bugs"></span>), link: {label, tab (home|todo|tools|server) OR href (URL)}, hidden}] }. Max 24 widgets. Homepage design work belongs to the dedicated "designer" role/agent when possible. To redesign the homepage, edit this file directly (Claude: bash; Gemini: file tools) — changes appear on the next browser refresh with NO server restart and NO promote, because data/ is never synced by promote.sh. Keep it valid JSON; malformed content is dropped by the server's sanitizer. A homepage widget's html body MAY embed the chat widget element (see rule 10) — e.g. <ada-widget type="countdown" id="x" target="ISO" remove-on-complete="true"></ada-widget> — which is the ONLY way to get self-deleting/conditional behavior on the homepage (the ada-countdown component does NOT self-delete; note remove-on-complete only hides the card body client-side, the JSON entry remains until deleted). WARNING: homepage.json is last-writer-wins with no merge — ALWAYS re-read the file immediately before writing, because another agent or the dashboard UI may have changed it since you last looked (a stale write clobbered a sibling agent's widget on 2026-09-02).
10. GENERATIVE UI IN CHAT: You can embed live interactive widgets directly in your chat replies by writing <ada-widget> tags in your markdown (raw HTML passes through). Always put the tag on its own line and ALWAYS close it explicitly with </ada-widget> (never self-close). Types: (a) button — invokes a script or API when Alex clicks it: <ada-widget type="button" label="Restart Crawler" icon="fa-rotate" accent="emerald" script-id="my-script"></ada-widget> or with endpoint="/api/..." method="POST" payload='{"key":"val"}' (single-quote the payload attribute; endpoint must start with /api/; add confirm="Are you sure?" for dangerous actions). (b) photo: <ada-widget type="photo" src="/media/chat/x.png" caption="..."></ada-widget>. (c) countdown: <ada-widget type="countdown" target="2026-09-03T00:00:00Z" label="Deploy window"></ada-widget>. (d) gauge — static value="42" max="100" unit="%" label="CPU", or live with endpoint="/api/system" path="cpu.usage" refresh="10". Accents: indigo|purple|emerald|rose|amber|sky|cyan|red. Use widgets when they beat plain text (one-click follow-up actions, visual status, timers); do not use them decoratively. IMPORTANT WIDGET RULES: script-id MUST be one of the registered ids — currently: ${scriptRegistryNote} — anything else fails with "Unknown script ID". For a harmless demo/preview button, use endpoint="/api/system" method="GET" instead of inventing a script. Never describe behavior the widget's attributes do not declare (a button only self-deletes if you set remove-on-success="true"). CONDITIONAL ATTRS (any type): id="x" (identity — required for the following state to persist across page refreshes); start-hidden="true" (invisible until revealed); show-after="ISO" / show-until="ISO" (time-window visibility, e.g. a message that only appears on a specific date); remove-on-success="true" on buttons (self-deletes after a successful press, e.g. one-shot action buttons); remove-on-complete="true" on countdowns (self-deletes ~3s after hitting zero); on-success-show="targetId" / on-complete-show="targetId" (reveals the start-hidden widget with that id — lets a countdown or button trigger the next widget to appear).
11. AGENDA / CALENDAR: GET /api/agenda?days=N merges Alex's Google Calendar (secret ICS feed URLs in data/calendar-feeds.json — NEVER print, log, or echo these URLs) with local dashboard events in data/calendar.json. To put an event on Alex's agenda widget, append to the data/calendar.json array: {"id":"unique","title":"...","startsAt":"ISO8601","endsAt":"ISO8601 optional","allDay":false,"location":"optional","addedBy":"your name"}. data/ files apply immediately (no restart, no promote). The homepage widget is <ada-calendar> and reads /api/agenda itself.`;

  // Proactive promote-button behavior, appended to CODE-CAPABLE roles only.
  // Read-only 'query' is intentionally excluded — it cannot stage changes, so it
  // must never surface a promote button. Built with string concatenation (no
  // inline backticks) for the same reason PROMOTE_ACTION_TOKEN is a constant:
  // this text must never risk closing the surrounding template literal.
  const promoteWorkflow =
      '\n\nPROMOTE WORKFLOW (code changes): You edit and verify on the STAGING tree'
    + ' (/home/ubuntu/dashboard-staging, served on :3001) — never on live directly. When a change is'
    + ' staged AND verified and ready for Alex, END your reply with ' + PROMOTE_ACTION_TOKEN + ' on its own'
    + ' line; the dashboard renders it as a one-click "Push Staging → Live" button. Only emit it for a'
    + ' real, verified, promotable change — never speculatively — and never run promote.sh yourself.';
  const rolePrompts = {
    debugger: `${sharedMemoryContext}\nRole: Server Debugger & Systems Engineer. Full read/write and bash execution tools. Diagnose issues thoroughly, run commands when necessary, and provide concise, accurate explanations and fixes.${promoteWorkflow}`,
    query: `${sharedMemoryContext}\nRole: System Inspector (SAFE READ-ONLY). Answer questions clearly about server health, logs, and configurations. You cannot modify files.`,
    automator: `${sharedMemoryContext}\nRole: Automation Engineer. Write, test, and manage Python scripts in /home/ubuntu/dashboard/scripts/.${promoteWorkflow}`,
    architect: `${sharedMemoryContext}\nRole: System Architect. Design system plans to /home/ubuntu/dashboard/plans/<name>.md, and build new Web Components (Custom Elements) into /home/ubuntu/dashboard/public/components/ when requested so the Designer agent has more widgets to work with.${promoteWorkflow}`,
    // No promoteWorkflow: the Designer never touches code, so it must never
    // surface a promote button. Its writes are ENFORCED to the page document
    // (tool-level walls in executeLocalTool and the Claude arg builder), so
    // the scope rules below are a description of real limits, not a request.
    bridge: `${sharedMemoryContext}
Role: Remote Bridge. (This role does not use the local LLM; messages are polled externally).`,
    designer: `${sharedMemoryContext}
Role: Page Designer ("Designer"). RULING: you are containerized to exactly ONE page — this session is bound to the dashboard "${session.page || 'home'}" page, which renders entirely from the JSON document at ${getPageDocPath(session.page || 'home')}. That file is your ONLY writable surface (enforced at the tool layer: no shell, writes outside it are denied). You may NOT edit code, other data files, cron jobs, or server state.
CRITICAL: NEVER overwrite homepage.json from scratch! You MUST ALWAYS use read_file on it first, parse the existing widgets, and ONLY modify the specific widgets requested by the user, leaving the rest exactly as they were.
DESIGN CANVAS: { glanceTheme: {theme, accent}, widgets: [{id, title, icon, accent, html, link, hidden}] }. IMPORTANT: You are absolutely FORBIDDEN from writing raw javascript or <script> tags in the 'html' field. Instead, you MUST build the dashboard using the available Web Components (Custom Elements) from the Component Library. All components are transparent by default (no borders), but you can optionally pass theme="glass" (for a sleek translucent blur) or theme="solid". Available blocks:
${(() => { const cat = readComponentCatalog(); return cat.widgets.map(w => `- <${w.tag}> attributes: ${w.schema.map(describeSchemaField).join('; ')}; plus theme (glass|transparent|solid|neon|gradient) and accent (indigo|purple|emerald|rose|amber|sky)`).join('\n'); })()}
- <ada-analog-clock theme="glass|dark|light|transparent"></ada-analog-clock>
- <ada-sysmon theme="glass|transparent|solid|neon|gradient" accent="emerald"></ada-sysmon>
- <ada-scratchpad theme="glass|transparent|solid|neon|gradient" accent="amber"></ada-scratchpad>
- <ada-calendar theme="glass|transparent|solid|neon|gradient" accent="indigo"></ada-calendar>
(The attribute lists above are generated from the components' own code — trust them over memory.)
If the user wants a widget that isn't in the library, tell them to ask the Architect to build the Custom Element first! Changes appear instantly on save.

PAGE SECTIONS (Page Builder v2) — use these to build real, polished pages (landing pages, portfolios, event pages, anything "professional"). The document may hold "pageSections": an ordered list rendered top to bottom:
  [{ "id": "sec-hero1", "type": "<type>", "props": { "<attr>": "<string>" } }]
Section types and their props (generated from the section components' code):
${readComponentCatalog().sections.map(x => `- ${x.type}: ${x.schema.map(describeSchemaField).join('; ')}`).join('\n')}
- grid: holds widgets. props: heading (optional).
LIST PROPS are ONE string, one item per line ("\\n" between lines), fields separated by " | " — fill them with real content, never leave them to the defaults. Examples:
  features.items: "fa-bread-slice | Baked daily | Out of the oven before 7am\\nfa-leaf | Local flour | Milled 20 miles away"
  pricing.plans:  "Small box | $12 | 4 pastries; Mix and match | Order | /order\\n*Family box | $28 | 10 pastries; Free coffee | Order | /order"
  gallery.images: "https://example.com/a.jpg | Caption"   footer.links: "Instagram | https://instagram.com/x\\nContact | mailto:hi@x.com"
  (Arrays are converted to this format, but a string is preferred.) A widget joins a grid with "section": "<grid section id>"; widgets without "section" go to the first grid.
RULES: every prop value is a STRING. Only the listed props exist; unknown types/props are DROPPED by the server's sanitizer. Props are shown as TEXT — never put HTML in them (lists use the line formats in the labels). Links: https://, /path, #anchor or mailto: only. Ids: letters, digits, - and _. When a page has widgets but no pageSections and you add sections, ALSO add a grid section so the existing widgets keep a home.
LOOK — "tokens": { "preset": "default|midnight|glass|minimalist|neon|sunset|rose", "fontHeading"/"fontBody": a CSS font stack (good pairs: 'Playfair Display' + 'Source Sans 3'; 'Fraunces' + 'Inter'; 'Nunito'; 'Poppins'; 'Inter'), "scale": "compact|normal|large", "density": "compact|normal|airy", "radius": "none|sm|md|lg|xl", "brand"/"surface"/"text"/"muted": "#rrggbb" }. Choose a coherent palette with readable contrast (text on surface; buttons pick black or white text automatically). Fonts that load: Inter, Playfair Display, Source Sans 3, Fraunces, Nunito, Poppins, JetBrains Mono, Lato, Montserrat, Roboto, Open Sans, Merriweather, Lora, Raleway, DM Sans, DM Serif Display — use these names exactly, first in the stack.
EDIT, DON'T REBUILD: when asked to change something, re-read the file and change only that — keep every other section, widget and token exactly as it was. Your write_file result includes a "sanitizer" report; if it says anything was dropped, fix it and write again. The user can undo your change from the builder.`
  };

  const systemInstruction = rolePrompts[session.role] || rolePrompts.debugger;
  const toolExecutions = (ctrl && ctrl.toolExecutions) || [];

  // Build an agent error message + queueable errorInfo from a Gemini failure.
  const failure = (httpStatus, errObj) => {
    const info = classifyGeminiError(httpStatus, errObj);
    const agentMsg = {
      role: 'agent',
      text: `⚠️ ${info.message}`,
      timestamp: new Date().toISOString(),
      toolExecutions,
      errorType: info.errorType
    };
    // `overload` is recoverable in exactly the same sense as `quota`: a different
    // model usually works right now. Excluding it suppressed the switch-model
    // offer for the one failure it helps most with (found live 2026-08-26).
    const errorInfo = buildErrorInfo('gemini', modelInfo.id, info.errorType, info.message,
      info.errorType === 'quota' || info.errorType === 'overload');
    return { agentMsg, errorInfo };
  };

  try {
    if (modelInfo.engine === 'claude') {
      return await runClaudeHeavyTurn(session, promptText, systemInstruction, modelInfo.id, modelInfo.apiModel, ctrl);
    }
    if (modelInfo.engine === 'ollama') {
      return await runOllamaTurn(session, promptText, systemInstruction, modelInfo.id, modelInfo.apiModel, ctrl);
    }
    if (modelInfo.engine === 'openai') {
      return await runOpenAITurn(session, promptText, systemInstruction, modelInfo.id, modelInfo.apiModel, ctrl);
    }

    // Default: Antigravity Gemini Flash with Function Calling over Cloudflare Proxy
    const recentMessages = session.messages.slice(-6);
    const contents = [];
    recentMessages.forEach(msg => {
      // A prior turn's text can be thousands of chars on its own; six of them
      // used to be the request's whole starting weight before a single tool
      // even ran. (The previous attempt at this line contained a literal
      // newline inside a single-quoted string, which is a SyntaxError — it
      // crash-looped staging 153 times and is why nothing here was running.)
      const t = truncateForModel(msg.text || '', GEMINI_MAX_HISTORY_CHARS);
      if (msg.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: t }] });
      } else if (msg.role === 'agent' && t) {
        contents.push({ role: 'model', parts: [{ text: t }] });
      }
    });

    // Gemini hard-rejects a request whose final turn is a `model` turn:
    // "Requests ending with a model turn are not supported." That happens
    // whenever agent messages land AFTER the user's last one, and two paths
    // now do exactly that:
    //   1. restart auto-resume, which appends a "resuming automatically"
    //      notice to the session before re-dispatching the job, and
    //   2. send_message, which lets an agent append messages at will.
    // Hit live 2026-08-26: restarting staging twice left three consecutive
    // agent messages, and the resumed turn died on an opaque 400 that looked
    // like a model fault rather than a malformed request. Agents restart
    // staging constantly (stage-check.sh does it), so this would recur.
    // Guarantee the conversation ends with the prompt being answered.
    const lastEntry = contents[contents.length - 1];
    if (!lastEntry || lastEntry.role !== 'user') {
      contents.push({ role: 'user', parts: [{ text: truncateForModel(promptText || 'Continue.', GEMINI_MAX_HISTORY_CHARS) }] });
    }

    // apiModel falls back to the default Gemini model's if the resolved model
    // somehow has none (shouldn't happen — every registered gemini entry has one).
    const geminiApiModel = modelInfo.apiModel || getDefaultModel().apiModel;
    const apiUrl = `${GEMINI_PROXY_URL}/v1beta/models/${geminiApiModel}:generateContent?key=${GEMINI_API_KEY}`;
    // Hardened 2026-08-26 after live failures. Two real faults were reaching the
    // user as raw JS errors:
    //   1. Google/Cloudflare return an HTML error page (404, 429, 5xx, CF 524)
    //      and `apiRes.json()` threw "Unexpected token '<', \"<!DOCTYPE\"...".
    //      Verified live: the proxy faithfully forwards Google's HTML 404 page.
    //   2. `fetch` has NO default timeout. A throttled key made requests hang;
    //      one observed turn stalled 125s before failing. Now bounded.
    // 90s proved too tight on 2026-08-26: a throttled key made single calls hang,
    // and legitimate tool-loop turns were being cut off mid-work. Raised again to
    // 300s per contract §1 — still a bound (a socket with no bytes for 5 minutes
    // is a dead connection, not work), just a more realistic one now that Claude
    // has no bound at all and Gemini is the only engine that still needs one.
    const GEMINI_TIMEOUT_MS = 300000;
    // `ctrl.kill` is (re)pointed at whichever Gemini fetch is currently in
    // flight, so a job's DELETE handler can abort mid-call. Between calls in
    // the tool-execution loop there's a brief window with no live fetch to
    // abort — the loop itself also checks `ctrl.cancelled` before starting
    // another round (below) so cancellation isn't limited to only landing
    // while a fetch happens to be in flight.
    // Turn a bare AbortError into something that says what actually happened.
    // Shared by the fetch AND the body read below: an abort landing while the
    // response body was still streaming used to escape readGemini untagged and
    // reach the chat as the literal, meaningless string "This operation was
    // aborted" — observed live 2026-08-26 in the "Bug Reports" session.
    const classifyAbort = (e) => {
      if (!e || !(e.name === 'AbortError' || /aborted/i.test(e.message || ''))) return null;
      if (ctrl && ctrl.cancelled) {
        const ce = new Error('Cancelled by user.');
        ce.isCancelled = true;
        return ce;
      }
      const te = new Error(`Gemini did not respond within ${Math.round(GEMINI_TIMEOUT_MS / 1000)}s.`);
      te.isGeminiTimeout = true;
      return te;
    };

    const callGemini = async (body) => {
      await paceGeminiRequest(ctrl);
      // Bound the request BEFORE it goes out. Enforcing here rather than at each
      // call site means every path is covered — first call, tool loop, synthesis,
      // and anything added later — instead of relying on each one to remember.
      if (body && Array.isArray(body.contents)) {
        const budget = enforceContentsBudget(body.contents);
        if (budget.compacted || budget.droppedRounds) {
          console.log(`[gemini] request trimmed ${budget.before} -> ${budget.after} chars ` +
            `(compacted ${budget.compacted} tool results, dropped ${budget.droppedRounds} rounds)`);
          // Say it out loud in the progress feed. A silently shortened context
          // makes the model look forgetful for no visible reason.
          if (ctrl && typeof ctrl.onProgress === 'function') {
            ctrl.onProgress(`Context trimmed to stay under the model's request limit (now ~${Math.round(budget.after / 1000)}k chars).`);
          }
        }
      }
      const ac = new AbortController();
      if (ctrl) ctrl.kill = () => ac.abort();
      const timer = setTimeout(() => ac.abort(), GEMINI_TIMEOUT_MS);
      try {
        let attempt = 0;
        while (attempt < 3) {
          attempt++;
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ac.signal
          });
          
          if (res.status === 429 && attempt < 3) {
            // Free tier Gemini 1.5 Flash has a 15 RPM limit. Tool loops often hit this.
            // Sleep for 20 seconds before retrying to let the minute bucket clear.
            await new Promise(resolve => setTimeout(resolve, 20000));
            continue;
          }
          
          return res;
        }
      } catch (e) {
        // An aborted fetch surfaces as a bare AbortError whose message is
        // "This operation was aborted" — meaningless to Alex, and it leaked
        // straight to the chat UI on 2026-08-26. Tag it so the handler below
        // can say what actually happened. A user-initiated cancel (contract
        // §3) and an actual dead-connection timeout both abort the same
        // AbortController, so ctrl.cancelled is what tells them apart.
        const tagged = classifyAbort(e);
        if (tagged) throw tagged;
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };

    // Parse defensively: never hand a non-JSON body to .json(). Returns
    // { data, htmlError } so callers can fail cleanly instead of throwing.
    const readGemini = async (res) => {
      try {
        return await readGeminiBody(res);
      } catch (e) {
        // Reading the body is a SECOND network operation, minutes after the
        // headers arrived on a slow generation. It can abort too, and that
        // abort was previously untagged and leaked to the chat verbatim.
        const tagged = classifyAbort(e);
        if (tagged) throw tagged;
        throw e;
      }
    };

    const readGeminiBody = async (res) => {
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (!ctype.includes('json')) {
        const text = (await res.text()).slice(0, 400);
        const looksHtml = /^\s*<(!doctype|html)/i.test(text);
        return {
          data: null,
          htmlError: {
            code: res.status,
            message: looksHtml
              ? `The Gemini endpoint returned an HTML error page (HTTP ${res.status}) instead of JSON. This is normally upstream throttling or an unavailable model, not a fault in the dashboard.`
              : `Gemini returned a non-JSON response (HTTP ${res.status}, content-type "${ctype || 'unknown'}").`
          }
        };
      }
      try {
        return { data: await res.json(), htmlError: null };
      } catch (e) {
        // Don't let this catch swallow an abort and relabel it "malformed
        // JSON" — a cancel or a timeout would be reported as a parse bug.
        if (classifyAbort(e)) throw e;
        return { data: null, htmlError: { code: res.status, message: `Gemini returned malformed JSON (HTTP ${res.status}).` } };
      }
    };

    let apiRes = await callGemini({ systemInstruction: { parts: [{ text: systemInstruction }] }, contents, tools: AGENT_TOOLS_DECLARATION });
    let parsed = await readGemini(apiRes);
    if (parsed.htmlError) return failure(apiRes.status, parsed.htmlError);
    let data = parsed.data;
    if (!apiRes.ok || data.error) return failure(apiRes.status, data.error);
    let candidate = data.candidates && data.candidates[0];

    // --- Multi-turn tool execution loop -------------------------------------
    // REWRITTEN 2026-08-26. This was `turns < 5`, which capped an agent at FIVE
    // tool calls per message. Reading one 2,700-line file to find an edit point
    // burns all five on greps, so the agent was cut off mid-task and then — being
    // a small model — narrated its plan as though it were finished. Alex had to
    // say "go ahead" repeatedly, buying five calls at a time, and still got
    // nothing implemented.
    //
    // The cap existed because turns used to be synchronous HTTP: you cannot hold
    // a request open for forty tool calls. Jobs are asynchronous now, with cancel
    // and no wall-clock limit, so the constraint no longer applies.
    //
    // MAX_TOOL_TURNS is a RUNAWAY GUARD, not a work budget. Normal termination is
    // the model returning text instead of a functionCall — i.e. it decides it is
    // done. Hitting the guard is an anomaly and is reported as one, never silently.
    const MAX_TOOL_TURNS = 120;
    let turns = 0;
    let hitGuard = false;
    const recentCalls = [];
    while (candidate && candidate.content && candidate.content.parts) {
      if (ctrl && ctrl.cancelled) break; // don't start another round after cancel
      const toolCallPart = candidate.content.parts.find(p => p.functionCall);
      if (!toolCallPart) break;  // <- normal exit: the model produced prose, so it is finished

      if (turns >= MAX_TOOL_TURNS) { hitGuard = true; break; }

      const functionCall = toolCallPart.functionCall;
      turns++;

      // Thrash guard: a weak model can loop on the same call forever. Three
      // identical consecutive calls means it is stuck, not working.
      const sig = functionCall.name + ':' + JSON.stringify(functionCall.args || {});
      recentCalls.push(sig);
      if (recentCalls.length > 3) recentCalls.shift();
      if (recentCalls.length === 3 && recentCalls.every(x => x === sig)) { hitGuard = true; break; }

      // Interim prose alongside a tool call is the agent narrating its progress.
      // Surface it live rather than discarding it — a long run must be visible,
      // or it is indistinguishable from a hang.
      const interim = candidate.content.parts.filter(pp => pp.text).map(pp => pp.text).join(' ').trim();
      if (interim && ctrl && typeof ctrl.onProgress === 'function') ctrl.onProgress(interim);

      const toolResult = await executeLocalTool(functionCall.name, functionCall.args || {}, session.role, session.id);
      toolExecutions.push({ name: functionCall.name, args: functionCall.args, result: toolResult });
      if (ctrl && typeof ctrl.onTool === 'function') {
        ctrl.onTool({ name: functionCall.name, args: functionCall.args, result: toolResult });
      }

      contents.push(candidate.content);
      // The model gets a capped copy; `toolExecutions` above already holds the
      // full result, so the dashboard still shows Alex the complete output.
      // This is the per-result half of the fix — enforceContentsBudget in
      // callGemini is the cumulative half.
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: functionCall.name, response: { name: functionCall.name, content: capToolResultForModel(toolResult) } } }]
      });

      apiRes = await callGemini({ systemInstruction: { parts: [{ text: systemInstruction }] }, contents, tools: AGENT_TOOLS_DECLARATION });
      const loopParsed = await readGemini(apiRes);
      if (loopParsed.htmlError) return failure(apiRes.status, loopParsed.htmlError);
      data = loopParsed.data;
      if (!apiRes.ok || data.error) return failure(apiRes.status, data.error);
      candidate = data.candidates && data.candidates[0];
    }

    // Extract text response
    let responseText = '';
    if (hitGuard) {
      // Never let a truncated run be reported as a completed one — that is the
      // exact failure this whole change exists to prevent.
      responseText = `⚠️ I stopped after ${turns} tool calls without finishing — either I hit the safety guard or I was repeating the same call. **This task is NOT complete.** Nothing here should be treated as done. Tell me to continue and I will pick up from where I stopped.\n\n`;
    }
    if (candidate && candidate.content && candidate.content.parts) {
      const textParts = candidate.content.parts.filter(p => p.text).map(p => p.text);
      if (textParts.length > 0) responseText += textParts.join('\n\n');
    }

    // If Gemini still returned no final text, force a synthesis turn
    if (!responseText || responseText.trim() === '') {
      contents.push({
        role: 'user',
        parts: [{ text: 'Based on the tool results above, provide a direct, conversational explanation answering my original question.' }]
      });
      const finalRes = await callGemini({ systemInstruction: { parts: [{ text: systemInstruction }] }, contents });
      const finalParsed = await readGemini(finalRes);
      if (finalParsed.htmlError) return failure(finalRes.status, finalParsed.htmlError);
      const finalData = finalParsed.data;
      if (!finalRes.ok || finalData.error) return failure(finalRes.status, finalData.error);
      if (finalData.candidates && finalData.candidates[0] && finalData.candidates[0].content) {
        const textParts = finalData.candidates[0].content.parts.filter(p => p.text).map(p => p.text);
        if (textParts.length > 0) responseText = textParts.join('\n\n');
      }
    }

    if (!responseText) {
      responseText = 'I processed your request, but could not format a final response. Please rephrase or check logs.';
    }

    // --- Honesty guard (added 2026-08-26) ------------------------------------
    // Flash Lite reliably stops after ONE tool call and then reports that it
    // did all the remaining steps. Observed repeatedly while testing async
    // chat: it ran a single `wc -l`, then stated it had sent two progress
    // messages and queued a follow-up prompt. None of those tools had run.
    // Rule 7 of the system prompt forbids exactly this and the model does it
    // anyway, so the claim is checked here against what actually executed.
    //
    // Deliberately narrow: it fires only on a PAST-TENSE claim about one of
    // the two tools whose execution is unambiguous. "I can schedule that for
    // you" is an offer, not a claim, and must not trip it.
    const ranTool = (n) => toolExecutions.some(t => t.name === n);
    const falseClaims = [];
    if (!ranTool('send_message') &&
        /\b(?:sent|posted|shared|delivered)\b[^.!?]{0,70}\b(?:message|update|progress note|chat)\b/i.test(responseText)) {
      falseClaims.push('posting a chat message — `send_message` never ran');
    }
    if (!ranTool('schedule_prompt') &&
        /\b(?:scheduled|queued|enqueued)\b[^.!?]{0,70}\b(?:prompt|follow[- ]?up|task|chunk|next step|work)\b/i.test(responseText)) {
      falseClaims.push('queueing follow-up work — `schedule_prompt` never ran');
    }
    if (falseClaims.length) {
      responseText += `\n\n---\n⚠️ **Automatic correction:** this reply claims ${falseClaims.join(', and ')}. ` +
        `Those steps did NOT happen — treat them as outstanding. Ask me to actually run them.`;
      console.log(`[honesty-guard] corrected ${falseClaims.length} unbacked claim(s) in a ${modelInfo.id} turn`);
    }

    return {
      agentMsg: { role: 'agent', text: responseText, timestamp: new Date().toISOString(), toolExecutions },
      errorInfo: null
    };
  } catch (err) {
    // A user-initiated cancel (contract §3). The job wrapper overrides this
    // message with its own cancellation record anyway (it has the definitive
    // toolExecutions list and knows whether any ran), but this keeps
    // runAgentTurn itself well-behaved — it never throws, even when killed.
    if (err && err.isCancelled) {
      return {
        agentMsg: { role: 'agent', text: '🛑 Cancelled by user.', timestamp: new Date().toISOString(), toolExecutions, errorType: 'cancelled' },
        errorInfo: null
      };
    }
    // A Gemini timeout is recoverable in the useful sense: another model —
    // especially a Claude one, which does not touch Gemini at all — usually
    // works right now. Treat it like quota/overload so the UI offers the switch.
    if (err && err.isGeminiTimeout) {
      const msg = `${err.message} The model is most likely throttled upstream rather than broken — this key has been returning 429s and long hangs. Switching to a Claude model bypasses Gemini entirely, or queue the prompt and retry later.`;
      return {
        agentMsg: { role: 'agent', text: `⚠️ ${msg}`, timestamp: new Date().toISOString(), toolExecutions, errorType: 'timeout' },
        errorInfo: buildErrorInfo(modelInfo.engine, modelInfo.id, 'timeout', msg, true)
      };
    }
    return {
      agentMsg: { role: 'agent', text: `Failed to generate agent response: ${err.message}`, timestamp: new Date().toISOString(), toolExecutions, errorType: 'other' },
      errorInfo: buildErrorInfo(modelInfo.engine, modelInfo.id, 'other', err.message, false)
    };
  }
}

// --- Agent Jobs & Cancellation (contract §3), added 2026-08-26 ---
// Re-reads the session store fresh and appends one message to one session,
// then writes back. Used for the job's FINAL write (which happens after an
// arbitrarily long await), so it doesn't clobber whatever any other request
// wrote to agent_sessions.json in the meantime — the risk this change
// introduces by holding a job open for up to 15 minutes instead of one HTTP
// request. `mutateExtra` optionally copies over other fields that changed on
// the in-memory session object during the turn (currently just
// claudeSessionId, set by runClaudeHeavyTurn via --resume).
function appendMessageFreshly(sessionId, message, mutateExtra) {
  const sessions = readSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return false; // session was deleted mid-job — nothing to append to
  if (mutateExtra) mutateExtra(session);
  session.messages.push(message);
  writeSessions(sessions);
  // Feedback lifecycle Step 2: after the message is safely persisted (a
  // feedback-store hiccup must never lose a chat message), check whether a
  // linked session just declared its fix staged.
  if (message.role === 'agent') {
    try { markFeedbackStaged(session, message.text); }
    catch (e) { console.error('[feedback] markFeedbackStaged failed:', e.message); }
  }
  return true;
}

// Runs one job to completion in the background (fire-and-forget from the
// caller's perspective — never awaited by the HTTP handler). Never throws:
// every path resolves the job to a terminal state and appends exactly one
// message to the session.
async function runJobInBackground(job, session, promptText, modelOverride, ctrl) {
  try {
    const { agentMsg, errorInfo } = await runAgentTurn(session, promptText, modelOverride, ctrl);
    finishJob(job, session, agentMsg, errorInfo, ctrl);
  } catch (err) {
    // Belt-and-suspenders — runAgentTurn is written to never throw, but a job
    // that silently vanishes because of one uncaught exception would be a far
    // worse failure mode than a slightly awkward error message.
    const agentMsg = {
      role: 'agent',
      text: `⚠️ Internal error while running this turn: ${err.message}`,
      timestamp: new Date().toISOString(),
      toolExecutions: ctrl.toolExecutions,
      errorType: 'other'
    };
    const errorInfo = buildErrorInfo(job.engine, job.model, 'other', err.message, false);
    finishJob(job, session, agentMsg, errorInfo, ctrl);
  } finally {
    if (sessionActiveJob.get(job.sessionId) === job.id) sessionActiveJob.delete(job.sessionId);
    persistJobs();
  }
}

// Resolves a job to its terminal state and appends the resulting message to
// the session. If the job was cancelled while running, the normal
// agentMsg/errorInfo from runAgentTurn are DISCARDED in favor of an explicit
// cancellation record — contract §3: "A cancelled job still records what
// happened... including any tool executions that already ran." This is the
// single point that decides what the user sees for a cancelled turn,
// regardless of how the underlying Claude/Gemini call reacted to being killed.
function finishJob(job, session, agentMsg, errorInfo, ctrl) {
  const mutateExtra = (freshSession) => {
    if (session.claudeSessionId !== undefined) freshSession.claudeSessionId = session.claudeSessionId;
  };

  if (job.status === 'cancelled') {
    const ranCount = ctrl.toolExecutions.length;
    const cancelMsg = {
      role: 'agent',
      text: ranCount
        ? `🛑 Cancelled by user. ${ranCount} tool execution${ranCount === 1 ? '' : 's'} had already run before cancellation — server state may have changed as a result.`
        : '🛑 Cancelled by user before any tool executions ran.',
      timestamp: new Date().toISOString(),
      toolExecutions: ctrl.toolExecutions,
      errorType: 'cancelled'
    };
    job.result = cancelMsg;
    job.toolExecutions = ctrl.toolExecutions;
    job.finishedAt = job.finishedAt || new Date().toISOString();
    appendMessageFreshly(job.sessionId, cancelMsg, mutateExtra);
    return;
  }

  job.status = errorInfo ? 'error' : 'done';
  job.finishedAt = new Date().toISOString();
  job.result = agentMsg;
  job.errorInfo = errorInfo;
  job.toolExecutions = ctrl.toolExecutions;
  appendMessageFreshly(job.sessionId, agentMsg, mutateExtra);
  notifyJobOutcome(job, session, agentMsg, errorInfo);
}

// Send Chat Message to Agent — starts a job and returns immediately (contract
// §3). The synchronous, whole-turn-in-one-request version is gone: the client
// now polls GET /api/agent/jobs/:jobId (or GET .../job to reattach).
app.post('/api/agent/sessions/:id/chat', (req, res) => {
  try {
    const { id } = req.params;
    let { prompt, model, persistModel } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });
    if (!isAdminReq(req)) { model = PAGES_USER_DESIGNER_MODEL; persistModel = false; }

    const sessions = readSessions();
    const session = sessions.find(s => s.id === id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Only ONE running job per session (contract §2) — a second POST while one
    // is running returns 409 with the running job's id/state so the UI can
    // attach to it instead of starting a second turn.
    const existingJobId = sessionActiveJob.get(id);
    if (existingJobId) {
      const existingJob = jobs.get(existingJobId);
      if (existingJob && existingJob.status === 'running') {
        return res.status(409).json({
          error: 'A job is already running for this session.',
          jobId: existingJob.id,
          job: serializeJob(existingJob)
        });
      }
      sessionActiveJob.delete(id); // stale entry (shouldn't happen, but don't trust it)
    }

    // Optional per-turn model override (contract §2). Both fields absent = today's
    // behavior exactly (undefined override -> runAgentTurn falls back to session.model).
    let modelOverride;
    if (model !== undefined) {
      if (!getModelById(model)) {
        return res.status(400).json({ error: `Unknown model id "${model}". See GET /api/agent/models.` });
      }
      modelOverride = model;
      if (persistModel) session.model = model;
    }

    // The user message is appended and persisted BEFORE responding (contract
    // §3), so it renders instantly regardless of how long the turn takes.
    session.messages.push({ role: 'user', text: prompt.trim(), timestamp: new Date().toISOString() });
    writeSessions(sessions);
    
    // [BRIDGE INTERCEPT]
    // If this session is the Remote Bridge, we DO NOT invoke the local Gemini/Claude
    // agent logic. We just stop here and let the external python daemon poll it.
    if (session.role === 'bridge') {
      return res.json({ bridge: true, session });
    }

    const effectiveModelId = modelOverride || session.model || getDefaultModel().id;
    const modelInfo = getModelById(effectiveModelId) || getDefaultModel();

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ctrl = makeJobCtrl();
    const job = {
      id: jobId,
      sessionId: id,
      status: 'running',
      prompt: prompt.trim(),
      model: modelInfo.id,
      engine: modelInfo.engine,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      toolExecutions: ctrl.toolExecutions,
      progress: ctrl.progress,
      result: null,
      errorInfo: null,
      _ctrl: ctrl
    };
    jobs.set(jobId, job);
    sessionActiveJob.set(id, jobId);
    jobsBySession.set(id, jobId);
    persistJobs();

    // Fire-and-forget — runJobInBackground never throws and always resolves
    // the job to a terminal state, so nothing here needs to await it.
    runJobInBackground(job, session, prompt.trim(), modelOverride, ctrl);

    res.status(202).json({ jobId, status: 'running' });
  } catch (err) {
    res.status(500).json({ error: `Agent chat failed: ${err.message}` });
  }
});

// Job state. When done/error, includes agentMsg/result and errorInfo in the
// shape the UI already handles (contract §3).
app.get('/api/agent/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(serializeJob(job));
});

// The session's current/most-recent job, so a reconnecting client (phone
// dropped, tab reloaded) can find its work again (contract §3).
app.get('/api/agent/sessions/:id/job', (req, res) => {
  const jobId = jobsBySession.get(req.params.id);
  const job = jobId && jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'No job found for this session' });
  res.json(serializeJob(job));
});

// --- Async chat (added 2026-08-26) ------------------------------------------
// Put a message into a chat WITHOUT a prompt having been sent. Until now the
// only way anything reached the chat was as the single terminal message of a
// job the user had started, so a long task was completely silent until it
// finished — and if it died, everything it had done vanished with it.
//
// With this, an agent can report a finished piece, queue the next piece with
// schedule_prompt, and end its turn. Backs the `send_message` tool, and is
// callable by any server-side process (cron, scripts) that wants to talk here.
app.post('/api/agent/sessions/:id/messages', (req, res) => {
  try {
    const { text, role, from } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
    // Anything not explicitly 'user' is an agent message. Accepting arbitrary
    // role strings would put values in the store that renderChatMessages has
    // no branch for, and they would render as blank bubbles.
    const message = {
      role: role === 'user' ? 'user' : 'agent',
      text: String(text).trim(),
      timestamp: new Date().toISOString(),
      async: true,
      fromSessionId: from || null
    };
    if (!appendMessageFreshly(req.params.id, message)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(201).json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: `Failed to post message: ${err.message}` });
  }
});

// Cancel. Kills the Claude child process (SIGTERM, then SIGKILL after 5s) or
// aborts the in-flight Gemini fetch. Marks the job cancelled and returns it
// (contract §3). Idempotent: cancelling an already-finished job just returns
// its current state rather than erroring.
app.delete('/api/agent/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.status !== 'running') return res.json(serializeJob(job));

  job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  const ctrl = job._ctrl;
  if (ctrl) {
    ctrl.cancelled = true;
    if (typeof ctrl.kill === 'function') {
      try { ctrl.kill(); } catch (e) { /* best-effort — the process/fetch may already be gone */ }
    }
  }
  if (sessionActiveJob.get(job.sessionId) === job.id) sessionActiveJob.delete(job.sessionId);
  res.json(serializeJob(job));
});

// --- 6. SCHEDULED PROMPT QUEUE ---
// Execute one queued item: runs the prompt through its target session and updates the item.
async function runScheduledItem(item, opts = {}) {
  const sessions = readSessions();
  const session = sessions.find(s => s.id === item.sessionId);
  item.ranAt = new Date().toISOString();
  item.attempts = (item.attempts || 0) + 1;

  if (!session) {
    item.status = 'failed';
    item.result = 'Target agent session no longer exists.';
    pushNotification({ level: 'error', source: 'scheduler', title: `Scheduled prompt failed: ${item.sessionName || item.sessionId}`, body: item.result, dedupeKey: `sched-error:${item.id}` });
    return { success: false, item };
  }

  session.messages.push({ role: 'user', text: item.prompt, timestamp: new Date().toISOString(), scheduled: true });
  // item.model (contract §5) — the model chosen when this was queued. Existing
  // items with no model field fall back to the session's model, exactly as
  // before this feature, so nothing already queued breaks.
  const { agentMsg, errorInfo } = await runAgentTurn(session, item.prompt, item.model);
  session.messages.push(agentMsg);
  writeSessions(sessions);

  if (errorInfo) {
    item.lastErrorType = errorInfo.errorType;
    item.result = `Attempt ${item.attempts} failed: ${errorInfo.message}`;
    // Auto-runs back off and eventually give up so a dead token can't loop forever.
    if (opts.isAuto && item.attempts >= 5) {
      item.status = 'failed';
    } else if (opts.isAuto && item.runAt) {
      item.status = 'pending';
      item.runAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    } else {
      item.status = 'pending';
    }
    pushNotification({
      level: 'error', source: 'scheduler',
      title: item.status === 'failed' ? `Scheduled prompt gave up: ${session.name}` : `Scheduled prompt failed: ${session.name}`,
      body: item.result,
      link: { tab: 'server', sub: 'agents', sessionId: session.id },
      dedupeKey: `sched-error:${item.id}`
    });
    return { success: false, item, errorInfo };
  }

  // Background runs finish while nobody is looking — that is the whole point
  // of the notification stream. A reply that reads like a question for Alex
  // is escalated to a warning so it is not lost among routine completions.
  {
    const replyText = (agentMsg && agentMsg.text) || '';
    const isRoadblock = looksLikeRoadblock(replyText);
    pushNotification({
      level: isRoadblock ? 'warn' : 'success', source: 'scheduler',
      title: isRoadblock ? `${session.name} needs your input (scheduled run)` : `Scheduled prompt ran: ${session.name}`,
      body: replyText.slice(0, 300),
      link: { tab: 'server', sub: 'agents', sessionId: session.id }
    });
  }

  if (item.frequencyMinutes) {
    item.status = 'pending';
    item.runAt = new Date(Date.now() + item.frequencyMinutes * 60000).toISOString();
    item.attempts = 0;
    item.result = `Last run successful. Re-queued for ${new Date(item.runAt).toLocaleString()}.`;
  } else {
    item.status = 'sent';
    item.result = (agentMsg.text || '').slice(0, 500);
  }

  // Pre-approved deploy (fb-1788201858978): Alex checked the box when
  // scheduling, so an agent run that ends with the promote token deploys
  // without waiting for a button click he isn't around to press. We only
  // REQUEST it here — the caller persists the queue first, then calls
  // startPromotion(), because promote restarts this very process and an
  // unpersisted item would re-run (and re-deploy) after the restart.
  let deployRequested = false;
  if (item.preApproveDeploy && containsPromoteToken(agentMsg.text)) {
    deployRequested = true;
    item.autoDeployedAt = new Date().toISOString();
    item.result = `[auto-deploy] Promote token detected; deploy triggered at ${item.autoDeployedAt}. ` + (item.result || '');
  }
  return { success: true, item, deployRequested };
}

app.get('/api/agent/scheduled', (req, res) => res.json(readScheduled()));

app.post('/api/agent/scheduled', (req, res) => {
  const { sessionId, prompt, runAt, source, reason, model, frequencyMinutes } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });
  const session = readSessions().find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: 'Target agent session not found' });

  // model (contract §5) — the model chosen in the exhaustion-recovery modal, else the
  // session's model at queue time. An explicitly-passed unknown id is rejected rather
  // than silently accepted, matching the /model and /chat endpoints; omitted entirely
  // is fine (falls back to the session's current model, same as before this feature).
  let scheduledModel = session.model;
  if (model !== undefined) {
    if (!getModelById(model)) {
      return res.status(400).json({ error: `Unknown model id "${model}". See GET /api/agent/models.` });
    }
    scheduledModel = model;
  }

  const scheduled = readScheduled();
  const itemSource = source || 'manual'; // 'manual' | 'agent' | 'auto-recovery'
  const item = {
    id: `sched-${Date.now()}`,
    sessionId,
    sessionName: session.name,
    prompt: prompt.trim(),
    model: scheduledModel,
    runAt: runAt || null,               // ISO string => auto-run at that time; null => manual run-now
    frequencyMinutes: frequencyMinutes ? Math.max(10, Math.min(129600, parseInt(frequencyMinutes, 10))) : null,
    status: 'pending',
    source: itemSource,
    // Deploy pre-approval is Alex's call at scheduling time, made in the
    // dashboard UI — agent- and recovery-created items can never carry it
    // (fb-1788201858978). App-layer only (see the promote endpoint's threat
    // notes above), but it keeps honest agents honest.
    preApproveDeploy: itemSource === 'manual' && req.body.preApproveDeploy === true,
    reason: reason || null,
    attempts: 0,
    createdAt: new Date().toISOString(),
    result: null
  };
  scheduled.unshift(item);
  writeScheduled(scheduled);
  res.status(201).json(item);
});

app.delete('/api/agent/scheduled/:id', (req, res) => {
  const scheduled = readScheduled().filter(s => s.id !== req.params.id);
  writeScheduled(scheduled);
  res.json({ success: true });
});

app.post('/api/agent/scheduled/:id/run', async (req, res) => {
  try {
    const scheduled = readScheduled();
    const item = scheduled.find(s => s.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Scheduled prompt not found' });

    const result = await runScheduledItem(item, { isAuto: false });
    writeScheduled(scheduled);
    if (result.deployRequested) startPromotion('manual run of pre-approved scheduled item');
    res.json({ ...result, scheduled });
  } catch (err) {
    // Same rationale as the chat handler above — async, so a thrown parse
    // error from a corrupt store needs an explicit catch or the request hangs.
    res.status(500).json({ error: `Scheduled run failed: ${err.message}` });
  }
});

// Background worker: auto-run only time-scheduled items that are due. Failure-queued
// items with runAt=null stay manual so we never silently re-burn quota.
let schedulerBusy = false;
setInterval(async () => {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    // readScheduled() moved inside the try (was above it) — it can now throw
    // on a corrupt store, and this whole callback is async, so an uncaught
    // throw here would surface as an unhandled promise rejection every 30s
    // instead of a single logged, recoverable error.
    const scheduled = readScheduled();
    const now = Date.now();
    const due = scheduled.filter(s => s.status === 'pending' && s.runAt && new Date(s.runAt).getTime() <= now);
    if (!due.length) return;

    let deployRequested = false;
    for (const item of due) {
      const result = await runScheduledItem(item, { isAuto: true });
      // Persist after EVERY item, not once at the end: a pre-approved deploy
      // restarts this process, and an unpersisted ranAt would re-run items.
      writeScheduled(scheduled);
      if (result.deployRequested) deployRequested = true;
    }
    if (deployRequested) startPromotion('scheduled item (pre-approved by Alex)');
  } catch (err) {
    console.error('Scheduler error:', err.message);
  } finally {
    schedulerBusy = false;
  }
}, 30000);

// --- 7. FEEDBACK BOX API (Feedback Box — Contract.md §1-4) ---
// Storage: data/feedback.json — same array-of-objects convention as
// tasks.json / agent_sessions.json, and (like those) excluded from
// deploy.sh's rsync, so it's safe across deploys.

// Order = the priority an agent should work items in (contract §3): bugs
// first because something is broken, ideas last because they're unformed.
const FEEDBACK_TYPES = [
  { id: 'bug', label: 'Bug Report' },
  { id: 'improvement', label: 'Improvement' },
  { id: 'feature', label: 'Feature Request' },
  { id: 'chore', label: 'Chore' },
  { id: 'idea', label: 'Idea' }
];
const FEEDBACK_TYPE_IDS = FEEDBACK_TYPES.map(t => t.id);
const FEEDBACK_STATUSES = ['new', 'in-progress', 'done', 'wont-do'];

function sortFeedbackNewestFirst(items) {
  return items.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// --- Archival (added 2026-08-26, Alex via dispatcher — additive to the
// TODO port). "Disappear after 24h of being complete" is ruled as disappear
// from the ACTIVE list only, staying reachable on request — nothing is
// deleted, which is what keeps the `notes` an agent left auditable.
//
// `archived` is DERIVED at read time from `processedAt`, never persisted —
// same reasoning as the render-time `assumed` deadline in the TODO spec
// §3.5: a computed property written to storage stops being true the moment
// nothing rewrites the file. Uses todoEngine.now() as the one shared clock
// for the whole app rather than a bare `new Date()`.
const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
function computeArchived(item, nowMs) {
  if (item.status !== 'done' && item.status !== 'wont-do') return false;
  if (!item.processedAt) return false; // no timestamp (pre-dates this feature) -> treat as NOT archived, never guess one
  const processedMs = new Date(item.processedAt).getTime();
  if (Number.isNaN(processedMs)) return false;
  return (nowMs - processedMs) > ARCHIVE_AFTER_MS;
}
function decorateArchived(items, nowMs) {
  return items.map(i => ({ ...i, archived: computeArchived(i, nowMs) }));
}

// Retention (Alex, 2026-09-10): an archived ticket is deleted 30 days after it
// was closed. Runs at boot and every 6 h. Each purged item is appended to
// data/feedback-purged.jsonl first — not a graveyard the UI shows, just the
// one-line-per-ticket record that makes "what did we close in August?"
// answerable. Open tickets and closed tickets without a processedAt are
// never touched (no timestamp -> no guessing, same rule as computeArchived).
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const FEEDBACK_PURGED_FILE = path.join(DATA_DIR, 'feedback-purged.jsonl');
function purgeArchivedFeedback() {
  try {
    const nowMs = todoEngine.now().getTime();
    const items = readFeedback();
    const keep = [], purge = [];
    for (const i of items) {
      const closed = i.status === 'done' || i.status === 'wont-do';
      const t = i.processedAt ? new Date(i.processedAt).getTime() : NaN;
      if (closed && !Number.isNaN(t) && nowMs - t > PURGE_AFTER_MS) purge.push(i); else keep.push(i);
    }
    if (!purge.length) return 0;
    const purgedAt = new Date(nowMs).toISOString();
    fs.appendFileSync(FEEDBACK_PURGED_FILE, purge.map(i => JSON.stringify({ ...i, purgedAt })).join('\n') + '\n');
    writeFeedback(keep);
    console.log(`[feedback] purged ${purge.length} archived ticket(s) older than 30 days (recorded in feedback-purged.jsonl)`);
    return purge.length;
  } catch (err) {
    console.error('[feedback] purge failed:', err.message);
    return 0;
  }
}
setTimeout(purgeArchivedFeedback, 5000);
setInterval(purgeArchivedFeedback, 6 * 60 * 60 * 1000);

// Shared by the HTTP route and the agent tool (executeLocalTool) below, so
// both paths apply the exact same validation and processedAt semantics.
function applyFeedbackUpdate(item, patch) {
  if (patch.status !== undefined) {
    if (!FEEDBACK_STATUSES.includes(patch.status)) {
      return { error: `Invalid status "${patch.status}". Must be one of: ${FEEDBACK_STATUSES.join(', ')}` };
    }
    // processedAt is set the first time status leaves 'new' — never overwritten
    // again after that (contract §2).
    if (item.status === 'new' && patch.status !== 'new' && !item.processedAt) {
      item.processedAt = new Date().toISOString();
    }
    item.status = patch.status;
  }
  if (patch.processedBy !== undefined) item.processedBy = patch.processedBy;
  if (patch.notes !== undefined) item.notes = patch.notes;
  item.updatedAt = new Date().toISOString();
  return { item };
}

// --- Feedback lifecycle automation (plans/feedback_lifecycle_automation.md) ---
// Canonical promote-button trigger. Module scope: used by runAgentTurn's role
// prompts, containsPromoteToken below, and (as a synced copy) the chat UI's
// button matcher in public/index.html. Kept a constant — never inline it in a
// backtick template (see the 2026-08-27 SyntaxError note in runAgentTurn).
const PROMOTE_ACTION_TOKEN = '[ACTION: PROMOTE_STAGING]';

// The token counts ONLY when alone on its own line — exactly what the role
// prompts require of agents. A bare .includes() is a foot-gun: a message
// merely *mentioning* the token in prose (even in backticks) would count.
// The chat UI's button matcher applies this same rule; keep the two in sync.
function containsPromoteToken(text) {
  return typeof text === 'string' &&
    text.split('\n').some(l => l.trim() === PROMOTE_ACTION_TOKEN);
}

// Called from appendMessageFreshly — the one choke point every persisted
// agent message flows through. A session linked to a feedback item that emits
// the promote token stamps the item `stagedAt` ("staged — closes on deploy");
// the promote endpoint then closes staged items when Alex clicks the button.
function markFeedbackStaged(session, text) {
  if (!session || !session.feedbackId || !containsPromoteToken(text)) return;
  const items = readFeedback();
  const item = items.find(i => i.id === session.feedbackId);
  if (!item || item.status !== 'in-progress' || item.stagedAt) return;
  const now = new Date().toISOString();
  item.stagedAt = now;
  item.updatedAt = now;
  writeFeedback(items);
  console.log(`[feedback] ${item.id} staged by session ${session.id}`);
}

// Alex's deploy click is the confirmation-of-completion signal — the endpoint
// cannot observe promote.sh's outcome (it self-detaches), and that is by
// design. Only items an agent explicitly staged ever auto-close; in-progress
// items without stagedAt are never touched. stagedAt is kept as the audit
// record of when the agent declared the fix staged.
function closeStagedFeedbackOnPromote(nowIso) {
  const items = readFeedback();
  const closed = [];
  for (const item of items) {
    if (item.status === 'in-progress' && item.stagedAt) {
      const note = `[auto] Closed by Staging → Live deploy at ${nowIso}`;
      item.notes = item.notes ? `${item.notes}\n${note}` : note;
      item.status = 'done';
      item.updatedAt = nowIso;
      closed.push(item.id);
    }
  }
  if (closed.length) writeFeedback(items);
  return closed;
}

// GET /api/feedback/types — registered ahead of nothing in particular (no
// GET /api/feedback/:id route exists to collide with), but kept next to the
// vocabulary constants above for readability.
app.get('/api/feedback/types', (req, res) => {
  res.json({ types: FEEDBACK_TYPES, priorityOrder: FEEDBACK_TYPE_IDS });
});

app.get('/api/feedback', (req, res) => {
  let items = readFeedback();
  const { type, status, includeArchived } = req.query;
  items = decorateArchived(items, todoEngine.now().getTime());
  if (type) items = items.filter(i => i.type === type);
  if (status) {
    // An explicit status filter (e.g. ?status=done) always includes
    // archived items matching it — asking for done items and getting none
    // because they aged out would be absurd. includeArchived is moot here.
    items = items.filter(i => i.status === status);
  } else if (!(includeArchived === '1' || includeArchived === 'true')) {
    items = items.filter(i => !i.archived);
  }
  res.json(sortFeedbackNewestFirst(items));
});

app.post('/api/feedback', (req, res) => {
  const { type, title, body, urgency } = req.body || {};
  if (!type || !FEEDBACK_TYPE_IDS.includes(type)) {
    return res.status(400).json({ error: `Invalid type "${type}". Must be one of: ${FEEDBACK_TYPE_IDS.join(', ')}` });
  }
  const trimmedTitle = (title || '').trim();
  if (!trimmedTitle) {
    return res.status(400).json({ error: 'title is required and must be non-empty.' });
  }

  const items = readFeedback();
  const now = new Date().toISOString();
  const newItem = {
    id: `fb-${Date.now()}`,
    type,
    title: trimmedTitle,
    body: typeof body === 'string' ? body : '',
    status: 'new',
    createdAt: now,
    updatedAt: now,
    processedAt: null,
    processedBy: null,
    notes: null
  };
  items.unshift(newItem);
  writeFeedback(items);
  res.status(201).json(newItem);
});

app.patch('/api/feedback/:id', (req, res) => {
  const items = readFeedback();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Feedback item not found' });

  const { status, processedBy, notes } = req.body || {};
  const result = applyFeedbackUpdate(items[idx], { status, processedBy, notes });
  if (result.error) return res.status(400).json({ error: result.error });

  writeFeedback(items);
  res.json(items[idx]);
});

app.delete('/api/feedback/:id', (req, res) => {
  const items = readFeedback();
  const filtered = items.filter(i => i.id !== req.params.id);
  if (filtered.length === items.length) return res.status(404).json({ error: 'Feedback item not found' });
  writeFeedback(filtered);
  res.json({ success: true });
});

// --- 8. TODO ENGINE API (TODO Migration — Contract.md §4) ---
// Storage: data/todo_tasks.json / data/todo_completed.json via todo-store.js
// (atomic writes + cross-process lock). Recurrence/sort/window logic lives
// in todo-engine.js (pure functions, unit-tested in todo-engine.test.js).
// Validation shared with todo-cli.js via todo-validate.js — no second parser.
// Personal/Meta only — the work vault is deliberately out of scope (contract "Scope").

app.get('/api/todo', (req, res) => {
  try {
    const today = todoEngine.todayString();
    const rolledTasks = todoStore.withLock(() => {
      const tasks = todoStore.readTasks();
      const { tasks: newTasks, changed } = todoEngine.rollForward(tasks, today);
      if (changed) todoStore.writeTasks(newTasks);
      return newTasks;
    });
    const view = todoEngine.buildView(rolledTasks, today);
    const response = {
      pastDue: view.pastDue,
      today: view.today,
      upcoming: view.upcoming,
      generatedFor: today
    };
    // Defensive net, not the normal path — writes are validated (§1.3), so
    // this should stay empty in practice. Surfaces pre-validation/hand-
    // edited rows that fail to parse rather than silently dropping them.
    if (view.flagged && view.flagged.length) response.flagged = view.flagged;
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/todo/tasks', (req, res) => {
  try {
    let tasks = todoStore.readTasks();
    const { project, type } = req.query;
    if (project) tasks = tasks.filter(t => t.project === project);
    if (type) tasks = tasks.filter(t => t.type === type);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todo/tasks', (req, res) => {
  try {
    const { task, errors } = todoValidate.normalizeTask(req.body, null);
    if (errors) return res.status(400).json({ error: errors.join('; '), errors });
    const nowIso = new Date().toISOString();
    const newTask = {
      id: todoEngine.generateId(),
      ...task,
      sourceFile: null, // API/CLI-created tasks have no vault provenance
      createdAt: nowIso,
      updatedAt: nowIso
    };
    todoStore.withLock(() => {
      const tasks = todoStore.readTasks();
      tasks.push(newTask);
      todoStore.writeTasks(tasks);
    });
    res.status(201).json(newTask);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/todo/tasks/:id', (req, res) => {
  try {
    let result;
    todoStore.withLock(() => {
      const tasks = todoStore.readTasks();
      const idx = tasks.findIndex(t => t.id === req.params.id);
      if (idx === -1) { result = { status: 404, body: { error: 'Task not found' } }; return; }
      const { task, errors } = todoValidate.normalizeTask(req.body, tasks[idx]);
      if (errors) { result = { status: 400, body: { error: errors.join('; '), errors } }; return; }
      tasks[idx] = { ...tasks[idx], ...task, updatedAt: new Date().toISOString() };
      todoStore.writeTasks(tasks);
      result = { status: 200, body: tasks[idx] };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/todo/tasks/:id', (req, res) => {
  try {
    let result;
    todoStore.withLock(() => {
      const tasks = todoStore.readTasks();
      const filtered = tasks.filter(t => t.id !== req.params.id);
      if (filtered.length === tasks.length) { result = { status: 404, body: { error: 'Task not found' } }; return; }
      todoStore.writeTasks(filtered);
      result = { status: 200, body: { success: true } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The important one (contract §4). Semantics differ sharply by type — see
// spec §5.3-5.4 and contract §1.1/§1.2 for why: id-targeted (never
// name-targeted, closing the duplicate-name cascade bug), and scheduled/
// backlog completion writes history BEFORE removing the task (order is
// load-bearing, preserved from the Python original).
app.post('/api/todo/tasks/:id/complete', (req, res) => {
  try {
    let result;
    const today = todoEngine.todayString();
    todoStore.withLock(() => {
      const tasks = todoStore.readTasks();
      const idx = tasks.findIndex(t => t.id === req.params.id);
      if (idx === -1) { result = { status: 404, body: { error: 'Task not found' } }; return; }
      const task = tasks[idx];

      if (task.type === 'recurring') {
        const nextDue = todoEngine.calcNextDue(task.frequency, today);
        if (nextDue === null) {
          // Reject rather than writing "—" and orphaning the row, unlike Python (contract §4).
          result = { status: 400, body: { error: `Cannot complete "${task.name}": frequency "${task.frequency}" is unparseable, so no next due date could be computed.` } };
          return;
        }
        tasks[idx] = { ...task, lastCompleted: today, nextDue, updatedAt: new Date().toISOString() }; // dueTime untouched — preserved via spread
        todoStore.writeTasks(tasks);
        result = { status: 200, body: tasks[idx] };
        return; // Recurring completions are NOT logged to history (spec §5.3/§5.4).
      }

      // scheduled / backlog: log first, remove second — order preserved from the original.
      const completed = todoStore.readCompleted();
      const entry = {
        id: `completed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        taskId: task.id,
        name: task.name,
        project: task.project,
        type: task.type,
        completedAt: new Date().toISOString(),
        notes: task.notes || ''
      };
      completed.unshift(entry);
      todoStore.writeCompleted(completed);

      const remaining = tasks.filter(t => t.id !== task.id); // id-targeted (§1.1) — only this row, even with duplicate names
      todoStore.writeTasks(remaining);
      result = { status: 200, body: { success: true, completedEntry: entry } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/todo/completed', (req, res) => {
  try {
    const items = todoStore.readCompleted().slice().sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/todo/projects', (req, res) => {
  try {
    const tasks = todoStore.readTasks();
    const projects = Array.from(new Set(tasks.map(t => t.project))).filter(Boolean).sort();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 10. MEDIA MANAGER API ---
app.get('/api/media/libraries', (req, res) => {
  try {
    if (!fs.existsSync(MEDIA_DIR)) return res.json(['default']);
    const items = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });
    const libs = items.filter(i => i.isDirectory()).map(i => i.name);
    if (!libs.includes('default')) libs.unshift('default');
    res.json(libs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/media/files', (req, res) => {
  try {
    if (!fs.existsSync(MEDIA_DIR)) return res.json([]);
    const { library } = req.query;
    
    let results = [];
    // A library is a folder NAME: "../.." listed arbitrary server directories
    // (fb-1790201502191 — pages users can reach this route for the photo frame).
    if (library && library !== 'all' && !/^[A-Za-z0-9_-]{1,64}$/.test(library)) return res.status(400).json({ error: 'Invalid library' });
    const libs = (library && library !== 'all') ? [library] : fs.readdirSync(MEDIA_DIR, { withFileTypes: true }).filter(i => i.isDirectory()).map(i => i.name);
    
    for (const lib of libs) {
      const libPath = path.join(MEDIA_DIR, lib);
      if (!fs.existsSync(libPath)) continue;
      const files = fs.readdirSync(libPath).filter(f => !f.startsWith('.'));
      for (const f of files) {
        results.push({
          filename: f,
          library: lib,
          path: `/media/${lib}/${f}`
        });
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/media/files', (req, res) => {
  try {
    const { library, filename } = req.body;
    if (!library || !filename) return res.status(400).json({ error: 'Missing library or filename' });
    
    // Sanitize path inputs to prevent directory traversal
    const cleanLib = library.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    const cleanName = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
    
    const targetPath = path.join(MEDIA_DIR, cleanLib, cleanName);
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'File not found' });
    
    fs.unlinkSync(targetPath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/upload', async (req, res) => {
  try {
    const { library, filename, base64 } = req.body;
    if (!library || !filename || !base64) return res.status(400).json({ error: 'Missing library, filename, or base64 data' });
    
    // Sanitize
    const cleanLib = library.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    const cleanName = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!cleanName) return res.status(400).json({ error: 'Invalid filename' });

    const libDir = path.join(MEDIA_DIR, cleanLib);
    if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });

    const matches = base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return res.status(400).json({ error: 'Invalid base64 string format' });

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    
    // Compress images automatically
    if (mimeType.startsWith('image/')) {
      const sharp = require('sharp');
      const finalName = cleanName.replace(/\.[^/.]+$/, "") + ".webp";
      const targetPath = path.join(libDir, finalName);
      
      await sharp(buffer)
        .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(targetPath);
        
      res.json({ success: true, path: `/media/${cleanLib}/${finalName}` });
    } else {
      const targetPath = path.join(libDir, cleanName);
      fs.writeFileSync(targetPath, buffer);
      res.json({ success: true, path: `/media/${cleanLib}/${cleanName}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- 11. SYSTEM MONITORING API ---
app.get('/api/system/stats', (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memory = {
      total: Math.round(totalMem / 1024 / 1024),
      used: Math.round(usedMem / 1024 / 1024),
      free: Math.round(freeMem / 1024 / 1024),
      percent: Math.round((usedMem / totalMem) * 100)
    };
    
    const cpu = {
      load: os.loadavg(),
      cores: os.cpus().length
    };
    
    let disk = { total: '0G', used: '0G', percent: '0%' };
    try {
      const df = execSync('df -h /').toString().split('\n')[1].split(/\s+/);
      disk = { total: df[1], used: df[2], percent: df[4] };
    } catch(e) {}
    
    let pm2 = [];
    try {
      const pm2Out = JSON.parse(execSync('pm2 jlist').toString());
      pm2 = pm2Out.map(p => ({
        name: p.name,
        status: p.pm2_env.status,
        memory: Math.round(p.monit.memory / 1024 / 1024),
        cpu: p.monit.cpu,
        restarts: p.pm2_env.restart_time
      }));
    } catch(e) {}
    
    res.json({ memory, cpu, disk, pm2 });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/restart', (req, res) => {
  try {
    const { processName } = req.body;
    if (!processName) return res.status(400).json({ error: 'Missing processName' });
    const cleanName = processName.replace(/[^a-zA-Z0-9_-]/g, '');
    execSync(`pm2 restart ${cleanName}`);
    res.json({ success: true, message: `Restarted ${cleanName}` });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system/logs', (req, res) => {
  try {
    const { processName, lines = 100 } = req.query;
    if (!processName) return res.status(400).json({ error: 'Missing processName' });
    const cleanName = processName.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeLines = parseInt(lines) || 100;
    const logPath = `/home/ubuntu/.pm2/logs/${cleanName}-error.log`;
    if (!require('fs').existsSync(logPath)) return res.status(404).json({ error: 'Log file not found' });
    
    const logs = execSync(`tail -n ${safeLines} ${logPath}`).toString();
    res.json({ logs });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// --- 12. WEATHER & LOCATION API ---
app.get('/api/weather', async (req, res) => {
  try {
    
    // Default location is Windham, ME, or query if passed.
    const q = req.query.q || 'Windham,ME';
    const url = `https://wttr.in/${encodeURIComponent(q)}?format=j1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Weather API failed: ${response.statusText}`);
    const data = await response.json();
    
    const current = data.current_condition[0];
    res.json({
      temp_c: current.temp_C,
      temp_f: current.temp_F,
      condition: current.weatherDesc[0].value.trim(),
      icon: current.weatherIconUrl ? current.weatherIconUrl[0].value : ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- 13. CALENDAR API ---
// --- Agenda: Google Calendar ICS feeds + local server events (fb-1788188240701) ---
// Plan agreed with Alex 2026-09-03: his real calendar stays in Google, read
// via the secret ICS URL(s) in data/calendar-feeds.json; dashboard/agent
// events live in data/calendar.json. GET /api/agenda merges both. Feed URLs
// are SECRETS: data/ is gitignored and promote.sh never syncs it — never log
// or echo the URLs.
const AGENDA_CACHE_TTL_MS = 5 * 60 * 1000;
const agendaFeedCache = new Map(); // feed.id -> { fetchedAt, events, error }

function readCalendarFeeds() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'calendar-feeds.json'), 'utf8'));
    return Array.isArray(j.feeds) ? j.feeds.filter(f => f && f.id && f.url) : [];
  } catch { return []; }
}

function readLocalCalendarEvents() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'calendar.json'), 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// Minutes-offset of a timezone at a given instant, via Intl (no dependencies).
function tzOffsetMs(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms)).map(p => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    parts.hour === '24' ? 0 : +parts.hour, +parts.minute, +parts.second);
  return asUtc - ms;
}

// Convert wall-clock fields in a named zone to a UTC ms timestamp. Two passes
// so instants near a DST jump resolve against the offset actually in force.
function zonedToUtcMs(f, tz) {
  let ms = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  for (let i = 0; i < 2; i++) ms = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - tzOffsetMs(ms, tz);
  return ms;
}

// Step wall-clock fields by calendar units; Date.UTC normalizes overflow, so
// recurrence keeps its wall time across DST instead of drifting an hour.
function wallAdd(f, { days = 0, months = 0, years = 0 }) {
  const dt = new Date(Date.UTC(f.y + years, f.mo - 1 + months, f.d + days, f.h, f.mi, f.s));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
           h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds() };
}

// Parse one ICS date/date-time value into {fields, tz, allDay, ms}.
function parseIcsDate(value, params, defaultTz) {
  if (/^\d{8}$/.test(value)) {
    const f = { y: +value.slice(0, 4), mo: +value.slice(4, 6), d: +value.slice(6, 8), h: 0, mi: 0, s: 0 };
    return { fields: f, tz: defaultTz, allDay: true, ms: zonedToUtcMs(f, defaultTz) };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const f = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  const tz = m[7] === 'Z' ? 'UTC' : (params.TZID || defaultTz);
  return { fields: f, tz, allDay: false, ms: zonedToUtcMs(f, tz) };
}

// Minimal ICS parser: unfolds lines, walks VEVENTs, returns normalized events
// with enough recurrence info for window expansion. Handles the shapes Google
// Calendar actually exports (UTC + TZID datetimes, all-day dates, RRULE with
// FREQ/INTERVAL/BYDAY/UNTIL/COUNT, EXDATE, RECURRENCE-ID overrides).
function parseIcs(text, defaultTzHint) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  let calTz = defaultTzHint || 'America/New_York';
  for (const line of lines) {
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const left = line.slice(0, ci);
    const value = line.slice(ci + 1);
    const [name, ...paramParts] = left.split(';');
    const params = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    const prop = name.toUpperCase();
    if (prop === 'X-WR-TIMEZONE' && !cur) { calTz = value.trim() || calTz; continue; }
    if (prop === 'BEGIN' && value === 'VEVENT') { cur = { exdates: [] }; continue; }
    if (prop === 'END' && value === 'VEVENT') {
      if (cur && cur.start && cur.summary !== undefined) events.push(cur);
      cur = null; continue;
    }
    if (!cur) continue;
    if (prop === 'SUMMARY') cur.summary = value.replace(/\\([,;nN])/g, (m2, c) => (c === ',' || c === ';') ? c : '\n');
    else if (prop === 'LOCATION') cur.location = value.replace(/\\([,;nN])/g, (m2, c) => (c === ',' || c === ';') ? c : '\n');
    else if (prop === 'UID') cur.uid = value;
    else if (prop === 'DTSTART') cur.start = parseIcsDate(value, params, calTz);
    else if (prop === 'DTEND') cur.end = parseIcsDate(value, params, calTz);
    else if (prop === 'STATUS') cur.status = value;
    else if (prop === 'RECURRENCE-ID') cur.recurrenceId = parseIcsDate(value, params, calTz);
    else if (prop === 'EXDATE') {
      for (const v of value.split(',')) {
        const d = parseIcsDate(v.trim(), params, calTz);
        if (d) cur.exdates.push(d.ms);
      }
    } else if (prop === 'RRULE') {
      const rr = {};
      for (const kv of value.split(';')) {
        const eq = kv.indexOf('=');
        if (eq !== -1) rr[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
      }
      cur.rrule = rr;
    }
  }
  return events;
}

const ICS_WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Expand one parsed VEVENT into concrete occurrences inside [winStart, winEnd).
function expandIcsEvent(ev, winStartMs, winEndMs, overridesByUid) {
  const out = [];
  if (!ev.start) return out;
  if (ev.status === 'CANCELLED') return out;
  const durMs = ev.end ? Math.max(0, ev.end.ms - ev.start.ms) : (ev.start.allDay ? 86400000 : 0);
  const exdates = new Set(ev.exdates);
  const overridden = new Set((overridesByUid.get(ev.uid) || []).map(o => o.recurrenceId.ms));

  const push = (startMs) => {
    if (exdates.has(startMs) || overridden.has(startMs)) return;
    if (startMs < winEndMs && startMs + durMs > winStartMs) {
      out.push({ startMs, endMs: startMs + durMs, allDay: ev.start.allDay,
                 title: ev.summary || '(untitled)', location: ev.location || '' });
    }
  };

  if (!ev.rrule) { push(ev.start.ms); return out; }

  const rr = ev.rrule;
  const interval = Math.max(1, parseInt(rr.INTERVAL, 10) || 1);
  const untilMs = rr.UNTIL ? (parseIcsDate(rr.UNTIL, {}, ev.start.tz) || {}).ms ?? Infinity : Infinity;
  let remaining = rr.COUNT ? Math.max(0, parseInt(rr.COUNT, 10) || 0) : Infinity;
  const hardStopMs = Math.min(winEndMs, untilMs === Infinity ? winEndMs : untilMs + 1);
  let f = { ...ev.start.fields };
  const tz = ev.start.tz;
  let guard = 0;

  const emit = (fields) => {
    const ms = zonedToUtcMs(fields, tz);
    if (ms > untilMs) return false;
    if (remaining <= 0) return false;
    remaining--;
    if (ms >= winEndMs) return false;
    push(ms);
    return true;
  };

  if (rr.FREQ === 'WEEKLY' && rr.BYDAY) {
    const days = rr.BYDAY.split(',').map(d => ICS_WEEKDAYS[d.trim().slice(-2)]).filter(d => d !== undefined).sort();
    // Anchor at the Sunday of DTSTART's week, then emit requested weekdays.
    const startDow = new Date(zonedToUtcMs(f, tz) + tzOffsetMs(zonedToUtcMs(f, tz), tz)).getUTCDay();
    let weekAnchor = wallAdd(f, { days: -startDow });
    while (guard++ < 3000) {
      let done = false;
      for (const dow of days) {
        const occ = wallAdd(weekAnchor, { days: dow });
        const occMs = zonedToUtcMs(occ, tz);
        if (occMs < ev.start.ms) continue; // before the series started
        if (!emit(occ)) { if (occMs > hardStopMs || remaining <= 0) { done = true; break; } }
      }
      if (done) break;
      weekAnchor = wallAdd(weekAnchor, { days: 7 * interval });
      if (zonedToUtcMs(weekAnchor, tz) > hardStopMs) break;
    }
    return out;
  }

  const step = rr.FREQ === 'DAILY' ? { days: interval }
    : rr.FREQ === 'WEEKLY' ? { days: 7 * interval }
    : rr.FREQ === 'MONTHLY' ? { months: interval }
    : rr.FREQ === 'YEARLY' ? { years: interval }
    : null;
  if (!step) { push(ev.start.ms); return out; }
  while (guard++ < 3000) {
    if (!emit(f)) {
      const ms = zonedToUtcMs(f, tz);
      if (ms > hardStopMs || remaining <= 0) break;
    }
    f = wallAdd(f, step);
  }
  return out;
}

async function fetchFeedEvents(feed) {
  const cached = agendaFeedCache.get(feed.id);
  if (cached && Date.now() - cached.fetchedAt < AGENDA_CACHE_TTL_MS) return cached;
  try {
    const res = await fetch(feed.url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entry = { fetchedAt: Date.now(), events: parseIcs(await res.text()), error: null };
    agendaFeedCache.set(feed.id, entry);
    return entry;
  } catch (e) {
    // Keep serving the last good parse; surface the error in feed status.
    const entry = { fetchedAt: Date.now(), events: cached ? cached.events : [], error: e.message };
    agendaFeedCache.set(feed.id, entry);
    return entry;
  }
}

app.get('/api/agenda', async (req, res) => {
  const days = Math.min(31, Math.max(1, parseInt(req.query.days, 10) || 7));
  const TZ = 'America/New_York';
  // Window: start of today (Eastern) through `days` days out.
  const nowParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map(p => [p.type, p.value]));
  const todayF = { y: +nowParts.year, mo: +nowParts.month, d: +nowParts.day, h: 0, mi: 0, s: 0 };
  const winStartMs = zonedToUtcMs(todayF, TZ);
  const winEndMs = zonedToUtcMs(wallAdd(todayF, { days }), TZ);

  const events = [];
  const feedStatus = [];
  for (const feed of readCalendarFeeds()) {
    const { events: parsed, error, fetchedAt } = await fetchFeedEvents(feed);
    const overridesByUid = new Map();
    for (const ev of parsed) {
      if (ev.uid && ev.recurrenceId) {
        if (!overridesByUid.has(ev.uid)) overridesByUid.set(ev.uid, []);
        overridesByUid.get(ev.uid).push(ev);
      }
    }
    for (const ev of parsed) {
      if (ev.recurrenceId) { // override instance stands alone
        const durMs = ev.end ? Math.max(0, ev.end.ms - ev.start.ms) : 0;
        if (ev.status !== 'CANCELLED' && ev.start.ms < winEndMs && ev.start.ms + durMs > winStartMs) {
          events.push({ startMs: ev.start.ms, endMs: ev.start.ms + durMs, allDay: ev.start.allDay,
                        title: ev.summary || '(untitled)', location: ev.location || '',
                        source: 'feed', calendar: feed.label || feed.id });
        }
        continue;
      }
      for (const occ of expandIcsEvent(ev, winStartMs, winEndMs, overridesByUid)) {
        events.push({ ...occ, source: 'feed', calendar: feed.label || feed.id });
      }
    }
    feedStatus.push({ id: feed.id, label: feed.label || feed.id, ok: !error, error, fetchedAt });
  }

  for (const ev of readLocalCalendarEvents()) {
    const startMs = Date.parse(ev.startsAt);
    if (Number.isNaN(startMs) || !ev.title) continue;
    const endMs = Date.parse(ev.endsAt) || (ev.allDay ? startMs + 86400000 : startMs);
    if (startMs < winEndMs && endMs > winStartMs) {
      events.push({ startMs, endMs, allDay: !!ev.allDay, title: String(ev.title),
                    location: ev.location ? String(ev.location) : '',
                    source: 'local', calendar: ev.addedBy || 'dashboard' });
    }
  }

  events.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
  res.json({
    windowStart: new Date(winStartMs).toISOString(),
    windowEnd: new Date(winEndMs).toISOString(),
    events: events.map(e => ({ title: e.title, startsAt: new Date(e.startMs).toISOString(),
                               endsAt: new Date(e.endMs).toISOString(), allDay: e.allDay,
                               location: e.location, source: e.source, calendar: e.calendar })),
    feeds: feedStatus
  });
});

// Legacy alias — the old mock read data/events.json; the agenda is real now.
app.get('/api/calendar/events', async (req, res) => {
  res.redirect(302, '/api/agenda' + (req.query.days ? `?days=${encodeURIComponent(req.query.days)}` : ''));
});



// --- NOTIFICATIONS API (fb-1787765370485) ---
// GET  /api/notifications?unread=1&since=ISO&limit=N  -> { items, unreadCount, total }
// POST /api/notifications { level, title, body, source, link }  (agents/tools may post from loopback)
// POST /api/notifications/read-all
// POST /api/notifications/:id/read
// DELETE /api/notifications?read=1   (purge read)   DELETE /api/notifications/:id
app.get('/api/notifications', (req, res) => {
  try {
    const all = readNotifications();
    let items = all;
    if (req.query.unread === '1') items = items.filter(n => !n.read);
    if (req.query.since) {
      const t = new Date(req.query.since).getTime();
      if (!isNaN(t)) items = items.filter(n => new Date(n.createdAt).getTime() > t);
    }
    const limit = Math.max(1, Math.min(NOTIFICATIONS_MAX, parseInt(req.query.limit, 10) || 50));
    res.json({ items: items.slice(0, limit), unreadCount: all.filter(n => !n.read).length, total: all.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', (req, res) => {
  const { level, title, body, source, link } = req.body || {};
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  const n = pushNotification({
    level,
    title,
    body: typeof body === 'string' ? body : '',
    source: typeof source === 'string' && source ? source.slice(0, 40) : 'api',
    link: (link && typeof link === 'object') ? link : null
  });
  if (!n) return res.status(500).json({ error: 'Failed to store notification' });
  res.status(201).json(n);
});

app.post('/api/notifications/read-all', (req, res) => {
  try {
    const items = readNotifications();
    const now = new Date().toISOString();
    items.forEach(n => { if (!n.read) { n.read = true; n.readAt = now; } });
    writeNotifications(items);
    res.json({ success: true, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/:id/read', (req, res) => {
  try {
    const items = readNotifications();
    const n = items.find(x => x.id === req.params.id);
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    if (!n.read) { n.read = true; n.readAt = new Date().toISOString(); writeNotifications(items); }
    res.json(n);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notifications/:id', (req, res) => {
  try {
    const items = readNotifications();
    const filtered = items.filter(x => x.id !== req.params.id);
    if (filtered.length === items.length) return res.status(404).json({ error: 'Notification not found' });
    writeNotifications(filtered);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notifications', (req, res) => {
  try {
    const items = readNotifications();
    // Only ever purge what has been read; the unread ones are the point.
    const filtered = items.filter(n => !n.read);
    writeNotifications(filtered);
    res.json({ success: true, removed: items.length - filtered.length, remaining: filtered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- KANBAN API ---
const KANBAN_FILE = path.join(DATA_DIR, 'kanban.json');
function readKanban() {
  try {
    if (!fs.existsSync(KANBAN_FILE)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(KANBAN_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}
function writeKanban(data) {
  fs.writeFileSync(KANBAN_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/kanban/:id', (req, res) => {
  const data = readKanban();
  let board = data[req.params.id];
  if (!board) {
    board = {
      columns: [
        { id: 'col-todo', title: 'To Do', tasks: [] },
        { id: 'col-doing', title: 'In Progress', tasks: [] },
        { id: 'col-done', title: 'Done', tasks: [] }
      ]
    };
  }
  res.json(board);
});

app.post('/api/kanban/:id', (req, res) => {
  const data = readKanban();
  data[req.params.id] = req.body;
  writeKanban(data);
  res.json({ success: true });
});

// --- 14. SCRATCHPAD API ---

// --- Doc Body Store ---
const DOCS_DIR = path.join(__dirname, '../data/docs');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

app.get('/api/docs/:id', (req, res) => {
  const docPath = path.join(DOCS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(docPath)) {
    return res.json({ text: '' });
  }
  res.json(readJsonStoreOrThrow(docPath));
});

app.post('/api/docs/:id', (req, res) => {
  const docPath = path.join(DOCS_DIR, `${req.params.id}.json`);
  const text = req.body.text || '';
  const expectedUpdatedAt = req.body.expectedUpdatedAt;
  // Optimistic check (fb-1789015021701): two tabs on one document, or an
  // agent rewriting it while Alex types, no longer silently clobber each other.
  if (expectedUpdatedAt && fs.existsSync(docPath)) {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(docPath, 'utf8')); } catch (e) { current = null; }
    if (current && current.updatedAt && current.updatedAt !== expectedUpdatedAt) {
      return res.status(409).json({ error: 'stale', message: 'This document changed elsewhere since you loaded it.', updatedAt: current.updatedAt });
    }
  }
  const updatedAt = new Date().toISOString();
  fs.writeFileSync(docPath, JSON.stringify({ text, updatedAt }));
  res.json({ success: true, updatedAt });
});

app.get('/api/scratchpad', (req, res) => {
  try {
    const spPath = path.join(DATA_DIR, 'scratchpad.txt');
    if (require('fs').existsSync(spPath)) {
      return res.json({ text: require('fs').readFileSync(spPath, 'utf8') });
    }
    res.json({ text: "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scratchpad', (req, res) => {
  try {
    const spPath = path.join(DATA_DIR, 'scratchpad.txt');
    require('fs').writeFileSync(spPath, req.body.text || "");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- 15. REMOTE BRIDGE API ---
app.get('/api/bridge/sync', (req, res) => {
  const sessions = readSessions().filter(s => s.role === 'bridge');
  let pending = [];
  sessions.forEach(s => {
    if (!s.messages) return;
    const lastMsg = s.messages[s.messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      pending.push({ sessionId: s.id, text: lastMsg.text, timestamp: lastMsg.timestamp });
    }
  });
  res.json({ pending });
});

app.post('/api/bridge/reply', (req, res) => {
  const { sessionId, text } = req.body;
  const sessions = readSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  session.messages = session.messages || [];
  session.messages.push({ role: 'agent', text, timestamp: new Date().toISOString() });
  writeSessions(sessions);
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================`);
  console.log(` Ada Operations Hub live on port ${PORT}`);
  console.log(` Local: http://localhost:${PORT}`);
  console.log(`================================================`);
  // Resume only AFTER the listener is up — a resumed agent that immediately
  // calls a dead API learns nothing useful. Small delay lets routes settle.
  setTimeout(() => {
    try { recoverInterruptedJobs(); }
    catch (e) { console.error('[resume] recovery failed:', e.message); }
  }, 1500);
});
