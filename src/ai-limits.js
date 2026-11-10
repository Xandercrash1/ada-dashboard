// Daily AI limits for everyone but admins (Plan — Roles § AI limits, Alex 2026-11-09).
// The Designer chat spends Alex's OpenAI key and site builds his Claude subscription,
// so each non-admin person gets a few of each per day. One Designer message is one
// "chat". Days follow Eastern time, and counts live in data/ai-usage.json so a
// restart doesn't hand out fresh turns.
const fs = require('fs');
const path = require('path');

const LIMITS = { designer: 10, site: 3 };
const ZONE = 'America/New_York';

const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

function create({ dataDir, limits = LIMITS, clock = () => new Date() }) {
  const file = path.join(dataDir, 'ai-usage.json');
  const load = () => {
    const day = today(clock());
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.day === day && d.counts && typeof d.counts === 'object') return d;
    } catch (e) { if (e.code !== 'ENOENT') console.error('[ai-limits] unreadable usage file, starting the day fresh:', e.message); }
    return { day, counts: {} };
  };
  const save = (d) => { const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, file); };
  const unlimited = (user) => !user || user.role === 'admin';

  // Uses one turn. False when the person has none left today.
  function take(user, kind) {
    if (unlimited(user)) return true;
    const d = load();
    const mine = d.counts[user.username] || (d.counts[user.username] = {});
    if ((mine[kind] || 0) >= limits[kind]) return false;
    mine[kind] = (mine[kind] || 0) + 1;
    save(d);
    return true;
  }

  // Hands a turn back, e.g. when a site build fails.
  function refund(user, kind) {
    if (unlimited(user)) return;
    const d = load();
    const mine = d.counts[user.username];
    if (!mine || !mine[kind]) return;
    mine[kind] -= 1;
    save(d);
  }

  function left(user) {
    if (unlimited(user)) return { unlimited: true };
    const mine = load().counts[user.username] || {};
    const out = {};
    for (const k of Object.keys(limits)) out[k] = { used: mine[k] || 0, limit: limits[k], left: Math.max(0, limits[k] - (mine[k] || 0)) };
    return out;
  }

  return { take, refund, left, limits };
}

module.exports = { create, LIMITS, today };
