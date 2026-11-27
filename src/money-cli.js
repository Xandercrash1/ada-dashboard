#!/usr/bin/env node
'use strict';

/**
 * money-cli.js — add to and read the Money store from a shell on the VPS (for Ada). Same file, same validation and
 * the same lock as the dashboard's /api/money routes (src/money.js). Local shell access is already trusted; this
 * adds no network surface. It prints exactly one JSON object (the result, or { error }) and nothing else.
 * Amounts and descriptions never go into vault files, tasks, tickets or logs: print them to the caller, nowhere else.
 *
 *   node src/money-cli.js add-expense --amount 54.20 --description "Groceries" [--date 2026-11-26] [--category food/groceries]
 *                                     [--paid-with "<card/account name or id>"] [--force] --json
 *   node src/money-cli.js add-bill --name "Electric" [--amount 90] [--cycle monthly|yearly|weekly|months] [--every N]
 *                                  [--category utilities/electric] [--paid-with "<name or id>"] [--due-day 15] [--notes "…"] --json
 *   node src/money-cli.js list [--month 2026-11] --json        (the month view: same as GET /api/money/month)
 *
 * --amount on add-expense is the money spent (a positive number). --account is an older name for --paid-with.
 * Dates default to today in America/New_York. Exit code 0 on success, 1 on any error.
 * DATA_DIR overrides the data directory (tests); by default it is this checkout's data/.
 */

const path = require('path');
const money = require('./money');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['json', 'force'].includes(key)) { out[key] = true; continue; }
    if (i + 1 >= argv.length) { out[key] = ''; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const today = () => money.nyDate(new Date());

function run(argv, { dataDir } = {}) {
  const args = parseArgs(argv);
  const m = money.create({ dataDir: dataDir || process.env.DATA_DIR || path.join(__dirname, '../data'), lockWaitMs: 3000 });
  const findAccount = (store, v) => {
    if (v === undefined || v === '') return { id: null };
    const a = store.accounts.find(x => x.id === v) || store.accounts.filter(x => x.name.toLowerCase() === String(v).toLowerCase())[0];
    return a ? { id: a.id } : { error: 'unknown card/account' };
  };
  const cmd = args._[0];
  if (cmd === 'list') {
    const month = args.month || today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { code: 1, out: { error: 'month must look like 2026-11' } };
    return { code: 0, out: m.plan(month) };
  }
  if (cmd === 'add-expense' || cmd === 'add-bill') {
    m.readSeeded();   // the subscription card exists before anything can point at it
    return m.withLock(() => {
      const acct = findAccount(m.read(), args['paid-with'] !== undefined ? args['paid-with'] : args.account);
      if (acct.error) return { code: 1, out: { error: acct.error } };
      const r = cmd === 'add-expense'
        ? m.addManual({ date: args.date || today(), amount: args.amount, expense: true, description: args.description, category: args.category || null, paidWith: acct.id, force: !!args.force })
        : m.addBill({ name: args.name, amount: args.amount, cycle: args.cycle, everyMonths: args.every, category: args.category, paidWith: acct.id, dueDay: args['due-day'], notes: args.notes });
      return { code: r.status < 300 ? 0 : 1, out: r.body };
    });
  }
  return { code: 1, out: { error: 'usage: money-cli.js add-expense|add-bill|list [options] --json' } };
}

if (require.main === module) {
  let res;
  try { res = run(process.argv.slice(2)); } catch (e) { res = { code: 1, out: { error: 'money store error' } }; }   // never the message: it could quote data
  process.stdout.write(JSON.stringify(res.out) + '\n');
  process.exitCode = res.code;
}

module.exports = { run, parseArgs };
