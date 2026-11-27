/*
 * money-tab.js — the Money page (Alex only, phase 1, 2026-11-26). Talks only to /api/money.
 * Overview (month totals, categories, top merchants, 12 months, coverage, recurring from Subscriptions),
 * Transactions (search, filter, category edits that can become rules), Import (CSV: detect or map, preview, commit),
 * Add cash, and Setup (accounts, saved profiles, rules).
 * Every value from the server or a CSV goes through esc() before it reaches innerHTML.
 */
(function () {
  'use strict';
  const root = () => document.getElementById('money-root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const monthLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  const input = 'rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 py-2 text-sm';
  const btn = 'min-h-[40px] px-3 rounded-xl text-sm font-semibold';
  const primary = btn + ' bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50';
  const ghost = btn + ' bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15';
  const card = 'rounded-2xl bg-white dark:bg-gray-800/60 border border-black/5 dark:border-white/10 p-4';
  const muted = 'text-xs text-gray-500 dark:text-gray-400';

  const S = { tab: 'month', plan: null, edit: null, lastExpCat: '', lastExpAcct: '', month: thisMonth(), meta: null, summary: null, tx: null, filter: { q: '', category: '', accountId: '' },
    pendingCat: null, imp: { accountId: '', step: 'pick', data: null, map: {}, sign: 'as-is', saveAs: '' }, msg: '', err: '', busy: false };

  async function api(path, opts) {
    const o = Object.assign({}, opts);
    if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers); }
    const r = await fetch('/api/money' + path, o);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(b.error || `HTTP ${r.status}`); e.status = r.status; e.body = b; throw e; }
    return b;
  }
  const catOptions = (sel, withAll) => (withAll ? `<option value="">All categories</option>` : '') + (S.meta ? S.meta.categories : []).map((c) =>
    `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${c.parent ? '&nbsp;&nbsp;' : ''}${esc(c.id)}</option>`).join('');
  const acctOptions = (sel, label) => `<option value="">${esc(label)}</option>` + (S.meta ? S.meta.accounts : []).map((a) =>
    `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}${a.last4 ? ' ••' + esc(a.last4) : ''}</option>`).join('');

  async function load() {
    try {
      S.meta = await api('/meta');
      if (S.tab === 'month' || S.tab === 'expenses') S.plan = await api('/month?month=' + encodeURIComponent(S.month));
      if (S.tab === 'stmt') S.summary = await api('/summary?month=' + encodeURIComponent(S.month));
      if (S.tab === 'transactions') await loadTx();
      S.err = '';
    } catch (e) { S.err = e.message; }
    render();
  }
  async function loadTx() {
    const p = new URLSearchParams({ month: S.month });
    for (const k of ['q', 'category', 'accountId']) if (S.filter[k]) p.set(k, S.filter[k]);
    S.tx = await api('/transactions?' + p.toString());
  }

  // ---------- Overview ----------
  function overview() {
    const s = S.summary;
    if (!s) return `<div class="${card} text-sm">Loading…</div>`;
    const tile = (label, v, sub) => `<div class="${card}"><div class="${muted}">${esc(label)}</div><div class="text-2xl font-bold">${esc(usd(v))}</div>${sub ? `<div class="mt-1 ${muted}">${esc(sub)}</div>` : ''}</div>`;
    const cov = s.coverage.length ? `<div class="${card} border-amber-500/40 bg-amber-500/10 text-sm space-y-1"><div class="font-semibold">Coverage</div>${s.coverage.map((c) =>
      `<div>${esc(c.name)}: ${c.empty ? 'no transactions imported yet' : 'no transactions in ' + c.missing.map(monthLabel).map(esc).join(', ')}</div>`).join('')}</div>` : '';
    const rec = s.recurring.items.length ? `<div class="${card} text-sm"><div class="flex justify-between"><span class="font-semibold">Recurring (from Subscriptions)</span><span class="font-semibold">${esc(usd(s.recurring.monthlyCents))}/mo</span></div>
      <div class="mt-1 ${muted}">${s.recurring.items.map((i) => `${esc(i.name)} ${i.cents == null ? '(no price)' : esc(usd(i.cents)) + (i.cycle === 'yearly' ? '/yr' : '')}`).join(' · ')}</div>
      <div class="mt-1 ${muted}">Read-only list from the Subscriptions page; the charges themselves show up below once imported.</div></div>` : '';
    const spendCats = s.categories.filter((c) => c.category !== 'income' && c.category !== 'transfer');
    const maxSpend = Math.max(1, ...spendCats.map((c) => -c.cents));
    const cats = s.categories.length ? s.categories.map((c) => {
      const pct = c.category === 'income' || c.category === 'transfer' ? 0 : Math.max(0, Math.min(100, (-c.cents / maxSpend) * 100));
      return `<tr class="border-t border-black/5 dark:border-white/10"><td class="py-2 pr-3"><button type="button" class="font-medium hover:underline" data-act="cat" data-cat="${esc(c.category)}">${esc(c.category)}</button>
        <div class="${muted}">${c.subs.filter((x) => x.category !== c.category).map((x) => `${esc(x.category.split('/')[1])} ${esc(usd(-x.cents))}`).join(' · ')}</div></td>
        <td class="py-2 pr-3 w-1/3"><div class="h-2 rounded-full bg-black/10 dark:bg-white/10"><div class="h-2 rounded-full bg-indigo-500" style="width:${pct.toFixed(1)}%"></div></div></td>
        <td class="py-2 text-right whitespace-nowrap">${esc(usd(c.category === 'income' ? c.cents : -c.cents))}<div class="${muted}">${c.count} tx</div></td></tr>`;
    }).join('') : `<tr><td class="py-2 ${muted}">No transactions this month.</td></tr>`;
    const merch = s.topMerchants.length ? s.topMerchants.map((m) => `<tr class="border-t border-black/5 dark:border-white/10"><td class="py-1.5 pr-3">${esc(m.merchant)}</td><td class="py-1.5 pr-3 ${muted}">${m.count}×</td><td class="py-1.5 text-right">${esc(usd(m.cents))}</td></tr>`).join('') : `<tr><td class="${muted}">None yet.</td></tr>`;
    const maxM = Math.max(1, ...s.last12.map((m) => Math.max(m.income, m.spending)));
    const year = s.last12.map((m) => `<tr class="border-t border-black/5 dark:border-white/10 ${m.month === s.month ? 'font-semibold' : ''}"><td class="py-1.5 pr-3 whitespace-nowrap">${esc(monthLabel(m.month))}</td>
      <td class="py-1.5 pr-3 w-1/2"><div class="h-1.5 rounded bg-emerald-500" style="width:${(Math.max(0, m.income) / maxM * 100).toFixed(1)}%"></div><div class="mt-0.5 h-1.5 rounded bg-rose-500" style="width:${(Math.max(0, m.spending) / maxM * 100).toFixed(1)}%"></div></td>
      <td class="py-1.5 pr-3 text-right text-emerald-600 dark:text-emerald-400">${esc(usd(m.income))}</td><td class="py-1.5 pr-3 text-right text-rose-500">${esc(usd(m.spending))}</td><td class="py-1.5 text-right">${esc(usd(m.net))}</td></tr>`).join('');
    return `<div class="space-y-4">
      <div class="grid gap-3 sm:grid-cols-3">${tile('Income', s.income)}${tile('Spending', s.spending, 'Transfers and card payments left out')}${tile('Net', s.net, s.count + ' transactions')}</div>
      ${cov}${rec}
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="${card} overflow-x-auto"><div class="font-semibold mb-2">By category</div><table class="w-full text-sm">${cats}</table></div>
        <div class="${card} overflow-x-auto"><div class="font-semibold mb-2">Top merchants</div><table class="w-full text-sm">${merch}</table></div>
      </div>
      <div class="${card} overflow-x-auto"><div class="font-semibold mb-2">Income vs spending, last 12 months</div>
        <table class="w-full text-sm"><thead><tr class="${muted}"><th class="text-left font-medium">Month</th><th></th><th class="text-right font-medium">In</th><th class="text-right font-medium">Out</th><th class="text-right font-medium">Net</th></tr></thead><tbody>${year}</tbody></table></div>
    </div>`;
  }

  // ---------- Transactions ----------
  function transactions() {
    const f = S.filter;
    const head = `<div class="flex flex-wrap gap-2 items-center">
      <input id="money-q" class="${input} flex-1 min-w-[10rem]" placeholder="Search description or merchant" value="${esc(f.q)}">
      <select id="money-cat" class="${input}">${catOptions(f.category, true)}</select>
      <select id="money-acct" class="${input}">${acctOptions(f.accountId, 'All accounts')}</select>
      <button type="button" class="${ghost}" data-act="search">Search</button></div>`;
    if (!S.tx) return head + `<div class="${card} mt-3 text-sm">Loading…</div>`;
    const accts = new Map((S.meta.accounts || []).map((a) => [a.id, a.name]));
    const rows = S.tx.transactions.map((t) => {
      const pend = S.pendingCat && S.pendingCat.id === t.id ? `<div class="mt-1 flex flex-wrap gap-1">
        <button type="button" class="text-xs rounded-lg px-2 py-1 bg-indigo-600 text-white" data-act="cat-one" data-id="${esc(t.id)}">Just this one</button>
        <button type="button" class="text-xs rounded-lg px-2 py-1 bg-indigo-600/80 text-white" data-act="cat-always" data-id="${esc(t.id)}">Always for ${esc(t.merchant)}</button>
        <button type="button" class="text-xs rounded-lg px-2 py-1 bg-black/10 dark:bg-white/10" data-act="cat-cancel">Cancel</button></div>` : '';
      return `<tr class="border-t border-black/5 dark:border-white/10 align-top"><td class="py-2 pr-3 whitespace-nowrap">${esc(t.date)}</td>
        <td class="py-2 pr-3"><div>${esc(t.description)}</div><div class="${muted}">${esc(t.merchant)} · ${esc(accts.get(t.accountId) || '')}${t.source === 'manual' ? ' · cash/manual' : ''}</div></td>
        <td class="py-2 pr-3"><select class="${input} py-1 text-xs" data-act="setcat" data-id="${esc(t.id)}">${catOptions(S.pendingCat && S.pendingCat.id === t.id ? S.pendingCat.category : t.category)}</select>
          <div class="${muted}">${esc(t.categorySource)}</div>${pend}</td>
        <td class="py-2 pr-3 text-right whitespace-nowrap ${t.cents < 0 ? '' : 'text-emerald-600 dark:text-emerald-400'}">${esc(usd(t.cents))}</td>
        <td class="py-2"><button type="button" class="text-xs text-rose-500 hover:underline" data-act="deltx" data-id="${esc(t.id)}">Delete</button></td></tr>`;
    }).join('');
    return head + `<div class="${card} mt-3 overflow-x-auto"><div class="${muted} mb-2">${S.tx.total} transactions in ${esc(monthLabel(S.month))}${S.tx.total > S.tx.transactions.length ? ', showing ' + S.tx.transactions.length : ''}</div>
      <table class="w-full text-sm">${rows || `<tr><td class="${muted}">Nothing matches.</td></tr>`}</table></div>`;
  }

  // ---------- Import ----------
  function importView() {
    const I = S.imp;
    if (!S.meta.accounts.length) return `<div class="${card} text-sm">Add a card under Cards &amp; budgets first.</div>`;
    let body = `<div class="${card} space-y-3"><div class="flex flex-wrap gap-2 items-center">
      <select id="money-imp-acct" class="${input}">${acctOptions(I.accountId, 'Choose account…')}</select>
      <input id="money-file" type="file" accept=".csv,text/csv" class="text-sm">
      <button type="button" class="${primary}" data-act="upload" ${S.busy ? 'disabled' : ''}>Upload</button></div>
      <div class="${muted}">CSV only, up to 5 MB. The file is read in memory and never saved; card and account numbers are cut to the last 4 digits.</div></div>`;
    const d = I.data;
    if (d && I.step === 'map') {
      const sel = (field, label, optional) => `<label class="block text-sm"><span class="${muted}">${esc(label)}</span><select class="${input} w-full" data-map="${field}">
        <option value="">${optional ? '(none)' : 'Choose…'}</option>${d.headers.map((h) => `<option value="${esc(h)}" ${I.map[field] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
      const sample = `<div class="overflow-x-auto"><table class="text-xs w-full"><tr>${d.headers.map((h) => `<th class="text-left pr-2 font-semibold">${esc(h)}</th>`).join('')}</tr>${d.sample.map((r) =>
        `<tr>${d.headers.map((_, i) => `<td class="pr-2 py-0.5 whitespace-nowrap">${esc(r[i])}</td>`).join('')}</tr>`).join('')}</table></div>`;
      body += `<div class="${card} space-y-3"><div class="font-semibold">Map the columns (${d.rowCount} rows)</div>${sample}
        <div class="grid gap-2 sm:grid-cols-3">${sel('date', 'Date')}${sel('description', 'Description')}${sel('category', 'Category (optional)', true)}</div>
        <div class="flex flex-wrap gap-3 text-sm">${[['as-is', 'One amount column, negative = money out'], ['invert', 'One amount column, positive = charge (most credit cards)'], ['split', 'Separate debit and credit columns']].map(([v, l]) =>
          `<label class="flex items-center gap-1"><input type="radio" name="money-sign" value="${v}" ${I.sign === v ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
        <div class="grid gap-2 sm:grid-cols-3">${I.sign === 'split' ? sel('debit', 'Debit (money out)', true) + sel('credit', 'Credit (money in)', true) : sel('amount', 'Amount')}</div>
        <label class="block text-sm"><span class="${muted}">Save as a profile (optional, so this bank is detected next time)</span><input id="money-saveas" class="${input} w-full" value="${esc(I.saveAs)}" placeholder="e.g. Credit union checking"></label>
        <button type="button" class="${primary}" data-act="map" ${S.busy ? 'disabled' : ''}>Preview</button></div>`;
    }
    if (d && I.step === 'preview') {
      const c = d.counts;
      const rows = d.rows.slice(0, 300).map((r) => `<tr class="border-t border-black/5 dark:border-white/10 ${r.duplicate || r.error ? 'opacity-50' : ''}">
        <td class="py-1 pr-2 whitespace-nowrap">${esc(r.date || '')}</td><td class="py-1 pr-2">${esc(r.description)}</td><td class="py-1 pr-2">${esc(r.category || '')}</td>
        <td class="py-1 pr-2 text-right whitespace-nowrap">${r.cents == null ? '' : esc(usd(r.cents))}</td>
        <td class="py-1 text-xs">${r.error ? `<span class="text-rose-500">${esc(r.error)}</span>` : r.duplicate ? '<span class="text-amber-500">duplicate</span>' : '<span class="text-emerald-500">new</span>'}</td></tr>`).join('');
      body += `<div class="${card} space-y-3"><div class="font-semibold">Preview: ${esc(d.profile.name)}</div>
        <div class="text-sm">${c.ok} new · ${c.duplicates} duplicates (skipped) · ${c.errors} unreadable (skipped). Check that charges show as negative.</div>
        <div class="overflow-x-auto max-h-[28rem]"><table class="w-full text-sm">${rows}</table></div>${d.rows.length > 300 ? `<div class="${muted}">First 300 of ${d.rows.length} shown.</div>` : ''}
        <div class="flex gap-2"><button type="button" class="${primary}" data-act="commit" ${S.busy || !c.ok ? 'disabled' : ''}>Import ${c.ok} transactions</button>
        <button type="button" class="${ghost}" data-act="remap">Change mapping</button><button type="button" class="${ghost}" data-act="imp-cancel">Cancel</button></div></div>`;
    }
    return `<div class="space-y-4">${body}</div>`;
  }

  // ---------- Month (the main view) ----------
  const srcLabel = (v) => (v.source === 'avg' ? `avg of ${v.months} mo` : v.source === 'estimate' ? 'estimate' : 'no estimate yet');
  const catLabel = (id) => (id === 'subscriptions' ? 'subscriptions (from Subscriptions page)' : id);
  const tr = 'border-t border-black/5 dark:border-white/10';
  function monthView() {
    const p = S.plan;
    if (!p) return `<div class="${card} text-sm">Loading…</div>`;
    const sp = p.spending, co = p.cashOut;
    const totals = `<div class="grid gap-3 sm:grid-cols-3">
      <div class="${card}"><div class="${muted}">Spending, expected per month</div><div class="text-2xl font-bold">${esc(usd(sp.expectedCents))}</div>
        <div class="mt-1 ${muted}">bills ${esc(usd(sp.billsCents))} + subscriptions ${esc(usd(sp.subscriptionsCents))} + variable ${esc(usd(sp.variableCents))}</div></div>
      <div class="${card}"><div class="${muted}">Spending, ${esc(monthLabel(p.month))} so far</div><div class="text-2xl font-bold">${esc(usd(sp.soFarCents))}</div>
        <div class="mt-1 ${muted}">bills and subscriptions ${esc(usd(sp.recurringCents))} + logged ${esc(usd(sp.loggedCents))}</div></div>
      <div class="${card}"><div class="${muted}">Cash out (leaving the bank)</div><div class="text-2xl font-bold">${esc(usd(co.cents))}</div>
        <div class="mt-1 ${muted}">card payments + what checking, savings and cash pay directly</div></div></div>`;
    const need = p.priceNeeded.length ? `<div class="${card} border-amber-500/40 bg-amber-500/10 text-sm"><div class="font-semibold">Price needed</div>
      <div class="mt-1">${p.priceNeeded.map((x) => `${esc(x.name)}${x.source === 'subscriptions' ? ' <span class="' + muted + '">(Subscriptions page)</span>' : ''}`).join(' · ')}</div></div>` : '';
    const tone = { short: 'border-rose-500/40 bg-rose-500/10', covers: '', over: '', 'no-autopay': 'border-amber-500/40 bg-amber-500/10' };
    const payoffText = (o) => {
      if (!o) return '';
      if (o.paidOff) return `<div>Probably paid off by now (estimated from the balance entered ${esc(o.elapsedMonths)} months ago).</div>`;
      const today = o.estimatedToday ? `Estimated today: about ${esc(usd(o.projectedBalanceCents))} left after ${esc(o.elapsedMonths)} months. ` : '';
      if (o.never) return `<div class="text-rose-500">${today}Never pays off at this rate (${esc(o.reason)})${o.monthlyInterestCents ? `: interest is ${esc(usd(o.monthlyInterestCents))} a month` : ''}.</div>`;
      return `<div>${today}Rough payoff: ${esc(o.months)} months (${esc(monthLabel(o.payoffMonth))})${o.withInterest ? `, about ${esc(usd(o.interestCents))} interest` : ''}, ${esc(o.label)}.</div>`;
    };
    const checks = p.cardChecks.map((c) => `<div class="${card} ${tone[c.status] || ''} text-sm space-y-1">
      <div class="flex flex-wrap justify-between gap-2"><span class="font-semibold">${esc(c.name)}${c.last4 ? ' ••' + esc(c.last4) : ''}</span>
        <span>${c.autopayCents == null ? 'no autopay set' : 'autopay ' + esc(usd(c.autopayCents))}${c.dueDay ? ' · due day ' + esc(c.dueDay) : ''}</span></div>
      ${c.isSubscriptionCard ? `<div class="${muted}">Linked to the Subscriptions page: target ${esc(usd(c.targetCents))}, set ${esc(usd(c.autopayCents))}${c.targetGapCents ? ` <span class="text-amber-600">(gap ${esc(usd(c.targetGapCents))})</span>` : ''}. Updates when you check off its autopay task.</div>` : ''}
      <div>Charges ${esc(usd(c.chargesCents))}/mo (bills and subscriptions ${esc(usd(c.recurringChargesCents))}, expenses ${esc(usd(c.expenseChargesCents))} ${c.expenseBasis === 'avg' ? 'avg of ' + esc(c.expenseMonths) + ' mo' : 'so far this month'})${c.isSubscriptionCard ? ` · ${esc(usd(c.paydownReservedCents))} paying down the old balance · ${esc(usd(c.bufferCents))} buffer` : ''}</div>
      <div class="font-medium ${c.status === 'short' ? 'text-rose-600 dark:text-rose-400' : c.status === 'no-autopay' ? 'text-amber-600' : 'text-emerald-600 dark:text-emerald-400'}">${esc(c.message)}</div>
      ${c.balanceCents ? `<div class="${muted}">Balance ${esc(usd(c.balanceCents))}${c.balanceAsOf ? ' as of ' + esc(c.balanceAsOf) : ''}${c.apr != null ? ' at ' + esc(c.apr) + '% APR' : ''}</div>${payoffText(c.payoff)}` : ''}</div>`).join('');
    const payers = co.byPayer.map((x) => `<tr class="${tr}"><td class="py-1.5 pr-3">${esc(x.name)}${x.unset ? ` <span class="${muted}">(set a payer)</span>` : ''}</td>
      <td class="py-1.5 pr-3 ${muted}">${x.kind === 'credit card' ? (x.autopayMissing ? 'card payment not set' : 'card payment') : 'paid directly'}</td><td class="py-1.5 text-right">${esc(usd(x.cents))}</td></tr>`).join('');
    const cats = p.byCategory.map((c) => `<tr class="${tr}"><td class="py-2 pr-3">${esc(c.category)}</td><td class="py-2 pr-3 text-right">${c.billsCents + c.subscriptionsCents ? esc(usd(c.billsCents + c.subscriptionsCents)) : ''}</td>
      <td class="py-2 pr-3 text-right whitespace-nowrap">${c.budgetCents == null ? '' : esc(usd(c.budgetCents)) + `<div class="${muted}">${esc(c.budgetSource === 'avg' ? 'avg' : c.budgetSource === 'estimate' ? 'estimate' : 'no estimate')}</div>`}</td>
      <td class="py-2 pr-3 text-right">${c.loggedCents ? esc(usd(c.loggedCents)) : ''}</td><td class="py-2 text-right font-medium">${esc(usd(c.expectedCents))}</td></tr>`).join('');
    const vars = p.variable.length ? p.variable.map((v) => { const pct = v.cents ? Math.min(100, v.actualCents / v.cents * 100) : 0;
      return `<tr class="${tr}"><td class="py-2 pr-3">${esc(v.category)}</td><td class="py-2 pr-3 w-1/3"><div class="h-2 rounded-full bg-black/10 dark:bg-white/10"><div class="h-2 rounded-full ${v.cents && v.actualCents > v.cents ? 'bg-rose-500' : 'bg-indigo-500'}" style="width:${pct.toFixed(1)}%"></div></div></td>
        <td class="py-2 pr-3 text-right whitespace-nowrap">${esc(usd(v.actualCents))} / ${esc(usd(v.cents))}</td><td class="py-2 ${muted}">${esc(srcLabel(v))}</td></tr>`; }).join('') : `<tr><td class="${muted}">No variable categories yet (Cards & budgets).</td></tr>`;
    const th = (l, r) => `<th class="pb-2 ${r ? 'text-right' : 'text-left'} font-medium">${l}</th>`;
    return `<div class="space-y-4">${totals}${need}
      <div class="space-y-2"><div class="font-semibold">Each card: charges vs payment</div>${checks || `<div class="${card} ${muted}">No credit cards yet.</div>`}</div>
      <div class="${card} overflow-x-auto"><div class="font-semibold mb-2">Cash out by payer</div><table class="w-full text-sm">${payers}</table></div>
      <div class="${card} overflow-x-auto"><div class="font-semibold mb-2">Variable spending this month</div><table class="w-full text-sm">${vars}</table></div>
      <div class="${card} overflow-x-auto"><div class="font-semibold mb-2">Spending by category</div><table class="w-full text-sm"><thead><tr class="${muted}">${th('Category')}${th('Bills + subs', 1)}${th('Budget', 1)}${th('Logged', 1)}${th('Expected', 1)}</tr></thead><tbody>${cats || `<tr><td class="${muted}">Nothing yet.</td></tr>`}</tbody></table></div>
    </div>`;
  }

  // ---------- Bills ----------
  const cycleText = (b) => (b.cycle === 'months' ? `every ${b.everyMonths} months` : b.cycle);
  function billsView() {
    const m = S.meta, e = S.edit && S.edit.kind === 'bill' ? S.edit.item : null;
    const accts = new Map(m.accounts.map((a) => [a.id, a.name]));
    const rows = m.bills.map((b) => `<tr class="${tr} align-top"><td class="py-2 pr-3"><div class="font-medium">${esc(b.name)}</div>${b.notes ? `<div class="${muted}">${esc(b.notes)}</div>` : ''}</td>
      <td class="py-2 pr-3 whitespace-nowrap">${b.cents == null ? '<span class="text-xs font-semibold rounded-full px-2 py-0.5 bg-amber-500/15 text-amber-600">price needed</span>' : esc(usd(b.cents)) + ' ' + esc(cycleText(b))}</td>
      <td class="py-2 pr-3 text-right whitespace-nowrap">${b.monthlyCents == null ? '' : esc(usd(b.monthlyCents)) + '/mo'}</td><td class="py-2 pr-3">${esc(b.category)}</td>
      <td class="py-2 pr-3">${esc(accts.get(b.accountId) || '')}${b.dueDay ? `<div class="${muted}">due day ${esc(b.dueDay)}</div>` : ''}</td>
      <td class="py-2 whitespace-nowrap"><button type="button" class="text-xs hover:underline mr-2" data-act="editbill" data-id="${esc(b.id)}">Edit</button><button type="button" class="text-xs text-rose-500 hover:underline" data-act="delbill" data-id="${esc(b.id)}">Delete</button></td></tr>`).join('');
    const f = e || { name: '', cents: null, cycle: 'monthly', everyMonths: 3, category: 'other', accountId: '', dueDay: '', notes: '' };
    const form = `<div class="${card} space-y-2"><div class="font-semibold">${e ? 'Edit bill' : 'Add a recurring bill'}</div>
      <div class="grid gap-2 sm:grid-cols-3"><input id="bill-name" class="${input}" placeholder="Name" maxlength="80" value="${esc(f.name)}">
        <input id="bill-amt" class="${input}" placeholder="Amount (blank = price needed)" inputmode="decimal" value="${f.cents == null ? '' : esc((f.cents / 100).toFixed(2))}">
        <div class="flex gap-2"><select id="bill-cycle" class="${input} flex-1">${m.cycles.map((c) => `<option value="${esc(c)}" ${f.cycle === c ? 'selected' : ''}>${c === 'months' ? 'every N months' : esc(c)}</option>`).join('')}</select>
        <input id="bill-every" class="${input} w-16" placeholder="N" inputmode="numeric" value="${esc(f.everyMonths || '')}" title="N for every N months"></div>
        <select id="bill-cat" class="${input}">${catOptions(f.category)}</select><select id="bill-acct" class="${input}">${acctOptions(f.paidWith || f.accountId || '', 'Paid with… (optional)')}</select>
        <input id="bill-due" class="${input}" placeholder="Due day (optional)" inputmode="numeric" value="${esc(f.dueDay || '')}"></div>
      <input id="bill-notes" class="${input} w-full" placeholder="Notes (optional)" maxlength="500" value="${esc(f.notes || '')}">
      <div class="flex gap-2"><button type="button" class="${primary}" data-act="${e ? 'savebill' : 'addbill'}" ${e ? `data-id="${esc(e.id)}"` : ''}>${e ? 'Save' : 'Add bill'}</button>${e ? `<button type="button" class="${ghost}" data-act="cancel-edit">Cancel</button>` : ''}</div></div>`;
    const total = m.bills.reduce((a, b) => a + (b.monthlyCents || 0), 0);
    return `<div class="space-y-4">${form}<div class="${card} overflow-x-auto"><div class="${muted} mb-2">${m.bills.length} bills · ${esc(usd(total))}/mo (Subscriptions-page items are added on the Month view)</div>
      <table class="w-full text-sm">${rows || `<tr><td class="${muted}">No bills yet.</td></tr>`}</table></div></div>`;
  }

  // ---------- Expenses (one-offs) ----------
  function expensesView() {
    const m = S.meta, p = S.plan;
    const accts = new Map(m.accounts.map((a) => [a.id, a.name]));
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const form = `<div class="${card} space-y-2"><div class="font-semibold">Log an expense</div><div class="${muted}">One at a time: a grocery trip, gas, eating out…</div>
      <div class="grid gap-2 sm:grid-cols-3"><input id="exp-date" type="date" class="${input}" value="${esc(today)}">
        <input id="exp-amt" class="${input}" placeholder="Amount spent, e.g. 54.20" inputmode="decimal">
        <input id="exp-desc" class="${input}" placeholder="What was it?" maxlength="200">
        <select id="exp-cat" class="${input}"><option value="">Category: use the rules</option>${catOptions(S.lastExpCat || '')}</select>
        <select id="exp-acct" class="${input}">${acctOptions(S.lastExpAcct || '', 'Paid with… (optional)')}</select>
        <button type="button" class="${primary}" data-act="addexp">Add</button></div></div>`;
    const rows = p ? p.oneOffs.slice().reverse().map((t) => `<tr class="${tr}"><td class="py-2 pr-3 whitespace-nowrap">${esc(t.date)}</td><td class="py-2 pr-3">${esc(t.description)}</td>
      <td class="py-2 pr-3">${esc(t.category)}</td><td class="py-2 pr-3">${esc(accts.get(t.accountId) || '')}</td><td class="py-2 pr-3 text-right whitespace-nowrap">${esc(usd(-t.cents))}</td>
      <td class="py-2"><button type="button" class="text-xs text-rose-500 hover:underline" data-act="deltx" data-id="${esc(t.id)}">Delete</button></td></tr>`).join('') : '';
    return `<div class="space-y-4">${form}<div class="${card} overflow-x-auto"><div class="${muted} mb-2">${esc(monthLabel(S.month))}: ${p ? esc(usd(p.loggedCents)) : ''} logged</div>
      <table class="w-full text-sm">${rows || `<tr><td class="${muted}">Nothing logged this month.</td></tr>`}</table></div></div>`;
  }

  // ---------- Cards & budgets ----------
  function cardsView() {
    const m = S.meta, e = S.edit && S.edit.kind === 'card' ? S.edit.item : null;
    const rows = m.accounts.map((a) => `<tr class="${tr} align-top"><td class="py-2 pr-3"><div class="font-medium">${esc(a.name)}${a.last4 ? ' ••' + esc(a.last4) : ''}</div><div class="${muted}">${esc(a.kind)}</div></td>
      <td class="py-2 pr-3 whitespace-nowrap">${a.isSubscriptionCard ? `set ${esc(usd(a.autopayCents))} · target ${esc(usd(a.targetCents))} <span class="text-xs font-semibold rounded-full px-2 py-0.5 bg-indigo-500/15 text-indigo-500">linked: Subscriptions</span>` : a.autopayCents == null ? `<span class="${muted}">no autopay set</span>` : esc(usd(a.autopayCents))}</td>
      <td class="py-2 pr-3">${a.dueDay ? 'due day ' + esc(a.dueDay) : ''}${a.balanceCents != null ? `<div class="${muted}">balance ${esc(usd(a.balanceCents))}${a.balanceAsOf ? ' (' + esc(a.balanceAsOf) + ')' : ''}${a.apr != null ? ' · ' + esc(a.apr) + '% APR' : ''}</div>` : ''}</td>
      <td class="py-2 whitespace-nowrap"><button type="button" class="text-xs hover:underline mr-2" data-act="editcard" data-id="${esc(a.id)}">Edit</button>${a.isSubscriptionCard ? '' : `<button type="button" class="text-xs text-rose-500 hover:underline" data-act="delacct" data-id="${esc(a.id)}">Delete</button>`}</td></tr>`).join('');
    const f = e || { name: '', kind: 'credit card', last4: '', autopayCents: null, dueDay: '' };
    const sub = !!(e && e.isSubscriptionCard);
    const form = `<div class="${card} space-y-2"><div class="font-semibold">${e ? 'Edit card' : 'Add a card or account'}</div>
      <div class="grid gap-2 sm:grid-cols-3"><input id="acct-name" class="${input}" placeholder="Name" maxlength="60" value="${esc(f.name)}">
        <select id="acct-kind" class="${input}" ${sub ? 'disabled' : ''}>${m.kinds.map((k) => `<option value="${esc(k)}" ${f.kind === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
        <input id="acct-last4" class="${input}" placeholder="Last 4 (optional)" maxlength="4" inputmode="numeric" value="${esc(f.last4 || '')}">
        ${sub ? `<div class="${input} ${muted}">Autopay set ${esc(usd(f.autopayCents))} (target ${esc(usd(f.targetCents))}): changes when you check off its Subscriptions task</div>` : `<input id="acct-autopay" class="${input}" placeholder="Monthly autopay (optional)" inputmode="decimal" value="${f.autopayCents == null ? '' : esc((f.autopayCents / 100).toFixed(2))}">`}
        <input id="acct-due" class="${input}" placeholder="Due day (optional)" inputmode="numeric" value="${esc(f.dueDay || '')}">
        <input id="acct-balance" class="${input}" placeholder="Balance owed (optional)" inputmode="decimal" value="${f.balanceCents == null ? '' : esc((f.balanceCents / 100).toFixed(2))}">
        <input id="acct-apr" class="${input}" placeholder="APR % (optional)" inputmode="decimal" value="${f.apr == null ? '' : esc(f.apr)}"></div>
      <div class="flex gap-2"><button type="button" class="${primary}" data-act="${e ? 'savecard' : 'addacct'}" ${e ? `data-id="${esc(e.id)}"` : ''}>${e ? 'Save' : 'Add'}</button>${e ? `<button type="button" class="${ghost}" data-act="cancel-edit">Cancel</button>` : ''}</div></div>`;
    const vars = m.variable.map((v) => `<tr class="${tr}"><td class="py-2 pr-3">${esc(v.category)}</td><td class="py-2 pr-3">${v.estimateCents == null ? `<span class="${muted}">no estimate</span>` : esc(usd(v.estimateCents)) + '/mo'}</td>
      <td class="py-2"><button type="button" class="text-xs text-rose-500 hover:underline" data-act="unvar" data-cat="${esc(v.category)}">Remove</button></td></tr>`).join('');
    return `<div class="space-y-4">${form}<div class="${card} overflow-x-auto"><table class="w-full text-sm">${rows}</table></div>
      <div class="${card} space-y-2"><div class="font-semibold">Variable categories</div>
        <div class="${muted}">Groceries, gas, eating out… The budget is the average of what you logged over the last 3 full months once a full month has entries; until then, your estimate.</div>
        <table class="w-full text-sm">${vars || `<tr><td class="${muted}">None yet.</td></tr>`}</table>
        <div class="flex flex-wrap gap-2"><select id="var-cat" class="${input}">${catOptions('food/groceries')}</select><input id="var-est" class="${input} w-40" placeholder="Monthly estimate" inputmode="decimal">
        <button type="button" class="${primary}" data-act="setvar">Save</button></div></div></div>`;
  }

  // ---------- Statement import (coming later): rules and profiles ----------
  function rulesView() {
    const m = S.meta;
    const profs = m.profiles.map((p) => `<tr class="${tr}"><td class="py-1.5 pr-3">${esc(p.name)}</td><td class="py-1.5">${p.builtin ? `<span class="${muted}">built in</span>` : `<button type="button" class="text-xs text-rose-500 hover:underline" data-act="delprof" data-id="${esc(p.id)}">Delete</button>`}</td></tr>`).join('');
    const rules = m.rules.map((r) => `<tr class="${tr}"><td class="py-1.5 pr-3 ${muted}">${esc(r.priority)}</td><td class="py-1.5 pr-3 font-mono text-xs break-all">${esc(r.pattern)}</td><td class="py-1.5 pr-3">${esc(r.category)}</td>
      <td class="py-1.5"><button type="button" class="text-xs text-rose-500 hover:underline" data-act="delrule" data-id="${esc(r.id)}">Delete</button></td></tr>`).join('');
    return `<div class="grid gap-4 lg:grid-cols-2">
      <div class="${card} space-y-3"><div class="font-semibold">CSV profiles</div><table class="w-full text-sm">${profs}</table></div>
      <div class="${card} space-y-3 lg:col-span-2"><div class="font-semibold">Category rules</div><div class="${muted}">Also used for expenses logged without a category. First match wins, lowest number first.</div>
        <div class="overflow-x-auto max-h-[24rem]"><table class="w-full text-sm">${rules}</table></div>
        <div class="flex flex-wrap gap-2"><input id="rule-pat" class="${input} flex-1" placeholder="Pattern, e.g. blue\\s*bottle" maxlength="200">
        <select id="rule-cat" class="${input}">${catOptions('')}</select><input id="rule-pri" class="${input} w-24" placeholder="500" inputmode="numeric">
        <button type="button" class="${primary}" data-act="addrule">Add rule</button></div></div></div>`;
  }

  const MAIN_TABS = [['month', 'Month'], ['bills', 'Bills'], ['expenses', 'Expenses'], ['cards', 'Cards & budgets']];
  const STMT_TABS = [['stmt', 'Statement overview'], ['transactions', 'Transactions'], ['import', 'Import a CSV'], ['rules', 'Rules & profiles']];
  function render() {
    const el = root();
    if (!el) return;
    const tabBtn = ([k, l]) => `<button type="button" class="${btn} ${S.tab === k ? 'bg-indigo-600 text-white' : 'bg-black/5 dark:bg-white/10'}" data-tab="${k}">${l}</button>`;
    const inStmt = STMT_TABS.some(([k]) => k === S.tab);
    const views = { month: monthView, bills: billsView, expenses: expensesView, cards: cardsView, stmt: overview, transactions, import: importView, rules: rulesView };
    let main = '';
    if (!S.meta) main = `<div class="${card} text-sm">${S.err ? esc(S.err) : 'Loading…'}</div>`;
    else main = (views[S.tab] || monthView)();
    el.innerHTML = `<div class="max-w-6xl mx-auto space-y-4">
      <div class="flex flex-wrap items-center gap-3"><h2 class="text-xl font-bold mr-auto">Money</h2>
        <input id="money-month" type="month" class="${input}" value="${esc(S.month)}">
        <a class="${ghost} inline-flex items-center" href="/api/money/export.csv?month=${encodeURIComponent(S.month)}">Export CSV</a></div>
      <div class="flex flex-wrap gap-2">${MAIN_TABS.map(tabBtn).join('')}</div>
      ${S.msg ? `<div class="rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-3 py-2 text-sm">${esc(S.msg)}</div>` : ''}
      ${S.err && S.meta ? `<div class="rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-300 px-3 py-2 text-sm">${esc(S.err)}</div>` : ''}
      ${inStmt ? '' : main}
      <details id="money-stmt" class="${card}" ${inStmt ? 'open' : ''}><summary class="cursor-pointer font-semibold">Statement import (coming later)</summary>
        <div class="mt-3 space-y-3"><div class="${muted}">On hold: expenses are entered by hand for now. This part is built and tested but not in use yet.</div>
        <div class="flex flex-wrap gap-2">${STMT_TABS.map(tabBtn).join('')}</div>${inStmt ? main : ''}</div></details></div>`;
  }

  const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
  async function run(fn) {
    S.busy = true; S.err = ''; S.msg = ''; render();
    try { await fn(); } catch (e) { S.err = e.message; }
    S.busy = false;
    await load();
  }

  async function onClick(ev) {
    const t = ev.target.closest('[data-tab],[data-act]');
    if (!t || !root().contains(t)) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.msg = ''; S.err = ''; S.pendingCat = null; S.edit = null; return load(); }
    const id = t.dataset.id, act = t.dataset.act;
    if (act === 'cat') { S.tab = 'transactions'; S.filter.category = t.dataset.cat; return load(); }
    if (act === 'search') { S.filter = { q: val('money-q'), category: val('money-cat'), accountId: val('money-acct') }; return load(); }
    if (act === 'cat-cancel') { S.pendingCat = null; return render(); }
    if (act === 'cat-one' || act === 'cat-always') {
      const p = S.pendingCat; S.pendingCat = null;
      return run(async () => { const r = await api('/transactions/' + encodeURIComponent(id), { method: 'PATCH', body: { category: p.category, always: act === 'cat-always' } });
        S.msg = r.rule ? `Category saved, and a rule added${r.recategorized ? `; ${r.recategorized} other transactions moved` : ''}.` : 'Category saved.'; });
    }
    if (act === 'deltx') { if (!confirm('Delete this transaction?')) return; return run(() => api('/transactions/' + encodeURIComponent(id), { method: 'DELETE' })); }
    if (act === 'delacct') { if (!confirm('Delete this account?')) return; return run(() => api('/accounts/' + encodeURIComponent(id), { method: 'DELETE' })); }
    if (act === 'delprof') { if (!confirm('Delete this profile?')) return; return run(() => api('/profiles/' + encodeURIComponent(id), { method: 'DELETE' })); }
    if (act === 'delrule') { if (!confirm('Delete this rule?')) return; return run(() => api('/rules/' + encodeURIComponent(id), { method: 'DELETE' })); }
    const cardBody = () => { const b = { name: val('acct-name'), kind: val('acct-kind'), last4: val('acct-last4') || null, dueDay: val('acct-due') || null, balance: val('acct-balance') || null, apr: val('acct-apr') || null };
      if (document.getElementById('acct-autopay')) b.autopay = val('acct-autopay') || null; return b; };
    if (act === 'addacct') return run(async () => { await api('/accounts', { method: 'POST', body: cardBody() }); S.msg = 'Card added.'; });
    if (act === 'editcard') { S.edit = { kind: 'card', item: S.meta.accounts.find((a) => a.id === id) }; return render(); }
    if (act === 'savecard') return run(async () => { const b = cardBody(); if (S.edit && S.edit.item.isSubscriptionCard) delete b.kind; await api('/accounts/' + encodeURIComponent(id), { method: 'PATCH', body: b }); S.edit = null; S.msg = 'Card saved.'; });
    if (act === 'cancel-edit') { S.edit = null; return render(); }
    const billBody = () => ({ name: val('bill-name'), amount: val('bill-amt') || null, cycle: val('bill-cycle'), everyMonths: val('bill-cycle') === 'months' ? parseInt(val('bill-every'), 10) : undefined,
      category: val('bill-cat'), paidWith: val('bill-acct') || null, dueDay: val('bill-due') || null, notes: val('bill-notes') });
    if (act === 'addbill') return run(async () => { await api('/bills', { method: 'POST', body: billBody() }); S.msg = 'Bill added.'; });
    if (act === 'editbill') { S.edit = { kind: 'bill', item: S.meta.bills.find((b) => b.id === id) }; return render(); }
    if (act === 'savebill') return run(async () => { await api('/bills/' + encodeURIComponent(id), { method: 'PATCH', body: billBody() }); S.edit = null; S.msg = 'Bill saved.'; });
    if (act === 'delbill') { if (!confirm('Delete this bill?')) return; return run(() => api('/bills/' + encodeURIComponent(id), { method: 'DELETE' })); }
    if (act === 'setvar') return run(async () => { await api('/variable', { method: 'PUT', body: { category: val('var-cat'), variable: true, estimate: val('var-est') || null } }); S.msg = 'Variable category saved.'; });
    if (act === 'unvar') return run(() => api('/variable', { method: 'PUT', body: { category: t.dataset.cat, variable: false } }));
    if (act === 'addrule') return run(async () => { const p = parseInt(val('rule-pri'), 10); await api('/rules', { method: 'POST', body: { pattern: val('rule-pat'), category: val('rule-cat'), priority: Number.isInteger(p) ? p : undefined } }); S.msg = 'Rule added (applies to new imports).'; });
    if (act === 'addexp') {
      const body = { paidWith: val('exp-acct') || null, date: val('exp-date'), description: val('exp-desc'), amount: val('exp-amt'), expense: true, category: val('exp-cat') || null };
      S.lastExpCat = body.category || ''; S.lastExpAcct = body.accountId || '';
      return run(async () => {
        try { await api('/transactions', { method: 'POST', body }); }
        catch (e) { if (e.status === 409 && confirm(e.message)) await api('/transactions', { method: 'POST', body: Object.assign(body, { force: true }) }); else throw e; }
        S.msg = 'Added.';
      });
    }
    if (act === 'upload') {
      const f = document.getElementById('money-file').files[0];
      S.imp.accountId = val('money-imp-acct');
      if (!S.imp.accountId) { S.err = 'Choose an account.'; return render(); }
      if (!f) { S.err = 'Choose a CSV file.'; return render(); }
      if (!/\.csv$/i.test(f.name)) { S.err = 'Only .csv files can be imported.'; return render(); }
      if (f.size > 5 * 1024 * 1024) { S.err = 'That file is larger than 5 MB.'; return render(); }
      return run(async () => {
        const text = await f.text();
        const d = await api('/import?accountId=' + encodeURIComponent(S.imp.accountId), { method: 'POST', body: text, headers: { 'Content-Type': 'text/csv', 'X-Filename': 'upload.csv' } });
        S.imp.data = d; S.imp.step = d.needsMapping ? 'map' : 'preview'; S.imp.map = {}; S.imp.saveAs = '';
        if (d.needsMapping) S.msg = 'Layout not recognised: map the columns once.';
      });
    }
    if (act === 'map') {
      document.querySelectorAll('#money-root [data-map]').forEach((s) => { S.imp.map[s.dataset.map] = s.value || null; });
      S.imp.saveAs = val('money-saveas');
      return run(async () => {
        const d = await api('/import/' + encodeURIComponent(S.imp.data.previewId) + '/map', { method: 'POST', body: { map: S.imp.map, sign: S.imp.sign, saveAs: S.imp.saveAs || undefined } });
        S.imp.data = Object.assign({}, S.imp.data, d); S.imp.step = 'preview';
      });
    }
    if (act === 'remap') { S.imp.step = 'map'; return render(); }
    if (act === 'imp-cancel') { const pid = S.imp.data && S.imp.data.previewId; S.imp.data = null; S.imp.step = 'pick'; if (pid) api('/import/' + encodeURIComponent(pid), { method: 'DELETE' }).catch(() => {}); return render(); }
    if (act === 'commit') return run(async () => { const r = await api('/import/' + encodeURIComponent(S.imp.data.previewId) + '/commit', { method: 'POST' }); S.imp.data = null; S.imp.step = 'pick'; S.msg = `Imported ${r.added} transactions (${r.skipped} skipped).`; });
  }

  function onChange(ev) {
    const t = ev.target;
    if (!root() || !root().contains(t)) return;
    if (t.id === 'money-month' && /^\d{4}-\d{2}$/.test(t.value)) { S.month = t.value; return load(); }
    if (t.name === 'money-sign') {
      document.querySelectorAll('#money-root [data-map]').forEach((s) => { S.imp.map[s.dataset.map] = s.value || null; });
      S.imp.saveAs = val('money-saveas'); S.imp.sign = t.value; return render();
    }
    if (t.dataset && t.dataset.act === 'setcat') { S.pendingCat = { id: t.dataset.id, category: t.value }; return render(); }
  }
  function onKey(ev) { if (ev.key === 'Enter' && ev.target.id === 'money-q') { S.filter.q = ev.target.value; load(); } }

  let wired = false;
  window.AdaMoney = {
    show() {
      if (!wired && root()) { root().addEventListener('click', onClick); root().addEventListener('change', onChange); root().addEventListener('keydown', onKey); wired = true; }
      load();
    },
  };
})();
