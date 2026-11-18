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
  const ghost = `${btn} border border-gray-300 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5`;
  const input = 'w-full rounded-xl border border-gray-300 dark:border-white/10 bg-transparent px-3 py-2.5 text-base min-h-[44px] focus:outline-none focus:ring-2 focus:ring-indigo-500';
  const label = 'block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1';

  const S = { tab: 'today', date: null, day: null, profile: null, targets: null, computed: null, hist: null, coach: null, plans: [], foods: [], limit: null, busy: false, sheet: null, err: '', msg: '', openPlan: null, loaded: false };

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
    return marked.parse(String(text || ''), { renderer: r, breaks: true });
  }
  const prose = 'prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-a:text-indigo-500';

  // ------------------------------------------------------------ loading
  async function loadAll() {
    S.err = '';
    try {
      const [p, day, foods, plans] = await Promise.all([api('/api/nutrition/profile'), api('/api/nutrition/day?date=' + S.date), api('/api/nutrition/foods'), api('/api/nutrition/plans')]);
      S.profile = p.profile; S.targets = p.targets; S.computed = p.computed; S.day = day; S.foods = foods; S.plans = plans; S.loaded = true;
    } catch (e) { S.err = e.message; }
    render();
  }
  async function loadDay() { try { S.day = await api('/api/nutrition/day?date=' + S.date); S.targets = S.day.targets; } catch (e) { S.err = e.message; } render(); }
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
      return `<div><div class="flex justify-between text-sm mb-1"><span class="font-medium">${n.label}</span><span class="text-gray-500 dark:text-gray-400">${fmt(tot[k] || 0, k)}${tv ? ' / ' + fmt(tv, k) : ''} ${n.unit}</span></div>${bar(k, tot[k] || 0, tv)}</div>`;
    };
    const extras = ['fiber', 'sugar', 'sodium'].map((k) => {
      const n = NUTS.find((x) => x.k === k); const tv = t ? t[k] : 0;
      return `<div><div class="flex justify-between text-xs mb-1 text-gray-500 dark:text-gray-400"><span>${n.label}${n.limit ? ' (limit)' : ''}</span><span>${fmt(tot[k] || 0, k)}${tv ? ' / ' + fmt(tv, k) : ''} ${n.unit}</span></div>${bar(k, tot[k] || 0, tv, 'h-1.5')}</div>`;
    }).join('');
    const summary = `<div class="${card} p-4 space-y-4">
      <div class="flex items-center gap-4">${ring}
        <div class="min-w-0"><div class="text-sm text-gray-500 dark:text-gray-400">${t && t.calories ? 'Target ' + fmt(t.calories) + ' kcal' : 'No target yet'}</div>
        <div class="text-2xl font-bold ${left !== null && left < 0 ? 'text-rose-500' : ''}">${left === null ? '&nbsp;' : (left >= 0 ? fmt(left) + ' left' : fmt(-left) + ' over')}</div>
        ${t ? '' : '<button data-act="goto" data-tab="profile" class="mt-1 text-sm text-indigo-500 underline">Set up your profile to get targets</button>'}</div></div>
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
      <button data-act="day" data-n="1" class="${ghost} !px-4" aria-label="Next day"><i class="fa-solid fa-chevron-right"></i></button></div>${summary}${meals}`;
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
      <section class="${card} p-4 space-y-3"><h3 class="font-semibold">Weight</h3>${weightChart(w, units)}
        <form data-form="weight" class="flex gap-2 items-end"><div class="flex-1"><label class="${label}" for="w-val">Today's weight (${units === 'imperial' ? 'lb' : 'kg'})</label><input id="w-val" name="w" type="number" inputmode="decimal" step="any" min="1" required class="${input}" placeholder="${wl ? r1(units === 'imperial' ? kgToLb(wl.kg) : wl.kg) : ''}"></div><button class="${primary}">Log</button></form>
        ${w.length ? `<div class="text-xs text-gray-500 dark:text-gray-400">${w.slice(-5).reverse().map((x) => `<span class="inline-flex items-center gap-1 mr-3">${esc(x.date)}: ${r1(units === 'imperial' ? kgToLb(x.kg) : x.kg)} <button data-act="del-weight" data-id="${esc(x.id)}" class="text-rose-500 px-1" aria-label="Delete weigh-in ${esc(x.date)}">&times;</button></span>`).join('')}</div>` : ''}</section>`;
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
      : `<div class="flex justify-start"><div class="max-w-[94%] rounded-2xl rounded-bl-md bg-black/5 dark:bg-white/10 px-3.5 py-2.5 text-[15px] break-words"><div class="${prose}">${md(m.content)}</div><div class="flex flex-wrap gap-2 mt-2 pt-2 border-t border-black/10 dark:border-white/10"><button data-act="saveplan" data-i="${i}" data-type="diet" class="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-white/20 min-h-[36px]"><i class="fa-solid fa-bookmark"></i> Save as diet plan</button><button data-act="saveplan" data-i="${i}" data-type="workout" class="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-white/20 min-h-[36px]"><i class="fa-solid fa-dumbbell"></i> Save as workout plan</button></div></div></div>`).join('');
    const chips = ['Make me a 7-day meal plan for my targets', 'Make me a 4-week workout plan', 'How was my eating this week?', 'What should I eat for dinner tonight?'];
    const plans = S.plans.length ? S.plans.map((p) => `<div class="${card} overflow-hidden"><button data-act="toggle-plan" data-id="${esc(p.id)}" class="w-full text-left px-4 py-3 flex items-center justify-between gap-3 min-h-[52px]"><span class="min-w-0"><span class="block font-medium truncate"><i class="fa-solid ${p.type === 'diet' ? 'fa-bowl-food' : 'fa-dumbbell'} text-indigo-500 mr-2"></i>${esc(p.title)}</span><span class="block text-xs text-gray-500 dark:text-gray-400">${p.type === 'diet' ? 'Diet plan' : 'Workout plan'} · ${esc(new Date(p.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span></span><i class="fa-solid fa-chevron-${S.openPlan === p.id ? 'up' : 'down'} text-gray-400"></i></button>${S.openPlan === p.id ? `<div class="px-4 pb-4 border-t border-gray-200 dark:border-white/10"><div class="${prose} pt-2">${md(p.content)}</div><button data-act="del-plan" data-id="${esc(p.id)}" class="${ghost} !text-rose-500 mt-3">Delete plan</button></div>` : ''}</div>`).join('') : '<p class="text-sm text-gray-500 dark:text-gray-400">No saved plans yet. Ask the Coach for one, then tap Save under its answer.</p>';
    return `<section class="${card} p-3 sm:p-4 space-y-3">
      <div class="flex items-center justify-between gap-2"><h3 class="font-semibold"><i class="fa-solid fa-comments text-indigo-500 mr-2"></i>Coach</h3><div class="text-xs text-gray-500 dark:text-gray-400 text-right" id="nut-limit">${esc(limText)}</div></div>
      <p class="text-xs text-gray-500 dark:text-gray-400">General wellness guidance, not medical advice. For health conditions, pregnancy, eating-disorder worries or anyone under 18, please talk to a doctor or dietitian.</p>
      <div id="nut-chat" class="space-y-3 max-h-[52vh] overflow-y-auto pr-1" aria-live="polite">${msgs || '<p class="text-sm text-gray-500 dark:text-gray-400">Ask about your food, a diet plan, or a workout plan. The Coach knows your profile, targets and the last two weeks of your log.</p>'}${S.busy ? '<div class="flex"><div class="rounded-2xl bg-black/5 dark:bg-white/10 px-3.5 py-2.5 text-sm text-gray-500"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Thinking… plans can take a minute</div></div>' : ''}</div>
      ${c.messages.length ? '' : `<div class="flex flex-wrap gap-2">${chips.map((x) => `<button data-act="chip" data-t="${esc(x)}" class="text-sm px-3 py-2 rounded-full border border-gray-300 dark:border-white/10 min-h-[40px]">${esc(x)}</button>`).join('')}</div>`}
      ${out ? `<div class="text-sm text-amber-500 border border-amber-500/30 bg-amber-500/10 rounded-xl px-3 py-2">That's all your Coach messages for today. They come back at midnight (Eastern).</div>` : ''}
      <form data-form="coach" class="flex gap-2 items-end"><textarea id="nut-input" rows="2" maxlength="2000" placeholder="${out ? 'No messages left today' : 'Message the Coach…'}" class="${input} resize-none" ${out || S.busy ? 'disabled' : ''}></textarea><button class="${primary} h-[44px]" ${out || S.busy ? 'disabled' : ''} aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></form>
      ${c.messages.length ? `<div class="text-right"><button data-act="clear-chat" class="text-xs text-gray-500 underline">Clear conversation</button></div>` : ''}</section>
      <section class="space-y-3"><h3 class="font-semibold px-1">Saved plans</h3>${plans}</section>`;
  }
  function scrollChat() { const el = document.getElementById('nut-chat'); if (el) el.scrollTop = el.scrollHeight; }
  let pollTimer = null;
  function pollCoach() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const st = await api('/api/nutrition/coach/status');
        S.limit = st.limit;
        if (st.state === 'running') return pollCoach();
        S.busy = false;
        if (st.messages) S.coach.messages = st.messages;
        if (st.state === 'failed') S.err = st.error || 'The Coach could not answer.';
        render(); scrollChat();
      } catch (e) { pollCoach(); }
    }, 2000);
  }
  async function sendCoach(text) {
    text = String(text || '').trim(); if (!text || S.busy) return;
    try {
      const r = await api('/api/nutrition/coach', { method: 'POST', body: { message: text } });
      S.limit = r.limit; S.busy = true; S.err = '';
      S.coach.messages.push({ role: 'user', content: text });
      render(); scrollChat(); pollCoach();
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
    const rates = imp ? [[0.5, '0.5 lb / week'], [1, '1 lb / week'], [1.5, '1.5 lb / week'], [2, '2 lb / week']] : [[0.25, '0.25 kg / week'], [0.5, '0.5 kg / week'], [0.75, '0.75 kg / week'], [1, '1 kg / week']];
    const curRate = imp ? kgToLb(p.rateKgPerWeek || 0.5) : (p.rateKgPerWeek || 0.5);
    const nearest = rates.reduce((a, b) => (Math.abs(b[0] - curRate) < Math.abs(a[0] - curRate) ? b : a))[0];
    const t = S.computed, ov = p.overrides || {};
    const ovf = (k, l, u) => `<div><label class="${label}" for="po-${k}">${l} (${u})</label><input id="po-${k}" name="ov.${k}" type="number" inputmode="decimal" min="0" step="any" class="${input}" value="${ov[k] ? esc(ov[k]) : ''}" placeholder="${t ? esc(t[k]) : ''}"></div>`;
    return `<form data-form="profile" class="space-y-4">
      <section class="${card} p-4 space-y-4"><h3 class="font-semibold">About you</h3>
        <div><span class="${label}">Units</span><div class="grid grid-cols-2 gap-2"><label class="${ghost} flex items-center justify-center gap-2 cursor-pointer"><input type="radio" name="units" value="imperial" ${imp ? 'checked' : ''}> lb, ft / in</label><label class="${ghost} flex items-center justify-center gap-2 cursor-pointer"><input type="radio" name="units" value="metric" ${imp ? '' : 'checked'}> kg, cm</label></div></div>
        <div class="grid grid-cols-2 gap-3"><div><label class="${label}" for="pf-age">Age</label><input id="pf-age" name="age" type="number" inputmode="numeric" min="10" max="100" class="${input}" value="${p.age || ''}"></div>
          <div><label class="${label}" for="pf-sex">Sex (for the calorie formula)</label><select id="pf-sex" name="sex" class="${input}"><option value="">Choose…</option>${[['male', 'Male'], ['female', 'Female'], ['other', 'Other / prefer not to say']].map(([v, n]) => `<option value="${v}" ${p.sex === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          ${imp ? `<div><label class="${label}" for="pf-ft">Height (ft)</label><input id="pf-ft" name="ft" type="number" inputmode="numeric" min="3" max="8" class="${input}" value="${ft}"></div><div><label class="${label}" for="pf-in">Height (in)</label><input id="pf-in" name="inch" type="number" inputmode="decimal" min="0" max="11.9" step="any" class="${input}" value="${inch}"></div>
          <div class="col-span-2"><label class="${label}" for="pf-w">Weight (lb)</label><input id="pf-w" name="weight" type="number" inputmode="decimal" step="any" class="${input}" value="${p.weightKg ? r1(kgToLb(p.weightKg)) : ''}"></div>`
          : `<div><label class="${label}" for="pf-h">Height (cm)</label><input id="pf-h" name="cm" type="number" inputmode="decimal" step="any" class="${input}" value="${p.heightCm || ''}"></div><div><label class="${label}" for="pf-w">Weight (kg)</label><input id="pf-w" name="weight" type="number" inputmode="decimal" step="any" class="${input}" value="${p.weightKg || ''}"></div>`}</div>
        <div><label class="${label}" for="pf-act">Activity level</label><select id="pf-act" name="activity" class="${input}"><option value="">Choose…</option>${ACTIVITY.map(([v, n]) => `<option value="${v}" ${p.activity === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="grid grid-cols-2 gap-3"><div><label class="${label}" for="pf-goal">Goal</label><select id="pf-goal" name="goal" class="${input}">${[['lose', 'Lose weight'], ['maintain', 'Maintain'], ['gain', 'Gain weight']].map(([v, n]) => `<option value="${v}" ${p.goal === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <div><label class="${label}" for="pf-rate">Pace</label><select id="pf-rate" name="rate" class="${input}">${rates.map(([v, n]) => `<option value="${v}" ${v === nearest ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
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

  // ------------------------------------------------------------ shell
  function render() {
    const el = root(); if (!el) return;
    const tabs = [['today', 'Today', 'fa-utensils'], ['history', 'History', 'fa-chart-column'], ['coach', 'Coach', 'fa-comments'], ['profile', 'Profile', 'fa-user']];
    const nav = `<div class="grid grid-cols-4 gap-1 p-1 rounded-2xl bg-black/5 dark:bg-white/5" role="tablist">${tabs.map(([k, n, ic]) => `<button role="tab" aria-selected="${S.tab === k}" data-act="tab" data-tab="${k}" class="py-2.5 rounded-xl text-sm font-medium min-h-[44px] flex items-center justify-center gap-1.5 ${S.tab === k ? 'bg-indigo-600 text-white shadow' : 'text-gray-500 dark:text-gray-400'}"><i class="fa-solid ${ic} text-xs"></i>${n}</button>`).join('')}</div>`;
    let body = '';
    if (!S.loaded) body = S.err ? '' : '<div class="text-sm text-gray-500 p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
    else if (S.tab === 'today') body = renderToday();
    else if (S.tab === 'history') body = renderHistory();
    else if (S.tab === 'coach') body = renderCoach();
    else body = renderProfile();
    const ta = document.getElementById('nut-input'); const draft = ta ? ta.value : '';
    el.innerHTML = `<div class="max-w-2xl mx-auto space-y-4 pb-24 md:pb-8">${nav}${note('err')}${note('msg')}${body}</div>${sheetHtml()}`;
    const ta2 = document.getElementById('nut-input'); if (ta2 && draft) ta2.value = draft;
  }

  async function setTab(tab) {
    S.tab = tab; S.err = ''; S.msg = ''; render();
    if (tab === 'history' && !S.hist) loadHistory();
    if (tab === 'coach') loadCoach();
  }

  function onClick(ev) {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act;
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
    const t = ev.target; const f = t.dataset && t.dataset.f; if (!f || !S.sheet) return;
    const v = t.type === 'checkbox' ? t.checked : t.value;
    if (f === 'portion') { S.sheet.portion = Number(v); applyPortion(); return keepScroll(render); }
    if (f === 'meal' || f === 'brands') { setPath(S.sheet, f, v); return; }
    setPath(S.sheet, f, v);
  }
  function onKey(ev) {
    if (ev.key === 'Enter' && ev.target.id === 'nf-q') { ev.preventDefault(); doSearch(); }
    if (ev.key === 'Enter' && !ev.shiftKey && ev.target.id === 'nut-input' && window.matchMedia('(min-width: 768px)').matches) { ev.preventDefault(); const v = ev.target.value; ev.target.value = ''; sendCoach(v); }
  }
  function onSubmit(ev) {
    const form = ev.target.closest('[data-form]'); if (!form) return;
    ev.preventDefault();
    const k = form.dataset.form;
    if (k === 'profile') return saveProfile(form);
    if (k === 'coach') { const ta = document.getElementById('nut-input'); const v = ta.value; ta.value = ''; return sendCoach(v); }
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
