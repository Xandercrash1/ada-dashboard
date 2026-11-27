'use strict';

/**
 * money.js — the Money page (phase 1 of Plan — Money on the VPS, 2026-11-26). ALEX ONLY.
 *
 * Bank CSV import (known layouts auto-detected, or columns mapped once and saved as a profile), preview with
 * duplicates marked, commit; fingerprint dedupe; regex category rules plus manual edits that can become rules;
 * a month view (categories, income vs spending, top merchants, coverage gaps, recurring from Subscriptions).
 *
 * SECURITY (all load-bearing, each covered by src/money.test.js):
 *   - Access: only a real browser session for the user `alex` (req.session set by auth.js AND
 *     req.user.username === 'alex'). The loopback shortcut in auth.js (username 'system', no session),
 *     the Mac-bridge exemption, other admins, 303, guests and signed-out callers all get 404.
 *     gate(requireAuth) runs BEFORE server.js's global requireAuth, so a signed-out caller gets 404, not 401.
 *   - Card/account-number-like digit runs (8+ digits, spaces/dashes allowed) are cut to ••1234 in every cell at
 *     upload, before anything else sees the rows. Date-shaped tokens (2026-11-26, 11-26-2026) are left alone.
 *   - The raw CSV is never written to disk. Uploads are text/csv bodies of at most 5 MB, parsed in memory; only the
 *     masked rows live (in memory, 15 minutes) between preview and commit.
 *   - Storage: data/money/money.json, directory 0700, file 0600, atomic write (tmp + rename).
 *   - No descriptions or amounts in console output or error answers (errors are generic; error-report.js
 *     only ever sees those generic strings).
 *   - CSV export: every cell that starts with = + - @ (or tab / CR) gets a leading single quote.
 *   - No model calls of any kind in this module.
 *
 * SCOPE (Alex, 2026-11-26 22:22): statement uploads are ON HOLD. Phase 1 is cards with their autopay, recurring bills,
 * one-off expenses (groceries, gas, eating out are logged one at a time) and variable-category budgets. The CSV import
 * below stays built and tested, but the page keeps it collapsed under "Statement import (coming later)".
 *
 * API (all under /api/money, JSON in and out, amounts in DOLLARS on input and CENTS on output; alex session only):
 *   GET    /meta                         categories, kinds, cycles, accounts (subscription card seeded on first load), bills, variable
 *   GET    /month?month=YYYY-MM          the month view: expectedCents, soFarCents, byCategory, byCard, variable, priceNeeded, oneOffs
 *   POST   /accounts                     { name, kind: checking|savings|credit card|other, last4?: '1234', autopay?: 125.00, dueDay?: 1–31 }
 *   PATCH  /accounts/:id                 same fields, partial. The subscription card refuses `autopay` (read live from subscriptions.js)
 *   DELETE /accounts/:id                 refused for the subscription card, or while expenses/bills point at it
 *   POST   /bills                        { name, amount?: 15.49 (blank = "price needed"), cycle?: monthly|yearly|weekly|months,
 *                                          everyMonths?: N (cycle 'months'), category?, accountId?, dueDay?, notes? }
 *   PATCH  /bills/:id · DELETE /bills/:id
 *   PUT    /variable                     { category, variable: true|false, estimate?: 400.00 } (monthly estimate, optional)
 *   POST   /transactions                 one-off: { date: '2026-11-26', amount: 54.20, expense: true, description, category?, accountId? }
 *                                          (without `expense`, the sign is taken as given: negative = money out). 409 + needsConfirm
 *                                          for an identical entry the same day; resend with force: true.
 *   GET    /transactions?month=&q=&category=&accountId=   · PATCH /transactions/:id { category, always? } · DELETE /transactions/:id
 *   GET    /export.csv?month=            formula-escaped CSV
 *   Statement import (on hold): POST /import?accountId= (text/csv body, X-Filename: *.csv) · POST /import/:id/map · POST /import/:id/commit
 *   Rules: POST /rules { pattern, category, priority? } · DELETE /rules/:id · DELETE /profiles/:id · GET /summary?month= (statement view)
 * Ada on the VPS can also use src/money-cli.js (same store, same validation, same lock): see that file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const MAX_UPLOAD = '5mb';
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEWS = 5;
const MAX_ROWS = 20000;

// ---------------------------------------------------------------------------
// Category taxonomy (DOCS.md § Category Taxonomy). Ids are 'food' or 'food/groceries'.
// ---------------------------------------------------------------------------
const TAXONOMY = {
  food: ['groceries', 'restaurants', 'coffee', 'delivery'],
  transport: ['gas', 'parking', 'rideshare', 'transit', 'auto'],
  utilities: ['electric', 'water', 'internet', 'phone', 'streaming'],
  housing: ['rent', 'mortgage', 'insurance', 'maintenance'],
  health: ['pharmacy', 'doctor', 'gym', 'insurance'],
  shopping: ['clothing', 'electronics', 'home', 'amazon'],
  entertainment: ['events', 'hobbies', 'games'],
  travel: ['flights', 'hotels', 'vacation'],
  income: ['paycheck', 'transfer_in', 'interest', 'refund'],
  transfer: ['transfer_out', 'payment', 'atm'],
  other: [],
};
const CATEGORIES = Object.entries(TAXONOMY).flatMap(([top, subs]) => [{ id: top, parent: null }, ...subs.map(s => ({ id: `${top}/${s}`, parent: top }))]);
const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));
const topOf = (cat) => String(cat || 'other').split('/')[0];

// Starter rules for common merchants. Lower priority number runs first; the first match wins.
const STARTER_RULES = [
  [10, 'uber\\s*eats|doordash|grubhub|postmates|instacart', 'food/delivery'],
  [20, 'netflix|spotify|hulu|disney\\s*plus|disney\\+|hbo\\s*max|\\bmax\\.com|youtube\\s*premium|paramount\\+|peacock|apple\\.com/bill|audible', 'utilities/streaming'],
  [30, 'amazon|amzn', 'shopping/amazon'],
  [40, 'walmart|wal-mart|target|kroger|aldi|costco|whole\\s*foods|trader\\s*joe|publix|safeway|food\\s*lion|giant\\s*eagle|wegmans|h-e-b|meijer|sam\'?s\\s*club', 'food/groceries'],
  [50, '\\bshell\\b|exxon|mobil|chevron|\\bbp\\b|sunoco|speedway|wawa|sheetz|circle\\s*k|marathon|citgo|valero|7-eleven|quiktrip|racetrac', 'transport/gas'],
  [60, '\\buber\\b|\\blyft\\b', 'transport/rideshare'],
  [70, 'starbucks|dunkin|tim\\s*hortons|peet\'?s', 'food/coffee'],
  [80, 'mcdonald|burger\\s*king|wendy\'?s|taco\\s*bell|chick-fil-a|chipotle|subway|domino|pizza\\s*hut|panera|five\\s*guys|kfc|popeyes', 'food/restaurants'],
  [90, '\\bcvs\\b|walgreens|rite\\s*aid', 'health/pharmacy'],
  [100, 'planet\\s*fitness|la\\s*fitness|anytime\\s*fitness|\\bymca\\b', 'health/gym'],
  [110, 'comcast|xfinity|spectrum|verizon\\s*fios|optimum|frontier', 'utilities/internet'],
  [120, 'verizon|t-mobile|tmobile|at&t|\\bat\\s*t\\b|mint\\s*mobile|cricket', 'utilities/phone'],
  [130, 'steam|playstation|xbox|nintendo|epic\\s*games', 'entertainment/games'],
  [140, 'payroll|direct\\s*dep|salary', 'income/paycheck'],
  [150, 'interest\\s*(paid|earned|payment)', 'income/interest'],
  [160, '\\batm\\b', 'transfer/atm'],
  [170, 'payment\\s*-?\\s*thank\\s*you|autopay|card\\s*payment|online\\s*payment', 'transfer/payment'],
];

// Known bank layouts. Written from public descriptions of each bank's export, NOT checked against a real file:
// the preview shows the parsed signs and dates, so a wrong guess is visible before commit.
const BUILTIN_PROFILES = [
  { id: 'builtin-chase-card', name: 'Chase credit card (unverified)', headers: ['transaction date', 'post date', 'description', 'category', 'type', 'amount', 'memo'],
    map: { date: 'Transaction Date', description: 'Description', amount: 'Amount' }, sign: 'as-is', builtin: true },
  { id: 'builtin-chase-checking', name: 'Chase checking (unverified)', headers: ['details', 'posting date', 'description', 'amount', 'type', 'balance', 'check or slip #'],
    map: { date: 'Posting Date', description: 'Description', amount: 'Amount' }, sign: 'as-is', builtin: true },
  { id: 'builtin-capitalone-card', name: 'Capital One card (unverified)', headers: ['transaction date', 'posted date', 'card no.', 'description', 'category', 'debit', 'credit'],
    map: { date: 'Transaction Date', description: 'Description', debit: 'Debit', credit: 'Credit' }, sign: 'split', builtin: true },
  { id: 'builtin-discover-card', name: 'Discover card (unverified)', headers: ['trans. date', 'post date', 'description', 'amount', 'category'],
    map: { date: 'Trans. Date', description: 'Description', amount: 'Amount' }, sign: 'invert', builtin: true },
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Date-shaped tokens that the digit-run mask must not eat: YYYY-MM-DD and MM-DD-YYYY (dashes count as separators).
const DATE_TOKEN_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})-(\d{1,2})-(\d{4})\b/g;
const DIGIT_RUN_RE = /\d(?:[ -]?\d){7,}/g;
const validMD = (m, d) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31;

/** maskDigits(s): every run of 8+ digits (spaces/dashes allowed between) becomes ••<last 4>. */
function maskDigits(value) {
  const s = String(value == null ? '' : value);
  if (!/\d{2}/.test(s.replace(/[ -]/g, ''))) return s;
  // Protect valid date tokens, mask the rest, then put the dates back.
  const kept = [];
  const guarded = s.replace(DATE_TOKEN_RE, (m, y1, m1, d1, m2, d2) => {
    if ((y1 && validMD(m1, d1)) || (y1 === undefined && validMD(m2, d2))) { kept.push(m); return `\u0000${kept.length - 1}\u0000`; }
    return m;
  });
  const masked = guarded.replace(DIGIT_RUN_RE, (run) => '••' + run.replace(/\D/g, '').slice(-4));
  return masked.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[+i]);
}

/** parseCsv(text) -> rows (arrays of strings). RFC 4180: quoted fields, "" escapes, commas and newlines inside quotes. */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field.trim() === '') { field = ''; inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      if (c === '\r' && s[i + 1] === '\n') i++;
      i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

/** parseAmount('$1,234.50') -> 123450 cents; '(12.00)' and '-12' and '12-' are negative; bad input -> null. */
function parseAmount(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/usd/i, '').replace(/[$\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  s = s.replace(/^\$/, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{1,2})?$/.test(s) || s === '' || s === '.') return null;
  s = s.replace(/,/g, '');
  const [whole, frac = ''] = s.split('.');
  const cents = (whole ? parseInt(whole, 10) : 0) * 100 + (frac ? parseInt(frac.padEnd(2, '0'), 10) : 0);
  if (!Number.isSafeInteger(cents)) return null;
  return neg && cents !== 0 ? -cents : cents;
}

/** parseDate('3/7/26') -> '2026-03-07'. US order for slashed dates; ISO for year-first. Bad -> null. */
function parseDate(value) {
  const s = String(value == null ? '' : value).trim().split(/[ T]/)[0];
  let y, m, d, mm;
  if ((mm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) [, y, m, d] = mm;
  else if ((mm = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) { [, m, d, y] = mm; if (y.length === 2) y = String(2000 + +y); }
  else return null;
  y = +y; m = +m; d = +d;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** cleanDescription: masked, POS/ACH/# tokens and * removed, whitespace collapsed, upper case. Fingerprint input. */
function cleanDescription(desc) {
  return maskDigits(desc).replace(/#/g, ' ').replace(/\*/g, ' ').replace(/\b(POS|ACH)\b/gi, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

const MERCHANT_NOISE = new Set(['SQ', 'TST', 'SP', 'PAYPAL', 'PP', 'DEBIT', 'CARD', 'PURCHASE', 'CHECKCARD', 'RECURRING', 'VISA', 'DDA', 'POS', 'ACH', 'WWW', 'THE']);
/** merchantOf: a short display name for grouping ("SQ *BLUE BOTTLE 1234 OAKLAND CA" -> "Blue Bottle Oakland"). */
function merchantOf(desc) {
  const words = cleanDescription(desc).replace(/[^A-Z0-9&'.+\- ]/g, ' ').split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && MERCHANT_NOISE.has(words[i])) i++;
  const kept = words.slice(i).filter(w => !/\d/.test(w) && !/^[-.]+$/.test(w)).slice(0, 3);
  const name = kept.join(' ');
  if (!name) return 'Unknown';
  return name.toLowerCase().replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

/** fingerprint(accountId, date, cents, cleaned, occurrence) — SHA-256, per DOCS.md plus the account and an occurrence counter. */
function fingerprint(accountId, date, cents, cleaned, occurrence) {
  return crypto.createHash('sha256').update(`${accountId}|${date}|${(cents / 100).toFixed(2)}|${String(cleaned).toLowerCase()}|${occurrence}`).digest('hex');
}

/** compileRules(rules) -> sorted [{rule, re}]; a rule whose pattern fails to compile is skipped. */
function compileRules(rules) {
  return (rules || []).slice().sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id))).map(rule => {
    try { return { rule, re: new RegExp(rule.pattern, 'i') }; } catch (e) { return null; }
  }).filter(Boolean);
}

/** categorize(description, merchant, cents, compiled) -> { category, source, ruleId }. */
function categorize(description, merchant, cents, compiled) {
  const hay = `${description} ${merchant}`;
  for (const { rule, re } of compiled) if (re.test(hay)) return { category: rule.category, source: 'rule', ruleId: rule.id };
  return { category: cents > 0 ? 'income' : 'other', source: 'default', ruleId: null };
}

/** escapeCsvCell: formula guard (leading = + - @ tab CR gets a single quote), then RFC 4180 quoting. */
function escapeCsvCell(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** detectProfile(headers, profiles) -> best profile with >= 80% header overlap, or null. */
function detectProfile(headers, profiles) {
  const have = new Set(headers.map(h => String(h).trim().toLowerCase()));
  let best = null, bestScore = 0;
  for (const p of profiles) {
    const want = (p.headers || []).map(h => String(h).toLowerCase());
    if (!want.length) continue;
    const hit = want.filter(h => have.has(h)).length;
    const score = hit / Math.max(want.length, have.size);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 0.8 ? best : null;
}

/** splitHeader(rows): the header is the first row (within 15) with 2+ non-empty cells; preamble lines above are dropped. */
function splitHeader(rows) {
  const idx = rows.slice(0, 15).findIndex(r => r.filter(c => String(c).trim() !== '').length >= 2);
  if (idx === -1) return null;
  return { headers: rows[idx].map(h => String(h).trim()), data: rows.slice(idx + 1) };
}

/** resolveProfile(profile, headers): the profile with its column names matched to this file's headers (case-insensitive). */
function resolveProfile(profile, headers) {
  const find = (name) => (name ? headers.find(h => h.toLowerCase() === String(name).toLowerCase()) || name : name);
  const map = {};
  for (const [k, v] of Object.entries(profile.map || {})) map[k] = find(v);
  return { ...profile, map };
}

/** validateMapping(map, sign, headers) -> errors[] */
function validateMapping(map, sign, headers) {
  const errors = [];
  const has = (h) => typeof h === 'string' && headers.includes(h);
  if (!map || typeof map !== 'object') return ['mapping is required'];
  if (!has(map.date)) errors.push('choose the date column');
  if (!has(map.description)) errors.push('choose the description column');
  if (!['as-is', 'invert', 'split'].includes(sign)) errors.push('sign must be as-is, invert or split');
  if (sign === 'split') { if (!has(map.debit) && !has(map.credit)) errors.push('choose the debit and/or credit columns'); }
  else if (!has(map.amount)) errors.push('choose the amount column');
  if (map.category != null && map.category !== '' && !has(map.category)) errors.push('category column not found');
  return errors;
}

/**
 * normalizeRows(headers, data, profile, ctx) -> rows[]. ctx = { accountId, compiled, existing:Set(fingerprints) }.
 * Each row: { date, description, merchant, cents, category, categorySource, ruleId, fingerprint, duplicate, error }.
 * The occurrence counter makes the n-th identical (account, date, amount, description) row in a file its own fingerprint.
 */
function normalizeRows(headers, data, profile, ctx) {
  const col = (name) => (name ? headers.indexOf(name) : -1);
  const iDate = col(profile.map.date), iDesc = col(profile.map.description), iAmt = col(profile.map.amount);
  const iDeb = col(profile.map.debit), iCred = col(profile.map.credit), iCat = col(profile.map.category);
  const seen = new Map();
  return data.slice(0, MAX_ROWS).map((cells) => {
    const get = (i) => (i >= 0 && i < cells.length ? String(cells[i]).trim() : '');
    const date = parseDate(get(iDate));
    const description = maskDigits(get(iDesc)).replace(/\s+/g, ' ').trim().slice(0, 200);
    let cents = null;
    if (profile.sign === 'split') {
      const deb = parseAmount(get(iDeb)), cred = parseAmount(get(iCred));
      if (deb) cents = -Math.abs(deb);
      else if (cred) cents = Math.abs(cred);
      else if (deb === 0 || cred === 0) cents = 0;
    } else {
      const a = parseAmount(get(iAmt));
      if (a !== null) cents = profile.sign === 'invert' ? -a : a;
    }
    const error = !date ? 'bad date' : cents === null ? 'bad amount' : !description ? 'no description' : null;
    if (error) return { date, description, cents, error };
    const cleaned = cleanDescription(description);
    const merchant = merchantOf(description);
    const base = `${date}|${cents}|${cleaned}`;
    const occ = (seen.get(base) || 0) + 1;
    seen.set(base, occ);
    const fp = fingerprint(ctx.accountId, date, cents, cleaned, occ);
    let cat = categorize(description, merchant, cents, ctx.compiled);
    const csvCat = iCat >= 0 ? get(iCat).toLowerCase().replace(/\s+/g, '_') : '';
    if (csvCat && CATEGORY_IDS.has(csvCat) && cat.source === 'default') cat = { category: csvCat, source: 'csv', ruleId: null };
    return { date, description, merchant, cents, category: cat.category, categorySource: cat.source, ruleId: cat.ruleId, fingerprint: fp, duplicate: ctx.existing.has(fp), error: null };
  });
}

const monthOf = (date) => String(date).slice(0, 7);
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Income vs spending: income/* counts as income, transfer/* is left out (card payments and moves between
 * Alex's own accounts would count twice), everything else is spending, netted (a refund lowers its category).
 */
function monthTotals(txs) {
  let income = 0, spending = 0;
  for (const t of txs) {
    const top = topOf(t.category);
    if (top === 'transfer') continue;
    if (top === 'income') income += t.cents; else spending -= t.cents;
  }
  return { income, spending, net: income - spending };
}

/** summarize(store, month, subs) -> the month view. All amounts in cents. */
function summarize(store, month, subs) {
  const inMonth = store.transactions.filter(t => monthOf(t.date) === month);
  const byCat = new Map();
  for (const t of inMonth) {
    const top = topOf(t.category);
    const c = byCat.get(top) || { category: top, cents: 0, count: 0, subs: new Map() };
    c.cents += t.cents; c.count++;
    const sub = t.category.includes('/') ? t.category : top;
    c.subs.set(sub, (c.subs.get(sub) || 0) + t.cents);
    byCat.set(top, c);
  }
  const categories = [...byCat.values()].map(c => ({ category: c.category, cents: c.cents, count: c.count,
    subs: [...c.subs.entries()].map(([category, cents]) => ({ category, cents })).sort((a, b) => a.cents - b.cents) })).sort((a, b) => a.cents - b.cents);
  const merch = new Map();
  for (const t of inMonth) {
    if (t.cents >= 0 || ['transfer', 'income'].includes(topOf(t.category))) continue;
    const m = merch.get(t.merchant) || { merchant: t.merchant, cents: 0, count: 0 };
    m.cents -= t.cents; m.count++;
    merch.set(t.merchant, m);
  }
  const topMerchants = [...merch.values()].sort((a, b) => b.cents - a.cents).slice(0, 10);
  const last12 = [];
  for (let i = 11; i >= 0; i--) {
    const ym = addMonths(month, -i);
    last12.push({ month: ym, ...monthTotals(store.transactions.filter(t => monthOf(t.date) === ym)) });
  }
  // Coverage: for each account, months in the 12-month window (from its first transaction on) with no transactions.
  const windowStart = addMonths(month, -11);
  const coverage = store.accounts.map(a => {
    const months = new Set(store.transactions.filter(t => t.accountId === a.id).map(t => monthOf(t.date)));
    if (!months.size) return { accountId: a.id, name: a.name, missing: [], empty: true };
    const first = [...months].sort()[0];
    const missing = [];
    for (let ym = first > windowStart ? first : windowStart; ym <= month; ym = addMonths(ym, 1)) if (!months.has(ym)) missing.push(ym);
    return { accountId: a.id, name: a.name, missing, empty: false };
  }).filter(c => c.missing.length || c.empty);
  const recurringItems = (Array.isArray(subs) ? subs : []).filter(s => s && s.name).map(s => {
    const price = s.price != null && Number.isFinite(Number(s.price)) ? Math.round(Number(s.price) * 100) : null;
    return { name: String(s.name), cents: price, cycle: s.cycle === 'yearly' ? 'yearly' : 'monthly', monthlyCents: price == null ? null : (s.cycle === 'yearly' ? Math.round(price / 12) : price) };
  });
  const recurring = { items: recurringItems, monthlyCents: recurringItems.reduce((a, s) => a + (s.monthlyCents || 0), 0) };
  return { month, ...monthTotals(inMonth), count: inMonth.length, categories, topMerchants, last12, coverage, recurring };
}

// ---------------------------------------------------------------------------
// Budget plan: bills, variable categories, one-offs (phase 1 after the 2026-11-26 scope change)
// ---------------------------------------------------------------------------

// Loaded lazily: subscriptions.js owns the subscription card's autopay formula (computeTotal); never copy it here.
let subsMod = null;
const subscriptionsModule = () => (subsMod || (subsMod = require('./subscriptions')));

/** monthlyEquivalent(bill) -> cents per month, or null when the price is not known yet. */
function monthlyEquivalent(bill) {
  if (!bill || bill.cents == null) return null;
  switch (bill.cycle) {
    case 'yearly': return Math.round(bill.cents / 12);
    case 'weekly': return Math.round(bill.cents * 52 / 12);
    case 'months': return Math.round(bill.cents / Math.max(1, bill.everyMonths || 1));
    default: return bill.cents;
  }
}

/** localMonth(date) -> 'YYYY-MM' in the server's time zone (America/New_York on the VPS), not UTC. */
const localMonth = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const isSpend = (t) => t.cents < 0 && !['income', 'transfer'].includes(topOf(t.category));
const inCategory = (t, cat) => t.category === cat || (!cat.includes('/') && topOf(t.category) === cat);

/**
 * variableBudget(store, v, month, now) -> { category, cents, source:'avg'|'estimate'|'none', months, actualCents }
 * The average of logged spending in the category over the 3 FULL months before `month` (months before the
 * current calendar month only), divided by the number of those months that have entries. Used once at least one
 * full month has entries; otherwise the manual estimate.
 */
function variableBudget(store, v, month, now) {
  const current = localMonth(now);
  const spent = (ym) => store.transactions.filter(t => monthOf(t.date) === ym && inCategory(t, v.category) && isSpend(t));
  let total = 0, withEntries = 0;
  for (let i = 1; i <= 3; i++) {
    const ym = addMonths(month, -i);
    if (ym >= current) continue;   // not a full month yet
    const txs = spent(ym);
    if (txs.length) { withEntries++; total += txs.reduce((a, t) => a - t.cents, 0); }
  }
  const actualCents = spent(month).reduce((a, t) => a - t.cents, 0);
  if (withEntries) return { category: v.category, cents: Math.round(total / withEntries), source: 'avg', months: withEntries, actualCents, estimateCents: v.estimateCents };
  return { category: v.category, cents: v.estimateCents || 0, source: v.estimateCents == null ? 'none' : 'estimate', months: 0, actualCents, estimateCents: v.estimateCents };
}

/**
 * monthPlan(store, month, subs, now, subscriptionAutopay) -> the month view.
 * expected = recurring bills (monthly equivalent, plus the priced items on the Subscriptions page) + variable budgets.
 * soFar = the same bills (assumed paid) + one-offs logged in the month. All amounts in cents.
 */
function monthPlan(store, month, subs, now, subscriptionAutopay) {
  const subCard = store.accounts.find(a => a.isSubscriptionCard) || null;
  const bills = store.recurring.map(b => ({ ...b, monthlyCents: monthlyEquivalent(b) }));
  const subsRows = (Array.isArray(subs) ? subs : []).filter(s => s && s.name).map(s => {
    const cents = s.price != null && Number.isFinite(Number(s.price)) ? Math.round(Number(s.price) * 100) : null;
    return { name: String(s.name), cents, cycle: s.cycle === 'yearly' ? 'yearly' : 'monthly', onCard: !!s.onCard,
      monthlyCents: cents == null ? null : (s.cycle === 'yearly' ? Math.round(cents / 12) : cents) };
  });
  const subsMonthly = subsRows.reduce((a, s) => a + (s.monthlyCents || 0), 0);
  const billsMonthly = bills.reduce((a, b) => a + (b.monthlyCents || 0), 0) + subsMonthly;
  const variable = store.variable.map(v => variableBudget(store, v, month, now));
  const variableMonthly = variable.reduce((a, v) => a + v.cents, 0);
  const oneOffs = store.transactions.filter(t => monthOf(t.date) === month && isSpend(t)).sort((a, b) => a.date.localeCompare(b.date));
  const loggedCents = oneOffs.reduce((a, t) => a - t.cents, 0);

  const cats = new Map();
  const cat = (id) => { if (!cats.has(id)) cats.set(id, { category: id, billsCents: 0, loggedCents: 0, budgetCents: null, budgetSource: null }); return cats.get(id); };
  for (const b of bills) if (b.monthlyCents) cat(topOf(b.category)).billsCents += b.monthlyCents;
  if (subsMonthly) cat('subscriptions').billsCents += subsMonthly;
  for (const t of oneOffs) cat(topOf(t.category)).loggedCents -= t.cents;
  for (const v of variable) { const c = cat(topOf(v.category)); c.budgetCents = (c.budgetCents || 0) + v.cents; c.budgetSource = v.source; }
  const byCategory = [...cats.values()].map(c => ({ ...c, expectedCents: c.billsCents + (c.budgetCents || 0), soFarCents: c.billsCents + c.loggedCents }))
    .sort((a, b) => b.expectedCents - a.expectedCents || b.soFarCents - a.soFarCents);

  const sub = subscriptionAutopay ? subscriptionAutopay(subs) : null;
  const card = (a) => {
    const id = a ? a.id : null;
    const own = bills.filter(b => (b.accountId || null) === id);
    let billsCents = own.reduce((x, b) => x + (b.monthlyCents || 0), 0);
    if (a && a.isSubscriptionCard) billsCents += subsRows.filter(s => s.onCard).reduce((x, s) => x + (s.monthlyCents || 0), 0);
    if (!a) billsCents += subsRows.filter(s => !s.onCard || !subCard).reduce((x, s) => x + (s.monthlyCents || 0), 0);
    const logged = oneOffs.filter(t => (t.accountId || null) === id).reduce((x, t) => x - t.cents, 0);
    return { accountId: id, name: a ? a.name : 'No card set', kind: a ? a.kind : null, last4: a ? a.last4 : null, dueDay: a ? a.dueDay : null,
      isSubscriptionCard: !!(a && a.isSubscriptionCard), autopayCents: a ? (a.isSubscriptionCard ? (sub ? sub.cents : null) : a.autopayCents) : null,
      autopaySource: a && a.isSubscriptionCard ? 'subscriptions' : (a && a.autopayCents != null ? 'manual' : null),
      billsCents, loggedCents: logged, billCount: own.length };
  };
  const byCard = store.accounts.map(card);
  const none = card(null);
  if (none.billsCents || none.loggedCents || none.billCount) byCard.push(none);

  const priceNeeded = bills.filter(b => b.cents == null).map(b => ({ id: b.id, name: b.name, source: 'bill' }))
    .concat(subsRows.filter(s => s.cents == null).map(s => ({ name: s.name, source: 'subscriptions' })));
  return { month, expectedCents: billsMonthly + variableMonthly, billsMonthlyCents: billsMonthly, subscriptionsMonthlyCents: subsMonthly, variableMonthlyCents: variableMonthly,
    loggedCents, soFarCents: billsMonthly + loggedCents, bills, subscriptions: subsRows, variable, oneOffs: oneOffs.map(({ fingerprint: _f, ...t }) => t), byCategory, byCard, priceNeeded,
    subscriptionCard: subCard ? { accountId: subCard.id, autopayCents: sub ? sub.cents : null, items: sub ? sub.items : [] } : null };
}

// ---------------------------------------------------------------------------
// Access guard
// ---------------------------------------------------------------------------

/** isAlexSession(req): a real cookie session (auth.js sets req.session only for one) for the user `alex`. */
const isAlexSession = (req) => !!(req && req.session && typeof req.session === 'object' && req.user && req.user.username === 'alex');

function notFound(req, res) {
  if (res.headersSent) return;
  if (String(req.originalUrl || req.url).startsWith('/api/')) res.status(404).json({ error: 'Not found' });
  else res.status(404).type('text/plain').send('Not found');
}

/**
 * gate(requireAuth): middleware for /api/money and /money, mounted BEFORE the global requireAuth.
 * Runs the real requireAuth against a stand-in response: if it would answer (401 or a login redirect),
 * the caller gets 404 instead. If it lets the request through, only an alex browser session continues.
 */
function gate(requireAuth) {
  return function moneyGate(req, res, next) {
    let done = false;
    const deny = () => { if (!done) { done = true; notFound(req, res); } };
    const shim = { status() { return shim; }, json: deny, send: deny, end: deny, redirect: deny, sendStatus: deny, setHeader() { return shim; }, set() { return shim; } };
    try {
      requireAuth(req, shim, () => { if (done) return; done = true; isAlexSession(req) ? next() : notFound(req, res); });
    } catch (e) { deny(); }
    if (!done) deny();   // requireAuth answered nothing and called nothing: treat as refused
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const newId = (prefix) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

function create({ dataDir, subscriptionsFile, clock = () => new Date() }) {
  const dir = path.join(dataDir, 'money');
  const file = path.join(dir, 'money.json');
  const lockFile = path.join(dir, '.lock');
  const subsFile = subscriptionsFile || path.join(dataDir, 'subscriptions.json');
  const previews = new Map();

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  function fresh() {
    return { version: 1, accounts: [], transactions: [], profiles: [], recurring: [], variable: [],
      rules: STARTER_RULES.map(([priority, pattern, category], i) => ({ id: `starter-${i + 1}`, priority, pattern, category, source: 'starter' })) };
  }
  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fresh(); throw e; }
    const s = JSON.parse(raw);   // a corrupt file throws: never overwrite it with an empty store
    for (const k of ['accounts', 'transactions', 'profiles', 'rules', 'recurring', 'variable']) if (!Array.isArray(s[k])) s[k] = [];
    return s;
  }
  function write(store) {
    ensureDir();
    const tmp = path.join(dir, `.money.json.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }
  /**
   * withLock(fn): cross-process lock (the server and src/money-cli.js share the file). Create-exclusive lockfile,
   * bounded wait, a lock older than 10 s is treated as stale. Every write path runs inside it.
   */
  function withLock(fn) {
    ensureDir();
    const deadline = Date.now() + 3000;
    let fd = null;
    while (fd === null) {
      try { fd = fs.openSync(lockFile, 'wx', 0o600); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lockFile).mtimeMs > 10000) { fs.unlinkSync(lockFile); continue; } } catch (e2) { continue; }
        if (Date.now() > deadline) { const err = new Error('money store is busy'); err.code = 'EBUSY'; throw err; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try { return fn(); } finally { try { fs.closeSync(fd); fs.unlinkSync(lockFile); } catch (e) { /* already gone */ } }
  }
  function readSubs() {
    try { const v = JSON.parse(fs.readFileSync(subsFile, 'utf8')); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  /** The subscription card's autopay, live: subscriptions.js computeTotal() — the same figure as its autopay task. */
  function subscriptionAutopay(subs = readSubs()) {
    const { items, total } = subscriptionsModule().computeTotal(subs);
    return { cents: Math.round(total * 100), items: items.map(s => ({ name: String(s.name), cents: Math.round(Number(s.price) * 100) })) };
  }

  function prunePreviews() {
    const now = clock().getTime();
    for (const [id, p] of previews) if (now - p.at > PREVIEW_TTL_MS) previews.delete(id);
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
  }

  // --- Accounts (cards) ---
  const KINDS = ['checking', 'savings', 'credit card', 'other'];
  const optDay = (v, errors, label) => {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 31) { errors.push(`${label} must be a whole number from 1 to 31`); return null; }
    return n;
  };
  const optCents = (v, errors, label) => {
    if (v === null || v === '' || v === undefined) return null;
    const c = typeof v === 'number' ? Math.round(v * 100) : parseAmount(v);
    if (c === null || !Number.isFinite(c) || c < 0) { errors.push(`${label} must be an amount of 0 or more`); return null; }
    return c;
  };
  function validateAccount(b, partial, existing) {
    const errors = [], v = {};
    if (!partial || b.name !== undefined) {
      const name = typeof b.name === 'string' ? maskDigits(b.name).trim() : '';
      if (!name || name.length > 60) errors.push('name: 1–60 characters'); else v.name = name;
    }
    if (!partial || b.kind !== undefined) { if (!KINDS.includes(b.kind)) errors.push('kind must be checking, savings, credit card or other'); else v.kind = b.kind; }
    if (b.last4 !== undefined) {
      if (b.last4 === null || b.last4 === '') v.last4 = null;
      else if (!/^\d{4}$/.test(String(b.last4))) errors.push('last4 must be exactly 4 digits'); else v.last4 = String(b.last4);
    } else if (!partial) v.last4 = null;
    if (b.autopay !== undefined && b.autopay !== null && b.autopay !== '' && existing && existing.isSubscriptionCard) errors.push("the subscription card's autopay is read from the Subscriptions page and can't be typed in");
    else if (b.autopay !== undefined || !partial) v.autopayCents = existing && existing.isSubscriptionCard ? null : optCents(b.autopay, errors, 'autopay');
    if (b.dueDay !== undefined || !partial) v.dueDay = optDay(b.dueDay, errors, 'due day');
    return errors.length ? { errors } : { value: v };
  }
  /** ensureSubscriptionCard(store) -> true if it had to add the card. */
  function ensureSubscriptionCard(store) {
    if (store.accounts.some(a => a.isSubscriptionCard)) return false;
    store.accounts.unshift({ id: newId('acct'), name: 'The subscription card', kind: 'credit card', last4: null, autopayCents: null, dueDay: null, isSubscriptionCard: true, createdAt: clock().toISOString() });
    return true;
  }
  /** readSeeded(): the store, with the subscription card added (and saved) on first load. */
  function readSeeded() {
    const s = read();
    if (s.accounts.some(a => a.isSubscriptionCard)) return s;
    return withLock(() => { const t = read(); if (ensureSubscriptionCard(t)) write(t); return t; });
  }

  // --- Recurring bills ---
  const CYCLES = ['monthly', 'yearly', 'weekly', 'months'];
  function validateBill(b, partial, store) {
    const errors = [], v = {};
    if (!partial || b.name !== undefined) {
      const name = typeof b.name === 'string' ? maskDigits(b.name).replace(/\s+/g, ' ').trim() : '';
      if (!name || name.length > 80) errors.push('name: 1–80 characters'); else v.name = name;
    }
    if (!partial || b.amount !== undefined) v.cents = optCents(b.amount, errors, 'amount');
    if (!partial || b.cycle !== undefined) {
      const cycle = b.cycle == null || b.cycle === '' ? 'monthly' : b.cycle;
      if (!CYCLES.includes(cycle)) errors.push('cycle must be monthly, yearly, weekly or months'); else v.cycle = cycle;
    }
    if (!partial || b.everyMonths !== undefined || b.cycle !== undefined) {
      const cyc = v.cycle || b.cycle;
      if (cyc === 'months') {
        const n = Number(b.everyMonths);
        if (!Number.isInteger(n) || n < 1 || n > 60) errors.push('every N months: N must be 1 to 60'); else v.everyMonths = n;
      } else v.everyMonths = null;
    }
    if (!partial || b.category !== undefined) {
      const c = b.category == null || b.category === '' ? 'other' : b.category;
      if (!CATEGORY_IDS.has(c)) errors.push('unknown category'); else v.category = c;
    }
    if (!partial || b.accountId !== undefined) {
      if (b.accountId == null || b.accountId === '') v.accountId = null;
      else if (!store.accounts.some(a => a.id === b.accountId)) errors.push('unknown card/account'); else v.accountId = b.accountId;
    }
    if (!partial || b.dueDay !== undefined) v.dueDay = optDay(b.dueDay, errors, 'due day');
    if (!partial || b.notes !== undefined) {
      const notes = typeof b.notes === 'string' ? maskDigits(b.notes).trim() : '';
      if (notes.length > 500) errors.push('notes: 500 characters at most'); else v.notes = notes;
    }
    return errors.length ? { errors } : { value: v };
  }
  function addBill(b) {
    const store = read();
    const v = validateBill(b || {}, false, store);
    if (v.errors) return { status: 400, body: { error: v.errors.join('; '), errors: v.errors } };
    const bill = { id: newId('bill'), ...v.value, createdAt: clock().toISOString() };
    store.recurring.push(bill);
    write(store);
    return { status: 201, body: { bill: { ...bill, monthlyCents: monthlyEquivalent(bill) } } };
  }
  function updateBill(id, b) {
    const store = read();
    const bill = store.recurring.find(x => x.id === id);
    if (!bill) return { status: 404, body: { error: 'Not found' } };
    const v = validateBill({ cycle: bill.cycle, everyMonths: bill.everyMonths, ...(b || {}) }, true, store);
    if (v.errors) return { status: 400, body: { error: v.errors.join('; '), errors: v.errors } };
    Object.assign(bill, v.value);
    write(store);
    return { status: 200, body: { bill: { ...bill, monthlyCents: monthlyEquivalent(bill) } } };
  }

  // --- Variable categories (groceries, gas, eating out…) ---
  function setVariable(b) {
    const category = b && b.category;
    if (!CATEGORY_IDS.has(category)) return { status: 400, body: { error: 'unknown category' } };
    const errors = [];
    const estimateCents = optCents(b.estimate, errors, 'estimate');
    if (errors.length) return { status: 400, body: { error: errors.join('; '), errors } };
    const store = read();
    store.variable = store.variable.filter(x => x.category !== category);
    if (b.variable !== false) store.variable.push({ category, estimateCents });
    write(store);
    return { status: 200, body: { variable: store.variable } };
  }

  function plan(month) {
    return monthPlan(readSeeded(), month, readSubs(), clock(), subscriptionAutopay);
  }

  // --- Import ---
  /** startImport(csvText, accountId, profileId?) -> preview response */
  function startImport(text, accountId, profileId) {
    const store = read();
    if (!store.accounts.some(a => a.id === accountId)) return { status: 400, body: { error: 'Choose an account first.' } };
    if (/\u0000/.test(text)) return { status: 415, body: { error: 'That file is not a CSV.' } };
    const rows = parseCsv(text).map(r => r.map(maskDigits));   // masked before anything else touches the rows
    const split = splitHeader(rows);
    if (!split || !split.data.length) return { status: 400, body: { error: 'No rows found. Is this a CSV with a header row?' } };
    if (split.data.length > MAX_ROWS) return { status: 413, body: { error: `More than ${MAX_ROWS} rows; split the file.` } };
    prunePreviews();
    const id = crypto.randomBytes(12).toString('hex');
    previews.set(id, { at: clock().getTime(), accountId, headers: split.headers, data: split.data });
    const profiles = BUILTIN_PROFILES.concat(store.profiles);
    const found = profileId ? profiles.find(p => p.id === profileId) : detectProfile(split.headers, profiles);
    const profile = found ? resolveProfile(found, split.headers) : null;
    const base = { previewId: id, headers: split.headers, sample: split.data.slice(0, 5), rowCount: split.data.length };
    if (!profile || validateMapping(profile.map, profile.sign, split.headers).length) return { status: 200, body: { ...base, needsMapping: true, profile: null } };
    return { status: 200, body: { ...base, needsMapping: false, ...previewRows(store, previews.get(id), profile) } };
  }
  function previewRows(store, pv, profile) {
    const existing = new Set(store.transactions.filter(t => t.accountId === pv.accountId).map(t => t.fingerprint));
    const rows = normalizeRows(pv.headers, pv.data, profile, { accountId: pv.accountId, compiled: compileRules(store.rules), existing });
    pv.profile = { id: profile.id, name: profile.name, map: profile.map, sign: profile.sign };
    pv.rows = rows;
    return { profile: pv.profile, rows, counts: { total: rows.length, ok: rows.filter(r => !r.error && !r.duplicate).length,
      duplicates: rows.filter(r => r.duplicate).length, errors: rows.filter(r => r.error).length } };
  }
  function mapImport(id, b) {
    prunePreviews();
    const pv = previews.get(id);
    if (!pv) return { status: 404, body: { error: 'That preview has expired. Upload the file again.' } };
    const map = b && b.map && typeof b.map === 'object' ? { date: b.map.date, description: b.map.description, amount: b.map.amount || null,
      debit: b.map.debit || null, credit: b.map.credit || null, category: b.map.category || null } : null;
    const sign = b && b.sign;
    const errors = validateMapping(map, sign, pv.headers);
    if (errors.length) return { status: 400, body: { error: errors.join('; '), errors } };
    const store = read();
    let profile = { id: 'adhoc', name: 'This file', map, sign };
    if (b.saveAs) {
      const name = maskDigits(String(b.saveAs)).trim().slice(0, 60);
      if (!name) return { status: 400, body: { error: 'Profile name is empty.' } };
      profile = { id: newId('profile'), name, headers: pv.headers.map(h => h.toLowerCase()), map, sign, createdAt: clock().toISOString() };
      store.profiles.push(profile);
      write(store);
    }
    return { status: 200, body: { previewId: id, ...previewRows(store, pv, profile) } };
  }
  function commitImport(id) {
    prunePreviews();
    const pv = previews.get(id);
    if (!pv || !pv.rows) return { status: 404, body: { error: 'That preview has expired. Upload the file again.' } };
    const store = read();
    if (!store.accounts.some(a => a.id === pv.accountId)) return { status: 400, body: { error: 'The account no longer exists.' } };
    const existing = new Set(store.transactions.filter(t => t.accountId === pv.accountId).map(t => t.fingerprint));
    const at = clock().toISOString();
    let added = 0, skipped = 0;
    for (const r of pv.rows) {
      if (r.error || existing.has(r.fingerprint)) { skipped++; continue; }
      existing.add(r.fingerprint);
      store.transactions.push({ id: newId('tx'), accountId: pv.accountId, date: r.date, description: r.description, merchant: r.merchant, cents: r.cents,
        category: r.category, categorySource: r.categorySource, ruleId: r.ruleId, fingerprint: r.fingerprint, source: 'import', importedAt: at });
      added++;
    }
    write(store);
    previews.delete(id);
    return { status: 200, body: { added, skipped } };
  }

  // --- Transactions ---
  function addManual(b) {
    const store = read();
    const errors = [];
    if (b.accountId == null || b.accountId === '') b = { ...b, accountId: null };
    else if (!store.accounts.some(a => a.id === b.accountId)) errors.push('unknown card/account');
    const date = parseDate(b.date);
    if (!date) errors.push('date must look like 2026-11-26 or 11/26/2026');
    const description = typeof b.description === 'string' ? maskDigits(b.description).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!description) errors.push('description is required');
    let cents = typeof b.amount === 'number' ? Math.round(b.amount * 100) : parseAmount(b.amount);
    if (cents === null || !Number.isFinite(cents) || cents === 0) errors.push('amount must be a non-zero number (negative = money out)');
    else if (b.expense === true) cents = -Math.abs(cents);   // an expense: the amount may be typed as positive
    if (b.category != null && b.category !== '' && !CATEGORY_IDS.has(b.category)) errors.push('unknown category');
    if (errors.length) return { status: 400, body: { error: errors.join('; '), errors } };
    const cleaned = cleanDescription(description);
    const merchant = merchantOf(description);
    const same = store.transactions.filter(t => t.accountId === b.accountId && t.date === date && t.cents === cents && cleanDescription(t.description) === cleaned).length;
    if (same && b.force !== true) return { status: 409, body: { error: 'An identical transaction already exists on that day. Add it anyway?', needsConfirm: true } };
    const cat = b.category ? { category: b.category, source: 'manual', ruleId: null } : categorize(description, merchant, cents, compileRules(store.rules));
    const tx = { id: newId('tx'), accountId: b.accountId, date, description, merchant, cents, category: cat.category, categorySource: cat.source, ruleId: cat.ruleId,
      fingerprint: fingerprint(b.accountId, date, cents, cleaned, same + 1), source: 'manual', importedAt: clock().toISOString() };
    store.transactions.push(tx);
    write(store);
    return { status: 201, body: { transaction: tx } };
  }

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** setCategory(id, category, always): manual edit; `always` adds a top-priority rule for the merchant and re-applies it. */
  function setCategory(id, category, always) {
    if (!CATEGORY_IDS.has(category)) return { status: 400, body: { error: 'unknown category' } };
    const store = read();
    const tx = store.transactions.find(t => t.id === id);
    if (!tx) return { status: 404, body: { error: 'Not found' } };
    tx.category = category; tx.categorySource = 'manual'; tx.ruleId = null;
    let rule = null, recategorized = 0;
    if (always) {
      if (!tx.merchant || tx.merchant === 'Unknown') return { status: 400, body: { error: 'This transaction has no merchant name to make a rule from.' } };
      const pattern = '(?<!\\w)' + escapeRe(tx.merchant).replace(/\s+/g, '\\s+') + '(?!\\w)';
      const minP = Math.min(0, ...store.rules.map(r => r.priority));
      rule = { id: newId('rule'), priority: minP - 1, pattern, category, source: 'user', merchant: tx.merchant, createdAt: clock().toISOString() };
      store.rules.push(rule);
      const re = new RegExp(pattern, 'i');
      for (const t of store.transactions) {
        if (t.id === tx.id || t.categorySource === 'manual') continue;
        if (re.test(`${t.description} ${t.merchant}`)) { t.category = category; t.categorySource = 'rule'; t.ruleId = rule.id; recategorized++; }
      }
    }
    write(store);
    return { status: 200, body: { transaction: tx, rule, recategorized } };
  }

  function listTransactions(q) {
    const store = read();
    let txs = store.transactions;
    if (q.month && MONTH_RE.test(q.month)) txs = txs.filter(t => monthOf(t.date) === q.month);
    if (q.accountId) txs = txs.filter(t => t.accountId === q.accountId);
    if (q.category) txs = txs.filter(t => t.category === q.category || topOf(t.category) === q.category);
    if (q.q) { const needle = String(q.q).toLowerCase().slice(0, 100); txs = txs.filter(t => `${t.description} ${t.merchant}`.toLowerCase().includes(needle)); }
    txs = txs.slice().sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 500, 1), 2000);
    return { total: txs.length, transactions: txs.slice(0, limit).map(({ fingerprint: _f, ...t }) => t) };
  }

  function exportCsv(q) {
    const { transactions } = listTransactions({ ...q, limit: 2000 });
    const accounts = new Map(read().accounts.map(a => [a.id, a.name]));
    const lines = [['Date', 'Account', 'Description', 'Merchant', 'Category', 'Out', 'In']];
    for (const t of transactions.slice().reverse()) {
      const v = (Math.abs(t.cents) / 100).toFixed(2);
      lines.push([t.date, accounts.get(t.accountId) || '', t.description, t.merchant, t.category, t.cents < 0 ? v : '', t.cents > 0 ? v : '']);
    }
    return lines.map(l => l.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
  }

  // --- Routes ---
  function mount(app) {
    const r = express.Router({ caseSensitive: true, strict: false });
    r.use((req, res, next) => (isAlexSession(req) ? next() : notFound(req, res)));   // second wall behind gate()
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const send = (res, out) => res.status(out.status).json(out.body);
    const safe = (fn) => (req, res) => {
      try { req.method === 'GET' ? fn(req, res) : withLock(() => fn(req, res)); } catch (err) {
        console.error('[money] request failed:', err && (err.code || err.name) || 'error');   // never the message: it could quote data
        if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the Money page.' });
      }
    };
    const textBody = express.text({ limit: MAX_UPLOAD, type: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'] });
    const upload = (req, res, next) => {
      const name = String(req.get('X-Filename') || '');
      if (!/\.csv$/i.test(name)) return res.status(415).json({ error: 'Only .csv files can be imported.' });
      if (!req.is(['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'])) return res.status(415).json({ error: 'Only .csv files can be imported.' });
      textBody(req, res, (err) => {
        if (err) return res.status(err.status === 413 || err.type === 'entity.too.large' ? 413 : 400).json({ error: err.type === 'entity.too.large' ? 'That file is larger than 5 MB.' : 'Could not read the upload.' });
        if (typeof req.body !== 'string' || !req.body.length) return res.status(400).json({ error: 'The file is empty.' });
        next();
      });
    };

    r.get('/meta', safe((req, res) => {
      const s = readSeeded();
      const sub = subscriptionAutopay();
      res.json({ categories: CATEGORIES, kinds: KINDS, cycles: CYCLES,
        accounts: s.accounts.map(a => (a.isSubscriptionCard ? { ...a, autopayCents: sub.cents, autopaySource: 'subscriptions' } : a)),
        bills: s.recurring.map(b => ({ ...b, monthlyCents: monthlyEquivalent(b) })), variable: s.variable, profiles: BUILTIN_PROFILES.concat(s.profiles).map(({ id, name, builtin }) => ({ id, name, builtin: !!builtin })),
        rules: compileRules(s.rules).map(x => x.rule) });
    }));
    r.post('/accounts', safe((req, res) => {
      const v = validateAccount(req.body || {}, false, null);
      if (v.errors) return res.status(400).json({ error: v.errors.join('; '), errors: v.errors });
      const s = read();
      const acct = { id: newId('acct'), ...v.value, isSubscriptionCard: false, createdAt: clock().toISOString() };
      s.accounts.push(acct); write(s);
      res.status(201).json({ account: acct });
    }));
    r.patch('/accounts/:id', safe((req, res) => {
      const s = read();
      const a = s.accounts.find(x => x.id === req.params.id);
      if (!a) return res.status(404).json({ error: 'Not found' });
      const v = validateAccount(req.body || {}, true, a);
      if (v.errors) return res.status(400).json({ error: v.errors.join('; '), errors: v.errors });
      Object.assign(a, v.value); write(s);
      res.json({ account: a });
    }));
    r.delete('/accounts/:id', safe((req, res) => {
      const s = read();
      const i = s.accounts.findIndex(x => x.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Not found' });
      if (s.accounts[i].isSubscriptionCard) return res.status(409).json({ error: "The subscription card is linked to the Subscriptions page and can't be deleted." });
      const n = s.transactions.filter(t => t.accountId === req.params.id).length + s.recurring.filter(b => b.accountId === req.params.id).length;
      if (n) return res.status(409).json({ error: `This card has ${n} expenses or bills. Move or delete those first.` });
      s.accounts.splice(i, 1); write(s);
      res.json({ ok: true });
    }));
    r.post('/bills', safe((req, res) => send(res, addBill(req.body || {}))));
    r.patch('/bills/:id', safe((req, res) => send(res, updateBill(req.params.id, req.body || {}))));
    r.delete('/bills/:id', safe((req, res) => {
      const s = read();
      const i = s.recurring.findIndex(b => b.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Not found' });
      s.recurring.splice(i, 1); write(s); res.json({ ok: true });
    }));
    r.put('/variable', safe((req, res) => send(res, setVariable(req.body || {}))));
    r.get('/month', safe((req, res) => {
      const month = MONTH_RE.test(String(req.query.month || '')) ? String(req.query.month) : localMonth(clock());
      res.json(plan(month));
    }));
    r.post('/import', upload, safe((req, res) => send(res, startImport(req.body, String(req.query.accountId || ''), req.query.profileId ? String(req.query.profileId) : null))));
    r.post('/import/:id/map', safe((req, res) => send(res, mapImport(req.params.id, req.body || {}))));
    r.post('/import/:id/commit', safe((req, res) => send(res, commitImport(req.params.id))));
    r.delete('/import/:id', safe((req, res) => { previews.delete(req.params.id); res.json({ ok: true }); }));
    r.delete('/profiles/:id', safe((req, res) => {
      const s = read();
      const i = s.profiles.findIndex(p => p.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Not found' });
      s.profiles.splice(i, 1); write(s); res.json({ ok: true });
    }));
    r.get('/transactions', safe((req, res) => res.json(listTransactions(req.query))));
    r.post('/transactions', safe((req, res) => send(res, addManual(req.body || {}))));
    r.patch('/transactions/:id', safe((req, res) => send(res, setCategory(req.params.id, req.body && req.body.category, !!(req.body && req.body.always)))));
    r.delete('/transactions/:id', safe((req, res) => {
      const s = read();
      const i = s.transactions.findIndex(t => t.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Not found' });
      s.transactions.splice(i, 1); write(s); res.json({ ok: true });
    }));
    r.post('/rules', safe((req, res) => {
      const b = req.body || {};
      const pattern = typeof b.pattern === 'string' ? b.pattern.trim() : '';
      if (!pattern || pattern.length > 200) return res.status(400).json({ error: 'pattern: 1–200 characters' });
      try { new RegExp(pattern, 'i'); } catch (e) { return res.status(400).json({ error: 'That pattern is not a valid regular expression.' }); }
      if (!CATEGORY_IDS.has(b.category)) return res.status(400).json({ error: 'unknown category' });
      const priority = Number.isInteger(b.priority) ? b.priority : 500;
      const s = read();
      const rule = { id: newId('rule'), priority, pattern, category: b.category, source: 'user', createdAt: clock().toISOString() };
      s.rules.push(rule); write(s);
      res.status(201).json({ rule });
    }));
    r.delete('/rules/:id', safe((req, res) => {
      const s = read();
      const i = s.rules.findIndex(x => x.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Not found' });
      s.rules.splice(i, 1); write(s); res.json({ ok: true });
    }));
    r.get('/summary', safe((req, res) => {
      const month = MONTH_RE.test(String(req.query.month || '')) ? String(req.query.month) : localMonth(clock());
      res.json(summarize(read(), month, readSubs()));
    }));
    r.get('/export.csv', safe((req, res) => {
      const body = exportCsv(req.query);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="money-${MONTH_RE.test(String(req.query.month || '')) ? req.query.month : 'all'}.csv"`);
      res.send(body);
    }));
    r.use((req, res) => res.status(404).json({ error: 'Not found' }));
    app.use('/api/money', r);
  }

  return { mount, read, readSeeded, write, withLock, file, dir, previews, addBill, updateBill, setVariable, plan, subscriptionAutopay, ensureSubscriptionCard, validateAccount, startImport, mapImport, commitImport, addManual, setCategory, listTransactions, exportCsv };
}

module.exports = { create, gate, isAlexSession, maskDigits, parseCsv, parseAmount, parseDate, cleanDescription, merchantOf, fingerprint, compileRules,
  categorize, escapeCsvCell, detectProfile, resolveProfile, splitHeader, monthlyEquivalent, variableBudget, monthPlan, validateMapping, normalizeRows, summarize, monthTotals, addMonths,
  TAXONOMY, CATEGORIES, STARTER_RULES, BUILTIN_PROFILES };
