/*
 * nutrition-tab.js — the Nutrition tab (admin and 303 accounts; guests never see it).
 * Everything here talks to /api/nutrition, which only ever returns the signed-in person's
 * own data. Four sections: Today (food log), History (charts), Coach (AI chat and saved plans),
 * Profile (body details, targets). Phone first: one column, big tap targets, 16px inputs.
 */
(function () {
  'use strict';
  const root = () => document.getElementById('nutrition-root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, opts) => {
    const o = Object.assign({}, opts);
    if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers); }
    const r = await fetch(url, o);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(b.error || `HTTP ${r.status}`); e.status = r.status; e.body = b; throw e; }
    return b;
  };

  const NUTS = [
    { k: 'calories', label: 'Calories', unit: 'kcal', main: true },
    { k: 'protein', label: 'Protein', unit: 'g', main: true, color: '#6366f1' },
    { k: 'carbs', label: 'Carbs', unit: 'g', main: true, color: '#f59e0b' },
    { k: 'fat', label: 'Fat', unit: 'g', main: true, color: '#ec4899' },
    { k: 'fiber', label: 'Fibre', unit: 'g', color: '#10b981' },
    { k: 'sugar', label: 'Sugar', unit: 'g', limit: true, color: '#f97316' },
    { k: 'sodium', label: 'Sodium', unit: 'mg', limit: true, color: '#06b6d4' },
  ];
  const MEALS = [['breakfast', 'Breakfast', 'fa-mug-hot'], ['lunch', 'Lunch', 'fa-bowl-food'], ['dinner', 'Dinner', 'fa-utensils'], ['snack', 'Snacks', 'fa-cookie-bite']];
  const ACTIVITY = [['sedentary', 'Sedentary (desk job, little exercise)'], ['light', 'Light (exercise 1-3 days a week)'], ['moderate', 'Moderate (3-5 days a week)'], ['active', 'Active (6-7 days a week)'], ['very_active', 'Very active (hard training or physical job)']];

  const card = 'rounded-2xl border border-gray-200 dark:border-dark-border bg-white dark:bg-dark-card';
  const btn = 'px-4 py-2.5 rounded-xl text-sm font-medium transition-colors min-h-[44px]';
  const primary = `${btn} bg-indigo-600 hover:bg-indigo-500 text-white`;
  const ghost = `${btn} border border-gray-300 dark:border-white/10 text-gray-300 hover:bg-black/5 dark:hover:bg-white/5`;   // gray-300 is remapped to a readable slate in the light theme
  const input = 'w-full rounded-xl border border-gray-300 dark:border-white/10 bg-transparent px-3 py-2.5 text-base min-h-[44px] focus:outline-none focus:ring-2 focus:ring-indigo-500';
  const label = 'block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1';

  const S = { tab: 'today', date: null, day: null, profile: null, targets: null, computed: null, hist: null, coach: null, plans: [], foods: [], limit: null, busy: false, sheet: null, err: '', msg: '', openPlan: null, loaded: false, view: null, wiz: null, ws: null, gs: null, dayWorkouts: [], lastChanges: [], jobKind: null, autoTried: false, skipSetup: false, autoRev: false, help: {}, more: {}, nutOpen: null };

  const r0 = (n) => Math.round(n);
  const r1 = (n) => Math.round(n * 10) / 10;
  const LB = 0.45359237;
  const kgToLb = (kg) => kg / LB;
  const lbToKg = (lb) => lb * LB;
  const cmToFtIn = (cm) => { const t = cm / 2.54; let ft = Math.floor(t / 12); let inch = Math.round(t - ft * 12); if (inch === 12) { ft += 1; inch = 0; } return [ft, inch]; };
  const ftInToCm = (ft, inch) => (Number(ft) * 12 + Number(inch || 0)) * 2.54;
  const fmt = (n, k) => (k === 'sodium' ? String(r0(n)).replace(/\B(?=(\d{3})+$)/g, ',') : String(r0(n)));

  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const shiftDate = (d, n) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const dayWords = (d) => {
    const t = localToday();
    if (d === t) return 'Today';
    if (d === shiftDate(t, -1)) return 'Yesterday';
    if (d === shiftDate(t, 1)) return 'Tomorrow';
    return new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };

  function md(text) {
    if (typeof marked === 'undefined') return `<div style="white-space:pre-wrap">${esc(text)}</div>`;
    const r = new marked.Renderer();
    r.html = (t) => esc(typeof t === 'string' ? t : (t && (t.text || t.raw)) || '');   // never render raw HTML
    const link = r.link;
    r.link = function (a, b, c) { const h = link.apply(this, arguments); return String(h).replace('<a ', '<a target="_blank" rel="noopener noreferrer" '); };
    return window.safeHtml(marked.parse(String(text || ''), { renderer: r, breaks: true }));   // and no javascript: links (2026-11-25)
  }
  const prose = 'prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-a:text-indigo-500';

  // ------------------------------------------------------------ loading
  async function loadAll() {
    S.err = '';
    try {
      const [v, day, foods, plans, dw] = await Promise.all([api('/api/nutrition/state'), api('/api/nutrition/day?date=' + S.date), api('/api/nutrition/foods'), api('/api/nutrition/plans'), api('/api/nutrition/workouts?from=' + S.date + '&to=' + S.date)]);
      S.view = v; applyView(); S.day = day; S.foods = foods; S.plans = plans; S.dayWorkouts = dw; S.loaded = true;
      if (!v.setup.done && !S.skipSetup && !S.wiz) S.wiz = newWiz(false);
    } catch (e) { S.err = e.message; }
    render();
    if (S.view && S.view.reviewDue && !S.autoTried && !S.busy) { S.autoTried = true; S.autoRev = true; startReview(true); }
  }
  async function loadDay() { try { S.day = await api('/api/nutrition/day?date=' + S.date); S.targets = S.day.targets; await loadDayWorkouts(); } catch (e) { S.err = e.message; } render(); }
  async function loadHistory() { try { S.hist = await api('/api/nutrition/history?days=30'); } catch (e) { S.err = e.message; } render(); }
  async function loadCoach() {
    try { S.coach = await api('/api/nutrition/coach'); S.limit = S.coach.limit; if (S.coach.busy) { S.busy = true; pollCoach(); } } catch (e) { S.err = e.message; }
    render();
    scrollChat();
  }

  // ------------------------------------------------------------ shared pieces
  function bar(k, total, target, h = 'h-2') {
    const n = NUTS.find((x) => x.k === k);
    const pct = target ? Math.min(100, (total / target) * 100) : 0;
    const over = target && total > target;
    const col = over && (n.limit || k === 'calories') ? '#ef4444' : (n.color || '#6366f1');
    return `<div class="${h} rounded-full bg-black/10 dark:bg-white/10 overflow-hidden" role="progressbar" aria-valuenow="${r0(total)}" aria-valuemax="${target ? r0(target) : 0}" aria-label="${esc(n.label)}"><div class="${h} rounded-full" style="width:${pct}%;background:${col}"></div></div>`;
  }
  function note(kind) {
    const text = kind === 'err' ? S.err : S.msg;
    if (!text) return '';
    return `<div class="${kind === 'err' ? 'bg-rose-500/10 text-rose-500 border-rose-500/30' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'} border rounded-xl px-3 py-2 text-sm flex justify-between gap-3" role="${kind === 'err' ? 'alert' : 'status'}"><span>${esc(text)}</span><button data-act="dismiss" aria-label="Dismiss" class="shrink-0 px-2">&times;</button></div>`;
  }

  // ------------------------------------------------------------ Today
  // Tap a bar to see which foods made up the day's total, largest first.
  function breakdownHtml(k) {
    if (S.nutOpen !== k || !S.day || !S.day.breakdown) return '';
    const n = NUTS.find((x) => x.k === k), rows = S.day.breakdown[k] || [];
    const unit = n.unit;
    const list = rows.length ? `<ul class="divide-y divide-gray-200 dark:divide-white/10">${rows.slice(0, 15).map((r) => `<li class="py-1.5 flex items-start justify-between gap-3"><span class="min-w-0"><span class="block text-sm truncate">${esc(r.name)}</span><span class="block text-xs text-gray-500 dark:text-gray-400">${esc(r.servings)} × ${esc(r.serving || 'serving')} · ${esc({ breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' }[r.meal] || '')}</span></span><span class="shrink-0 text-right"><span class="block text-sm font-medium">${fmt(r.amount, k)} ${unit}</span><span class="block text-xs text-gray-500 dark:text-gray-400">${r.share}% of today</span></span></li>`).join('')}</ul>${rows.length > 15 ? `<p class="text-xs text-gray-500">and ${rows.length - 15} more</p>` : ''}` : `<p class="text-sm text-gray-500 dark:text-gray-400">Nothing logged with ${esc(n.label.toLowerCase())} yet.</p>`;
    const ks = S.day.breakdown.kcalShare && S.day.breakdown.kcalShare[k];
    const per = { protein: 4, carbs: 4, fat: 9 }[k];
    const calLine = ks ? `<p class="text-sm mt-2">${esc(n.label)}: ${fmt(ks.grams, k)} g × ${per} kcal = ${fmt(ks.kcal)} kcal, which is <b>${ks.pct}%</b> of today's calories.</p><p class="text-xs text-gray-500 dark:text-gray-400">Fat has 9 kcal per gram, while protein and carbs have 4. That is why fat can be a small share of the grams and a bigger share of the calories.</p>` : '';
    return `<div class="mt-2 rounded-xl bg-black/5 dark:bg-white/5 p-3" data-breakdown="${k}"><div class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Where today's ${esc(n.label.toLowerCase())} came from</div>${list}${calLine}</div>`;
  }
  const nutBtn = (k, inner, cls) => `<div role="button" tabindex="0" data-act="nut" data-k="${k}" aria-expanded="${S.nutOpen === k}" aria-label="Show where today's ${k} came from" class="cursor-pointer ${cls || ''}">${inner}</div>`;

  function renderToday() {
    const d = S.day, t = S.targets;
    const tot = d ? d.totals : {};
    const cal = tot.calories || 0;
    const left = t && t.calories ? t.calories - cal : null;
    const ring = (() => {
      const R = 52, C = 2 * Math.PI * R;
      const pct = t && t.calories ? Math.min(1, cal / t.calories) : 0;
      const over = t && t.calories && cal > t.calories;
      return `<svg viewBox="0 0 120 120" class="w-32 h-32 shrink-0" role="img" aria-label="${r0(cal)} of ${t ? t.calories : '?'} calories"><circle cx="60" cy="60" r="${R}" fill="none" stroke="currentColor" stroke-opacity=".12" stroke-width="10"/><circle cx="60" cy="60" r="${R}" fill="none" stroke="${over ? '#ef4444' : '#6366f1'}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" transform="rotate(-90 60 60)"/><text x="60" y="58" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor">${fmt(cal)}</text><text x="60" y="76" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".6">kcal eaten</text></svg>`;
    })();
    const macroRow = (k) => {
      const n = NUTS.find((x) => x.k === k);
      const tv = t ? t[k] : 0;
      return `<div>${nutBtn(k, `<div class="flex justify-between text-sm mb-1"><span class="font-medium">${n.label} <i class="fa-solid fa-chevron-${S.nutOpen === k ? 'up' : 'down'} text-[10px] text-gray-400"></i></span><span class="text-gray-500 dark:text-gray-400">${fmt(tot[k] || 0, k)}${tv ? ' / ' + fmt(tv, k) : ''} ${n.unit}</span></div>${bar(k, tot[k] || 0, tv)}`, 'py-1')}${breakdownHtml(k)}</div>`;
    };
    const extras = ['fiber', 'sugar', 'sodium'].map((k) => {
      const n = NUTS.find((x) => x.k === k); const tv = t ? t[k] : 0;
      return `<div>${nutBtn(k, `<div class="flex justify-between text-xs mb-1 text-gray-500 dark:text-gray-400"><span>${n.label}${n.limit ? ' (limit)' : ''} <i class="fa-solid fa-chevron-${S.nutOpen === k ? 'up' : 'down'} text-[9px]"></i></span><span>${fmt(tot[k] || 0, k)}${tv ? ' / ' + fmt(tv, k) : ''} ${n.unit}</span></div>${bar(k, tot[k] || 0, tv, 'h-1.5')}`, 'py-1.5')}${breakdownHtml(k)}</div>`;
    }).join('');
    const summary = `<div class="${card} p-4 space-y-4">
      <div role="button" tabindex="0" data-act="nut" data-k="calories" aria-expanded="${S.nutOpen === 'calories'}" aria-label="Show where today's calories came from" class="flex items-center gap-4 cursor-pointer">${ring}
        <div class="min-w-0"><div class="text-sm text-gray-500 dark:text-gray-400">${t && t.calories ? 'Target ' + fmt(t.calories) + ' kcal' : 'No target yet'}</div>
        <div class="text-2xl font-bold ${left !== null && left < 0 ? 'text-rose-500' : ''}">${left === null ? '&nbsp;' : (left >= 0 ? fmt(left) + ' left' : fmt(-left) + ' over')}</div>
        ${t ? '' : '<button data-act="goto" data-tab="profile" class="mt-1 text-sm text-indigo-500 underline">Set up your profile to get targets</button>'}${t ? `<div class="mt-1 text-xs text-indigo-500">${S.nutOpen === 'calories' ? 'Hide' : 'Tap for where it came from'}</div>` : ''}</div></div>${breakdownHtml('calories')}
      <div class="grid gap-3">${['protein', 'carbs', 'fat'].map(macroRow).join('')}</div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 border-t border-gray-200 dark:border-white/10">${extras}</div></div>`;
    const meals = MEALS.map(([m, name, icon]) => {
      const es = d ? d.entries.filter((e) => e.meal === m) : [];
      const sub = es.reduce((a, e) => a + e.total.calories, 0);
      return `<section class="${card} overflow-hidden"><div class="flex items-center justify-between px-4 py-3"><h3 class="font-semibold flex items-center gap-2"><i class="fa-solid ${icon} text-indigo-500 w-5 text-center"></i>${name}</h3><div class="flex items-center gap-3"><span class="text-sm text-gray-500 dark:text-gray-400">${es.length ? fmt(sub) + ' kcal' : ''}</span><button data-act="add" data-meal="${m}" class="${primary} !px-3 !py-1.5 !min-h-[40px]" aria-label="Add food to ${name}"><i class="fa-solid fa-plus"></i> Add</button></div></div>
        ${es.map((e) => `<button data-act="edit" data-id="${esc(e.id)}" class="w-full text-left px-4 py-3 border-t border-gray-200 dark:border-white/10 flex justify-between gap-3 hover:bg-black/5 dark:hover:bg-white/5 min-h-[52px]"><span class="min-w-0"><span class="block truncate">${esc(e.name)}</span><span class="block text-xs text-gray-500 dark:text-gray-400">${esc(e.servings)} &times; ${esc(e.serving || 'serving')} &middot; P ${r0(e.total.protein)} C ${r0(e.total.carbs)} F ${r0(e.total.fat)}</span></span><span class="shrink-0 font-medium">${fmt(e.total.calories)}</span></button>`).join('')}</section>`;
    }).join('');
    return `<div class="flex items-center justify-between gap-2"><button data-act="day" data-n="-1" class="${ghost} !px-4" aria-label="Previous day"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="text-center"><div class="font-semibold text-lg">${esc(dayWords(S.date))}</div>${S.date !== localToday() ? `<button data-act="day" data-n="0" class="text-xs text-indigo-500">Back to today</button>` : `<div class="text-xs text-gray-500 dark:text-gray-400">${esc(S.date)}</div>`}</div>
      <button data-act="day" data-n="1" class="${ghost} !px-4" aria-label="Next day"><i class="fa-solid fa-chevron-right"></i></button></div>${summary}${energyCard()}${renderTodayWorkout()}${meals}`;
  }

  // ------------------------------------------------------------ add / edit sheet
  function openSheet(opts) {
    const e = opts.entry;
    S.sheet = {
      id: e ? e.id : null, meal: e ? e.meal : opts.meal, name: e ? e.name : '', servings: e ? e.servings : 1, serving: e ? e.serving : '',
      per: Object.assign({ calories: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', sodium: '' }, e ? e.per : {}),
      results: [], q: '', searching: false, searchErr: '', chosen: null, portion: 0, saveFood: false, source: e ? e.source : 'manual',
    };
    render();
  }
  function sheetHtml() {
    const s = S.sheet; if (!s) return '';
    const field = (k, l, u) => `<div><label class="${label}" for="nf-${k}">${l} (${u})</label><input id="nf-${k}" data-f="per.${k}" type="number" inputmode="decimal" min="0" step="any" class="${input}" value="${esc(s.per[k])}"></div>`;
    const results = s.results.map((f, i) => `<button data-act="pick" data-i="${i}" class="w-full text-left px-3 py-2.5 rounded-xl border border-gray-200 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 ${s.chosen && s.chosen.id === f.id ? 'ring-2 ring-indigo-500' : ''}"><span class="block text-sm font-medium">${esc(f.name)}${f.brand ? ' <span class="text-gray-500 font-normal">· ' + esc(f.brand) + '</span>' : ''}</span><span class="block text-xs text-gray-500 dark:text-gray-400">per 100 g: ${r0(f.per100.calories)} kcal · P ${r0(f.per100.protein)} · C ${r0(f.per100.carbs)} · F ${r0(f.per100.fat)}</span></button>`).join('');
    const myFoods = S.foods.length ? `<div><div class="${label}">My foods</div><div class="flex flex-wrap gap-2">${S.foods.map((f, i) => `<button data-act="myfood" data-i="${i}" class="px-3 py-2 rounded-full text-sm border border-gray-300 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 min-h-[40px]">${esc(f.name)}</button>`).join('')}</div></div>` : '';
    return `<div class="fixed inset-0 z-[1100] bg-black/70 flex items-end sm:items-center justify-center" data-act="sheet-bg">
      <div class="bg-white dark:bg-dark-card w-full sm:max-w-lg max-h-[94vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-4 space-y-4" role="dialog" aria-modal="true" aria-label="${s.id ? 'Edit food' : 'Add food'}">
        <div class="flex items-center justify-between"><h3 class="font-semibold text-lg">${s.id ? 'Edit food' : 'Add food'}</h3><button data-act="sheet-close" class="px-3 py-2 text-2xl leading-none" aria-label="Close">&times;</button></div>
        ${s.searchErr ? `<div class="text-sm text-rose-500">${esc(s.searchErr)}</div>` : ''}
        <div><label class="${label}" for="nf-meal">Meal</label><select id="nf-meal" data-f="meal" class="${input}">${MEALS.map(([m, n]) => `<option value="${m}" ${s.meal === m ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        ${s.id ? '' : `<div><label class="${label}" for="nf-q">Search foods (USDA)</label><div class="flex gap-2"><input id="nf-q" data-f="q" type="search" enterkeyhint="search" placeholder="e.g. banana, oats, chicken breast" class="${input}" value="${esc(s.q)}"><button data-act="search" class="${primary}" aria-label="Search">${s.searching ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-magnifying-glass"></i>'}</button></div>
          <label class="mt-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><input type="checkbox" data-f="brands" ${s.brands ? 'checked' : ''}> Include packaged / brand-name foods</label></div>
          ${results ? `<div class="space-y-2">${results}</div>` : ''}${myFoods}`}
        ${s.chosen ? `<div><label class="${label}" for="nf-portion">Portion</label><select id="nf-portion" data-f="portion" class="${input}">${s.chosen.portions.map((p, i) => `<option value="${i}" ${s.portion === i ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>` : ''}
        <div class="grid grid-cols-2 gap-3"><div class="col-span-2"><label class="${label}" for="nf-name">Food</label><input id="nf-name" data-f="name" class="${input}" value="${esc(s.name)}" maxlength="120"></div>
          <div><label class="${label}" for="nf-servings">Servings</label><input id="nf-servings" data-f="servings" type="number" inputmode="decimal" min="0.01" step="any" class="${input}" value="${esc(s.servings)}"></div>
          <div><label class="${label}" for="nf-serving">Serving size</label><input id="nf-serving" data-f="serving" class="${input}" value="${esc(s.serving)}" placeholder="1 cup" maxlength="60"></div></div>
        <div><div class="text-xs text-gray-500 dark:text-gray-400 mb-2">Nutrients <b>per serving</b> (filled in from the search; type your own if you like)</div>
          <div class="grid grid-cols-2 gap-3">${field('calories', 'Calories', 'kcal')}${field('protein', 'Protein', 'g')}${field('carbs', 'Carbs', 'g')}${field('fat', 'Fat', 'g')}${field('fiber', 'Fibre', 'g')}${field('sugar', 'Sugar', 'g')}${field('sodium', 'Sodium', 'mg')}</div></div>
        ${s.id ? '' : `<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-f="saveFood" ${s.saveFood ? 'checked' : ''}> Save to My foods for next time</label>`}
        <div class="flex gap-2 pt-1 sticky bottom-0 bg-white dark:bg-dark-card pb-1">${s.id ? `<button data-act="del-entry" class="${ghost} !text-rose-500">Delete</button>` : ''}<button data-act="sheet-close" class="${ghost} flex-1">Cancel</button><button data-act="save-entry" class="${primary} flex-1">${s.id ? 'Save' : 'Add to log'}</button></div>
      </div></div>`;
  }
  function applyPortion() {
    const s = S.sheet; if (!s.chosen) return;
    const p = s.chosen.portions[s.portion] || s.chosen.portions[0];
    const f = p.grams / 100;
    ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'].forEach((k) => { s.per[k] = r1((s.chosen.per100[k] || 0) * f); });
    s.serving = p.label;
  }
  async function doSearch() {
    const s = S.sheet; if (!s || s.q.trim().length < 2) return;
    s.searching = true; s.searchErr = ''; keepScroll(render);
    try { s.results = await api('/api/food-lookup?q=' + encodeURIComponent(s.q.trim()) + (s.brands ? '&brands=1' : '')); if (!s.results.length) s.searchErr = 'Nothing found. Try another word, or type the numbers in below.'; }
    catch (e) { s.searchErr = e.message; s.results = []; }
    s.searching = false; keepScroll(render);
  }
  function keepScroll(fn) {
    const sheet = document.querySelector('[data-act="sheet-bg"] > div');
    const top = sheet ? sheet.scrollTop : 0;
    const focusId = document.activeElement && document.activeElement.id;
    fn();
    const again = document.querySelector('[data-act="sheet-bg"] > div'); if (again) again.scrollTop = top;
    if (focusId) { const el = document.getElementById(focusId); if (el && el.focus) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } }
  }
  async function saveEntry() {
    const s = S.sheet;
    const body = { date: S.date, meal: s.meal, name: s.name, servings: s.servings, serving: s.serving, per: s.per, source: s.chosen ? 'usda' : (s.source || 'manual'), saveFood: s.saveFood };
    try {
      if (s.id) { delete body.date; delete body.saveFood; await api('/api/nutrition/entries/' + s.id, { method: 'PATCH', body }); } else await api('/api/nutrition/entries', { method: 'POST', body });
      S.sheet = null; S.err = '';
      if (S.coach) refreshLogged();
      if (body.saveFood) S.foods = await api('/api/nutrition/foods');
      await loadDay();
    } catch (e) { s.searchErr = e.message; keepScroll(render); }
  }

  // ------------------------------------------------------------ History
  function barChart(days, key, target, color, unit) {
    const W = 360, H = 190, L = 34, B = 22, T = 10, R = 6;
    const vals = days.map((d) => (d.logged ? d.totals[key] : 0));
    const max = Math.max(target || 0, ...vals, key === 'calories' ? 500 : 50) * 1.1;
    const bw = (W - L - R) / days.length;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const ticks = [0, 0.5, 1].map((f) => max / 1.1 * f);
    const bars = days.map((d, i) => {
      const v = vals[i]; const x = L + i * bw + bw * 0.14; const w = bw * 0.72;
      const over = target && v > target * 1.1;
      return d.logged ? `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(H - B - y(v)).toFixed(1)}" rx="2" fill="${over ? '#ef4444' : color}"><title>${esc(d.date)}: ${fmt(v)} ${unit}</title></rect>` : `<rect x="${x.toFixed(1)}" y="${H - B - 2}" width="${w.toFixed(1)}" height="2" fill="currentColor" fill-opacity=".2"><title>${esc(d.date)}: nothing logged</title></rect>`;
    }).join('');
    const xl = days.map((d, i) => (i % 7 === 3 || i === days.length - 1 ? `<text x="${(i === days.length - 1 ? W - R : L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="${i === days.length - 1 ? 'end' : 'middle'}" font-size="11" fill="currentColor" fill-opacity=".6">${esc(d.date.slice(5))}</text>` : '')).join('');
    const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="currentColor" stroke-opacity=".1"/><text x="${L - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${r0(v)}</text>`).join('');
    const tl = target ? `<line x1="${L}" x2="${W - R}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}" stroke="#10b981" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W - R}" y="${(y(target) - 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#10b981">target ${fmt(target)}</text>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto max-w-[480px] mx-auto block" role="img" aria-label="Daily ${key} for the last ${days.length} days">${grid}${bars}${tl}${xl}</svg>`;
  }
  function weightChart(ws, units) {
    if (ws.length < 2) return '<p class="text-sm text-gray-500 dark:text-gray-400">Log at least two weigh-ins to see the trend.</p>';
    const conv = (kg) => (units === 'imperial' ? kgToLb(kg) : kg);
    const W = 360, H = 170, L = 36, B = 22, T = 12, R = 10;
    const vs = ws.map((w) => conv(w.kg)); const lo = Math.min(...vs) - 1, hi = Math.max(...vs) + 1;
    const t0 = Date.parse(ws[0].date), t1 = Date.parse(ws[ws.length - 1].date) || t0 + 1;
    const x = (d) => L + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const pts = ws.map((w) => `${x(w.date).toFixed(1)},${y(conv(w.kg)).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto max-w-[480px] mx-auto block" role="img" aria-label="Weight trend"><line x1="${L}" x2="${W - R}" y1="${y(lo + 1)}" y2="${y(lo + 1)}" stroke="currentColor" stroke-opacity=".1"/><text x="${L - 4}" y="${y(lo + 1) + 3}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${r1(lo + 1)}</text><text x="${L - 4}" y="${y(hi - 1) + 3}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${r1(hi - 1)}</text><polyline points="${pts}" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linejoin="round"/>${ws.map((w) => `<circle cx="${x(w.date).toFixed(1)}" cy="${y(conv(w.kg)).toFixed(1)}" r="3.5" fill="#6366f1"><title>${esc(w.date)}: ${r1(conv(w.kg))} ${units === 'imperial' ? 'lb' : 'kg'}</title></circle>`).join('')}<text x="${L}" y="${H - 6}" font-size="11" fill="currentColor" fill-opacity=".6">${esc(ws[0].date.slice(5))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${esc(ws[ws.length - 1].date.slice(5))}</text></svg>`;
  }
  function renderHistory() {
    const h = S.hist;
    if (!h) return '<div class="text-sm text-gray-500 p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
    const logged = h.days.filter((d) => d.logged);
    const avg = (k) => (logged.length ? logged.reduce((a, d) => a + d.totals[k], 0) / logged.length : 0);
    const t = h.targets || {};
    const units = (S.profile && S.profile.units) || 'imperial';
    const stat = (l, v) => `<div class="${card} p-3 text-center"><div class="text-xl font-bold">${v}</div><div class="text-xs text-gray-500 dark:text-gray-400">${l}</div></div>`;
    const w = h.weights; const wl = w.length ? w[w.length - 1] : null;
    return `<div class="grid grid-cols-3 gap-3">${stat('days logged', logged.length + ' / ' + h.days.length)}${stat('avg kcal / logged day', fmt(avg('calories')))}${stat('avg protein (g)', fmt(avg('protein')))}</div>
      <section class="${card} p-4"><h3 class="font-semibold mb-2">Calories, last 30 days</h3>${barChart(h.days, 'calories', t.calories, '#6366f1', 'kcal')}<p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Red bars are more than 10% over target. Flat grey marks are days with nothing logged.</p></section>
      <section class="${card} p-4"><h3 class="font-semibold mb-2">Protein, last 30 days</h3>${barChart(h.days, 'protein', t.protein, '#10b981', 'g')}</section>
      ${deficitCard()}
      ${workoutList(h)}
      <section class="${card} p-4 space-y-3"><h3 class="font-semibold">Weight</h3>${weightChart(w, units)}
        <form data-form="weight" class="flex gap-2 items-end"><div class="flex-1"><label class="${label}" for="w-val">Today's weight (${units === 'imperial' ? 'lb' : 'kg'})</label><input id="w-val" name="w" type="number" inputmode="decimal" step="any" min="1" required class="${input}" placeholder="${wl ? r1(units === 'imperial' ? kgToLb(wl.kg) : wl.kg) : ''}"></div><button class="${primary}">Log</button></form>
        ${w.length ? `<div class="text-xs text-gray-500 dark:text-gray-400">${w.slice(-5).reverse().map((x) => `<span class="inline-flex items-center gap-1 mr-3">${esc(x.date)}: ${r1(units === 'imperial' ? kgToLb(x.kg) : x.kg)} <button data-act="del-weight" data-id="${esc(x.id)}" class="text-rose-500 px-1" aria-label="Delete weigh-in ${esc(x.date)}">&times;</button></span>`).join('')}</div>` : ''}</section>
      <section class="${card} p-4 space-y-3"><h3 class="font-semibold">Waist</h3>${waistChart(h.waists || [])}
        <form data-form="waist" class="flex gap-2 items-end"><div class="flex-1"><label class="${label}" for="wa-val">Today's waist (${waistUnit()})</label><input id="wa-val" name="wa" type="number" inputmode="decimal" step="any" min="1" required class="${input}" placeholder="${(h.waists || []).length ? fromCm(h.waists[h.waists.length - 1].cm) : ''}"></div><button class="${primary}">Log</button></form>
        <p class="text-xs text-gray-500 dark:text-gray-400">How to measure: stand relaxed, wrap the tape around your belly at the belly button, snug but not squeezing, and read it after a normal breath out. Same time of day each time.</p>
        ${(h.waists || []).length ? `<div class="text-xs text-gray-500 dark:text-gray-400">${h.waists.slice(-5).reverse().map((x) => `<span class="inline-flex items-center gap-1 mr-3">${esc(x.date)}: ${fromCm(x.cm)} <button data-act="del-waist" data-id="${esc(x.id)}" class="text-rose-500 px-1" aria-label="Delete waist entry ${esc(x.date)}">&times;</button></span>`).join('')}</div>` : ''}</section>`;
  }

  // ------------------------------------------------------------ Coach
  function renderCoach() {
    const c = S.coach;
    if (!c) return '<div class="text-sm text-gray-500 p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
    const lim = S.limit;
    const limText = !lim ? '' : lim.unlimited ? 'No daily limit' : `${lim.left} of ${lim.limit} Coach messages left today`;
    const out = lim && !lim.unlimited && lim.left <= 0;
    const msgs = c.messages.map((m, i) => m.role === 'user'
      ? `<div class="flex justify-end"><div class="max-w-[88%] rounded-2xl rounded-br-md bg-indigo-600 text-white px-3.5 py-2.5 text-[15px] whitespace-pre-wrap break-words">${esc(m.content)}</div></div>`
      : `<div class="flex justify-start"><div class="max-w-[94%] rounded-2xl rounded-bl-md bg-black/5 dark:bg-white/10 px-3.5 py-2.5 text-[15px] break-words"><div class="${prose}">${md(m.content)}</div>${logCardsHtml(m)}<div class="flex flex-wrap gap-2 mt-2 pt-2 border-t border-black/10 dark:border-white/10"><button data-act="saveplan" data-i="${i}" data-type="diet" class="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-white/20 min-h-[36px]"><i class="fa-solid fa-bookmark"></i> Save as diet plan</button><button data-act="saveplan" data-i="${i}" data-type="workout" class="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-white/20 min-h-[36px]"><i class="fa-solid fa-dumbbell"></i> Save as workout plan</button></div></div></div>`).join('');
    const chips = ['Make me a 7-day meal plan for my targets', 'Make me a 4-week workout plan', 'How was my eating this week?', 'What should I eat for dinner tonight?'];
    const plans = S.plans.length ? S.plans.map((p) => `<div class="${card} overflow-hidden"><button data-act="toggle-plan" data-id="${esc(p.id)}" class="w-full text-left px-4 py-3 flex items-center justify-between gap-3 min-h-[52px]"><span class="min-w-0"><span class="block font-medium truncate"><i class="fa-solid ${p.type === 'diet' ? 'fa-bowl-food' : 'fa-dumbbell'} text-indigo-500 mr-2"></i>${esc(p.title)}</span><span class="block text-xs text-gray-500 dark:text-gray-400">${p.type === 'diet' ? 'Diet plan' : 'Workout plan'} · ${esc(new Date(p.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span></span><i class="fa-solid fa-chevron-${S.openPlan === p.id ? 'up' : 'down'} text-gray-400"></i></button>${S.openPlan === p.id ? `<div class="px-4 pb-4 border-t border-gray-200 dark:border-white/10"><div class="${prose} pt-2">${md(p.content)}</div><button data-act="del-plan" data-id="${esc(p.id)}" class="${ghost} !text-rose-500 mt-3">Delete plan</button></div>` : ''}</div>`).join('') : '<p class="text-sm text-gray-500 dark:text-gray-400">No saved plans yet. Ask the Coach for one, then tap Save under its answer.</p>';
    return `<section class="${card} p-3 sm:p-4 space-y-3">
      <div class="flex items-center justify-between gap-2"><h3 class="font-semibold"><i class="fa-solid fa-comments text-indigo-500 mr-2"></i>Coach</h3><div class="text-xs text-gray-500 dark:text-gray-400 text-right" id="nut-limit">${esc(limText)}</div></div>
      <p class="text-xs text-gray-500 dark:text-gray-400">General wellness guidance, not medical advice. For health conditions, pregnancy, eating-disorder worries or anyone under 18, please talk to a doctor or dietitian.</p>
      <div id="nut-chat" class="space-y-3 max-h-[52vh] overflow-y-auto pr-1" aria-live="polite">${msgs || '<p class="text-sm text-gray-500 dark:text-gray-400">Ask about your food, a diet plan, or a workout plan. The Coach knows your profile, targets and the last two weeks of your log.</p>'}${S.busy ? `<div class="flex"><div class="rounded-2xl bg-black/5 dark:bg-white/10 px-3.5 py-2.5 text-sm text-gray-500"><i class="fa-solid fa-spinner fa-spin mr-2"></i>${S.jobKind === 'review' ? 'Reviewing your progress…' : 'Thinking… plans can take a minute'}</div></div>` : ''}</div>
      ${c.messages.length ? '' : `<div class="flex flex-wrap gap-2">${chips.map((x) => `<button data-act="chip" data-t="${esc(x)}" class="text-sm px-3 py-2 rounded-full border border-gray-300 dark:border-white/10 min-h-[40px]">${esc(x)}</button>`).join('')}</div>`}
      ${out ? `<div class="text-sm text-amber-500 border border-amber-500/30 bg-amber-500/10 rounded-xl px-3 py-2">That's all your Coach messages for today. They come back at midnight (Eastern).</div>` : ''}
      <form data-form="coach" class="flex gap-2 items-end"><textarea id="nut-input" rows="2" maxlength="2000" placeholder="${out ? 'No messages left today' : 'Message the Coach…'}" class="${input} resize-none" ${out || S.busy ? 'disabled' : ''}></textarea><button class="${primary} h-[44px]" ${out || S.busy ? 'disabled' : ''} aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></form>
      ${(() => { const rc = (S.view ? S.view.changes : []).filter((x) => x.who === 'ai' && !x.undone && Date.now() - Date.parse(x.at) < 864e5).slice(0, 3); return rc.length ? `<div class="space-y-2"><div class="text-xs font-medium text-gray-500">Recent changes by the Coach</div>${changeCards(rc)}</div>` : ''; })()}
      ${c.messages.length ? `<div class="text-right"><button data-act="clear-chat" class="text-xs text-gray-500 underline">Clear conversation</button></div>` : ''}</section>
      <section class="space-y-3"><h3 class="font-semibold px-1">Saved plans</h3>${plans}</section>`;
  }
  function scrollChat() { const el = document.getElementById('nut-chat'); if (el) el.scrollTop = el.scrollHeight; }
  async function sendCoach(text) {
    text = String(text || '').trim(); if (!text || S.busy) return;
    try {
      const r = await api('/api/nutrition/coach', { method: 'POST', body: { message: text } });
      S.limit = r.limit; S.err = '';
      S.coach.messages.push({ role: 'user', content: text });
      startPoll('chat'); scrollChat();
    } catch (e) { S.err = e.message; if (e.body && e.body.limit) S.limit = e.body.limit; render(); }
  }
  async function savePlan(i, type) {
    const m = S.coach.messages[i]; if (!m) return;
    const first = String(m.content).split('\n').map((l) => l.replace(/^[#*\s>-]+|[*]+$/g, '').trim()).find((l) => l) || (type === 'diet' ? 'Diet plan' : 'Workout plan');
    const title = (window.prompt('Name this plan', first.slice(0, 80)) || '').trim();
    if (!title) return;
    try { await api('/api/nutrition/plans', { method: 'POST', body: { type, title, content: m.content } }); S.plans = await api('/api/nutrition/plans'); S.msg = 'Plan saved. Find it under Saved plans below.'; } catch (e) { S.err = e.message; }
    render();
  }

  // ------------------------------------------------------------ Profile
  function renderProfile() {
    const p = S.profile; if (!p) return '';
    const imp = p.units !== 'metric';
    const [ft, inch] = p.heightCm ? cmToFtIn(p.heightCm) : ['', ''];
    const capKg = p.weightKg ? safeCapKg(p.weightKg) : 0.9;
    const rates0 = imp ? [[0.5, '0.5 lb / week'], [1, '1 lb / week'], [1.5, '1.5 lb / week'], [2, '2 lb / week']] : [[0.25, '0.25 kg / week'], [0.5, '0.5 kg / week'], [0.75, '0.75 kg / week'], [1, '1 kg / week']];
    const rates = rates0.filter((r) => (imp ? lbToKg(r[0]) : r[0]) <= capKg + 0.001).length ? rates0.filter((r) => (imp ? lbToKg(r[0]) : r[0]) <= capKg + 0.001) : [rates0[0]];
    const curRate = imp ? kgToLb(p.rateKgPerWeek || 0.5) : (p.rateKgPerWeek || 0.5);
    const nearest = rates.reduce((a, b) => (Math.abs(b[0] - curRate) < Math.abs(a[0] - curRate) ? b : a))[0];
    const t = S.computed, ov = p.overrides || {};
    const ovf = (k, l, u) => `<div><label class="${label}" for="po-${k}">${l} (${u})</label><input id="po-${k}" name="ov.${k}" type="number" inputmode="decimal" min="0" step="any" class="${input}" value="${ov[k] ? esc(ov[k]) : ''}" placeholder="${t ? esc(t[k]) : ''}"></div>`;
    return profileExtras() + `<form data-form="profile" class="space-y-4">
      <section class="${card} p-4 space-y-4"><h3 class="font-semibold">About you</h3>
        <div><span class="${label}">Units</span><div class="grid grid-cols-2 gap-2"><label class="${ghost} flex items-center justify-center gap-2 cursor-pointer"><input type="radio" name="units" value="imperial" ${imp ? 'checked' : ''}> lb, ft / in</label><label class="${ghost} flex items-center justify-center gap-2 cursor-pointer"><input type="radio" name="units" value="metric" ${imp ? '' : 'checked'}> kg, cm</label></div></div>
        <div class="grid grid-cols-2 gap-3"><div><label class="${label}" for="pf-age">Age</label><input id="pf-age" name="age" type="number" inputmode="numeric" min="10" max="100" class="${input}" value="${p.age || ''}"></div>
          <div><label class="${label}" for="pf-sex">Sex (for the calorie formula)</label><select id="pf-sex" name="sex" class="${input}"><option value="">Choose…</option>${[['male', 'Male'], ['female', 'Female'], ['other', 'Other / prefer not to say']].map(([v, n]) => `<option value="${v}" ${p.sex === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          ${imp ? `<div><label class="${label}" for="pf-ft">Height (ft)</label><input id="pf-ft" name="ft" type="number" inputmode="numeric" min="3" max="8" class="${input}" value="${ft}"></div><div><label class="${label}" for="pf-in">Height (in)</label><input id="pf-in" name="inch" type="number" inputmode="decimal" min="0" max="11.9" step="any" class="${input}" value="${inch}"></div>
          <div class="col-span-2"><label class="${label}" for="pf-w">Weight (lb)</label><input id="pf-w" name="weight" type="number" inputmode="decimal" step="any" class="${input}" value="${p.weightKg ? r1(kgToLb(p.weightKg)) : ''}"></div>`
          : `<div><label class="${label}" for="pf-h">Height (cm)</label><input id="pf-h" name="cm" type="number" inputmode="decimal" step="any" class="${input}" value="${p.heightCm || ''}"></div><div><label class="${label}" for="pf-w">Weight (kg)</label><input id="pf-w" name="weight" type="number" inputmode="decimal" step="any" class="${input}" value="${p.weightKg || ''}"></div>`}</div>
        <div><label class="${label}" for="pf-act">Activity level</label><select id="pf-act" name="activity" class="${input}"><option value="">Choose…</option>${ACTIVITY.map(([v, n]) => `<option value="${v}" ${p.activity === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="grid grid-cols-2 gap-3"><div><label class="${label}" for="pf-goal">Goal</label><select id="pf-goal" name="goal" class="${input}">${[['lose', 'Lose weight'], ['maintain', 'Maintain'], ['gain', 'Gain weight']].map(([v, n]) => `<option value="${v}" ${p.goal === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <div><label class="${label}" for="pf-rate">Pace <span class="text-[11px] font-normal">(max for you: ${esc(paceWt(capKg))}/wk)</span></label><select id="pf-rate" name="rate" class="${input}">${rates.map(([v, n]) => `<option value="${v}" ${v === nearest ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
        <div><label class="${label}" for="pf-notes">Notes for the Coach (diet, allergies, injuries, equipment)</label><textarea id="pf-notes" name="notes" rows="2" maxlength="400" class="${input}">${esc(p.notes || '')}</textarea></div></section>
      <section class="${card} p-4 space-y-3"><h3 class="font-semibold">Daily targets</h3>
        ${t ? `<div class="text-sm text-gray-500 dark:text-gray-400">Resting burn about <b>${fmt(t.bmr)}</b> kcal, with activity about <b>${fmt(t.tdee)}</b>. Suggested: <b>${fmt(t.calories)} kcal</b>, protein ${t.protein} g, carbs ${t.carbs} g, fat ${t.fat} g.</div>${(t.notes || []).map((n) => `<div class="text-sm text-amber-500">${esc(n)}</div>`).join('')}` : '<div class="text-sm text-gray-500 dark:text-gray-400">Fill in age, sex, height, weight and activity, then Save, to get suggested targets.</div>'}
        <div class="text-xs text-gray-500 dark:text-gray-400">Want your own numbers? Type them below; leave a box empty to use the suggestion.</div>
        <div class="grid grid-cols-2 gap-3">${ovf('calories', 'Calories', 'kcal')}${ovf('protein', 'Protein', 'g')}${ovf('carbs', 'Carbs', 'g')}${ovf('fat', 'Fat', 'g')}${ovf('fiber', 'Fibre', 'g')}${ovf('sugar', 'Sugar limit', 'g')}${ovf('sodium', 'Sodium limit', 'mg')}</div></section>
      <button class="${primary} w-full">Save profile</button></form>`;
  }
  async function saveProfile(form) {
    const f = new FormData(form); const g = (k) => f.get(k);
    const imp = g('units') === 'imperial';
    const body = { units: g('units'), age: g('age'), sex: g('sex'), activity: g('activity'), goal: g('goal'), notes: g('notes') };
    if (imp) {
      body.heightCm = g('ft') === '' && g('inch') === '' ? null : r1(ftInToCm(g('ft') || 0, g('inch') || 0));
      body.weightKg = g('weight') === '' ? null : r1(lbToKg(Number(g('weight'))));
      body.rateKgPerWeek = r1(lbToKg(Number(g('rate'))));
    } else { body.heightCm = g('cm'); body.weightKg = g('weight'); body.rateKgPerWeek = g('rate'); }
    body.overrides = {}; ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'].forEach((k) => { body.overrides[k] = g('ov.' + k); });
    try {
      const r = await api('/api/nutrition/profile', { method: 'PUT', body });
      S.profile = r.profile; S.targets = r.targets; S.computed = r.computed; S.err = ''; S.msg = 'Saved.'; S.hist = null;
      S.day = await api('/api/nutrition/day?date=' + S.date);
    } catch (e) { S.err = e.message; S.msg = ''; }
    render();
    window.scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------ 1.0.1: help text, long text, waist, deficit
  const HELP = {
    deficit: "A deficit means eating less than your body burns. The gap comes out of stored energy, mostly body fat. Eating more than you burn is a surplus. Roughly 3,500 calories is a pound of body fat (7,700 per kg), so a 500 a day deficit is about 1 lb a week. Bigger gaps are not safer or faster in a healthy way, which is why there is a safe maximum.",
    burn: "Your burn is about how many calories your body uses in a day: resting energy plus normal daily activity, worked out from your age, height, weight and activity level, plus a rough figure for any workouts you logged. It is an estimate, not a measurement. Eating about your maintenance keeps your weight steady.",
    target: "Your calorie target is your daily goal: your maintenance with a small, safe amount taken off (to lose) or added (to gain). The Coach can adjust it, and you can change it in Profile.",
    macros: "Protein helps you keep and build muscle, especially while losing weight. Carbs and fat are your main fuel. These numbers are a guide for the day, not a pass or fail.",
    pace: "Pace is how fast you are moving toward a goal, worked out from your logged deficit (or your targets if you have not logged much). The date is an estimate and moves as your numbers change. Weight loss is capped at about 1% of your body weight per week, never more than 2 lb.",
  };
  // The chain, in one line: resting burn x activity = daily burn, minus the deficit = target.
  function chainText() {
    const c = S.view && S.view.computed, t = S.view && S.view.targets;
    if (!c || !t || !c.bmr) return '';
    const f = c.tdee && c.bmr ? Math.round((c.tdee / c.bmr) * 100) / 100 : '?';
    const def = c.tdee - t.calories;
    return `Resting burn ${fmt(c.bmr)} × activity ${f} = daily burn ${fmt(c.tdee)} ${def >= 0 ? '− deficit ' + fmt(def) : '+ surplus ' + fmt(-def)} = target ${fmt(t.calories)} kcal.`;
  }
  const helpText = (k) => {
    if (k === 'burn') return HELP.burn + ' Resting burn is what you would burn lying still all day; your activity level turns it into your daily burn (maintenance). ' + chainText();
    if (k === 'target') return HELP.target + ' ' + chainText();
    return HELP[k];
  };
  const helpBlock = (k) => `<div class="mt-1"><button type="button" data-act="help" data-k="${k}" aria-expanded="${!!S.help[k]}" class="text-xs text-indigo-500 min-h-[32px] px-1">${S.help[k] ? 'Hide' : "What's this?"}</button>${S.help[k] ? `<p class="text-xs text-gray-600 dark:text-gray-300 mt-1 leading-relaxed" data-help-text="${k}">${esc(helpText(k))}</p>` : ''}</div>`;
  // Long text: shows the start with a Show more toggle, cut at a sentence end.
  function moreText(key, text, n, cls) {
    const t = String(text || '');
    if (t.length <= n) return `<p class="${cls}">${esc(t)}</p>`;
    const open = !!S.more[key];
    let head = t.slice(0, n); const i = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    head = i > n * 0.5 ? head.slice(0, i + 1) : head.replace(/\s+\S*$/, '') + '…';
    return `<p class="${cls}">${esc(open ? t : head)}</p><button type="button" data-act="more" data-k="${esc(key)}" class="text-xs text-indigo-500 min-h-[32px]">${open ? 'Show less' : 'Show more'}</button>`;
  }
  const inUnit = () => (!S.profile || S.profile.units !== 'metric');
  const cmToIn = (cm) => cm / 2.54;
  const waistStr = (cm) => (inUnit() ? `${r1(cmToIn(cm))} in` : `${r1(cm)} cm`);
  const waistUnit = () => (inUnit() ? 'in' : 'cm');
  const waistToCm = (v) => (inUnit() ? Number(v) * 2.54 : Number(v));
  const fromCm = (cm) => (inUnit() ? r1(cmToIn(cm)) : r1(cm));
  const paceWt = (kg) => (inUnit() ? `${r1(kgToLb(kg))} lb` : `${Math.round(kg * 100) / 100} kg`);
  const safeCapKg = (kg) => Math.min(0.9, 0.01 * kg);
  function paceLine(g) {
    const p = g.pace; if (!p) return '';
    if (p.reached) return '<div class="text-xs text-emerald-500">Target reached.</div>';
    const when = p.reachDate ? new Date(p.reachDate + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    if (g.type === 'reduce_waist') return when ? `<div class="text-xs text-gray-500 dark:text-gray-400">About ${p.perWeekCm >= 1 ? '1 cm' : esc(waistStr(p.perWeekCm))} a week lately${p.capped ? ' (estimate capped)' : ''} → about <b>${esc(when)}</b>${helpBlock('pace')}</div>` : '<div class="text-xs text-gray-500 dark:text-gray-400">Log your waist a couple of weeks apart to get an estimate.</div>';
    if (!p.perWeek) return '<div class="text-xs text-gray-500 dark:text-gray-400">Log a few days of food to get a pace and date. At your current numbers the scale is not set to move this way.</div>';
    return `<div class="text-xs text-gray-500 dark:text-gray-400">About ${esc(paceWt(p.perWeek))} a week ${p.source === 'logged' ? 'at your logged pace' : 'at your target pace'}${p.capped ? ' (capped at the safe pace)' : ''} → about <b>${esc(when)}</b>${helpBlock('pace')}</div>`;
  }
  function deficitCard() {
    const d = S.view && S.view.deficit; if (!d) return '';
    if (!d.days) return `<section class="${card} p-4 space-y-1"><h3 class="font-semibold">Your pace</h3><p class="text-sm text-gray-500 dark:text-gray-400">Log food for a few days and this shows how far under or over your burn you are, and what that means for your weight.</p>${helpBlock('deficit')}</section>`;
    const under = d.avg >= 0, n = Math.abs(d.avg), wk = Math.abs(d.kgPerWeek);
    const fast = under && d.kgPerWeek > d.safeKgPerWeek + 0.01;
    return `<section class="${card} p-4 space-y-1"><h3 class="font-semibold">Your pace</h3><p class="text-sm">Over the last 7 days (${d.days} logged day${d.days === 1 ? '' : 's'}) you averaged about <b>${fmt(n)} kcal a day ${under ? 'under' : 'over'}</b> your burn. At that pace that is about <b>${esc(paceWt(wk))} a week</b> of ${under ? 'weight loss' : 'weight gain'}.</p>${fast ? `<p class="text-sm text-amber-500">That is faster than the safe pace for you (${esc(paceWt(d.safeKgPerWeek))} a week). Eat a little more.</p>` : ''}<p class="text-xs text-gray-500 dark:text-gray-400">An estimate: your burn is worked out, not measured.</p>${helpBlock('deficit')}</section>`;
  }
  function energyCard() {
    const d = S.day; if (!d) return '';
    if (!d.burn) return `<section class="${card} p-4"><h3 class="font-semibold">Energy balance</h3><p class="text-sm text-gray-500 dark:text-gray-400">Add your age, sex, height, weight and activity in Profile to see how your eating compares to what you burn.</p></section>`;
    const b = d.burn, eaten = d.totals.calories, isToday = S.date === localToday();
    let line;
    if (d.deficit === null) line = `Log what you eat to see how ${isToday ? 'today' : 'this day'} compares to your burn.`;
    else line = d.deficit >= 0 ? `About <b>${fmt(d.deficit)} kcal under</b> your burn${isToday ? ' so far' : ''}` : `About <b>${fmt(-d.deficit)} kcal over</b> your burn${isToday ? ' so far' : ''}`;
    const wk = b.workouts.length ? ` + ${fmt(b.workoutKcal)} from ${b.workouts.length} workout${b.workouts.length === 1 ? '' : 's'}${b.workouts.some((w) => w.assumed) ? ' (30 minutes assumed where none was logged)' : ''}` : '';
    return `<section class="${card} p-4 space-y-1"><h3 class="font-semibold">Energy balance</h3><p class="text-lg">${line}</p><p class="text-sm text-gray-500 dark:text-gray-400">Daily burn (maintenance) about ${fmt(b.total)} kcal${b.workouts.length ? ` (${fmt(b.maintenance)}${wk})` : ''}, eaten ${fmt(eaten)}. An estimate, not a measurement.</p>${helpBlock('burn')}${helpBlock('deficit')}</section>`;
  }
  function waistChart(ws) {
    if (ws.length < 2) return '<p class="text-sm text-gray-500 dark:text-gray-400">Log at least two measurements to see the trend.</p>';
    const conv = (cm) => (inUnit() ? cm / 2.54 : cm);
    const W = 360, H = 170, L = 36, B = 22, T = 12, R = 10;
    const vs = ws.map((w) => conv(w.cm)); const lo = Math.min(...vs) - 1, hi = Math.max(...vs) + 1;
    const t0 = Date.parse(ws[0].date), t1 = Date.parse(ws[ws.length - 1].date) || t0 + 1;
    const x = (d) => L + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto max-w-[480px] mx-auto block" role="img" aria-label="Waist trend"><text x="${L - 4}" y="${y(lo + 1) + 3}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${r1(lo + 1)}</text><text x="${L - 4}" y="${y(hi - 1) + 3}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${r1(hi - 1)}</text><polyline points="${ws.map((w) => `${x(w.date).toFixed(1)},${y(conv(w.cm)).toFixed(1)}`).join(' ')}" fill="none" stroke="#ec4899" stroke-width="2.5" stroke-linejoin="round"/>${ws.map((w) => `<circle cx="${x(w.date).toFixed(1)}" cy="${y(conv(w.cm)).toFixed(1)}" r="3.5" fill="#ec4899"><title>${esc(w.date)}: ${r1(conv(w.cm))} ${waistUnit()}</title></circle>`).join('')}<text x="${L}" y="${H - 6}" font-size="11" fill="currentColor" fill-opacity=".6">${esc(ws[0].date.slice(5))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${esc(ws[ws.length - 1].date.slice(5))}</text></svg>`;
  }

  // ---- items the Coach logged from chat: cards with Edit, Undo and portion buttons
  const PORTIONS = [['Smaller', 0.75], ['Typical', 1], ['Larger', 1.33]];
  function logCardsHtml(m) {
    const ls = (S.coach && S.coach.loggedState) || {};
    const cards = (m.logged || []).map((l) => {
      const st = ls[l.changeId] || {};
      const gone = st.present === false;
      const icon = { food: 'fa-utensils', workout: 'fa-dumbbell', weight: 'fa-weight-scale', waist: 'fa-ruler' }[l.kind] || 'fa-check';
      const kcal = st.kcal !== null && st.kcal !== undefined ? ` · ${fmt(st.kcal)} kcal` : '';
      const where = l.kind === 'food' ? `${esc({ breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' }[l.meal] || '')}` : '';
      const body = gone ? `<div class="text-xs text-gray-500">Removed from your log.</div>` : `<div class="text-xs text-gray-600 dark:text-gray-300 mt-0.5">${esc(l.summary)}</div>`;
      const portions = !gone && l.kind === 'food' && l.estimate ? `<div class="flex gap-1.5 mt-2" role="group" aria-label="Portion size">${PORTIONS.map(([n, f]) => `<button type="button" data-act="log-portion" data-id="${esc(l.refId)}" data-c="${esc(l.changeId)}" data-f="${f}" aria-pressed="${st.factor !== null && st.factor !== undefined && Math.abs(st.factor - f) < 0.02}" class="flex-1 px-2 py-1.5 rounded-lg text-xs border min-h-[36px] ${st.factor !== null && st.factor !== undefined && Math.abs(st.factor - f) < 0.02 ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 dark:border-white/20'}">${n}${f === 1 ? '' : ' ×' + f}</button>`).join('')}</div>` : '';
      const btns = gone ? '' : `<div class="flex gap-2 mt-2">${l.kind === 'food' || l.kind === 'workout' ? `<button type="button" data-act="log-edit" data-kind="${l.kind}" data-id="${esc(l.refId)}" data-date="${esc(l.date)}" class="${ghost} !py-1 !min-h-[36px] text-xs">Edit</button>` : ''}${st.canUndo ? `<button type="button" data-act="log-undo" data-c="${esc(l.changeId)}" class="${ghost} !py-1 !min-h-[36px] text-xs">Undo</button>` : ''}</div>`;
      return `<div class="rounded-xl border border-gray-300 dark:border-white/15 p-2.5 ${gone ? 'opacity-60' : ''}" data-log-card="${esc(l.changeId)}"><div class="flex items-center justify-between gap-2"><span class="text-sm font-medium"><i class="fa-solid ${icon} text-indigo-500 mr-1.5"></i>${esc(l.label)}</span><span class="flex items-center gap-1.5">${l.kind === 'food' ? (l.estimate ? badge('estimate', 'bg-amber-500/15 text-amber-500') : badge('USDA', 'bg-emerald-500/15 text-emerald-500')) : ''}<span class="text-xs text-gray-500">${where}${esc(kcal)}</span></span></div>${body}${portions}${btns}</div>`;
    }).join('');
    return cards ? `<div class="space-y-2 mt-2">${cards}</div>` : '';
  }
  async function refreshLogged() { try { const r = await api('/api/nutrition/coach'); if (S.coach) S.coach.loggedState = r.loggedState; } catch (e) { /* cards keep their last state */ } }

  // ------------------------------------------------------------ round 2: plan, goals, workouts, setup
  const DAYN = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const DAYKEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const wkey = (d) => DAYKEYS[new Date(d + 'T12:00:00').getDay()];
  const TYPES = [['strength', 'Strength'], ['cardio', 'Cardio'], ['hiit', 'HIIT'], ['mobility', 'Mobility'], ['sport', 'Sport'], ['other', 'Other']];
  const GOALN = { lose_weight: 'Lose weight', gain_weight: 'Gain weight', reduce_waist: 'Reduce waist', strength: 'Build strength', endurance: 'Build endurance', general_health: 'General health', other: 'Other' };
  const imperial = () => !S.profile || S.profile.units !== 'metric';
  const wtStr = (kg) => (imperial() ? `${r1(kgToLb(kg))} lb` : `${r1(kg)} kg`);
  const wtUnit = () => (imperial() ? 'lb' : 'kg');
  const toKg = (v) => (imperial() ? lbToKg(Number(v)) : Number(v));
  const fromKg = (kg) => (imperial() ? r1(kgToLb(kg)) : r1(kg));
  const badge = (txt, cls) => `<span class="text-[11px] px-2 py-0.5 rounded-full ${cls}">${esc(txt)}</span>`;
  const whoBadge = (w) => (w === 'ai' ? badge('Coach', 'bg-indigo-500/15 text-indigo-500') : badge('You', 'bg-gray-500/15 text-gray-500'));

  function changeCards(list, empty) {
    if (!list.length) return empty ? `<p class="text-sm text-gray-500 dark:text-gray-400">${esc(empty)}</p>` : '';
    return list.map((c) => `<div class="${card} p-3 ${c.undone ? 'opacity-60' : ''}" data-change="${esc(c.id)}"><div class="flex items-center justify-between gap-2 mb-1"><div class="flex items-center gap-2">${whoBadge(c.who)}<span class="text-xs text-gray-500 dark:text-gray-400">${esc(new Date(c.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}${c.undone ? ' · undone' : ''}</span></div>${c.canUndo ? `<button data-act="undo" data-id="${esc(c.id)}" class="${ghost} !py-1 !min-h-[36px] text-sm">Undo</button>` : ''}</div><div class="text-sm font-medium">${esc(c.summary)}</div>${c.reason ? `<div class="mt-1">${moreText('ch-' + c.id, c.reason, 220, 'text-xs text-gray-500 dark:text-gray-400')}</div>` : ''}</div>`).join('');
  }
  const pctBar = (pct, col) => `<div class="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div class="h-2 rounded-full" style="width:${Math.round((pct || 0) * 100)}%;background:${col || '#6366f1'}"></div></div>`;

  function renderPlan() {
    const v = S.view; if (!v) return '<div class="text-sm text-gray-500 p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
    const t = v.targets, m = v.targetMeta || {}, rev = v.review;
    const lim = S.limit; const limText = !lim ? '' : lim.unlimited ? '' : ` (${lim.left} of ${lim.limit} Coach messages left today)`;
    const srcTxt = m.source === 'ai' ? 'Set by the Coach' : m.source === 'manual' ? 'Set by you' : 'Calculated from your profile';
    const head = rev ? `<section class="${card} p-4 space-y-2 border-indigo-500/40"><div class="flex items-center justify-between"><h3 class="font-semibold"><i class="fa-solid fa-wand-magic-sparkles text-indigo-500 mr-2"></i>${rev.mode === 'setup' ? 'Your plan' : rev.mode === 'weekly' ? 'Weekly review' : 'Latest review'}</h3><span class="text-xs text-gray-500">${esc(new Date(rev.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span></div>${moreText('rev-' + rev.at, rev.summary, 650, 'text-sm whitespace-pre-wrap')}${(rev.notes || []).map((n) => `<p class="text-xs text-amber-500">${esc(n)}</p>`).join('')}</section>` : '';
    const targets = `<section class="${card} p-4 space-y-2"><div class="flex items-center justify-between gap-2"><h3 class="font-semibold">Daily targets</h3>${badge(srcTxt, m.source === 'ai' ? 'bg-indigo-500/15 text-indigo-500' : 'bg-gray-500/15 text-gray-500')}</div>${t ? `<div class="grid grid-cols-4 gap-2 text-center">${[['calories', 'kcal'], ['protein', 'protein g'], ['carbs', 'carbs g'], ['fat', 'fat g']].map(([k, l]) => `<div class="rounded-xl bg-black/5 dark:bg-white/5 py-2"><div class="font-bold">${fmt(t[k], k)}</div><div class="text-[11px] text-gray-500 dark:text-gray-400">${l}</div></div>`).join('')}</div>` : '<p class="text-sm text-gray-500">Not set yet.</p>'}${m.reason ? `<p class="text-xs text-gray-500 dark:text-gray-400">${esc(m.reason)}</p>` : ''}<button data-act="goto" data-tab="profile" class="text-xs text-indigo-500 underline">Change targets in Profile</button><div class="flex gap-4">${helpBlock('target')}${helpBlock('macros')}</div></section>`;
    const goals = v.goals.filter((g) => g.status !== 'dropped').map((g) => {
      const p = g.progress || {};
      let line = '';
      if (p.kind === 'weight') line = `${wtStr(p.startKg)} → <b>${wtStr(p.currentKg)}</b>${g.target ? ' → ' + wtStr(g.target) : ''}`;
      else if (p.kind === 'waist') line = p.currentCm ? `${esc(p.startCm ? waistStr(p.startCm) : '?')} → <b>${esc(waistStr(p.currentCm))}</b>${g.target ? ' → ' + esc(waistStr(g.target)) : ''}` : 'Log your waist (History tab) to start tracking.';
      else line = g.target ? `${p.done} of ${g.target} workouts this week` : `${p.done} workout${p.done === 1 ? '' : 's'} this week`;
      const late = g.deadline && g.status === 'active' && g.deadline < v.today;
      return `<div class="${card} p-3 space-y-2 ${g.status === 'done' ? 'opacity-70' : ''}"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><div class="font-medium">${esc(g.title)} ${g.status === 'done' ? badge('Done', 'bg-emerald-500/15 text-emerald-500') : ''}</div><div class="text-xs text-gray-500 dark:text-gray-400">${esc(GOALN[g.type])}${g.deadline ? ' · by ' + esc(g.deadline) : ''}${late ? ' · past due' : ''}</div></div><div class="flex gap-1 shrink-0"><button data-act="goal-edit" data-id="${esc(g.id)}" class="px-2.5 py-1.5 text-sm min-h-[36px]" aria-label="Edit goal"><i class="fa-solid fa-pen"></i></button></div></div><div class="text-sm">${line}</div>${p.pct !== null && p.pct !== undefined ? pctBar(p.pct, g.status === 'done' ? '#10b981' : '#6366f1') : ''}${g.status === 'active' ? paceLine(g) : ''}${g.note ? `<div class="text-xs text-amber-500">${esc(g.note)}</div>` : ''}</div>`;
    }).join('');
    const wk = v.week;
    const rows = wk.days.map((d) => {
      const isToday = d.date === v.today;
      const planned = d.sessions.map((s, i) => {
        const done = d.logged.some((w) => w.name === s.name) || (d.logged.length > i);
        return `<div class="flex items-start justify-between gap-2 py-1.5"><div class="min-w-0"><div class="text-sm font-medium ${done ? 'line-through opacity-60' : ''}">${esc(s.name)} <span class="text-xs font-normal text-gray-500">${esc(s.type)} · ${s.minutes} min</span></div><details class="text-xs text-gray-500 dark:text-gray-400"><summary class="cursor-pointer">${s.exercises.length} exercises</summary><ul class="list-disc pl-4 mt-1">${s.exercises.map((e) => `<li>${esc(e.name)}${e.sets ? ' ' + e.sets + '×' + (e.reps || '') : ''}${e.minutes ? ' ' + e.minutes + ' min' : ''}${e.note ? ' <i>' + esc(e.note) + '</i>' : ''}</li>`).join('')}</ul></details></div>${done ? `<i class="fa-solid fa-circle-check text-emerald-500 mt-1"></i>` : (d.date <= v.today ? `<button data-act="wo-plan" data-date="${esc(d.date)}" data-i="${i}" class="${ghost} !py-1 !min-h-[36px] text-xs shrink-0">Done as planned</button>` : '')}</div>`;
      }).join('');
      const extra = d.logged.filter((w, i) => i >= d.sessions.length).map((w) => `<div class="text-sm py-1"><i class="fa-solid fa-plus text-xs text-emerald-500 mr-1"></i>${esc(w.name)} <span class="text-xs text-gray-500">extra</span></div>`).join('');
      return `<div class="px-4 py-2 border-t border-gray-200 dark:border-white/10 ${isToday ? 'bg-indigo-500/5' : ''}"><div class="text-xs font-semibold ${isToday ? 'text-indigo-500' : 'text-gray-500 dark:text-gray-400'}">${DAYN[d.day]}${isToday ? ' · today' : ''}</div>${planned || '<div class="text-sm text-gray-500 dark:text-gray-400 py-1">Rest</div>'}${extra}</div>`;
    }).join('');
    const week = `<section class="${card} overflow-hidden"><div class="p-4 flex items-center justify-between gap-2"><div><h3 class="font-semibold">This week</h3><div class="text-sm text-gray-500 dark:text-gray-400">${wk.planned ? `${wk.done} of ${wk.planned} planned sessions done` : 'No workout plan yet'}${wk.extra ? ` · ${wk.extra} extra` : ''}</div></div><button data-act="wo-new" class="${primary} !px-3 !min-h-[40px]"><i class="fa-solid fa-plus"></i> Log</button></div>${wk.planned ? pctBar(wk.done / wk.planned, '#10b981').replace('class="h-2', 'class="mx-4 mb-3 h-2') : ''}${v.workoutPlan ? `<div class="px-4 pb-2 text-xs text-gray-500 dark:text-gray-400">${esc(v.workoutPlan.title)}${v.workoutPlan.notes ? ' — ' + esc(v.workoutPlan.notes) : ''}</div>${rows}` : ''}</section>`;
    const reviewBtn = `<section class="${card} p-4 space-y-2"><h3 class="font-semibold">Check-in</h3><p class="text-sm text-gray-500 dark:text-gray-400">The Coach looks at your food, weight and workouts once a week and adjusts your plan a little if it needs it. You can ask for one any time${esc(limText)}.</p><button data-act="review" class="${primary} w-full" ${S.busy ? 'disabled' : ''}>${S.busy && S.jobKind === 'review' ? '<i class="fa-solid fa-spinner fa-spin"></i> Reviewing…' : 'Review my progress now'}</button></section>`;
    const needsPlan = v.setup.done && !v.workoutPlan && !S.busy ? `<section class="${card} p-4 space-y-2"><p class="text-sm">The Coach has not made your workout plan yet.</p><button data-act="gen-plan" class="${primary} w-full">Make my plan</button></section>` : '';
    const changes = `<section class="space-y-2"><h3 class="font-semibold px-1">Changes</h3>${changeCards(v.changes.slice(0, 8), 'Nothing has changed yet. Every change to your targets or plan shows here, with an Undo button.')}</section>`;
    return `${head}${needsPlan}${deficitCard()}<section class="space-y-2"><div class="flex items-center justify-between px-1"><h3 class="font-semibold">Goals</h3><button data-act="goal-new" class="text-sm text-indigo-500 min-h-[36px]"><i class="fa-solid fa-plus"></i> Add goal</button></div>${goals || '<p class="text-sm text-gray-500 dark:text-gray-400 px-1">No goals yet.</p>'}</section>${targets}${week}${reviewBtn}${changes}`;
  }

  // ---- goal sheet
  function goalSheetHtml() {
    const g = S.gs; if (!g) return '';
    const weight = g.type === 'lose_weight' || g.type === 'gain_weight';
    return `<div class="fixed inset-0 z-[1100] bg-black/70 flex items-end sm:items-center justify-center" data-act="gs-bg"><div class="bg-white dark:bg-dark-card w-full sm:max-w-md max-h-[94vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-4 space-y-4" role="dialog" aria-modal="true" aria-label="Goal">
      <div class="flex items-center justify-between"><h3 class="font-semibold text-lg">${g.id ? 'Edit goal' : 'Add goal'}</h3><button data-act="gs-close" class="px-3 py-2 text-2xl leading-none" aria-label="Close">&times;</button></div>
      ${g.err ? `<div class="text-sm text-rose-500 border border-rose-500/30 bg-rose-500/10 rounded-xl px-3 py-2" role="alert">${esc(g.err)}</div>` : ''}
      ${g.id ? '' : `<div><label class="${label}" for="g-type">Type</label><select id="g-type" data-g="type" class="${input}">${Object.entries(GOALN).map(([k, n]) => `<option value="${k}" ${g.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`}
      <div><label class="${label}" for="g-title">In your words</label><input id="g-title" data-g="title" class="${input}" maxlength="100" value="${esc(g.title)}" placeholder="e.g. Run a 5k"></div>
      <div class="grid grid-cols-2 gap-3"><div><label class="${label}" for="g-target">${weight ? 'Target weight (' + wtUnit() + ')' : g.type === 'reduce_waist' ? 'Target waist (' + waistUnit() + ')' : 'Workouts per week'}</label><input id="g-target" data-g="target" type="number" inputmode="decimal" step="any" class="${input}" value="${esc(g.target)}">${weight && S.view && S.view.safe ? `<div class="text-[11px] text-gray-500 mt-1">Lowest allowed for your height: ${esc(inUnit() ? Math.ceil(kgToLb(S.view.safe.minKg)) + ' lb' : (Math.ceil(S.view.safe.minKg * 10) / 10) + ' kg')}</div>` : ''}${g.type === 'reduce_waist' && S.view && S.view.safe ? `<div class="text-[11px] text-gray-500 mt-1">Lowest allowed for your height: ${esc(inUnit() ? (Math.ceil(cmToIn(S.view.safe.minWaistCm) * 10) / 10) + ' in' : (Math.ceil(S.view.safe.minWaistCm * 10) / 10) + ' cm')}</div>` : ''}</div>
        <div><label class="${label}" for="g-deadline">Deadline (optional)</label><input id="g-deadline" data-g="deadline" type="date" class="${input}" value="${esc(g.deadline)}"></div></div>
      ${g.id ? `<div><label class="${label}" for="g-status">Status</label><select id="g-status" data-g="status" class="${input}">${[['active', 'Active'], ['done', 'Done'], ['dropped', 'Dropped']].map(([k, n]) => `<option value="${k}" ${g.status === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>` : ''}
      <div class="flex gap-2">${g.id ? `<button data-act="gs-del" class="${ghost} !text-rose-500">Remove</button>` : ''}<button data-act="gs-close" class="${ghost} flex-1">Cancel</button><button data-act="gs-save" class="${primary} flex-1">Save</button></div></div></div>`;
  }
  async function saveGoal() {
    const g = S.gs;
    const weight = g.type === 'lose_weight' || g.type === 'gain_weight';
    const body = { type: g.type, title: g.title, target: g.target === '' ? null : (weight ? toKg(g.target) : g.type === 'reduce_waist' ? waistToCm(g.target) : g.target), deadline: g.deadline || null };
    try {
      if (g.id) await api('/api/nutrition/goals/' + g.id, { method: 'PATCH', body: { ...body, status: g.status } }); else await api('/api/nutrition/goals', { method: 'POST', body });
      S.gs = null; await refreshView();
    } catch (e) { g.err = e.message; render(); const sh = document.querySelector('[data-act="gs-bg"] > div'); if (sh) sh.scrollTop = 0; }
  }
  async function refreshView() { try { S.view = await api('/api/nutrition/state'); applyView(); } catch (e) { S.err = e.message; } render(); }
  function applyView() { const v = S.view; if (!v) return; S.profile = v.profile; S.targets = v.targets; S.computed = v.computed; S.limit = v.limit; }

  // ---- workout log
  function openWorkout(opts) {
    const w = opts.workout;
    S.ws = w ? { id: w.id, date: w.date, name: w.name, type: w.type, minutes: w.minutes || '', effort: w.effort || '', notes: w.notes || '', exercises: (w.exercises || []).map((e) => ({ name: e.name, sets: e.sets || '', reps: e.reps || '', weight: e.weightKg ? fromKg(e.weightKg) : '', minutes: e.minutes || '', distance: e.distanceKm || '' })) }
      : { id: null, date: opts.date || S.date, name: opts.name || '', type: opts.type || 'strength', minutes: '', effort: '', notes: '', exercises: (opts.exercises || [{ name: '', sets: '', reps: '', weight: '', minutes: '', distance: '' }]) };
    render();
  }
  function workoutSheetHtml() {
    const w = S.ws; if (!w) return '';
    const planned = S.view && S.view.workoutPlan ? (S.view.workoutPlan.days.find((d) => d.day === wkey(w.date)) || { sessions: [] }).sessions : [];
    const ex = w.exercises.map((e, i) => `<div class="rounded-xl border border-gray-200 dark:border-white/10 p-2 space-y-2"><div class="flex gap-2"><input data-wx="${i}.name" class="${input}" placeholder="Exercise" aria-label="Exercise ${i + 1} name" maxlength="80" value="${esc(e.name)}"><button data-act="wx-del" data-i="${i}" class="px-3 text-rose-500 text-xl" aria-label="Remove exercise">&times;</button></div><div class="grid grid-cols-3 gap-2">${[['sets', 'Sets'], ['reps', 'Reps'], ['weight', 'Weight ' + wtUnit()], ['minutes', 'Min'], ['distance', 'km']].map(([k, l]) => `<div><label class="text-[11px] text-gray-500">${l}</label><input data-wx="${i}.${k}" type="number" inputmode="decimal" step="any" min="0" class="${input} !px-2" value="${esc(e[k])}"></div>`).join('')}</div></div>`).join('');
    return `<div class="fixed inset-0 z-[1100] bg-black/70 flex items-end sm:items-center justify-center" data-act="ws-bg"><div class="bg-white dark:bg-dark-card w-full sm:max-w-lg max-h-[94vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-4 space-y-4" role="dialog" aria-modal="true" aria-label="Workout">
      <div class="flex items-center justify-between"><h3 class="font-semibold text-lg">${w.id ? 'Edit workout' : 'Log a workout'}</h3><button data-act="ws-close" class="px-3 py-2 text-2xl leading-none" aria-label="Close">&times;</button></div>
      ${!w.id && planned.length ? `<div><div class="${label}">Start from your plan</div><div class="flex flex-wrap gap-2">${planned.map((s, i) => `<button data-act="ws-from" data-i="${i}" class="px-3 py-2 rounded-full text-sm border border-gray-300 dark:border-white/10 min-h-[40px]">${esc(s.name)}</button>`).join('')}</div></div>` : ''}
      <div class="grid grid-cols-2 gap-3"><div class="col-span-2"><label class="${label}" for="ws-name">Workout</label><input id="ws-name" data-ws="name" class="${input}" maxlength="80" value="${esc(w.name)}" placeholder="e.g. Upper body"></div>
        <div><label class="${label}" for="ws-date">Date</label><input id="ws-date" data-ws="date" type="date" class="${input}" value="${esc(w.date)}"></div>
        <div><label class="${label}" for="ws-type">Type</label><select id="ws-type" data-ws="type" class="${input}">${TYPES.map(([k, n]) => `<option value="${k}" ${w.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label class="${label}" for="ws-min">Minutes</label><input id="ws-min" data-ws="minutes" type="number" inputmode="numeric" min="1" class="${input}" value="${esc(w.minutes)}"></div>
        <div><label class="${label}" for="ws-eff">Effort 1-10</label><input id="ws-eff" data-ws="effort" type="number" inputmode="numeric" min="1" max="10" class="${input}" value="${esc(w.effort)}"></div></div>
      <div class="space-y-2"><div class="${label}">Exercises (optional)</div>${ex}<button data-act="wx-add" class="${ghost} w-full"><i class="fa-solid fa-plus"></i> Add exercise</button></div>
      <div><label class="${label}" for="ws-notes">Notes</label><textarea id="ws-notes" data-ws="notes" rows="2" maxlength="500" class="${input}">${esc(w.notes)}</textarea></div>
      <div class="flex gap-2 sticky bottom-0 bg-white dark:bg-dark-card pb-1">${w.id ? `<button data-act="ws-del" class="${ghost} !text-rose-500">Delete</button>` : ''}<button data-act="ws-close" class="${ghost} flex-1">Cancel</button><button data-act="ws-save" class="${primary} flex-1">${w.id ? 'Save' : 'Log it'}</button></div></div></div>`;
  }
  async function saveWorkout() {
    const w = S.ws;
    const body = { date: w.date, name: w.name, type: w.type, minutes: w.minutes === '' ? null : Number(w.minutes), effort: w.effort === '' ? null : Number(w.effort), notes: w.notes,
      exercises: w.exercises.filter((e) => String(e.name).trim()).map((e) => { const o = { name: e.name }; if (e.sets !== '') o.sets = Number(e.sets); if (e.reps !== '') o.reps = Number(e.reps); if (e.weight !== '') o.weightKg = r1(toKg(e.weight)); if (e.minutes !== '') o.minutes = Number(e.minutes); if (e.distance !== '') o.distanceKm = Number(e.distance); return o; }) };
    try {
      if (w.id) await api('/api/nutrition/workouts/' + w.id, { method: 'PATCH', body }); else await api('/api/nutrition/workouts', { method: 'POST', body });
      S.ws = null; S.msg = 'Workout saved.'; S.hist = null; await Promise.all([refreshView(), loadDayWorkouts()]); if (S.coach) await refreshLogged(); render();
    } catch (e) { w.err = e.message; S.err = e.message; render(); }
  }
  async function loadDayWorkouts() { try { S.dayWorkouts = await api('/api/nutrition/workouts?from=' + S.date + '&to=' + S.date); } catch (e) { S.dayWorkouts = []; } }
  async function doneAsPlanned(date, i) {
    try { await api('/api/nutrition/workouts/from-plan', { method: 'POST', body: { date, session: Number(i) } }); S.msg = 'Logged as planned. Nice work.'; S.hist = null; await Promise.all([refreshView(), loadDayWorkouts()]); render(); } catch (e) { S.err = e.message; render(); }
  }
  function renderTodayWorkout() {
    const v = S.view; if (!v || !v.setup.done) return '';
    const wp = v.workoutPlan, key = wkey(S.date);
    const pd = wp ? wp.days.find((d) => d.day === key) : null;
    const logged = S.dayWorkouts || [];
    const planned = (pd ? pd.sessions : []).map((s, i) => {
      const done = logged.some((w) => w.name === s.name) || logged.length > i;
      return `<div class="flex items-center justify-between gap-2 py-2"><div class="min-w-0"><div class="text-sm font-medium ${done ? 'line-through opacity-60' : ''}">${esc(s.name)}</div><div class="text-xs text-gray-500 dark:text-gray-400">${esc(s.type)} · ${s.minutes} min · ${s.exercises.length} exercises</div></div>${done ? '<i class="fa-solid fa-circle-check text-emerald-500"></i>' : `<button data-act="wo-plan" data-date="${esc(S.date)}" data-i="${i}" class="${primary} !py-1.5 !min-h-[40px] text-sm shrink-0">Done as planned</button>`}</div>`;
    }).join('');
    const done = logged.map((w) => `<button data-act="wo-edit" data-id="${esc(w.id)}" class="w-full text-left py-2 flex justify-between gap-2 min-h-[44px]"><span class="text-sm truncate"><i class="fa-solid fa-dumbbell text-emerald-500 mr-2"></i>${esc(w.name)}</span><span class="text-xs text-gray-500 shrink-0">${w.minutes ? w.minutes + ' min' : ''}${w.effort ? ' · effort ' + w.effort : ''}</span></button>`).join('');
    return `<section class="${card} p-4"><div class="flex items-center justify-between"><h3 class="font-semibold"><i class="fa-solid fa-dumbbell text-indigo-500 mr-2"></i>Workout</h3><button data-act="wo-new" class="text-sm text-indigo-500 min-h-[36px]"><i class="fa-solid fa-plus"></i> Log workout</button></div>${planned || (logged.length ? '' : `<p class="text-sm text-gray-500 dark:text-gray-400 py-1">${wp ? 'Rest day. Nothing planned.' : 'No workout plan yet.'}</p>`)}${done}</section>`;
  }
  function workoutList(h) {
    const ws = h.workouts || [];
    return `<section class="${card} p-4 space-y-2"><div class="flex items-center justify-between"><h3 class="font-semibold">Workouts, last 30 days</h3><span class="text-sm text-gray-500">${ws.length} logged</span></div>${ws.length ? ws.slice(0, 40).map((w) => `<button data-act="wo-edit" data-id="${esc(w.id)}" class="w-full text-left flex justify-between gap-2 py-1.5 border-t border-gray-200 dark:border-white/10 min-h-[40px]"><span class="text-sm truncate">${esc(w.name)} <span class="text-xs text-gray-500">${esc(w.type)}</span></span><span class="text-xs text-gray-500 shrink-0">${esc(w.date.slice(5))}${w.minutes ? ' · ' + w.minutes + ' min' : ''}${w.effort ? ' · ' + w.effort + '/10' : ''}</span></button>`).join('') : '<p class="text-sm text-gray-500 dark:text-gray-400">No workouts logged yet.</p>'}</section>`;
  }

  // ---- first-time setup
  const QUICK = [['lose_weight', 'Lose weight', 'fa-arrow-trend-down'], ['gain_weight', 'Gain weight', 'fa-arrow-trend-up'], ['reduce_waist', 'Reduce waist', 'fa-ruler'], ['strength', 'Build strength', 'fa-dumbbell'], ['endurance', 'Build endurance', 'fa-person-running'], ['general_health', 'General health', 'fa-heart-pulse']];
  function newWiz(redo) {
    const p = S.profile || {}, a = (S.view && S.view.setup.answers) || {};
    const imp = (p.units || 'imperial') !== 'metric';
    const [ft, inch] = p.heightCm ? cmToFtIn(p.heightCm) : ['', ''];
    const goals = {}; QUICK.forEach(([k]) => { goals[k] = { on: false, target: '' }; });
    if (redo && S.view) S.view.goals.filter((g) => g.status === 'active' && goals[g.type]).forEach((g) => { goals[g.type] = { on: true, target: g.target ? (g.type.endsWith('weight') ? (imp ? r1(kgToLb(g.target)) : g.target) : g.type === 'reduce_waist' ? (imp ? r1(g.target / 2.54) : g.target) : '') : '' }; });
    return { step: 1, redo: !!redo, chat: [], chatOpen: false, busy: false, generating: false, failed: false, form: {
      units: p.units || 'imperial', age: p.age || '', sex: p.sex || '', ft, inch, cm: p.heightCm || '', weight: p.weightKg ? (imp ? r1(kgToLb(p.weightKg)) : p.weightKg) : '', activity: p.activity || '',
      goals, waist: '', pace: imp ? 1 : 0.5, goalsText: a.goalsText || '', experience: a.experience || 'beginner', daysPerWeek: a.daysPerWeek === undefined ? 3 : a.daysPerWeek, minutes: a.minutes || 45, equipment: a.equipment || 'home', limits: a.limits || '', routine: a.routine || '', diet: a.diet || '' } };
  }
  function wizConvert(f, to) {
    if (f.units === to) return;
    if (to === 'metric') { const cm = ftInToCm(f.ft || 0, f.inch || 0); f.cm = f.ft !== '' || f.inch !== '' ? r1(cm) : ''; f.weight = f.weight === '' ? '' : r1(lbToKg(Number(f.weight))); ['lose_weight', 'gain_weight'].forEach((k) => { if (f.goals[k].target !== '') f.goals[k].target = r1(lbToKg(Number(f.goals[k].target))); }); f.pace = 0.5; }
    else { if (f.cm !== '') { const [a, b] = cmToFtIn(Number(f.cm)); f.ft = a; f.inch = b; } f.weight = f.weight === '' ? '' : r1(kgToLb(Number(f.weight))); ['lose_weight', 'gain_weight'].forEach((k) => { if (f.goals[k].target !== '') f.goals[k].target = r1(kgToLb(Number(f.goals[k].target))); }); f.pace = 1; }
    if (f.waist !== '' && f.waist !== undefined) f.waist = to === 'metric' ? r1(Number(f.waist) * 2.54) : r1(Number(f.waist) / 2.54);
    if (f.goals.reduce_waist.target !== '') f.goals.reduce_waist.target = to === 'metric' ? r1(Number(f.goals.reduce_waist.target) * 2.54) : r1(Number(f.goals.reduce_waist.target) / 2.54);
    f.units = to;
  }
  function wizPayload(f) {
    const imp = f.units === 'imperial';
    const profile = { units: f.units, age: f.age, sex: f.sex, activity: f.activity, heightCm: imp ? r1(ftInToCm(f.ft || 0, f.inch || 0)) : Number(f.cm), weightKg: imp ? r1(lbToKg(Number(f.weight))) : Number(f.weight), rateKgPerWeek: imp ? r1(lbToKg(Number(f.pace))) : Number(f.pace) };
    const goals = [];
    QUICK.forEach(([k, n]) => {
      const g = f.goals[k]; if (!g.on) return;
      const o = { type: k, title: n };
      if (k.endsWith('weight') && g.target !== '') o.target = imp ? r1(lbToKg(Number(g.target))) : Number(g.target);
      if (k === 'reduce_waist' && g.target !== '') o.target = imp ? r1(Number(g.target) * 2.54) : Number(g.target);
      goals.push(o);
    });
    if (f.goalsText.trim() && !goals.length) goals.push({ type: 'other', title: f.goalsText.trim().slice(0, 100) });
    const answers = { goalsText: f.goalsText, experience: f.experience, daysPerWeek: Number(f.daysPerWeek), minutes: Number(f.minutes), equipment: f.equipment, limits: f.limits, routine: f.routine, diet: f.diet };
    const out = { profile, goals, answers };
    if (f.goals.reduce_waist.on && f.waist !== '' && f.waist !== undefined) out.waistCm = imp ? r1(Number(f.waist) * 2.54) : Number(f.waist);
    return out;
  }
  function wizMerge(fields) {
    const f = S.wiz.form, imp = f.units === 'imperial';
    ['goalsText', 'experience', 'daysPerWeek', 'minutes', 'equipment', 'limits', 'routine', 'diet'].forEach((k) => { if (fields[k] !== undefined) f[k] = fields[k]; });
    (fields.goals || []).forEach((g) => { if (!f.goals[g.type]) return; f.goals[g.type].on = true; if (g.target && g.type.endsWith('weight')) f.goals[g.type].target = imp ? r1(kgToLb(g.target)) : g.target; if (g.target && g.type === 'reduce_waist') f.goals[g.type].target = imp ? r1(g.target / 2.54) : g.target; });
    const b = fields.basics || {};
    if (b.age) f.age = b.age; if (b.sex) f.sex = b.sex; if (b.activity) f.activity = b.activity;
    if (b.heightCm) { if (imp) { const [a, i] = cmToFtIn(b.heightCm); f.ft = a; f.inch = i; } else f.cm = b.heightCm; }
    if (b.weightKg) f.weight = imp ? r1(kgToLb(b.weightKg)) : b.weightKg;
  }
  function wizSnapshot() { const f = S.wiz.form; const p = wizPayload(f); return { answers: p.answers, goalsPicked: p.goals.map((g) => g.type), basicsFilled: { age: f.age, sex: f.sex, activity: f.activity } }; }
  function wizStepError() {
    const f = S.wiz.form, n = S.wiz.step;
    if (n === 1) { if (!(Number(f.age) >= 10)) return 'Enter your age.'; if (!f.sex) return 'Choose an option for sex (used for the calorie formula).'; if (f.units === 'imperial' ? !(Number(f.ft) >= 3) : !(Number(f.cm) >= 90)) return 'Enter your height.'; if (!(Number(f.weight) > 0)) return 'Enter your weight.'; if (!f.activity) return 'Choose your daily activity level.'; }
    if (n === 2) { for (const k of ['lose_weight', 'gain_weight']) if (f.goals[k].on && f.goals[k].target === '') return 'Enter a target weight, or untick that goal.'; }
    return '';
  }
  function renderWiz() {
    const w = S.wiz, f = w.form, imp = f.units === 'imperial', n = w.step;
    const titles = ['About you', 'Your goals', 'Training', 'Where you are now', 'Review'];
    const inp = (id, lab, key, attrs, val) => `<div><label class="${label}" for="${id}">${lab}</label><input id="${id}" data-w="${key}" class="${input}" ${attrs || ''} value="${esc(val)}"></div>`;
    const sel = (id, lab, key, opts, cur) => `<div><label class="${label}" for="${id}">${lab}</label><select id="${id}" data-w="${key}" class="${input}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
    const seg = (key, opts, cur) => `<div class="grid grid-cols-${opts.length} gap-2">${opts.map(([v, t]) => `<button type="button" data-act="wz-set" data-k="${key}" data-v="${esc(v)}" class="py-2.5 rounded-xl border text-sm min-h-[44px] ${String(cur) === String(v) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 dark:border-white/10'}">${esc(t)}</button>`).join('')}</div>`;
    let body = '';
    if (w.generating) {
      body = w.failed ? `<section class="${card} p-5 space-y-3 text-center"><p>${esc(S.err || 'The Coach could not build your plan just now.')}</p><p class="text-sm text-gray-500">Your answers are saved.</p><button data-act="gen-plan" class="${primary} w-full">Try again</button><button data-act="wz-skip-plan" class="text-sm text-gray-500 underline">Continue without a plan for now</button></section>`
        : `<section class="${card} p-6 text-center space-y-3"><i class="fa-solid fa-spinner fa-spin text-3xl text-indigo-500"></i><div class="font-semibold">Building your plan…</div><p class="text-sm text-gray-500 dark:text-gray-400">The Coach is starting from what you already do and what you want. This can take up to a minute.</p></section>`;
    } else if (n === 1) {
      body = `<div><span class="${label}">Units</span>${seg('units', [['imperial', 'lb, ft / in'], ['metric', 'kg, cm']], f.units)}</div>
        <div class="grid grid-cols-2 gap-3">${inp('wz-age', 'Age', 'age', 'type="number" inputmode="numeric" min="10" max="100"', f.age)}${sel('wz-sex', 'Sex (for the calorie formula)', 'sex', [['', 'Choose…'], ['male', 'Male'], ['female', 'Female'], ['other', 'Other / prefer not to say']], f.sex)}
        ${imp ? inp('wz-ft', 'Height (ft)', 'ft', 'type="number" inputmode="numeric" min="3" max="8"', f.ft) + inp('wz-in', 'Height (in)', 'inch', 'type="number" inputmode="decimal" min="0" max="11.9" step="any"', f.inch) : inp('wz-cm', 'Height (cm)', 'cm', 'type="number" inputmode="decimal" step="any"', f.cm)}
        <div class="${imp ? 'col-span-2' : ''}">${inp('wz-w', `Weight (${imp ? 'lb' : 'kg'})`, 'weight', 'type="number" inputmode="decimal" step="any"', f.weight)}</div></div>
        ${sel('wz-act', 'How active are you day to day?', 'activity', [['', 'Choose…']].concat(ACTIVITY), f.activity)}`;
    } else if (n === 2) {
      body = `<div><span class="${label}">What do you want to work on? (pick any)</span><div class="flex flex-wrap gap-2">${QUICK.map(([k, t, ic]) => `<button type="button" data-act="wz-goal" data-g="${k}" aria-pressed="${f.goals[k].on}" class="px-3.5 py-2.5 rounded-full border text-sm min-h-[44px] ${f.goals[k].on ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 dark:border-white/10'}"><i class="fa-solid ${ic} mr-1.5"></i>${t}</button>`).join('')}</div></div>
        ${(() => {
          const wkg = imp ? lbToKg(Number(f.weight) || 0) : Number(f.weight) || 0, hcm = imp ? ftInToCm(f.ft || 0, f.inch || 0) : Number(f.cm) || 0;
          const cap = wkg ? safeCapKg(wkg) : 0.9;
          const allOpts = imp ? [0.5, 1, 1.5, 2].map((v) => [v, v + ' lb / week', lbToKg(v)]) : [0.25, 0.5, 0.75, 1].map((v) => [v, v + ' kg / week', v]);
          let opts = allOpts.filter((o) => o[2] <= cap + 0.001); if (!opts.length) opts = [allOpts[0]];
          if (!opts.some((o) => Number(o[0]) === Number(f.pace))) f.pace = opts[opts.length - 1][0];
          const minW = hcm ? (imp ? Math.ceil(kgToLb(18.5 * (hcm / 100) ** 2)) + ' lb' : (Math.ceil(18.5 * (hcm / 100) ** 2 * 10) / 10) + ' kg') : '';
          const minWaist = hcm ? (imp ? (Math.ceil(0.4 * hcm / 2.54 * 10) / 10) + ' in' : (Math.ceil(0.4 * hcm * 10) / 10) + ' cm') : '';
          const young = Number(f.age) > 0 && Number(f.age) < 18;
          return (young ? `<p class="text-sm text-amber-500">Under 18: weight-loss goals are not available. Pick a health, strength or endurance goal instead, and talk to a doctor or dietitian.</p>` : '')
            + ['lose_weight', 'gain_weight'].filter((k) => f.goals[k].on).map((k) => `<div class="grid grid-cols-2 gap-3">${inp('wz-t-' + k, `Target weight (${imp ? 'lb' : 'kg'})`, 'goal.' + k, 'type="number" inputmode="decimal" step="any"', f.goals[k].target)}${sel('wz-pace-' + k, 'Pace', 'pace', opts.map((o) => [o[0], o[1]]), f.pace)}${minW ? `<div class="col-span-2 text-xs text-gray-500">Lowest allowed for your height: ${minW}. Loss pace is capped at about 1% of your weight a week (max 2 lb).</div>` : ''}</div>`).join('')
            + (f.goals.reduce_waist.on ? `<div class="grid grid-cols-2 gap-3">${inp('wz-wc', `Waist now (${imp ? 'in' : 'cm'})`, 'waist', 'type="number" inputmode="decimal" step="any"', f.waist)}${inp('wz-wt', `Target waist (${imp ? 'in' : 'cm'})`, 'goal.reduce_waist', 'type="number" inputmode="decimal" step="any"', f.goals.reduce_waist.target)}<div class="col-span-2 text-xs text-gray-500">Measure around your belly button, relaxed, after a normal breath out.${minWaist ? ` Lowest allowed target: ${minWaist}.` : ''}</div></div>` : '');
        })()}
        <div><label class="${label}" for="wz-gt">…or in your own words</label><textarea id="wz-gt" data-w="goalsText" rows="3" maxlength="500" class="${input}" placeholder="e.g. I want to lose the weight I put on this year and get my energy back">${esc(f.goalsText)}</textarea></div>`;
    } else if (n === 3) {
      body = `<div><span class="${label}">Training experience</span>${seg('experience', [['beginner', 'Beginner'], ['intermediate', 'Some'], ['advanced', 'Advanced']], f.experience)}</div>
        <div class="grid grid-cols-2 gap-3">${sel('wz-days', 'Days a week you can train', 'daysPerWeek', [0, 1, 2, 3, 4, 5, 6, 7].map((x) => [x, String(x)]), f.daysPerWeek)}${sel('wz-min', 'Minutes per session', 'minutes', [20, 30, 45, 60, 75, 90].map((x) => [x, x + ' min']), f.minutes)}</div>
        <div><span class="${label}">Where will you train?</span>${seg('equipment', [['gym', 'Gym'], ['home', 'Home gear'], ['none', 'No equipment']], f.equipment)}</div>
        <div><label class="${label}" for="wz-lim">Injuries or limits (optional)</label><textarea id="wz-lim" data-w="limits" rows="2" maxlength="300" class="${input}" placeholder="e.g. sore left knee, no overhead lifting">${esc(f.limits)}</textarea></div>`;
    } else if (n === 4) {
      const chip = (k, vs) => `<div class="flex flex-wrap gap-2 mt-2">${vs.map((v) => `<button type="button" data-act="wz-chip" data-k="${k}" data-v="${esc(v)}" class="px-3 py-1.5 rounded-full border border-gray-300 dark:border-white/10 text-xs min-h-[36px]">${esc(v)}</button>`).join('')}</div>`;
      body = `<p class="text-sm text-gray-500 dark:text-gray-400">The Coach starts from what you already do and keeps what works. "Nothing yet" is a fine answer.</p>
        <div><label class="${label}" for="wz-routine">What training do you do now?</label><textarea id="wz-routine" data-w="routine" rows="3" maxlength="600" class="${input}" placeholder="e.g. Lift Mon/Wed/Fri at the gym, 20 min walk most days">${esc(f.routine)}</textarea>${chip('routine', ['Nothing yet', 'Walking most days', 'Gym 3 times a week', 'Running a few times a week'])}</div>
        <div><label class="${label}" for="wz-diet">How do you eat now, or what plan are you on?</label><textarea id="wz-diet" data-w="diet" rows="3" maxlength="400" class="${input}" placeholder="e.g. intermittent fasting, about 2000 kcal">${esc(f.diet)}</textarea>${chip('diet', ['No plan', 'Intermittent fasting', 'About 2000 kcal', 'Low carb', 'Vegetarian'])}</div>`;
    } else {
      const p = wizPayload(f);
      const rows = [['You', `${f.age}, ${f.sex}, ${imp ? f.ft + "'" + f.inch + '"' : f.cm + ' cm'}, ${f.weight} ${imp ? 'lb' : 'kg'}, ${(ACTIVITY.find((x) => x[0] === f.activity) || ['', ''])[1].split(' (')[0]}`], ['Goals', p.goals.map((g) => g.title + (g.target ? ' → ' + (imp ? r1(kgToLb(g.target)) + ' lb' : g.target + ' kg') : '')).join(', ') || '—'], ['In your words', f.goalsText || '—'], ['Training', `${f.experience}, ${f.daysPerWeek} days × ${f.minutes} min, ${f.equipment}${f.limits ? '; limits: ' + f.limits : ''}`], ['Doing now', f.routine || 'Nothing yet'], ['Eating now', f.diet || 'No plan']];
      body = `<section class="${card} p-4 divide-y divide-gray-200 dark:divide-white/10">${rows.map(([a, b]) => `<div class="py-2"><div class="text-xs text-gray-500">${a}</div><div class="text-sm">${esc(b)}</div></div>`).join('')}</section><p class="text-sm text-gray-500 dark:text-gray-400">The Coach will build your daily targets and a weekly workout plan from this, starting from what you already do. You can undo anything it sets.</p>`;
    }
    const chatPanel = !w.generating && n >= 2 ? `<section class="${card} p-3 space-y-2"><button data-act="wz-chat" class="w-full text-left flex justify-between items-center min-h-[40px]"><span class="font-medium text-sm"><i class="fa-solid fa-comments text-indigo-500 mr-2"></i>Talk it through with the Coach</span><span class="text-xs text-gray-500">free during setup <i class="fa-solid fa-chevron-${w.chatOpen ? 'up' : 'down'}"></i></span></button>${w.chatOpen ? `<div id="wz-chatlog" class="space-y-2 max-h-48 overflow-y-auto">${w.chat.map((m) => `<div class="${m.role === 'user' ? 'text-right' : ''}"><span class="inline-block rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-black/5 dark:bg-white/10'}">${esc(m.text)}</span></div>`).join('') || '<p class="text-xs text-gray-500">Tell the Coach about your goals, routine or how you eat. It fills in the form for you to check.</p>'}${w.busy ? '<div class="text-sm text-gray-500"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Thinking…</div>' : ''}</div><div class="flex gap-2"><input id="wz-chatin" class="${input}" maxlength="500" placeholder="Say something…" ${w.busy ? 'disabled' : ''}><button data-act="wz-send" class="${primary}" ${w.busy ? 'disabled' : ''} aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></div>` : ''}</section>` : '';
    const nav = w.generating ? '' : `<div class="flex gap-2 sticky bottom-0 py-2 bg-white/90 dark:bg-dark-bg/90 backdrop-blur">${n > 1 ? `<button data-act="wz-back" class="${ghost}">Back</button>` : (w.redo ? `<button data-act="wz-cancel" class="${ghost}">Cancel</button>` : `<button data-act="wz-skip" class="${ghost}">Skip for now</button>`)}<button data-act="${n === 5 ? 'wz-finish' : 'wz-next'}" class="${primary} flex-1">${n === 5 ? 'Create my plan' : 'Next'}</button></div>`;
    return `<div class="max-w-xl mx-auto space-y-4 pb-24"><div class="pt-2"><div class="text-xs text-gray-500 dark:text-gray-400">${w.generating ? 'Almost there' : `Step ${n} of 5`}</div><h2 class="text-xl font-bold">${w.generating ? 'Your plan' : titles[n - 1]}</h2><div class="flex gap-1 mt-2">${[1, 2, 3, 4, 5].map((i) => `<div class="h-1.5 flex-1 rounded-full ${i <= n ? 'bg-indigo-600' : 'bg-black/10 dark:bg-white/10'}"></div>`).join('')}</div></div>${note('err')}<section class="${card} p-4 space-y-4 ${w.generating ? 'hidden' : ''}">${w.generating ? '' : body}</section>${w.generating ? body : ''}${chatPanel}${nav}</div>`;
  }
  async function wizSend() {
    const el = document.getElementById('wz-chatin'); const text = el ? el.value.trim() : ''; const w = S.wiz;
    if (!text || w.busy) return;
    try {
      const r = await api('/api/nutrition/setup/chat', { method: 'POST', body: { message: text, current: wizSnapshot() } });
      w.chat.push({ role: 'user', text }); w.busy = true; S.err = ''; S.limit = r.limit; render(); startPoll('setup');
    } catch (e) { S.err = e.message; render(); }
  }
  async function wizFinish() {
    const w = S.wiz;
    try {
      await api('/api/nutrition/setup', { method: 'PUT', body: wizPayload(w.form) });
      w.generating = true; w.failed = false; S.err = ''; render(); startPoll('plan');
    } catch (e) { S.err = e.message; render(); }
  }

  // ---- jobs
  let pollTimer = null;
  function startPoll(kind) { S.busy = true; S.jobKind = kind; render(); pollCoach(); }
  function pollCoach() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const st = await api('/api/nutrition/coach/status');
        S.limit = st.limit;
        if (st.state === 'running') { S.jobKind = st.kind || S.jobKind; return pollCoach(); }
        const kind = st.kind || S.jobKind;
        S.busy = false;
        if (st.messages && S.coach) S.coach.messages = st.messages;
        if (st.loggedState && S.coach) S.coach.loggedState = st.loggedState;
        if (kind === 'chat' && (st.logged || []).length) { S.hist = null; await loadDay(); }
        if (st.view) { S.view = st.view; applyView(); }
        if (st.state === 'failed') { S.err = st.error || 'The Coach could not finish that.'; if (S.wiz) { S.wiz.busy = false; if (kind === 'plan') S.wiz.failed = true; } }
        else if (kind === 'setup' && st.setupReply && S.wiz) { S.wiz.busy = false; S.wiz.chat.push({ role: 'coach', text: st.setupReply.reply }); wizMerge(st.setupReply.fields || {}); }
        else if (kind === 'plan') { S.wiz = null; S.tab = 'plan'; S.msg = ''; S.hist = null; await Promise.all([loadDay(), loadDayWorkouts()]); }
        else if (kind === 'review') { S.msg = st.summary ? 'Review done.' : ''; S.tab = S.tab === 'today' ? 'plan' : S.tab; S.hist = null; }
        else if (kind === 'chat') { S.lastChanges = st.changes || []; }
        render(); scrollChat();
        const cl = document.getElementById('wz-chatlog'); if (cl) cl.scrollTop = cl.scrollHeight;
      } catch (e) { pollCoach(); }
    }, 2000);
  }
  async function startReview(auto) {
    try { const r = await api('/api/nutrition/review', { method: 'POST', body: { auto: !!auto } }); S.limit = r.limit; S.err = ''; startPoll('review'); }
    catch (e) { if (!auto) S.err = e.message; render(); }
  }
  async function genPlan() {
    try { const r = await api('/api/nutrition/plan/generate', { method: 'POST', body: {} }); S.limit = r.limit; S.err = ''; if (S.wiz) { S.wiz.generating = true; S.wiz.failed = false; } startPoll('plan'); }
    catch (e) { S.err = e.message; render(); }
  }
  async function undoChange(id) {
    try { S.view = await api('/api/nutrition/changes/' + id + '/undo', { method: 'POST' }); applyView(); S.msg = 'Undone.'; S.lastChanges = (S.lastChanges || []).filter((c) => c.id !== id); await loadDay(); } catch (e) { S.err = e.message; render(); }
  }
  function profileExtras() {
    const v = S.view; if (!v) return '';
    const a = v.setup.answers;
    return `<section class="${card} p-4 space-y-2"><h3 class="font-semibold">Goals and plan</h3>${a ? `<p class="text-sm text-gray-500 dark:text-gray-400">Training now: ${esc(a.routine || 'nothing yet')}. Eating now: ${esc(a.diet || 'no plan')}.</p>` : '<p class="text-sm text-gray-500">You have not done the guided setup yet.</p>'}<button data-act="wz-redo" class="${ghost} w-full">${v.setup.done ? 'Redo setup' : 'Start guided setup'}</button>${v.setup.done ? '<p class="text-xs text-gray-500 dark:text-gray-400">The Coach rebuilds your plan from your new answers. You can undo what it changes.</p>' : ''}</section>`;
  }

  // ------------------------------------------------------------ shell
  function render() {
    const el = root(); if (!el) return;
    if (S.wiz && S.loaded) {
      const keep = document.activeElement && document.activeElement.id; const sy = window.scrollY;
      el.innerHTML = renderWiz(); if (keep) { const e2 = document.getElementById(keep); if (e2 && e2.focus && e2.tagName !== 'BUTTON') e2.focus(); }
      return;
    }
    const tabs = [['today', 'Today', 'fa-utensils'], ['plan', 'Plan', 'fa-bullseye'], ['coach', 'Coach', 'fa-comments'], ['history', 'History', 'fa-chart-column'], ['profile', 'Profile', 'fa-user']];
    const nav = `<div class="grid grid-cols-5 gap-1 p-1 rounded-2xl bg-black/5 dark:bg-white/5" role="tablist">${tabs.map(([k, n, ic]) => `<button role="tab" aria-selected="${S.tab === k}" data-act="tab" data-tab="${k}" class="py-1.5 rounded-xl text-[12px] font-medium min-h-[48px] flex flex-col items-center justify-center gap-0.5 ${S.tab === k ? 'bg-indigo-600 text-white shadow' : 'text-gray-500 dark:text-gray-400'}"><i class="fa-solid ${ic} text-sm"></i>${n}</button>`).join('')}</div>`;
    let body = '';
    if (!S.loaded) body = S.err ? '' : '<div class="text-sm text-gray-500 p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
    else if (S.tab === 'today') body = renderToday();
    else if (S.tab === 'plan') body = renderPlan();
    else if (S.tab === 'history') body = renderHistory();
    else if (S.tab === 'coach') body = renderCoach();
    else body = renderProfile() + `<p class="text-center text-xs text-gray-400 dark:text-gray-500 pt-2">Nutrition ${esc((S.view && S.view.version) || '1.0.2')}</p>`;
    const ta = document.getElementById('nut-input'); const draft = ta ? ta.value : '';
    el.innerHTML = `<div class="max-w-2xl mx-auto space-y-4 pb-24 md:pb-8">${nav}${note('err')}${note('msg')}${body}</div>${sheetHtml()}${goalSheetHtml()}${workoutSheetHtml()}`;
    const ta2 = document.getElementById('nut-input'); if (ta2 && draft) ta2.value = draft;
  }

  async function setTab(tab) {
    S.tab = tab; S.err = ''; S.msg = ''; render();
    if (tab === 'history' && !S.hist) loadHistory();
    if (tab === 'plan') refreshView();
    if (tab === 'coach') loadCoach();
  }

  function onClick(ev) {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act;
    if (a === 'gs-bg' || a === 'ws-bg') { if (ev.target === t) { S.gs = null; S.ws = null; render(); } return; }
    if (a === 'undo') return undoChange(t.dataset.id);
    if (a === 'log-undo') { api('/api/nutrition/changes/' + t.dataset.c + '/undo', { method: 'POST' }).then(async (v) => { S.view = v; applyView(); S.hist = null; await refreshLogged(); await loadDay(); S.msg = 'Removed from your log.'; render(); }).catch((e) => { S.err = e.message; render(); }); return; }
    if (a === 'log-portion') { api('/api/nutrition/entries/' + t.dataset.id + '/portion', { method: 'POST', body: { factor: Number(t.dataset.f) } }).then(async () => { S.hist = null; await refreshLogged(); await loadDay(); render(); }).catch((e) => { S.err = e.message; render(); }); return; }
    if (a === 'log-edit') {
      const kind = t.dataset.kind, id = t.dataset.id, date = t.dataset.date;
      if (kind === 'food') api('/api/nutrition/day?date=' + date).then((d) => { const e = d.entries.find((x) => x.id === id); if (e) { S.date = date; S.day = d; openSheet({ entry: e }); } }).catch((er) => { S.err = er.message; render(); });
      else api('/api/nutrition/workouts?from=' + date + '&to=' + date).then((ws) => { const w = ws.find((x) => x.id === id); if (w) openWorkout({ workout: w }); }).catch((er) => { S.err = er.message; render(); });
      return;
    }
    if (a === 'nut') { S.nutOpen = S.nutOpen === t.dataset.k ? null : t.dataset.k; return render(); }
    if (a === 'help') { S.help[t.dataset.k] = !S.help[t.dataset.k]; return render(); }
    if (a === 'more') { S.more[t.dataset.k] = !S.more[t.dataset.k]; return render(); }
    if (a === 'del-waist') { api('/api/nutrition/waists/' + t.dataset.id, { method: 'DELETE' }).then(async () => { await refreshView(); return loadHistory(); }).catch((e) => { S.err = e.message; render(); }); return; }
    if (a === 'review') return startReview(false);
    if (a === 'gen-plan') return genPlan();
    if (a === 'goal-new') { S.gs = { id: null, type: 'strength', title: '', target: '', deadline: '', status: 'active' }; return render(); }
    if (a === 'goal-edit') { const g = S.view.goals.find((x) => x.id === t.dataset.id); if (g) { S.gs = { id: g.id, type: g.type, title: g.title, target: g.target ? (g.type.endsWith('weight') ? fromKg(g.target) : g.type === 'reduce_waist' ? fromCm(g.target) : g.target) : '', deadline: g.deadline || '', status: g.status }; render(); } return; }
    if (a === 'gs-close') { S.gs = null; return render(); }
    if (a === 'gs-save') return saveGoal();
    if (a === 'gs-del') { if (!confirm('Remove this goal?')) return; api('/api/nutrition/goals/' + S.gs.id, { method: 'DELETE' }).then(() => { S.gs = null; return refreshView(); }).catch((e) => { S.err = e.message; S.gs = null; render(); }); return; }
    if (a === 'wo-new') return openWorkout({});
    if (a === 'wo-edit') { api('/api/nutrition/workouts?from=2000-01-01&to=2100-01-01').then((all) => { const w = all.find((x) => x.id === t.dataset.id); if (w) openWorkout({ workout: w }); }).catch((e) => { S.err = e.message; render(); }); return; }
    if (a === 'wo-plan') return doneAsPlanned(t.dataset.date, t.dataset.i);
    if (a === 'ws-close') { S.ws = null; return render(); }
    if (a === 'ws-save') return saveWorkout();
    if (a === 'ws-del') { if (!confirm('Delete this workout?')) return; api('/api/nutrition/workouts/' + S.ws.id, { method: 'DELETE' }).then(async () => { S.ws = null; S.hist = null; await Promise.all([refreshView(), loadDayWorkouts()]); render(); }).catch((e) => { S.err = e.message; S.ws = null; render(); }); return; }
    if (a === 'ws-from') { const dd = (S.view.workoutPlan.days.find((d) => d.day === wkey(S.ws.date)) || { sessions: [] }).sessions[Number(t.dataset.i)]; if (dd) { S.ws.name = dd.name; S.ws.type = dd.type; S.ws.minutes = dd.minutes; S.ws.exercises = dd.exercises.map((e) => ({ name: e.name, sets: e.sets || '', reps: typeof e.reps === 'number' ? e.reps : parseInt(e.reps, 10) || '', weight: '', minutes: e.minutes || '', distance: '' })); } return render(); }
    if (a === 'wx-add') { S.ws.exercises.push({ name: '', sets: '', reps: '', weight: '', minutes: '', distance: '' }); return render(); }
    if (a === 'wx-del') { S.ws.exercises.splice(Number(t.dataset.i), 1); return render(); }
    if (a === 'wz-set') { const f = S.wiz.form; if (t.dataset.k === 'units') wizConvert(f, t.dataset.v); else f[t.dataset.k] = t.dataset.v; return render(); }
    if (a === 'wz-goal') { const g = S.wiz.form.goals[t.dataset.g]; g.on = !g.on; return render(); }
    if (a === 'wz-chip') { S.wiz.form[t.dataset.k] = t.dataset.v; return render(); }
    if (a === 'wz-next') { const er = wizStepError(); if (er) { S.err = er; return render(); } S.err = ''; S.wiz.step += 1; render(); return window.scrollTo({ top: 0 }); }
    if (a === 'wz-back') { S.err = ''; S.wiz.step -= 1; render(); return window.scrollTo({ top: 0 }); }
    if (a === 'wz-finish') return wizFinish();
    if (a === 'wz-chat') { S.wiz.chatOpen = !S.wiz.chatOpen; return render(); }
    if (a === 'wz-send') return wizSend();
    if (a === 'wz-skip') { S.skipSetup = true; S.wiz = null; return render(); }
    if (a === 'wz-cancel' || a === 'wz-skip-plan') { S.wiz = null; S.err = ''; S.tab = a === 'wz-skip-plan' ? 'plan' : S.tab; return render(); }
    if (a === 'wz-redo') { S.wiz = newWiz(true); render(); return window.scrollTo({ top: 0 }); }
    if (a === 'sheet-bg') { if (ev.target === t) { S.sheet = null; render(); } return; }
    if (a === 'tab') return setTab(t.dataset.tab);
    if (a === 'goto') return setTab(t.dataset.tab);
    if (a === 'dismiss') { S.err = ''; S.msg = ''; return render(); }
    if (a === 'day') { const n = Number(t.dataset.n); S.date = n === 0 ? localToday() : shiftDate(S.date, n); return loadDay(); }
    if (a === 'add') return openSheet({ meal: t.dataset.meal });
    if (a === 'edit') { const e = S.day.entries.find((x) => x.id === t.dataset.id); if (e) openSheet({ entry: e }); return; }
    if (a === 'sheet-close') { S.sheet = null; return render(); }
    if (a === 'search') return doSearch();
    if (a === 'pick') { const s = S.sheet; s.chosen = s.results[Number(t.dataset.i)]; s.portion = 0; s.name = s.chosen.name + (s.chosen.brand ? ' (' + s.chosen.brand + ')' : ''); s.servings = 1; s.source = 'usda'; applyPortion(); return keepScroll(render); }
    if (a === 'myfood') { const f = S.foods[Number(t.dataset.i)]; const s = S.sheet; s.chosen = null; s.name = f.name; s.serving = f.serving; s.per = Object.assign({}, f.per); s.servings = 1; s.source = 'myfood'; return keepScroll(render); }
    if (a === 'save-entry') return saveEntry();
    if (a === 'del-entry') { if (!confirm('Delete this food from your log?')) return; api('/api/nutrition/entries/' + S.sheet.id, { method: 'DELETE' }).then(() => { S.sheet = null; return loadDay(); }).catch((e) => { S.err = e.message; S.sheet = null; render(); }); return; }
    if (a === 'del-weight') { api('/api/nutrition/weights/' + t.dataset.id, { method: 'DELETE' }).then(loadHistory).catch((e) => { S.err = e.message; render(); }); return; }
    if (a === 'chip') return sendCoach(t.dataset.t);
    if (a === 'saveplan') return savePlan(Number(t.dataset.i), t.dataset.type);
    if (a === 'toggle-plan') { S.openPlan = S.openPlan === t.dataset.id ? null : t.dataset.id; return render(); }
    if (a === 'del-plan') { if (!confirm('Delete this saved plan?')) return; api('/api/nutrition/plans/' + t.dataset.id, { method: 'DELETE' }).then(async () => { S.plans = await api('/api/nutrition/plans'); S.openPlan = null; render(); }).catch((e) => { S.err = e.message; render(); }); return; }
    if (a === 'clear-chat') { if (!confirm('Clear this conversation? Saved plans stay.')) return; api('/api/nutrition/coach', { method: 'DELETE' }).then(() => { S.coach.messages = []; render(); }).catch((e) => { S.err = e.message; render(); }); }
  }
  function setPath(obj, path, val) { const ks = path.split('.'); let o = obj; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = val; }
  function onInput(ev) {
    const t = ev.target; const d = t.dataset || {};
    if (d.w !== undefined && S.wiz) { const f = S.wiz.form; if (d.w.startsWith('goal.')) f.goals[d.w.slice(5)].target = t.value; else if (d.w === 'pace') f.pace = Number(t.value); else f[d.w] = t.value; return; }
    if (d.g !== undefined && S.gs) { S.gs[d.g] = t.value; if (d.g === 'type') render(); return; }
    if (d.ws !== undefined && S.ws) { S.ws[d.ws] = t.value; return; }
    if (d.wx !== undefined && S.ws) { const [i, k] = d.wx.split('.'); S.ws.exercises[Number(i)][k] = t.value; return; }
    const f = d.f; if (!f || !S.sheet) return;
    const v = t.type === 'checkbox' ? t.checked : t.value;
    if (f === 'portion') { S.sheet.portion = Number(v); applyPortion(); return keepScroll(render); }
    if (f === 'meal' || f === 'brands') { setPath(S.sheet, f, v); return; }
    setPath(S.sheet, f, v);
  }
  function onKey(ev) {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.getAttribute && ev.target.getAttribute('role') === 'button' && ev.target.dataset.act === 'nut') { ev.preventDefault(); S.nutOpen = S.nutOpen === ev.target.dataset.k ? null : ev.target.dataset.k; render(); return; }
    if (ev.key === 'Enter' && ev.target.id === 'wz-chatin') { ev.preventDefault(); wizSend(); }
    if (ev.key === 'Enter' && ev.target.id === 'nf-q') { ev.preventDefault(); doSearch(); }
    if (ev.key === 'Enter' && !ev.shiftKey && ev.target.id === 'nut-input' && window.matchMedia('(min-width: 768px)').matches) { ev.preventDefault(); const v = ev.target.value; ev.target.value = ''; sendCoach(v); }
  }
  function onSubmit(ev) {
    const form = ev.target.closest('[data-form]'); if (!form) return;
    ev.preventDefault();
    const k = form.dataset.form;
    if (k === 'profile') return saveProfile(form);
    if (k === 'coach') { const ta = document.getElementById('nut-input'); const v = ta.value; ta.value = ''; return sendCoach(v); }
    if (k === 'waist') {
      const raw = Number(form.elements.wa.value);
      api('/api/nutrition/waists', { method: 'POST', body: { cm: waistToCm(raw) } }).then(async () => { S.err = ''; await refreshView(); return loadHistory(); }).catch((e) => { S.err = e.message; render(); });
      return;
    }
    if (k === 'weight') {
      const units = (S.profile && S.profile.units) || 'imperial'; const raw = Number(form.elements.w.value);
      api('/api/nutrition/weights', { method: 'POST', body: { kg: units === 'imperial' ? lbToKg(raw) : raw } }).then(async () => { S.profile = (await api('/api/nutrition/profile')).profile; return loadHistory(); }).catch((e) => { S.err = e.message; render(); });
    }
  }

  let wired = false;
  function show() {
    const el = root(); if (!el) return;
    if (!wired) {
      wired = true;
      el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('change', onInput);
      el.addEventListener('keydown', onKey); el.addEventListener('submit', onSubmit);
    }
    S.date = S.date || localToday();
    render();
    loadAll().then(() => { if (S.tab === 'history') loadHistory(); if (S.tab === 'coach') loadCoach(); });
  }
  window.AdaNutrition = { show };
})();
