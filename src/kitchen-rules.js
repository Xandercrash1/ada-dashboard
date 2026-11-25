/*
 * kitchen-rules.js — the pure parts of the Kitchen tool (Alex, 2026-11-24): how long food keeps,
 * units, matching recipe ingredients to what's on hand, and what cooking a recipe uses up.
 * No I/O here, so all of it is unit-tested in kitchen.test.js.
 *
 * Shelf lives are conservative home-kitchen figures (USDA/FoodKeeper style), in days, counted
 * from the day an item goes into that place. Moving an item (fridge -> freezer, freezer -> fridge
 * to thaw) restarts the clock for the new place. A date printed on the package always wins.
 */
'use strict';

const LOCATIONS = ['fridge', 'freezer', 'pantry'];

// days per location; null = doesn't belong there (falls back to the category's first location)
const SHELF = {
  poultry:     { fridge: 2,   freezer: 270, label: 'Poultry (raw)' },
  ground_meat: { fridge: 2,   freezer: 120, label: 'Ground meat (raw)' },
  meat:        { fridge: 4,   freezer: 180, label: 'Meat: steaks, chops, roasts (raw)' },
  fish:        { fridge: 2,   freezer: 180, label: 'Fish and seafood (raw)' },
  deli:        { fridge: 5,   freezer: 60,  label: 'Deli meat, bacon, hot dogs' },
  leftovers:   { fridge: 4,   freezer: 90,  label: 'Cooked leftovers' },
  milk:        { fridge: 7,   freezer: 90,  label: 'Milk and cream' },
  yogurt:      { fridge: 14,  freezer: 60,  label: 'Yogurt, sour cream' },
  cheese_soft: { fridge: 7,   freezer: 60,  label: 'Soft cheese' },
  cheese_hard: { fridge: 30,  freezer: 180, label: 'Hard cheese' },
  eggs:        { fridge: 35,  label: 'Eggs' },
  butter:      { fridge: 60,  freezer: 270, label: 'Butter' },
  leafy:       { fridge: 5,   label: 'Salad greens, herbs' },
  produce:     { fridge: 7,   pantry: 4,    freezer: 240, label: 'Vegetables' },
  fruit:       { fridge: 10,  pantry: 4,    freezer: 240, label: 'Fruit' },
  roots:       { pantry: 30,  fridge: 30,   label: 'Potatoes, onions, garlic, squash' },
  bread:       { pantry: 5,   freezer: 90,  fridge: 10, label: 'Bread and baked goods' },
  condiment:   { fridge: 180, pantry: 365,  label: 'Condiments and sauces' },
  dry:         { pantry: 365, label: 'Dry goods: pasta, rice, flour, beans, cereal' },
  canned:      { pantry: 730, label: 'Canned and jarred (unopened)' },
  frozen:      { freezer: 240, label: 'Frozen foods' },
  drink:       { fridge: 10,  pantry: 365,  label: 'Drinks' },
  other:       { fridge: 7,   pantry: 180,  freezer: 180, label: 'Other' },
};
const CATEGORIES = Object.keys(SHELF);

// Keyword guesses for items typed in by hand (the assistant sends its own category).
const GUESS = [
  ['poultry', /\b(chicken|turkey|duck)\b/], ['ground_meat', /\b(ground|mince|burger patt)/],
  ['deli', /\b(bacon|ham|salami|pepperoni|hot ?dogs?|deli|sausage|prosciutto)\b/],
  ['fish', /\b(salmon|tuna steak|cod|tilapia|shrimp|fish|scallops?|crab|lobster)\b/],
  ['meat', /\b(steak|beef|pork|lamb|chops?|roast|ribs|veal)\b/],
  ['leftovers', /\b(leftovers?|cooked)\b/], ['eggs', /\beggs?\b/], ['butter', /\bbutter\b/],
  ['milk', /\b(milk|cream|half and half)\b/], ['yogurt', /\b(yogh?urt|sour cream|cottage)\b/],
  ['cheese_hard', /\b(cheddar|parmesan|parmigiano|swiss|gouda|provolone|pecorino)\b/],
  ['cheese_soft', /\b(mozzarella|brie|feta|ricotta|cream cheese|goat cheese|cheese)\b/],
  ['leafy', /\b(lettuce|spinach|kale|arugula|greens|salad|cilantro|parsley|basil|herbs?)\b/],
  ['roots', /\b(potato(es)?|onions?|garlic|shallots?|squash|sweet potato(es)?)\b/],
  ['fruit', /\b(apples?|bananas?|berries|strawberr|blueberr|grapes|oranges?|lemons?|limes?|pears?|peach|avocados?|melon)\b/],
  ['produce', /\b(carrots?|broccoli|peppers?|tomato(es)?|cucumbers?|zucchini|celery|mushrooms?|cabbage|cauliflower|corn|beans? sprouts|asparagus|green beans)\b/],
  ['bread', /\b(bread|bagels?|tortillas?|buns?|rolls?|muffins?|pita)\b/],
  ['canned', /\b(canned|can of|tin of|jar of)\b/],
  ['condiment', /\b(ketchup|mustard|mayo|mayonnaise|sauce|salsa|dressing|vinegar|soy|jam|honey|syrup|oil)\b/],
  ['dry', /\b(rice|pasta|spaghetti|noodles|flour|sugar|oats|cereal|lentils|quinoa|beans|crackers|chips)\b/],
  ['drink', /\b(juice|soda|beer|wine|seltzer|water)\b/],
];
function guessCategory(name, unit) {
  const n = String(name || '').toLowerCase();
  if (/^(cans?|jars?|tins?)$/.test(String(unit || '').trim().toLowerCase()) && !/\b(sauce|salsa|jam|mustard|mayo)\b/.test(n)) return 'canned';
  for (const [c, re] of GUESS) if (re.test(n)) return c;
  return 'other';
}
const defaultLocation = (category) => Object.keys(SHELF[category] || SHELF.other).find((k) => LOCATIONS.includes(k));

const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Expiry for an item in a place from a start date. Returns { date, days } or null when it doesn't spoil on a useful scale.
function shelfLife(category, location, fromDate) {
  const s = SHELF[category] || SHELF.other;
  const days = s[location] != null ? s[location] : null;
  if (days == null) return null;
  return { date: addDays(fromDate, days), days };
}

// ---- units: everything converts to a base of grams, millilitres or count
const UNITS = {
  g: ['g', 1], gram: ['g', 1], grams: ['g', 1], kg: ['g', 1000], oz: ['g', 28.35], ounce: ['g', 28.35], ounces: ['g', 28.35], lb: ['g', 453.6], lbs: ['g', 453.6], pound: ['g', 453.6], pounds: ['g', 453.6],
  ml: ['ml', 1], l: ['ml', 1000], liter: ['ml', 1000], litre: ['ml', 1000], cup: ['ml', 240], cups: ['ml', 240], tbsp: ['ml', 15], tablespoon: ['ml', 15], tablespoons: ['ml', 15], tsp: ['ml', 5], teaspoon: ['ml', 5], teaspoons: ['ml', 5], 'fl oz': ['ml', 29.6], pint: ['ml', 473], quart: ['ml', 946], gallon: ['ml', 3785],
  '': ['count', 1], count: ['count', 1], each: ['count', 1], whole: ['count', 1], piece: ['count', 1], pieces: ['count', 1], clove: ['count', 1], cloves: ['count', 1], can: ['count', 1], cans: ['count', 1], jar: ['count', 1], jars: ['count', 1], bag: ['count', 1], bags: ['count', 1], box: ['count', 1], boxes: ['count', 1], pack: ['count', 1], packs: ['count', 1], package: ['count', 1], bunch: ['count', 1], head: ['count', 1], loaf: ['count', 1], dozen: ['count', 12], slice: ['count', 1], slices: ['count', 1], fillet: ['count', 1], fillets: ['count', 1], breast: ['count', 1], breasts: ['count', 1],
};
const normUnit = (u) => { const n = String(u == null ? '' : u).trim().toLowerCase().replace(/\.$/, ''); return ['count', 'each', 'ea', 'whole', 'items', 'item'].includes(n) ? '' : n; };   // plain counts are stored with no unit
const unitInfo = (u) => UNITS[normUnit(u)] || null;
// Amount in `fromUnit` expressed in `toUnit`, or null if they can't be compared (weight vs volume vs count).
function convert(qty, fromUnit, toUnit) {
  const a = unitInfo(fromUnit), b = unitInfo(toUnit);
  if (!a || !b || a[0] !== b[0]) return null;
  return (qty * a[1]) / b[1];
}

// ---- names: "Chicken breasts" matches "chicken breast"; "2 large eggs" matches "eggs"
const STOP = new Set(['fresh', 'large', 'small', 'medium', 'boneless', 'skinless', 'chopped', 'diced', 'minced', 'sliced', 'shredded', 'grated', 'raw', 'organic', 'whole', 'of', 'the', 'a', 'and', 'extra', 'virgin', 'unsalted', 'salted', 'lean', 'frozen', 'dried', 'ground']);
const KEEP_GROUND = (n) => /\bground\b/.test(n);   // "ground beef" is a different thing from "beef"
function words(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  return n.split(/\s+/).filter(Boolean).filter((w) => !STOP.has(w) || (w === 'ground' && KEEP_GROUND(n))).map((w) => (w.length > 3 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('oes') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
const keyOf = (name) => words(name).join(' ');
// Score how well an inventory item stands in for a recipe ingredient: 2 exact, 1 every ingredient word present, 0 no.
function matchScore(ingredient, itemName) {
  const a = words(ingredient), b = words(itemName);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 2;
  const bs = new Set(b), as = new Set(a);
  if (a.every((w) => bs.has(w)) || b.every((w) => as.has(w))) return 1;
  return 0;
}
// Pantry basics a recipe may list that nobody tracks; they never count as missing.
const ASSUMED = new Set(['salt', 'pepper', 'black pepper', 'salt and pepper', 'water', 'ice']);
const isAssumed = (name) => ASSUMED.has(keyOf(name)) || ASSUMED.has(String(name || '').trim().toLowerCase());

/*
 * What cooking a recipe would use. Items are taken soonest-expiring first.
 * Returns { uses: [{ingredient, itemId, itemName, take, unit, leftAfter}], missing: [{ingredient, qty, unit, short?}], unsure: [...] }
 *   missing: nothing on hand matches, or what's on hand isn't enough (short = how much more is needed)
 *   unsure: something matches but its unit can't be compared (e.g. recipe says 2 cups, inventory says 1 bag)
 */
function planCook(recipe, items, scale = 1) {
  const uses = [], missing = [], unsure = [];
  const left = new Map(items.map((i) => [i.id, i.qty]));
  for (const ing of recipe.ingredients || []) {
    if (isAssumed(ing.name)) continue;
    const need0 = (Number(ing.qty) || 0) * scale;
    const cands = items.map((i) => ({ i, s: matchScore(ing.name, i.name) })).filter((c) => c.s > 0)
      .sort((x, y) => y.s - x.s || String(x.i.expiresOn || '9999').localeCompare(String(y.i.expiresOn || '9999')));
    if (!cands.length) { missing.push({ ingredient: ing.name, qty: need0, unit: ing.unit || '' }); continue; }
    if (!need0) {   // "a pinch", "to taste": uses a little, deducts nothing
      uses.push({ ingredient: ing.name, itemId: cands[0].i.id, itemName: cands[0].i.name, take: 0, unit: cands[0].i.unit, leftAfter: left.get(cands[0].i.id), note: 'no amount given' });
      continue;
    }
    let need = need0, comparable = false;
    for (const { i } of cands) {
      const have = left.get(i.id);
      const needInItem = convert(need, ing.unit, i.unit);
      if (needInItem == null || have <= 0) continue;
      comparable = true;
      const take = Math.min(have, needInItem);
      left.set(i.id, have - take);
      uses.push({ ingredient: ing.name, itemId: i.id, itemName: i.name, take: round2(take), unit: i.unit, leftAfter: round2(have - take) });
      need -= convert(take, i.unit, ing.unit);
      if (need <= 1e-9) break;
    }
    if (!comparable) unsure.push({ ingredient: ing.name, qty: need0, unit: ing.unit || '', candidates: cands.slice(0, 3).map((c) => ({ itemId: c.i.id, itemName: c.i.name, qty: c.i.qty, unit: c.i.unit })) });
    else if (need > 1e-6) missing.push({ ingredient: ing.name, qty: round2(need0), unit: ing.unit || '', short: round2(need) });
  }
  return { uses, missing, unsure };
}
const round2 = (n) => Math.round(n * 100) / 100;

// Freshness of one item on a day: expired / today / soon (within 2 days) / week (within 7) / ok / none
function freshness(item, today) {
  if (!item.expiresOn) return { status: 'none', daysLeft: null };
  const d = daysBetween(today, item.expiresOn);
  return { status: d < 0 ? 'expired' : d === 0 ? 'today' : d <= 2 ? 'soon' : d <= 7 ? 'week' : 'ok', daysLeft: d };
}
const isLow = (item) => item.lowAt != null && item.lowAt !== '' && Number(item.qty) <= Number(item.lowAt);

module.exports = { LOCATIONS, SHELF, CATEGORIES, guessCategory, defaultLocation, shelfLife, addDays, daysBetween, convert, unitInfo, normUnit, words, keyOf, matchScore, isAssumed, planCook, freshness, isLow, round2 };
