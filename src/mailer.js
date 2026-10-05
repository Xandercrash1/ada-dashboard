'use strict';

/**
 * mailer.js — outbound email via Resend (One Ada, Plan § 4 P2-1).
 *
 * The API key lives ONLY in a mode-600 file on this box (default
 * ~/ops/secrets/resend.key), never in a repo, the vault, or pm2 env. It is read
 * at send time, so rotating it needs no restart.
 *
 * Free tier: the sender is fixed (onboarding@resend.dev) and Resend delivers
 * ONLY to the account's signup address, so a leaked key cannot mail anyone else.
 * Uses Node 20's built-in fetch, so no npm dependency (promote.sh never runs
 * `npm install`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_FILE = process.env.RESEND_KEY_FILE || path.join(os.homedir(), 'ops/secrets/resend.key');
const FROM = 'Ada <onboarding@resend.dev>';
const TO = 'lagasse.alex@gmail.com';

function readKey() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

/** Sends one email to Alex. Resolves { ok, id?, error? }; never throws. */
async function sendMail({ subject, text, html }) {
  const key = readKey();
  if (!key) return { ok: false, error: 'mailer: no API key file' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [TO], subject, text, ...(html ? { html } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, id: body.id } : { ok: false, error: `mailer: HTTP ${res.status} ${body.message || ''}`.trim() };
  } catch (e) {
    return { ok: false, error: `mailer: ${e.message}` };
  }
}

module.exports = { sendMail, KEY_FILE };
