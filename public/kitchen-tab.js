/*
 * kitchen-tab.js — the Kitchen tab (prototype, 2026-11-24). Talks only to /api/kitchen, which only
 * ever returns the signed-in person's own kitchen. Three sections:
 *   Plan      — this week's meals, Cook (takes ingredients out of the inventory, asks about missing ones),
 *               saved recipes and the shopping list
 *   Inventory — what's on hand by place, with use-by dates, "use soon" and "running low" at the top
 *   Assistant — chat that logs groceries, cooks, saves recipes and suggests meals from what's on hand
 * Phone first: one column, big tap targets, 16px inputs, no browser dialogs.
 */
(function () {
  'use strict';
  const root = () => document.getElementById('kitchen-root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, opts) => {
    const o = Object.assign({}, opts);
    if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers); }
    const r = await fetch('/api/kitchen' + url, o);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(b.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return b;
  };
  const S = { tab: 'plan', v: null, chat: [], busy: false, err: '', msg: '', sheet: null, cook: null, addOpen: false, recipeOpen: false, planOpen: null, editId: null };
  const PLACES = [['fridge', 'Fridge', 'fa-temperature-low'], ['freezer', 'Freezer', 'fa-snowflake'], ['pantry', 'Pantry', 'fa-box-archive']];
  const MEALS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snack', 'Snack']];
  const input = 'w-full rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 py-2.5 text-base';
  const btn = 'min-h-[44px] px-4 rounded-xl text-sm font-semibold';
  const primary = btn + ' bg-indigo-600 text-white hover:bg-indigo-500';
  const ghost = btn + ' bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15';
  const card = 'rounded-2xl bg-white dark:bg-gray-800/60 border border-black/5 dark:border-white/10 p-4';
  const qty = (n) => (Math.round(n * 100) / 100).toString();
  const amount = (q, u) => `${qty(q)}${u ? ' ' + esc(u) : ''}`;
  const dayName = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  function badge(it) {
    const d = it.daysLeft;
    if (it.status === 'none') return '<span class="text-xs text-gray-400">keeps</span>';
    const [cls, txt] = it.status === 'expired' ? ['bg-rose-500/15 text-rose-500', d === -1 ? 'expired' : `expired ${-d} days ago`]
      : it.status === 'today' ? ['bg-rose-500/15 text-rose-500', 'last day']
        : it.status === 'soon' ? ['bg-amber-500/15 text-amber-600 dark:text-amber-400', d === 1 ? '1 more day' : `${d} more days`]
          : it.status === 'week' ? ['bg-yellow-500/10 text-yellow-700 dark:text-yellow-300', `${d} days left`]
            : ['bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', d > 60 ? `${Math.round(d / 30)} months` : `${d} days`];
    return `<span class="text-xs font-semibold rounded-full px-2 py-0.5 whitespace-nowrap ${cls}" title="Good through ${esc(it.expiresOn)}${it.expirySource === 'label' ? ' (package date)' : ' (estimated)'}">${txt}</span>`;
  }
  const note = () => (S.err ? `<div class="bg-rose-500/10 text-rose-500 border border-rose-500/30 rounded-xl px-3 py-2 text-sm">${esc(S.err)}</div>` : '') + (S.msg ? `<div class="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-xl px-3 py-2 text-sm">${esc(S.msg)}</div>` : '');

  // ---------- Plan
  function renderPlan() {
    const v = S.v, out = [];
    const start = v.weekStart;
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const byDay = (d) => v.plan.filter((p) => p.date === d);
    out.push(`<div class="${card}"><div class="flex items-center justify-between mb-2"><h3 class="font-semibold">This week</h3><span class="text-xs text-gray-500">${dayName(days[0])} – ${dayName(days[6])}</span></div>
      <ul class="divide-y divide-black/5 dark:divide-white/10">${days.map((d) => `<li class="py-2 ${d === v.today ? 'bg-indigo-500/5 -mx-2 px-2 rounded-lg' : ''}">
        <div class="flex items-center justify-between gap-2"><span class="text-sm font-semibold ${d === v.today ? 'text-indigo-500' : ''}">${d === v.today ? 'Today' : dayName(d)}</span>
        <button class="text-xs text-indigo-500 font-semibold min-h-[36px] px-2" data-act="plan-open" data-date="${d}"><i class="fa-solid fa-plus"></i> Add</button></div>
        ${byDay(d).map((p) => `<div class="flex items-center justify-between gap-2 mt-1"><span class="text-sm min-w-0"><span class="text-xs uppercase text-gray-400 mr-1">${esc(p.meal)}</span>${p.cooked ? '<s class="text-gray-400">' + esc(p.title) + '</s> <i class="fa-solid fa-check text-emerald-500"></i>' : esc(p.title)}</span>
          <span class="flex gap-1 shrink-0">${!p.cooked && p.recipeId ? `<button class="${btn} bg-emerald-600 text-white !min-h-[36px] !px-3" data-act="cook" data-id="${p.recipeId}" data-plan="${p.id}"><i class="fa-solid fa-fire-burner"></i> Cook</button>` : ''}<button class="min-h-[36px] px-2 text-gray-400" aria-label="Remove from plan" data-act="plan-del" data-id="${p.id}"><i class="fa-solid fa-xmark"></i></button></span></div>`).join('')}
        ${S.planOpen === d ? planForm(d) : ''}</li>`).join('')}</ul></div>`);
    // shopping list
    out.push(`<div class="${card}"><h3 class="font-semibold mb-1"><i class="fa-solid fa-cart-shopping text-indigo-500"></i> Shopping list</h3><p class="text-xs text-gray-500 mb-2">For the next 7 days of planned meals, minus what you have, plus anything running low.</p>
      ${v.shopping.length ? `<ul class="space-y-1">${v.shopping.map((s) => `<li class="text-sm flex justify-between gap-2"><span>${esc(s.name)}${s.qty ? ` <span class="text-gray-500">${amount(s.qty, s.unit)}</span>` : ''}</span><span class="text-xs text-gray-400 text-right">${esc(s.why.join(', '))}</span></li>`).join('')}</ul>` : '<p class="text-sm text-gray-500">Nothing needed.</p>'}</div>`);
    // recipes
    out.push(`<div class="${card}"><div class="flex items-center justify-between mb-2"><h3 class="font-semibold"><i class="fa-solid fa-book-open text-indigo-500"></i> Recipes</h3><button class="${ghost} !min-h-[36px]" data-act="recipe-open">${S.recipeOpen ? 'Close' : '<i class="fa-solid fa-plus"></i> New'}</button></div>
      ${S.recipeOpen ? recipeForm() : ''}
      ${v.recipes.length ? `<ul class="divide-y divide-black/5 dark:divide-white/10">${v.recipes.map((r) => recipeRow(r)).join('')}</ul>` : '<p class="text-sm text-gray-500">No recipes yet. Add one here, or tell the assistant ("save my chili recipe: ...").</p>'}</div>`);
    return out.join('');
  }
  function recipeRow(r) {
    const have = R_have(r);
    return `<li class="py-2"><details><summary class="flex items-center justify-between gap-2 cursor-pointer list-none"><span class="min-w-0"><span class="font-medium">${esc(r.name)}</span> <span class="text-xs text-gray-500">serves ${r.servings}</span><br><span class="text-xs ${have.missing ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}">${have.missing ? `missing ${have.missing} of ${have.total}` : 'you have everything'}</span></span>
      <button class="${btn} bg-emerald-600 text-white !min-h-[36px] !px-3 shrink-0" data-act="cook" data-id="${r.id}"><i class="fa-solid fa-fire-burner"></i> Cook</button></summary>
      <ul class="mt-2 text-sm space-y-0.5">${r.ingredients.map((x) => `<li>${x.qty ? amount(x.qty, x.unit) + ' ' : ''}${esc(x.name)}</li>`).join('')}</ul>
      ${r.steps ? `<p class="mt-2 text-sm whitespace-pre-line text-gray-600 dark:text-gray-300">${esc(r.steps)}</p>` : ''}
      <button class="mt-2 text-xs text-rose-500 min-h-[36px]" data-act="recipe-del" data-id="${r.id}">Delete recipe</button></details></li>`;
  }
  // Rough "do I have it" for the recipe list (the server does the real check when cooking).
  function R_have(r) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z ]/g, '').replace(/s\b/g, '').trim();
    const names = S.v.items.map((i) => norm(i.name));
    const skip = new Set(['salt', 'pepper', 'water', 'salt and pepper', 'black pepper']);
    const ings = r.ingredients.filter((x) => !skip.has(norm(x.name)));
    const missing = ings.filter((x) => { const n = norm(x.name); return !names.some((m) => m === n || m.includes(n) || n.includes(m)); }).length;
    return { missing, total: ings.length };
  }
  const planForm = (d) => `<form class="mt-2 space-y-2" data-form="plan" data-date="${d}">
      <div class="grid grid-cols-2 gap-2"><select name="meal" class="${input}">${MEALS.map(([k, n]) => `<option value="${k}" ${k === 'dinner' ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <select name="recipeId" class="${input}"><option value="">Just a note…</option>${S.v.recipes.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
      <input name="title" class="${input}" placeholder="Or type a meal (e.g. Takeout)" maxlength="100">
      <div class="flex gap-2"><button class="${primary}">Add to ${d === S.v.today ? 'today' : dayName(d)}</button><button type="button" class="${ghost}" data-act="plan-close">Cancel</button></div></form>`;
  const recipeForm = () => `<form class="space-y-2 mb-3" data-form="recipe">
      <input name="name" class="${input}" placeholder="Recipe name" maxlength="100" required>
      <input name="servings" type="number" min="1" max="50" value="2" class="${input}" aria-label="Servings">
      <textarea name="ingredients" rows="5" class="${input}" placeholder="One ingredient per line:\n1.5 lb chicken breast\n2 cups rice\n3 cloves garlic\nsalt"></textarea>
      <textarea name="steps" rows="3" class="${input}" placeholder="Steps (optional)"></textarea>
      <button class="${primary} w-full">Save recipe</button></form>`;
  const UNIT_WORDS = 'g|grams?|kg|oz|ounces?|lbs?|pounds?|ml|l|liters?|litres?|cups?|tbsp|tablespoons?|tsp|teaspoons?|cans?|jars?|cloves?|bags?|box(es)?|packs?|packages?|bunch|heads?|slices?|pieces?|fillets?|breasts?|dozen|pinch|loaf';
  function parseIngredient(lineStr) {
    const s = lineStr.trim(); if (!s) return null;
    const m = new RegExp(`^((?:\\d+\\s+)?\\d+(?:[./]\\d+)?)?\\s*(${UNIT_WORDS})?\\b\\.?\\s*(?:of\\s+)?(.+)$`, 'i').exec(s);
    if (!m) return { name: s, qty: 0, unit: '' };
    let q = 0;
    if (m[1]) q = m[1].split(/\s+/).reduce((a, p) => a + (p.includes('/') ? Number(p.split('/')[0]) / Number(p.split('/')[1]) : Number(p)), 0);
    return { name: m[3].trim(), qty: Math.round(q * 100) / 100, unit: (m[2] || '').toLowerCase() };
  }

  // ---------- Inventory
  function renderInventory() {
    const v = S.v, out = [];
    const soon = v.alerts.expired.concat(v.alerts.soon);
    if (soon.length || v.alerts.low.length) {
      out.push(`<div class="${card} border-amber-500/30">${soon.length ? `<h3 class="font-semibold text-amber-600 dark:text-amber-400 mb-1"><i class="fa-solid fa-hourglass-half"></i> Use soon</h3><ul class="space-y-1 mb-2">${soon.map((i) => `<li class="flex justify-between gap-2 text-sm"><span>${esc(i.name)} <span class="text-gray-500">${amount(i.qty, i.unit)} · ${esc(i.location)}</span></span>${badge(i)}</li>`).join('')}</ul>
        <button class="${ghost} w-full" data-act="ask" data-q="What can I make tonight that uses up the things about to go bad?"><i class="fa-solid fa-wand-magic-sparkles"></i> Ideas to use these up</button>` : ''}
        ${v.alerts.low.length ? `<h3 class="font-semibold mt-3 mb-1"><i class="fa-solid fa-battery-quarter text-rose-500"></i> Running low</h3><ul class="space-y-1">${v.alerts.low.map((i) => `<li class="text-sm">${esc(i.name)} <span class="text-gray-500">${amount(i.qty, i.unit)} left</span></li>`).join('')}</ul>` : ''}</div>`);
    }
    if (v.suggestions && v.suggestions.length) out.push(`<div class="${card} border-indigo-500/30"><h3 class="font-semibold mb-1"><i class="fa-solid fa-lightbulb text-indigo-500"></i> Suggested keywords</h3><p class="text-xs text-gray-500 mb-2">Adding one means items with that word get the right date without asking the AI.</p>
      <ul class="space-y-2">${v.suggestions.map((x) => `<li class="rounded-xl bg-black/5 dark:bg-white/5 p-2"><div class="text-sm"><b>${esc(x.word)}</b> → ${esc(x.label)}</div><div class="text-xs text-gray-500">${esc(x.why)}</div>
        <div class="grid grid-cols-2 gap-2 mt-2"><button class="${primary} !min-h-[40px]" data-act="kw" data-id="${x.id}" data-do="add">Add</button><button class="${ghost} !min-h-[40px]" data-act="kw" data-id="${x.id}" data-do="skip">Skip</button></div></li>`).join('')}</ul></div>`);
    out.push(`<button class="${primary} w-full" data-act="add-open">${S.addOpen ? 'Close' : '<i class="fa-solid fa-plus"></i> Add food'}</button>`);
    if (S.addOpen) out.push(`<form class="${card} space-y-2" data-form="item">
      <input name="name" class="${input}" placeholder="What is it? (e.g. Chicken thighs)" maxlength="80" required>
      <div class="grid grid-cols-2 gap-2"><input name="qty" type="number" step="any" min="0" value="1" class="${input}" aria-label="Amount"><input name="unit" class="${input}" placeholder="unit (lb, cups, cans)" maxlength="16"></div>
      <div class="grid grid-cols-3 gap-2">${PLACES.map(([k, n], i) => `<label class="${ghost} flex items-center justify-center gap-1 cursor-pointer has-[:checked]:bg-indigo-600 has-[:checked]:text-white"><input type="radio" name="location" value="${k}" class="sr-only" ${i === 0 ? 'checked' : ''}>${n}</label>`).join('')}</div>
      <label class="block text-xs text-gray-500">Last good day, if the package says (optional; otherwise estimated)<input name="expiresOn" type="date" class="${input} mt-1"></label>
      <label class="block text-xs text-gray-500">Warn me when it gets down to (optional)<input name="lowAt" type="number" step="any" min="0" class="${input} mt-1"></label>
      <button class="${primary} w-full">Add</button><p class="text-xs text-gray-500">Tip: the assistant can add a whole grocery run at once.</p></form>`);
    for (const [k, n, ic] of PLACES) {
      const rows = v.items.filter((i) => i.location === k);
      out.push(`<div class="${card}"><h3 class="font-semibold mb-1"><i class="fa-solid ${ic} text-indigo-500"></i> ${n} <span class="text-xs text-gray-500 font-normal">${rows.length}</span></h3>
        ${rows.length ? `<ul class="divide-y divide-black/5 dark:divide-white/10">${rows.map(itemRow).join('')}</ul>` : '<p class="text-sm text-gray-500">Empty.</p>'}</div>`);
    }
    out.push(`<details class="${card}"><summary class="font-semibold cursor-pointer">How long things keep</summary><p class="text-xs text-gray-500 my-2">Days it stays good, counting the day it goes in; the last of those is its "last day" and it counts as expired the next day. Moving something to the freezer restarts its clock; a date on the package always wins.</p>
      <table class="w-full text-xs"><thead><tr class="text-gray-500"><th class="text-left py-1">Food</th><th>Fridge</th><th>Freezer</th><th>Pantry</th></tr></thead><tbody>${v.rules.map((r) => `<tr class="border-t border-black/5 dark:border-white/10"><td class="py-1">${esc(r.label)}</td><td class="text-center">${r.fridge || '–'}</td><td class="text-center">${r.freezer || '–'}</td><td class="text-center">${r.pantry || '–'}</td></tr>`).join('')}</tbody></table></details>`);
    if (v.log.length) out.push(`<details class="${card}"><summary class="font-semibold cursor-pointer">Recent changes</summary><ul class="mt-2 space-y-1 text-xs text-gray-500">${v.log.map((l) => `<li>${esc(new Date(l.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · ${l.who === 'assistant' ? 'Assistant' : esc(l.who.charAt(0).toUpperCase() + l.who.slice(1))}: ${esc(l.summary)}</li>`).join('')}</ul></details>`);
    return out.join('');
  }
  function itemRow(i) {
    const open = S.editId === i.id;
    return `<li class="py-2"><button class="w-full flex items-center justify-between gap-2 text-left min-h-[40px]" data-act="item-open" data-id="${i.id}"><span class="min-w-0"><span class="font-medium">${esc(i.name)}</span> <span class="text-sm text-gray-500">${amount(i.qty, i.unit)}</span>${i.low ? ' <i class="fa-solid fa-battery-quarter text-rose-500" title="Running low"></i>' : ''}${i.typeSource === 'default' || (i.typeSource === 'ai' && i.typeConfidence === 'low') ? ' <span class="text-[11px] text-amber-600 dark:text-amber-400">check the type</span>' : i.typeSource === 'pending' ? ' <i class="fa-solid fa-spinner fa-spin text-gray-400 text-xs" title="Working out the type"></i>' : ''}</span>${badge(i)}</button>
      ${open ? `<div class="mt-2 space-y-2"><div class="flex gap-2"><input id="kit-use-${i.id}" type="number" step="any" min="0" value="${i.qty <= 1 ? qty(i.qty) : 1}" class="${input} !w-24" aria-label="Amount used"><button class="${ghost} flex-1" data-act="item-use" data-id="${i.id}">Used this much</button></div>
        <div class="grid grid-cols-3 gap-2">${PLACES.filter(([k]) => k !== i.location).map(([k, n]) => `<button class="${ghost}" data-act="item-move" data-id="${i.id}" data-to="${k}">To ${n.toLowerCase()}</button>`).join('')}<button class="${ghost} text-rose-500" data-act="item-del" data-id="${i.id}">${i.status === 'expired' ? 'Toss' : 'Remove'}</button></div>
        <label class="block text-xs text-gray-500">Type of food${i.typeSource === 'pending' ? ' (still working it out…)' : i.typeSource === 'ai' ? ' (guessed by AI)' : i.typeSource === 'default' ? ' (no match, please pick)' : ''}<select data-type-for="${i.id}" class="${input} mt-1">${S.v.types.map((t) => `<option value="${t.id}" ${t.id === i.category ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
        <p class="text-xs text-gray-500">In the ${esc(i.location)} since ${esc(i.placedOn || i.addedOn)}${i.expiresOn ? `, good through ${esc(i.expiresOn)} (${i.expirySource === 'label' ? 'package date' : 'estimated'}); expired the day after` : ''}.</p></div>` : ''}</li>`;
  }

  // ---------- Assistant
  function renderAssistant() {
    const chips = ['What can I make with what I have?', 'What\'s about to go bad?', 'I just got groceries: ', 'Plan dinners for the rest of the week'];
    const msgs = S.chat.map((m) => m.role === 'user'
      ? `<div class="flex justify-end"><div class="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 text-white px-3 py-2 text-sm whitespace-pre-line">${esc(m.content)}</div></div>`
      : `<div class="max-w-[90%] rounded-2xl rounded-bl-md bg-black/5 dark:bg-white/10 px-3 py-2 text-sm whitespace-pre-line">${esc(m.content)}${(m.done && m.done.length) ? `<ul class="mt-2 pt-2 border-t border-black/10 dark:border-white/10 text-xs space-y-0.5">${m.done.map((x) => `<li><i class="fa-solid fa-check text-emerald-500"></i> ${esc(x)}</li>`).join('')}</ul>` : ''}${(m.problems && m.problems.length) ? `<ul class="mt-1 text-xs text-rose-500">${m.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`).join('');
    return `<div class="${card} space-y-3"><div class="space-y-2" id="kit-chat">${msgs || '<p class="text-sm text-gray-500">Tell me what you bought, what you cooked or used, or ask what to make. The kitchen is shared by the house, so everyone sees the same inventory and plan; this chat is just yours.</p>'}
      ${S.busy ? '<div class="text-sm text-gray-500"><i class="fa-solid fa-spinner fa-spin"></i> Thinking…</div>' : ''}</div>
      <div class="flex flex-wrap gap-2">${chips.map((c) => `<button class="text-xs rounded-full px-3 py-2 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300" data-act="chip" data-q="${esc(c)}">${esc(c.trim())}</button>`).join('')}</div>
      <form data-form="chat" class="flex gap-2 items-end"><textarea id="kit-input" rows="2" class="${input}" placeholder="e.g. Picked up 2 lb ground beef, a dozen eggs and spinach" maxlength="2000"></textarea><button class="${primary}" ${S.busy ? 'disabled' : ''} aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></form>
      ${S.chat.length ? '<button class="text-xs text-gray-400 min-h-[36px]" data-act="chat-clear">Clear chat</button>' : ''}</div>`;
  }

  // ---------- Cook sheet
  function cookSheet() {
    const c = S.cook; if (!c) return '';
    const p = c.preview;
    const rows = [];
    if (p.uses.length) rows.push(`<h4 class="text-sm font-semibold mt-2">Comes out of your kitchen</h4><ul class="text-sm space-y-0.5">${p.uses.map((u) => `<li>${esc(u.itemName)}: ${u.take ? amount(u.take, u.unit) : 'a little'} <span class="text-gray-500">(${amount(u.leftAfter, u.unit)} left)</span></li>`).join('')}</ul>`);
    const ask = p.missing.map((m) => ({ ...m, kind: 'missing' })).concat(p.unsure.map((m) => ({ ...m, kind: 'unsure' })));
    if (ask.length) rows.push(`<h4 class="text-sm font-semibold mt-3 text-amber-600 dark:text-amber-400">Not in your inventory</h4>${ask.map((m, idx) => {
      const r = c.resolve[m.ingredient];
      const need = m.short != null ? `${amount(m.short, m.unit)} more` : m.qty ? amount(m.qty, m.unit) : '';
      return `<div class="mt-2 rounded-xl bg-black/5 dark:bg-white/5 p-2"><div class="text-sm"><b>${esc(m.ingredient)}</b> ${need ? `<span class="text-gray-500">needs ${need}</span>` : ''}${m.kind === 'unsure' ? `<br><span class="text-xs text-gray-500">You have ${m.candidates.map((x) => amount(x.qty, x.unit) + ' ' + esc(x.itemName)).join(', ')}, counted differently.</span>` : ''}</div>
        <div class="grid grid-cols-2 gap-2 mt-2"><button class="${r && r !== 'skip' ? primary : ghost} !min-h-[40px]" data-act="res-bought" data-i="${idx}">I picked some up</button><button class="${r === 'skip' ? primary : ghost} !min-h-[40px]" data-act="res-skip" data-i="${idx}">Going without</button></div>
        ${r && r !== 'skip' ? `<div class="flex gap-2 mt-2"><input type="number" step="any" min="0" value="${qty(r.bought)}" data-res-qty="${idx}" class="${input} !w-24" aria-label="How much you got"><input value="${esc(r.unit)}" data-res-unit="${idx}" class="${input}" placeholder="unit" aria-label="Unit"></div><p class="text-xs text-gray-500 mt-1">Whatever's left after cooking stays in your inventory.</p>` : ''}</div>`;
    }).join('')}`);
    const open = ask.filter((m) => !c.resolve[m.ingredient]).length;
    return `<div class="fixed inset-0 z-[1100] bg-black/60 flex items-end md:items-center justify-center" data-act="cook-close-bg"><div class="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-white dark:bg-gray-900 rounded-t-3xl md:rounded-3xl p-5" data-stop="1">
      <div class="flex items-center justify-between"><h3 class="text-lg font-semibold">Cook ${esc(c.recipe.name)}</h3><button class="min-h-[44px] px-3 text-gray-400" data-act="cook-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <label class="text-sm flex items-center gap-2 mt-1">Batches <input type="number" min="0.25" max="10" step="0.25" value="${c.scale}" data-cook-scale="1" class="${input} !w-20"> <span class="text-xs text-gray-500">(1 = serves ${c.recipe.servings})</span></label>
      ${rows.join('') || '<p class="text-sm text-gray-500 mt-2">Nothing on this recipe is tracked.</p>'}
      <button class="${primary} w-full mt-4" data-act="cook-go" ${open ? 'disabled style="opacity:.5"' : ''}>${open ? `Answer ${open} question${open > 1 ? 's' : ''} above` : 'Cook it and update the kitchen'}</button></div></div>`;
  }

  // ---------- render + events
  function render() {
    const el = root(); if (!el) return;
    const tabs = [['plan', 'Meal plan', 'fa-calendar-days'], ['inventory', 'Inventory', 'fa-kitchen-set'], ['assistant', 'Assistant', 'fa-comments']];
    const alertN = S.v ? S.v.alerts.expired.length + S.v.alerts.soon.length : 0;
    const nav = `<div class="grid grid-cols-3 gap-1 p-1 rounded-2xl bg-black/5 dark:bg-white/5" role="tablist">${tabs.map(([k, n, ic]) => `<button role="tab" aria-selected="${S.tab === k}" data-act="tab" data-tab="${k}" class="min-h-[44px] rounded-xl text-[13px] font-semibold flex items-center justify-center gap-1.5 ${S.tab === k ? 'bg-white dark:bg-gray-700 shadow text-indigo-600 dark:text-indigo-300' : 'text-gray-500'}"><i class="fa-solid ${ic}"></i>${n}${k === 'inventory' && alertN ? ` <span class="text-[10px] rounded-full bg-amber-500 text-white px-1.5">${alertN}</span>` : ''}</button>`).join('')}</div>`;
    let body = !S.v ? (S.err ? '' : '<div class="text-sm text-gray-500 p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>') : S.tab === 'plan' ? renderPlan() : S.tab === 'inventory' ? renderInventory() : renderAssistant();
    const draft = (document.getElementById('kit-input') || {}).value || '';
    el.innerHTML = `<div class="max-w-2xl mx-auto space-y-4 pb-24 md:pb-8 px-1"><div class="flex items-baseline justify-between"><h2 class="text-xl font-bold"><i class="fa-solid fa-kitchen-set text-indigo-500"></i> Kitchen</h2><span class="text-xs text-gray-400">alpha ${esc(S.v ? S.v.version : '')}</span></div>${nav}${note()}${body}</div>${cookSheet()}`;
    const ta = document.getElementById('kit-input'); if (ta && draft) ta.value = draft;
    const ch = document.getElementById('kit-chat'); if (ch && S.tab === 'assistant') ch.lastElementChild && ch.lastElementChild.scrollIntoView({ block: 'nearest' });
  }
  const flash = (m, isErr) => { S.err = isErr ? m : ''; S.msg = isErr ? '' : m; render(); if (!isErr) setTimeout(() => { if (S.msg === m) { S.msg = ''; render(); } }, 3500); };
  const run = async (p, okMsg) => { try { const r = await p; if (r && r.state) S.v = r.state; if (okMsg) flash(okMsg); else { S.err = ''; render(); } return r; } catch (e) { flash(e.message, true); return null; } };
  const load = async () => { try { S.v = await api('/state'); S.err = ''; } catch (e) { S.err = e.message; } render(); };
  async function loadChat() { try { const r = await api('/assistant'); S.chat = r.messages || []; S.busy = r.busy; render(); if (S.busy) poll(); } catch (e) { /* shown on send */ } }
  async function poll() {
    for (let i = 0; i < 90; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      const r = await api('/assistant/status').catch(() => null);
      if (!r || r.state === 'running') continue;
      S.busy = false;
      if (r.state === 'failed') { flash(r.error, true); return; }
      if (r.messages) S.chat = r.messages; if (r.view) S.v = r.view;
      render(); return;
    }
    S.busy = false; flash('The assistant is taking too long. Try again.', true);
  }
  async function send(msg) {
    if (!msg.trim() || S.busy) return;
    S.chat = S.chat.concat({ role: 'user', content: msg }); S.busy = true; S.tab = 'assistant';
    const ta = document.getElementById('kit-input'); if (ta) ta.value = '';
    render();
    try { await api('/assistant', { method: 'POST', body: { message: msg } }); poll(); } catch (e) { S.busy = false; S.chat = S.chat.slice(0, -1); flash(e.message, true); }
  }
  async function openCook(recipeId, planId) {
    const recipe = S.v.recipes.find((r) => r.id === recipeId); if (!recipe) return;
    try { const preview = await api(`/recipes/${recipeId}/cook`, { method: 'POST', body: { scale: 1 } }); S.cook = { recipe, planId, scale: 1, preview, resolve: {} }; render(); } catch (e) { flash(e.message, true); }
  }
  async function rePreview() { const c = S.cook; try { c.preview = await api(`/recipes/${c.recipe.id}/cook`, { method: 'POST', body: { scale: c.scale } }); const names = new Set(c.preview.missing.concat(c.preview.unsure).map((m) => m.ingredient)); Object.keys(c.resolve).forEach((k) => { if (!names.has(k)) delete c.resolve[k]; }); render(); } catch (e) { flash(e.message, true); } }
  const askList = () => S.cook.preview.missing.concat(S.cook.preview.unsure);

  function onClick(ev) {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act, id = t.dataset.id;
    if (a === 'cook-close-bg' && ev.target.closest('[data-stop]')) return;
    if (t.tagName === 'BUTTON' && t.closest('summary')) ev.preventDefault();
    if (a === 'tab') { S.tab = t.dataset.tab; S.err = ''; render(); if (S.tab === 'assistant') loadChat(); }
    else if (a === 'add-open') { S.addOpen = !S.addOpen; render(); }
    else if (a === 'recipe-open') { S.recipeOpen = !S.recipeOpen; render(); }
    else if (a === 'plan-open') { S.planOpen = S.planOpen === t.dataset.date ? null : t.dataset.date; render(); }
    else if (a === 'plan-close') { S.planOpen = null; render(); }
    else if (a === 'plan-del') run(api(`/plan/${id}`, { method: 'DELETE' }));
    else if (a === 'recipe-del') run(api(`/recipes/${id}`, { method: 'DELETE' }), 'Recipe deleted.');
    else if (a === 'item-open') { S.editId = S.editId === id ? null : id; render(); }
    else if (a === 'item-use') { const q = Number((document.getElementById('kit-use-' + id) || {}).value); run(api(`/items/${id}/use`, { method: 'POST', body: { qty: q } }), 'Updated.'); }
    else if (a === 'item-move') run(api(`/items/${id}`, { method: 'PATCH', body: { location: t.dataset.to } }), `Moved to the ${t.dataset.to}. Its use-by date was worked out again.`);
    else if (a === 'item-del') { S.editId = null; run(api(`/items/${id}?reason=${encodeURIComponent(t.textContent.trim() === 'Toss' ? 'tossed' : 'removed')}`, { method: 'DELETE' }), 'Removed.'); }
    else if (a === 'ask' || a === 'chip') { const q = t.dataset.q; if (q.endsWith(': ')) { S.tab = 'assistant'; render(); loadChat(); const ta = document.getElementById('kit-input'); if (ta) { ta.value = q; ta.focus(); } } else { loadChat().then(() => send(q)); } }
    else if (a === 'chat-clear') run(api('/assistant', { method: 'DELETE' })).then(() => { S.chat = []; render(); });
    else if (a === 'cook') openCook(id, t.dataset.plan || null);
    else if (a === 'kw') run(api(`/keywords/suggestions/${id}`, { method: 'POST', body: { action: t.dataset.do } }), t.dataset.do === 'add' ? 'Keyword added.' : 'Skipped.');
    else if (a === 'cook-close' || a === 'cook-close-bg') { S.cook = null; render(); }
    else if (a === 'res-bought') { const m = askList()[Number(t.dataset.i)]; S.cook.resolve[m.ingredient] = { bought: m.short != null ? m.short : (m.qty || 1), unit: m.unit || '' }; render(); }
    else if (a === 'res-skip') { const m = askList()[Number(t.dataset.i)]; S.cook.resolve[m.ingredient] = 'skip'; render(); }
    else if (a === 'cook-go') {
      const c = S.cook;
      api(`/recipes/${c.recipe.id}/cook`, { method: 'POST', body: { apply: true, scale: c.scale, planId: c.planId, resolve: c.resolve } }).then((r) => {
        if (!r.applied) { c.preview = r; flash('Something changed; check the questions again.', true); return; }
        S.v = r.state; S.cook = null;
        flash(`Cooked ${c.recipe.name}. ${r.used.length ? 'Updated: ' + r.used.map((u) => `${u.name} ${u.gone ? 'used up' : qty(u.left) + ' left'}`).join(', ') + '.' : ''}`);
      }).catch((e) => flash(e.message, true));
    }
  }
  function onInput(ev) {
    const t = ev.target;
    if (t.dataset.typeFor && ev.type === 'change') { const lab = (S.v.types.find((x) => x.id === t.value) || {}).label; run(api(`/items/${t.dataset.typeFor}`, { method: 'PATCH', body: { category: t.value } }), `Changed to ${lab}; its date was worked out again. Thanks, that helps the keyword list learn.`); return; }
    if (t.dataset.cookScale) { S.cook.scale = Math.max(0.25, Number(t.value) || 1); if (ev.type === 'change') rePreview(); }
    if (t.dataset.resQty != null) { const m = askList()[Number(t.dataset.resQty)]; S.cook.resolve[m.ingredient].bought = Number(t.value) || 0; }
    if (t.dataset.resUnit != null) { const m = askList()[Number(t.dataset.resUnit)]; S.cook.resolve[m.ingredient].unit = t.value; }
  }
  function onSubmit(ev) {
    const f = ev.target.closest('form[data-form]'); if (!f) return;
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    const kind = f.dataset.form;
    if (kind === 'chat') send((document.getElementById('kit-input') || {}).value || '');
    else if (kind === 'item') {
      S.msg = 'Adding…'; render();
      run(api('/items', { method: 'POST', body: { name: fd.name, qty: fd.qty, unit: fd.unit, location: fd.location, expiresOn: fd.expiresOn || undefined, lowAt: fd.lowAt === '' ? undefined : fd.lowAt } })).then((r) => {
        if (!r) return;
        const it = r.item; S.addOpen = false;
        flash(it.typeSource === 'pending' ? `Added ${it.name}. Working out what kind of food it is; its date will update in a moment.` : `Added ${it.name}: ${it.typeLabel}${it.expiresOn ? `, good through ${dayName(it.expiresOn)}` : ''}${it.expirySource === 'label' ? ' (your date)' : ''}. Wrong type? Tap it to change.`);
        if (it.typeSource === 'pending') setTimeout(load, 15000);
      });
    }
    else if (kind === 'recipe') {
      const ingredients = String(fd.ingredients || '').split('\n').map(parseIngredient).filter(Boolean);
      run(api('/recipes', { method: 'POST', body: { name: fd.name, servings: fd.servings, ingredients, steps: fd.steps } }), `Saved ${fd.name}.`).then((r) => { if (r) { S.recipeOpen = false; render(); } });
    } else if (kind === 'plan') run(api('/plan', { method: 'POST', body: { date: f.dataset.date, meal: fd.meal, recipeId: fd.recipeId || undefined, title: fd.title || undefined } })).then((r) => { if (r) { S.planOpen = null; render(); } });
  }
  function onKey(ev) { if (ev.target.id === 'kit-input' && ev.key === 'Enter' && !ev.shiftKey && window.matchMedia('(min-width: 768px)').matches) { ev.preventDefault(); send(ev.target.value); } }

  let wired = false;
  function show() {
    const el = root(); if (!el) return;
    if (!wired) { wired = true; el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('change', onInput); el.addEventListener('submit', onSubmit); el.addEventListener('keydown', onKey); }
    render(); load(); if (S.tab === 'assistant') loadChat();
  }
  window.AdaKitchen = { show, parseIngredient };
})();
