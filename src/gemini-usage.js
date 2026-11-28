'use strict';
/**
 * gemini-usage.js — tiny per-day, per-model counter for Gemini calls (task rue6, 2026-11-27).
 * Stores ONLY counts: calls, ok, 429s, other errors and token totals. No prompt or response text,
 * no user names. File data/gemini-usage.json, 30 Eastern-time days kept, atomic write, mode 600.
 * record() never throws: any failure is swallowed so a counter problem can't break a Gemini call.
 * Shared by the dashboard server and cron scripts (gemini-client.js) via the same file.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '../data/gemini-usage.json');
const KEEP_DAYS = 30;
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (d) => fmt.format(d);   // YYYY-MM-DD, Eastern

const blank = () => ({ calls: 0, ok: 0, rate429: 0, errors: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0 });
const num = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

function create({ file = DEFAULT_FILE, now = () => new Date() } = {}) {
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j && typeof j.days === 'object' && j.days ? j : { days: {} };
    } catch { return { days: {} }; }
  }
  function save(doc) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  function prune(doc, today) {
    const keys = Object.keys(doc.days).sort();
    const cutoff = dayOf(new Date(new Date(`${today}T12:00:00Z`).getTime() - (KEEP_DAYS - 1) * 86400000));
    for (const k of keys) if (k < cutoff) delete doc.days[k];
  }

  // outcome: 'ok' | '429' | 'error'. usage: the response's usageMetadata (optional).
  function record(model, outcome, usage) {
    try {
      const today = dayOf(now());
      const doc = load();
      const m = String(model || 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) || 'unknown';
      const day = doc.days[today] || (doc.days[today] = {});
      const c = day[m] || (day[m] = blank());
      if (outcome === 'ok' || outcome === '429' || outcome === 'error') {
        c.calls++;
        if (outcome === 'ok') c.ok++; else if (outcome === '429') c.rate429++; else c.errors++;
      }
      if (usage && typeof usage === 'object') {
        c.promptTokens += num(usage.promptTokenCount);
        c.outputTokens += num(usage.candidatesTokenCount);
        c.totalTokens += num(usage.totalTokenCount);
      }
      prune(doc, today);
      save(doc);
    } catch { /* never throw into the caller */ }
  }

  function summary() {
    const today = dayOf(now());
    const doc = load();
    const out = { today: { date: today, models: doc.days[today] || {} }, days: [] };
    for (let i = 0; i < 7; i++) {
      const date = dayOf(new Date(new Date(`${today}T12:00:00Z`).getTime() - i * 86400000));
      const models = doc.days[date] || {};
      const t = blank();
      for (const c of Object.values(models)) for (const k of Object.keys(t)) t[k] += c[k] || 0;
      out.days.push({ date, ...t });
    }
    return out;
  }
  return { record, summary, file };
}

const shared = create();
module.exports = { create, record: shared.record, summary: shared.summary, dayOf };
