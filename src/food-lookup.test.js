// Tests for the USDA food lookup, with a fake USDA so no real lookups are spent. Run: node src/food-lookup.test.js
const assert = require('assert');
const { create, normalize, rank, setRetryDelay } = require('./food-lookup');
setRetryDelay(1);
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '—', e.message); } };

const banana = { fdcId: 1, dataType: 'Survey (FNDDS)', description: 'Banana, raw',
  foodMeasures: [{ disseminationText: 'Quantity not specified', gramWeight: 118 }, { disseminationText: '1 cup', gramWeight: 150 }, { disseminationText: '1 banana', gramWeight: 126 }],
  foodNutrients: [{ nutrientId: 1008, value: 97 }, { nutrientId: 1003, value: 0.74 }, { nutrientId: 1005, value: 22.71 }, { nutrientId: 1004, value: 0.28 }, { nutrientId: 1079, value: 1.7 }, { nutrientId: 2000, value: 15.8 }, { nutrientId: 1093, value: 0 }] };
const cheese = { fdcId: 2, dataType: 'Branded', description: 'CHEDDAR CHEESE', brandName: 'WEIS', brandOwner: 'Weis Markets, Inc.', servingSize: 28, servingSizeUnit: 'g', householdServingFullText: '1 ONZ',
  foodNutrients: [{ nutrientId: 1008, value: 393 }, { nutrientId: 1003, value: 25 }, { nutrientId: 1004, value: 32.1 }, { nutrientId: 1005, value: 3.57 }, { nutrientId: 1093, value: 643 }] };
const kale = { fdcId: 3, dataType: 'Foundation', description: 'Kale, raw', foodNutrients: [{ nutrientId: 2047, value: 49.6 }, { nutrientId: 1003, value: 2.92 }] };
const water = { fdcId: 4, dataType: 'SR Legacy', description: 'Water, tap', foodNutrients: [{ nutrientId: 1093, value: 4 }] };

function fakeFetch(status, foods) {
  const calls = [];
  const f = async (url) => { calls.push(url); return { status, ok: status >= 200 && status < 300, json: async () => ({ foods }) }; };
  f.calls = calls; return f;
}

(async () => {
  await t('generic food: per 100 g and its portions, "quantity not specified" dropped', () => {
    const n = normalize(banana);
    assert.deepStrictEqual(n.per100, { calories: 97, protein: 0.7, carbs: 22.7, fat: 0.3, fiber: 1.7, sugar: 15.8, sodium: 0 });
    assert.deepStrictEqual(n.portions.map((p) => p.label), ['1 banana (126 g)', '1 cup (150 g)', '100 g']);
    assert.strictEqual(n.brand, '');
  });
  await t('branded food: label serving first, names tidied', () => {
    const n = normalize(cheese);
    assert.strictEqual(n.name, 'Cheddar Cheese'); assert.strictEqual(n.brand, 'Weis');
    assert.deepStrictEqual(n.portions[0], { label: '1 onz (28 g)', grams: 28 });
    assert.strictEqual(n.per100.fiber, 0);
  });
  await t('Foundation food without 1008 uses the Atwater energy value', () => assert.strictEqual(normalize(kale).per100.calories, 49.6));
  await t('lookup drops foods with no calories or macros, and sends the right types', async () => {
    const f = fakeFetch(200, [banana, water]);
    const r = await create({ fetchImpl: f }).lookup('banana');
    assert.strictEqual(r.length, 1);
    assert(f.calls[0].includes('dataType=Foundation%2CSR+Legacy%2CSurvey+%28FNDDS%29'), f.calls[0]);
  });
  await t('brands asks only for branded foods', async () => {
    const f = fakeFetch(200, [cheese]);
    await create({ fetchImpl: f }).lookup('cheddar', true);
    assert(f.calls[0].includes('dataType=Branded'));
  });
  await t('same question within a week is answered from memory', async () => {
    let clock = 0; const f = fakeFetch(200, [banana]); const l = create({ fetchImpl: f, now: () => clock });
    await l.lookup('Banana'); await l.lookup('banana '); assert.strictEqual(f.calls.length, 1);
    clock = 8 * 24 * 3600 * 1000; await l.lookup('banana'); assert.strictEqual(f.calls.length, 2);
  });
  await t('too-short question is refused without a lookup', async () => {
    const f = fakeFetch(200, []);
    await assert.rejects(create({ fetchImpl: f }).lookup('a'), (e) => e.status === 400);
    assert.strictEqual(f.calls.length, 0);
  });
  await t('a flaky 400 is asked again, and a good answer gets through', async () => {
    const calls = []; let n = 0;
    const f = async (url) => { calls.push(url); n++; return n < 3 ? { status: 400, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => ({ foods: [banana] }) }; };
    const r = await create({ fetchImpl: f }).lookup('banana');
    assert.strictEqual(r.length, 1); assert.strictEqual(calls.length, 3);
  });
  await t('gives up after four tries with a plain message', async () => {
    const f = fakeFetch(400, []);
    await assert.rejects(create({ fetchImpl: f }).lookup('banana'), (e) => e.status === 502);
    assert.strictEqual(f.calls.length, 4);
  });
  await t('plain foods rank first', () => {
    const names = ['Bananas, dehydrated, or banana powder', 'Banana pudding', 'Banana, raw', 'Bread, banana'].map((name) => ({ name }));
    assert.deepStrictEqual(rank(names, 'banana').map((f) => f.name)[0], 'Banana, raw');
    assert.strictEqual(rank(names, 'banana').slice(-1)[0].name, 'Bread, banana');
  });
  await t('rate limit gives a plain message', async () => {
    await assert.rejects(create({ fetchImpl: fakeFetch(429, []) }).lookup('banana'), (e) => e.status === 429 && /Too many lookups/.test(e.message));
  });
  await t('network failure gives a plain message', async () => {
    const f = async () => { throw new Error('boom'); };
    await assert.rejects(create({ fetchImpl: f }).lookup('banana'), (e) => e.status === 502 && !/boom/.test(e.message));
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
