// gemini-client.js — one-shot Gemini calls for background jobs (bug-crawler,
// test suggestions). Added 2026-10-06 (Auto Ticket Processing).
//
// Why it exists: the newer Flash models on this key return 429 (rate limit)
// and 503 ("high demand") intermittently — measured 2026-10-06: 3.8-flash got
// 1 success in 6, 3.6-flash 6 in 6, flash-lite always fine. The 08-26 "Flash
// hangs" verdict was this, not a dead model. A daily job doesn't care about
// latency, so: retry with backoff, then walk down a model chain.
//
// Key: GEMINI_API_KEY from the environment (pm2 sets it), else the file
// ~/ops/secrets/gemini.key. Cron does not load ~/.bashrc, so a cron job
// without that file has no key and generate() throws NO_KEY.
const fs = require('fs');
const path = require('path');

const PROXY_URL = process.env.GEMINI_PROXY_URL || 'https://gemini-proxy.lagasse-alex.workers.dev';
const DEFAULT_CHAIN = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [5000, 15000, 45000]; // between attempts on the same model

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const f = path.join(process.env.HOME || '/home/ubuntu', 'ops/secrets/gemini.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// generate({ prompt, json, models, timeoutMs, log })
// -> { text, model }   (text is the raw model output; parse it yourself if json)
async function generate({ prompt, json = false, models = DEFAULT_CHAIN, timeoutMs = 120000, log = console.log } = {}) {
  const key = loadKey();
  if (!key) { const e = new Error('No Gemini key (GEMINI_API_KEY unset and ~/ops/secrets/gemini.key missing).'); e.code = 'NO_KEY'; throw e; }
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (json) body.generationConfig = { responseMimeType: 'application/json' };

  let lastErr = null;
  for (const model of models) {
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`${PROXY_URL}/v1beta/models/${model}:generateContent?key=${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal
        });
        if (RETRYABLE.has(res.status)) { lastErr = new Error(`${model}: HTTP ${res.status}`); log(`[gemini] ${lastErr.message}, attempt ${attempt + 1}`); continue; }
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (!ctype.includes('json')) { lastErr = new Error(`${model}: non-JSON HTTP ${res.status}`); break; } // not retryable: next model
        const data = await res.json();
        if (!res.ok) { lastErr = new Error(`${model}: HTTP ${res.status} ${(data.error && data.error.message || '').slice(0, 200)}`); break; }
        const text = (((data.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('') || '';
        if (!text) { lastErr = new Error(`${model}: empty response`); continue; }
        return { text, model };
      } catch (e) {
        lastErr = new Error(`${model}: ${e.name === 'AbortError' ? `no response in ${timeoutMs / 1000}s` : e.message}`);
        log(`[gemini] ${lastErr.message}, attempt ${attempt + 1}`);
      } finally { clearTimeout(timer); }
    }
    log(`[gemini] giving up on ${model}, trying the next model`);
  }
  throw lastErr || new Error('Gemini: no models tried');
}

module.exports = { generate, DEFAULT_CHAIN };
