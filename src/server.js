const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn, execFile } = require('child_process');
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
app.set('trust proxy', 1);            // single Caddy hop on the same host
app.use(cors());
app.use(express.json());              // must precede mountAuth: /api/login reads req.body
const { requireAuth } = mountAuth(app, {
  loginHtmlFile: path.join(__dirname, '../public/login.html'),
  behindProxy: true,                  // throws at startup if trust proxy is unset
});
app.use(requireAuth);                 // everything below requires a session
app.use(express.static(path.join(__dirname, '../public')));

// Directories
const DATA_DIR = path.join(__dirname, '../data');
const PLANS_DIR = path.join(__dirname, '../plans');
const SCRIPTS_DIR = path.join(__dirname, '../scripts');

[DATA_DIR, PLANS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'agent_sessions.json');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled_prompts.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const HOMEPAGE_FILE = path.join(DATA_DIR, 'homepage.json');
// Designer page-document registry: which dashboard pages have a
// designer-editable live document. Designer sessions record which page they
// are bound to (session.page) and the role's write walls point at that page's
// document — add an entry here (plus a page renderer) to bring the Designer
// to another page. Only the Home page has one today.
const PAGE_DOCS = { home: HOMEPAGE_FILE };

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
function readFeedback() {
  return readJsonStoreOrThrow(FEEDBACK_FILE);
}
function writeFeedback(items) {
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(items, null, 2));
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
app.post('/api/staging/promote', (req, res) => {
  if (req.get('X-Promote-Confirm') !== '1') {
    return res.status(403).json({ error: 'Refused: promotion must be initiated from the dashboard button.' });
  }
  // promote.sh self-detaches (setsid nohup) and returns in <1s, then runs the
  // real validate → snapshot → sync → restart → auto-rollback on its own. So we
  // don't hold this request open across the dashboard restart; we kick it off
  // and reply immediately.
  execFile('bash', ['/home/ubuntu/ops/promote.sh'], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) console.error('[promote] launch error:', err.message, (stderr || '').trim());
    else console.log('[promote]', (stdout || '').trim());
  });
  // Feedback lifecycle Step 3: the human click is the completion signal.
  try {
    const closed = closeStagedFeedbackOnPromote(new Date().toISOString());
    if (closed.length) console.log('[promote] auto-closed staged feedback:', closed.join(', '));
  } catch (e) {
    console.error('[promote] feedback auto-close failed:', e.message);
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

// Whitelist + cap a single widget; null if unsalvageable (dropped, not fatal).
function sanitizeHomepageWidget(w, index) {
  if (!w || typeof w !== 'object') return null;
  const clean = {
    id: typeof w.id === 'string' && w.id ? w.id.slice(0, 64) : `widget-${index}`,
    title: typeof w.title === 'string' ? w.title.slice(0, 120) : '',
    icon: typeof w.icon === 'string' && w.icon ? w.icon.slice(0, 64) : 'fa-cube',
    accent: HOMEPAGE_ACCENTS.includes(w.accent) ? w.accent : 'indigo',
    // Card-body HTML. Deliberately NOT stripped: it comes only from Alex or
    // his agents through the authenticated API / server filesystem, which is
    // the same trust level as the agents' bash access. Length-capped only.
    html: typeof w.html === 'string' ? w.html.slice(0, 20000) : '',
    hidden: w.hidden === true
  };
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
  const { announcement, widgets, sections, updatedBy } = req.body || {};
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
    updatedAt: new Date().toISOString(),
    updatedBy: typeof updatedBy === 'string' && updatedBy ? updatedBy : 'dashboard'
  });
  fs.writeFileSync(HOMEPAGE_FILE, JSON.stringify(merged, null, 2));
  res.json({ ...merged, path: HOMEPAGE_FILE });
});

// --- 3. SCRIPTS & AUTOMATION API ---
app.get('/api/scripts', (req, res) => {
  const scriptRegistry = [];
  res.json(scriptRegistry);
});

app.post('/api/scripts/run', (req, res) => {
  const { id, customArgs } = req.body;
  const scripts = {};

  const selected = scripts[id];
  if (!selected) return res.status(404).json({ error: 'Unknown script ID' });

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
    
    const hour = new Date().getHours();
    let greeting = 'Good evening';
    let icon = 'fa-moon';
    let color = 'indigo';
    if (hour < 12) { greeting = 'Good morning'; icon = 'fa-sun'; color = 'amber'; }
    else if (hour < 18) { greeting = 'Good afternoon'; icon = 'fa-cloud-sun'; color = 'sky'; }
    
    return res.json({ text: `${greeting}, Alex. All systems nominal.`, icon, color });
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
        description: 'List, update, or delete items in the feedback store (bug reports, feature requests, improvements, chores, and ideas filed via the dashboard feedback box). Priority order — work items in this order: bug > improvement > feature > chore > idea. Use action "list" to read items (optionally filtered; archived items — done/wont-do for over 24h — are hidden by default, pass filterStatus to see them), action "update" to set status/processedBy/notes on an item as you work it (this is how you record progress — do NOT delete an item you have processed), or action "delete" only to remove a mistaken entry. AFTER ACTING ON AN ITEM, YOU MUST CLOSE IT OUT: call action "update" with status set to "done" (or "wont-do" if you decided against it), processedBy set to who you are, and notes set to a one-line account of what you actually did or why you didn\'t. An item you fixed but left as "new" will be picked up and worked again by the next agent — closing it out is what makes it stop.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', description: 'One of: list, update, delete.' },
            filterType: { type: 'STRING', description: 'Optional, for action=list. One of: bug, improvement, feature, chore, idea.' },
            filterStatus: { type: 'STRING', description: 'Optional, for action=list. One of: new, in-progress, done, wont-do.' },
            id: { type: 'STRING', description: 'Required for update/delete — the feedback item id, e.g. fb-1787724518069.' },
            status: { type: 'STRING', description: 'For action=update. One of: new, in-progress, done, wont-do.' },
            processedBy: { type: 'STRING', description: 'For action=update. Free text identifying you (the agent) as the one working this item.' },
            notes: { type: 'STRING', description: 'For action=update. Closing note — what you did, or why not.' }
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
      const pageDoc = PAGE_DOCS[(designerSess && designerSess.page) || 'home'] || HOMEPAGE_FILE;
      if (toolName === 'run_bash') {
        return resolve({ error: `Permission Denied: the Designer is containerized to its page document and cannot run shell commands. Edit ${pageDoc} with write_file instead.` });
      }
      if (toolName === 'write_file') {
        const target = path.resolve('/home/ubuntu', args.filePath || '');
        if (target !== pageDoc) {
          return resolve({ error: `Permission Denied: the Designer may only write its page document: ${pageDoc}. Read access elsewhere is fine.` });
        }
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
app.get('/api/agent/sessions', (req, res) => res.json(readSessions()));

// Create new agent session
app.post('/api/agent/sessions', (req, res) => {
  const { name, role, model } = req.body;
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
    designer: 'Page Designer'
  };

  const initialGreetings = {
    debugger: 'Debugger online with full Read/Write and Bash execution access. How can I help you inspect, fix, or build on the server?',
    query: 'System Inspector online in Read-Only mode. Ready to inspect system states, query logs, or analyze files safely.',
    automator: 'Automation Scripter online. Ready to create Python scripts, test data scrapers, and configure cron workflows.',
    architect: 'System Architect online. When designing architecture, I save full execution plans into /home/ubuntu/dashboard/plans/ for other agents to read and implement.',
    designer: 'Designer here! I\'m containerized to this page — I can add widgets, rework the banner, hide or rebuild the stat boxes, and wire cards to your tools. Nothing I do can break the server. What should we change?'
  };

  // The Designer is a high-frequency, low-stakes role (its writes are walled
  // to the page document), so it defaults to the cheapest fast model instead
  // of the registry default. An explicit model in the request still wins, and
  // the model can be switched later like any session.
  if (sessionRole === 'designer' && !model && getModelById('antigravity-flash')) {
    sessionModel = 'antigravity-flash';
  }

  // Designer sessions are bound to one page for their whole life — the write
  // walls and role prompt follow this binding. Unknown pages fall back to
  // 'home' rather than erroring (same forgiving posture as unknown models).
  const requestedPage = (req.body || {}).page;
  const sessionPage = (sessionRole === 'designer')
    ? (typeof requestedPage === 'string' && PAGE_DOCS[requestedPage] ? requestedPage : 'home')
    : undefined;

  const newSession = {
    id: `session-${Date.now()}`,
    name: name || roleNames[sessionRole] || 'AI Agent',
    role: sessionRole,
    ...(sessionPage ? { page: sessionPage } : {}),
    model: sessionModel,
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
  const { feedbackId } = req.body || {};
  if (feedbackId) {
    const items = readFeedback();
    const item = items.find(i => i.id === feedbackId);
    if (item) {
      newSession.feedbackId = feedbackId;
      item.sessionId = newSession.id;
      if (item.status === 'new' || item.status === 'in-progress') {
        const modelLabel = (getModelById(sessionModel) || {}).label || sessionModel;
        applyFeedbackUpdate(item, { status: 'in-progress', processedBy: `${newSession.name} (${modelLabel})` });
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
  const tools = geminiToOpenAITools(allowedTools);
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
    
    const reqBody = { model: apiModel, messages, tools, stream: false };
    const headers = { 'Content-Type': 'application/json' };
    if (engine === 'openai') headers['Authorization'] = `Bearer ${OPENAI_API_KEY}`;
    
    let resData;
    try {
      const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text();
        return { agentMsg: { role: 'agent', text: `⚠️ API error (${res.status}): ${errText}`, timestamp: new Date().toISOString(), toolExecutions, errorType: 'api' }, errorInfo: null };
      }
      resData = await res.json();
    } catch (e) {
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
      const designerDoc = PAGE_DOCS[session.page] || HOMEPAGE_FILE;
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
// `ctrl` (optional, added 2026-08-26 for Agent Jobs & Cancellation Contract) —
// job-control object { toolExecutions, cancelled, kill }. Trailing and
// optional, so the scheduled-prompt queue (which calls this with 3 args, no
// ctrl) sees byte-for-byte identical behavior — contract §4.
async function runAgentTurn(session, promptText, modelIdOverride, ctrl) {
  const effectiveModelId = modelIdOverride || session.model || getDefaultModel().id;
  const modelInfo = getModelById(effectiveModelId) || getDefaultModel();
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
7. ASYNC COMMUNICATION & AUTONOMY: You can send messages to the chat asynchronously without ending your turn by POSTing to http://127.0.0.1:3001/api/agent/sessions/<your-session-id>/messages with body {"text": "your message", "role": "agent"}. (Gemini can also use the 'send_message' tool).
8. SCHEDULING & DEFERRING WORK: You can queue tasks to run autonomously later by POSTing to http://127.0.0.1:3001/api/agent/scheduled with body {"sessionId": "<your-session-id>", "prompt": "task description", "runAt": "ISO8601-timestamp", "frequencyMinutes": <optional-integer-minutes>, "source": "agent", "model": "<model-id>"}. (Gemini can also use the 'schedule_prompt' tool). Set frequencyMinutes (10 to 129600) to make it recurring. This allows you to split large tasks, retry after rate limits, or run background loops.
9. HOMEPAGE LIVE DOCUMENT: The dashboard Home tab (announcement banner + widget cards) renders entirely from the JSON file at ${HOMEPAGE_FILE}. Schema: { announcement: {title, text, icon, visible}, sections: {stats, quickLinks} (booleans to hide the built-in stat boxes / quick links), widgets: [{id, title, icon (FontAwesome class like fa-chart-line), accent (indigo|purple|emerald|rose|amber|sky), html (trusted HTML for the card body; may embed live stats via <span data-home-stat="todo|jobs|cpu|bugs"></span>), link: {label, tab (home|todo|tools|server) OR href (URL)}, hidden}] }. Max 24 widgets. Homepage design work belongs to the dedicated "designer" role/agent when possible. To redesign the homepage, edit this file directly (Claude: bash; Gemini: file tools) — changes appear on the next browser refresh with NO server restart and NO promote, because data/ is never synced by promote.sh. Keep it valid JSON; malformed content is dropped by the server's sanitizer.`;

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
    designer: `${sharedMemoryContext}
Role: Page Designer ("Designer"). RULING: you are containerized to exactly ONE page — this session is bound to the dashboard "${session.page || 'home'}" page, which renders entirely from the JSON document at ${PAGE_DOCS[session.page] || HOMEPAGE_FILE}. That file is your ONLY writable surface (enforced at the tool layer: no shell, writes outside it are denied). You may NOT edit code, other data files, cron jobs, or server state.
CRITICAL: NEVER overwrite homepage.json from scratch! You MUST ALWAYS use read_file on it first, parse the existing widgets, and ONLY modify the specific widgets requested by the user, leaving the rest exactly as they were.
DESIGN CANVAS: { glanceTheme: {theme, accent}, widgets: [{id, title, icon, accent, html, link, hidden}] }. IMPORTANT: You are absolutely FORBIDDEN from writing raw javascript or <script> tags in the 'html' field. Instead, you MUST build the dashboard using the available Web Components (Custom Elements) from the Component Library. All components are transparent by default (no borders), but you can optionally pass theme="glass" (for a sleek translucent blur) or theme="solid". Available blocks:
1. <ada-clock theme="glass|transparent|solid|neon|gradient"  format="12h|24h" font="'Orbitron', sans-serif"></ada-clock>
2. <ada-analog-clock theme="glass|dark|light|transparent"></ada-analog-clock>
3. <ada-countdown target="2027-01-01T00:00:00" title="New Year" accent="indigo" theme="glass|transparent|solid|neon|gradient" ></ada-countdown>
4. <ada-stopwatch title="Stopwatch" accent="emerald" theme="glass|transparent|solid|neon|gradient" ></ada-stopwatch>
5. <ada-timer minutes="5" title="Timer" accent="amber" theme="glass|transparent|solid|neon|gradient" ></ada-timer>
6. <ada-script-runner script-id="sys-health|web-scraper|data-cleaner" label="Run diagnostic" icon="fa-terminal" accent="indigo" theme="glass|transparent|solid|neon|gradient" ></ada-script-runner>
7. <ada-stat-box stat="todo|jobs|cpu|bugs|ram" title="Label" icon="fa-chart-bar" accent="indigo" theme="glass|transparent|solid|neon|gradient" ></ada-stat-box>
8. <ada-greeting name="User" theme="glass|transparent|solid|neon|gradient" ></ada-greeting>
If the user wants a widget that isn't in the library, tell them to ask the Architect to build the Custom Element first! Changes appear instantly on save.`
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
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal
        });
        return res;
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
}

// Send Chat Message to Agent — starts a job and returns immediately (contract
// §3). The synchronous, whole-turn-in-one-request version is gone: the client
// now polls GET /api/agent/jobs/:jobId (or GET .../job to reattach).
app.post('/api/agent/sessions/:id/chat', (req, res) => {
  try {
    const { id } = req.params;
    const { prompt, model, persistModel } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });

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
    return { success: false, item, errorInfo };
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
  return { success: true, item };
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
  const item = {
    id: `sched-${Date.now()}`,
    sessionId,
    sessionName: session.name,
    prompt: prompt.trim(),
    model: scheduledModel,
    runAt: runAt || null,               // ISO string => auto-run at that time; null => manual run-now
    frequencyMinutes: frequencyMinutes ? Math.max(10, Math.min(129600, parseInt(frequencyMinutes, 10))) : null,
    status: 'pending',
    source: source || 'manual',         // 'manual' | 'agent' | 'auto-recovery'
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

    for (const item of due) {
      await runScheduledItem(item, { isAuto: true });
    }
    writeScheduled(scheduled);
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
