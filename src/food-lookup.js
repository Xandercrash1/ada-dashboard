// Food lookup — nutrients from USDA FoodData Central, for pages built with New project (`ada.lookupFood`).
// Sites have no network, so the dashboard asks USDA for them. Uses ~/ops/secrets/usda.key if it exists,
// otherwise USDA's shared DEMO_KEY (about 10 lookups an hour). Answers are kept for a week to save lookups.
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_FILE = path.join(os.homedir(), 'ops/secrets/usda.key');
const SEARCH = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const GENERIC = 'Foundation,SR Legacy,Survey (FNDDS)';
const KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_CACHED = 500;
const TRIES = 4;
let RETRY_MS = 250;
// Nutrient ids in FoodData Central. Search results give them per 100 g.
const IDS = { calories: [1008, 2047, 2048], protein: [1003], carbs: [1005], fat: [1004], fiber: [1079], sugar: [2000, 1063], sodium: [1093] };

const apiKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim() || 'DEMO_KEY'; } catch (e) { return 'DEMO_KEY'; } };
const round = (n) => Math.round(n * 10) / 10;
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// One USDA search result → { id, name, brand, per100: {calories, …}, portions: [{label, grams}] }
function normalize(f) {
  const per100 = {};
  Object.entries(IDS).forEach(([k, ids]) => {
    const n = ids.map((id) => (f.foodNutrients || []).find((x) => x.nutrientId === id && typeof x.value === 'number')).find(Boolean);
    per100[k] = n ? round(n.value) : 0;
  });
  const portions = [];
  const seen = new Set();
  const add = (label, grams) => {
    if (!(grams > 0) || !label || /quantity not specified/i.test(label) || seen.has(label)) return;
    seen.add(label); portions.push({ label, grams: round(grams) });
  };
  if (f.servingSize > 0 && /^(g|grm|ml|mlt)$/i.test(f.servingSizeUnit || '')) {
    const unit = /^m/i.test(f.servingSizeUnit) ? 'ml' : 'g';
    add(f.householdServingFullText ? `${f.householdServingFullText.toLowerCase()} (${round(f.servingSize)} ${unit})` : `1 serving (${round(f.servingSize)} ${unit})`, f.servingSize);
  }
  // Portions named after the food ("1 banana") before cups and slices.
  const word = String(f.description || '').toLowerCase().split(/[ ,]/)[0].replace(/e?s$/, '');
  const measures = (f.foodMeasures || []).slice().sort((x, y) => (String(y.disseminationText).toLowerCase().includes(word) ? 1 : 0) - (String(x.disseminationText).toLowerCase().includes(word) ? 1 : 0));
  measures.forEach((m) => add(m.disseminationText ? `${m.disseminationText} (${round(m.gramWeight)} g)` : '', m.gramWeight));
  add('100 g', 100);
  const branded = f.dataType === 'Branded';
  return {
    id: f.fdcId,
    name: branded ? titleCase(f.description) : f.description,
    brand: branded ? titleCase(f.brandName || f.brandOwner || '') : '',
    per100,
    portions: portions.slice(0, 8),
  };
}

// USDA's own order puts "Bananas, dehydrated" before "Banana, raw" and "Egg burrito" before "Eggs, whole".
// Plain foods first: the asked-for words as the food's own name (its first one or two comma parts),
// then plain or raw forms, and prepared or processed foods (snacks, baby food, fast food) last.
const GOOD = /\b(raw|plain|whole|nfs|cooked|boiled|boneless|skinless|unsweetened|fresh)\b/;
const BAD = /\b(snacks?|babyfood|baby|cookies?|crackers?|bread|cakes?|candies|dessert|flour|powder|dehydrated|fast food|supplement|lunchmeat|deli|dry mix|nesquik)\b/;
const words = (t) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w));
function rank(foods, query) {
  const q = words(query);
  const same = (a, b) => a.length === b.length && a.every((w) => b.includes(w));
  const score = (f) => {
    const n = f.name.toLowerCase();
    const parts = n.split(',').map(words);
    const head = parts[0] || [], head2 = head.concat(parts[1] || []);
    let s = q.every((w) => head2.includes(w)) ? 0 : 6;
    if (same(head, q) || same(head2, q)) s -= 3;
    s += 0.8 * head.filter((w) => !q.includes(w)).length;
    if (GOOD.test(n)) s -= 1;
    if (BAD.test(n)) s += 2;
    return s + n.length / 200;
  };
  return foods.map((f, i) => ({ f, s: score(f), i })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.f);
}

function create({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  async function lookup(q, brands) {
    const query = String(q || '').trim().slice(0, 100);
    if (query.length < 2) { const e = new Error('Type at least two letters.'); e.status = 400; throw e; }
    const ck = `${brands ? 'b' : 'g'}:${query.toLowerCase()}`;
    const hit = cache.get(ck);
    if (hit && now() - hit.at < KEEP_MS) return hit.result;
    const url = `${SEARCH}?${new URLSearchParams({ api_key: apiKey(), query, pageSize: brands ? '8' : '25', dataType: brands ? 'Branded' : GENERIC })}`;
    // USDA's gateway answers a fair share of good requests with a bare 400 or a 5xx; asking again works.
    let res;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      try { res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); }
      catch (e) { if (attempt === TRIES) { const err = new Error('The food database didn\'t answer. Try again in a minute.'); err.status = 502; throw err; } continue; }
      if (res.status !== 400 && res.status < 500) break;
      if (attempt < TRIES) await new Promise((ok) => setTimeout(ok, RETRY_MS * attempt));
    }
    if (res.status === 429) { const e = new Error('Too many lookups this hour. Try again later, or type the numbers in.'); e.status = 429; throw e; }
    if (!res.ok) { const e = new Error('The food database had a problem. Try again later.'); e.status = 502; throw e; }
    const body = await res.json();
    let result = (body.foods || []).map(normalize).filter((f) => f.per100.calories || f.per100.protein || f.per100.carbs || f.per100.fat);
    if (!brands) result = rank(result, query);
    result = result.slice(0, 8);
    cache.set(ck, { at: now(), result });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return result;
  }
  return {
    lookup,
    mount(app) {
      app.get('/api/food-lookup', async (req, res) => {
        try { res.json(await lookup(req.query.q, req.query.brands === '1')); }
        catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'The food lookup failed.' }); }
      });
    },
  };
}

module.exports = { create, normalize, rank, setRetryDelay: (ms) => { RETRY_MS = ms; } };
