/*
 * subscriptions-tab.js — the Subscriptions page (admin only, 2026-11-24). Talks only to /api/subscriptions.
 * Shows what is on the subscription card against its $300 cap, what the card's autopay should be set to,
 * what has not moved yet, and a table of every subscription. "Add subscription" opens an in-page dialog.
 */
(function () {
  'use strict';
  const root = () => document.getElementById('subscriptions-root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toFixed(2);
  const S = { data: null, err: '', msg: '', dialog: false, confirm: null, busy: false, form: { name: '', price: '', cycle: 'monthly' }, formErr: '' };
  const input = 'w-full rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 py-2.5 text-base';
  const btn = 'min-h-[44px] px-4 rounded-xl text-sm font-semibold';
  const primary = btn + ' bg-indigo-600 text-white hover:bg-indigo-500';
  const ghost = btn + ' bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15';
  const card = 'rounded-2xl bg-white dark:bg-gray-800/60 border border-black/5 dark:border-white/10 p-4';
  const dateLabel = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';

  const api = async (opts) => {
    const o = Object.assign({}, opts);
    if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers = { 'Content-Type': 'application/json' }; }
    const r = await fetch('/api/subscriptions' + (o.path || ''), o);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
    return b;
  };

  function cards(t) {
    const pct = Math.max(0, Math.min(100, (t.onCardMonthly / t.cap) * 100));
    const barCls = pct > 90 ? 'bg-rose-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500';
    return `<div class="grid gap-3 sm:grid-cols-3">
      <div class="${card}"><div class="text-xs text-gray-500 dark:text-gray-400">On the card</div>
        <div class="text-2xl font-bold">${money(t.onCardMonthly)} <span class="text-base font-medium text-gray-500 dark:text-gray-400">/ $${esc(t.cap)}</span></div>
        <div class="mt-2 h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div class="h-2 rounded-full ${barCls}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">monthly subscriptions on the card</div></div>
      <div class="${card}"><div class="text-xs text-gray-500 dark:text-gray-400">Autopay should be</div>
        <div class="text-2xl font-bold">${money(t.autopay)}</div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">${money(t.onCardMonthly)} on card + $10.00 buffer + $30.00 minimum payment</div></div>
      <div class="${card}"><div class="text-xs text-gray-500 dark:text-gray-400">Not moved yet</div>
        <div class="text-2xl font-bold">${money(t.notMovedMonthly)}<span class="text-base font-medium text-gray-500 dark:text-gray-400">/mo</span></div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">+ ${money(t.notMovedYearly)}/yr &middot; card arrives ${esc(dateLabel(t.cardArrival))}</div></div>
    </div>`;
  }

  function table(rows) {
    if (!rows.length) return `<div class="${card} text-sm text-gray-500">No subscriptions yet.</div>`;
    const body = rows.map((s) => {
      const pill = s.onCard
        ? '<span class="text-xs font-semibold rounded-full px-2 py-0.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Yes</span>'
        : `<button type="button" class="text-xs font-semibold rounded-full px-2 py-0.5 bg-rose-500/15 text-rose-500 cursor-pointer hover:bg-rose-500/30 focus:outline-none focus:ring-2 focus:ring-rose-500/50" title="Mark as on the card" data-act="oncard" data-id="${esc(s.id)}">No</button>`;
      return `<tr class="border-t border-black/5 dark:border-white/10">
        <td class="py-2.5 pr-3 font-medium">${esc(s.name)}</td>
        <td class="py-2.5 pr-3 whitespace-nowrap">${s.price == null ? '<span class="text-gray-400">&mdash;</span>' : money(s.price)}</td>
        <td class="py-2.5 pr-3 capitalize">${esc(s.cycle)}</td>
        <td class="py-2.5 pr-3">${pill}</td>
        <td class="py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">${s.switchDue ? esc(dateLabel(s.switchDue)) : ''}</td></tr>`;
    }).join('');
    return `<div class="${card} overflow-x-auto"><table class="w-full text-sm text-left">
      <thead><tr class="text-xs text-gray-500 dark:text-gray-400"><th class="pb-2 pr-3 font-medium">Subscription</th><th class="pb-2 pr-3 font-medium">Price</th><th class="pb-2 pr-3 font-medium">Cycle</th><th class="pb-2 pr-3 font-medium">On sub card</th><th class="pb-2 font-medium">Switch task due</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function dialog() {
    if (!S.dialog) return '';
    const f = S.form;
    return `<div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" data-act="backdrop">
      <form data-form="add" class="w-full max-w-md ${card} space-y-3" role="dialog" aria-modal="true" aria-labelledby="subs-add-h">
        <h3 id="subs-add-h" class="text-lg font-bold">Add subscription</h3>
        <label class="block text-sm">Name<input class="${input} mt-1" data-f="name" maxlength="100" required autocomplete="off" value="${esc(f.name)}"></label>
        <label class="block text-sm">Price (optional)<input class="${input} mt-1" data-f="price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="leave blank if unknown" value="${esc(f.price)}"></label>
        <label class="block text-sm">Cycle<select class="${input} mt-1" data-f="cycle"><option value="monthly"${f.cycle === 'monthly' ? ' selected' : ''}>Monthly</option><option value="yearly"${f.cycle === 'yearly' ? ' selected' : ''}>Yearly</option></select></label>
        ${S.formErr ? `<div class="bg-rose-500/10 text-rose-500 border border-rose-500/30 rounded-xl px-3 py-2 text-sm">${esc(S.formErr)}</div>` : ''}
        <div class="flex gap-2 justify-end"><button type="button" class="${ghost}" data-act="cancel">Cancel</button><button type="submit" class="${primary}"${S.busy ? ' disabled' : ''}>Save</button></div>
      </form></div>`;
  }

  function confirmDialog() {
    const c = S.confirm; if (!c) return '';
    return `<div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" data-act="backdrop-confirm">
      <div class="w-full max-w-md ${card} space-y-3" role="dialog" aria-modal="true" aria-labelledby="subs-confirm-h">
        <h3 id="subs-confirm-h" class="text-lg font-bold">Mark as on the card</h3>
        <p class="text-sm">Mark ${esc(c.name)} as on the subscription card? This checks off its switch task and updates the autopay task.</p>
        ${S.confirmErr ? `<div class="bg-rose-500/10 text-rose-500 border border-rose-500/30 rounded-xl px-3 py-2 text-sm">${esc(S.confirmErr)}</div>` : ''}
        <div class="flex gap-2 justify-end"><button type="button" class="${ghost}" data-act="confirm-cancel">Cancel</button><button type="button" class="${primary}" data-act="confirm-ok"${S.busy ? ' disabled' : ''}>Confirm</button></div>
      </div></div>`;
  }

  function render() {
    const el = root(); if (!el) return;
    // Keep the dialog's typed text across re-renders (focus is restored below).
    const d = S.data;
    el.innerHTML = `<div class="space-y-4 max-w-4xl">
      <div class="flex items-center justify-between gap-3 flex-wrap"><h2 class="text-xl font-bold">Subscriptions</h2><button class="${primary}" data-act="add">Add subscription</button></div>
      ${S.err ? `<div class="bg-rose-500/10 text-rose-500 border border-rose-500/30 rounded-xl px-3 py-2 text-sm">${esc(S.err)}</div>` : ''}
      ${S.msg ? `<div class="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-xl px-3 py-2 text-sm">${S.msg}</div>` : ''}
      ${d ? cards(d.totals) + table(d.rows) : '<div class="text-sm text-gray-500">Loading&hellip;</div>'}
    </div>${dialog()}${confirmDialog()}`;
  }

  async function load() {
    try { S.data = await api(); S.err = ''; } catch (e) { S.err = e.message; }
    render();
  }

  function onClick(e) {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'add') { S.dialog = true; S.form = { name: '', price: '', cycle: 'monthly' }; S.formErr = ''; render(); const n = root().querySelector('[data-f="name"]'); if (n) n.focus(); }
    else if (act === 'cancel' || (act === 'backdrop' && e.target === a)) { S.dialog = false; render(); }
    else if (act === 'oncard') {
      const row = S.data && S.data.rows.find((r) => r.id === a.dataset.id); if (!row) return;
      S.confirm = { id: row.id, name: row.name }; S.confirmErr = ''; render();
      const ok = root().querySelector('[data-act="confirm-ok"]'); if (ok) ok.focus();
    }
    else if (act === 'confirm-cancel' || (act === 'backdrop-confirm' && e.target === a)) { S.confirm = null; render(); }
    else if (act === 'confirm-ok') doOnCard();
  }
  function onInput(e) { const f = e.target.dataset && e.target.dataset.f; if (f) S.form[f] = e.target.value; }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (S.confirm) { S.confirm = null; render(); }
    else if (S.dialog) { S.dialog = false; render(); }
  }
  async function doOnCard() {
    if (S.busy || !S.confirm) return;
    const c = S.confirm;
    S.busy = true; S.confirmErr = ''; render();
    try {
      const r = await api({ method: 'POST', path: '/' + encodeURIComponent(c.id) + '/on-card' });
      S.confirm = null; S.busy = false; S.err = '';
      S.msg = `Marked ${esc(c.name)} on the card. Autopay is now ${money(r.totals.autopay)}.`;
      await load();
      return;
    } catch (err) { S.confirmErr = err.message; }
    S.busy = false; render();
  }
  async function onSubmit(e) {
    if (!e.target.matches('[data-form="add"]')) return;
    e.preventDefault();
    if (S.busy) return;
    S.busy = true; S.formErr = '';
    try {
      const r = await api({ method: 'POST', body: { name: S.form.name, price: S.form.price === '' ? null : S.form.price, cycle: S.form.cycle } });
      S.dialog = false;
      S.msg = `Added ${esc(r.row.name)}. Created task${r.tasks.length > 1 ? 's' : ''}: ` + r.tasks.map((t) => `${esc(t.name)} (due ${esc(dateLabel(t.dueDate))})`).join('; ');
      S.err = '';
      S.busy = false;
      await load();
      return;
    } catch (err) { S.formErr = err.message; }
    S.busy = false; render();
    const n = root().querySelector('[data-f="name"]'); if (n) n.focus();
  }

  let wired = false;
  function show() {
    const el = root(); if (!el) return;
    if (!wired) { wired = true; el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('keydown', onKey); el.addEventListener('submit', onSubmit); }
    S.msg = '';
    render(); load();
  }
  window.AdaSubscriptions = { show };
})();
