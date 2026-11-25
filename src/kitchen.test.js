const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const R = require('./kitchen-rules');
const kitchen = require('./kitchen');

const NOW = new Date('2026-11-24T17:00:00Z');   // 12:00 Eastern, Tuesday

test('shelf life: raw meat 4 days in the fridge, much longer frozen; poultry 2', () => {
  assert.deepStrictEqual(R.shelfLife('meat', 'fridge', '2026-11-24'), { date: '2026-11-28', days: 4 });
  assert.strictEqual(R.shelfLife('meat', 'freezer', '2026-11-24').days, 180);
  assert.strictEqual(R.shelfLife('poultry', 'fridge', '2026-11-24').days, 2);
  assert.strictEqual(R.shelfLife('dry', 'fridge', '2026-11-24'), null);
});
test('category guesses', () => {
  assert.strictEqual(R.guessCategory('Chicken thighs'), 'poultry');
  assert.strictEqual(R.guessCategory('Ground beef'), 'ground_meat');
  assert.strictEqual(R.guessCategory('Pork chops'), 'meat');
  assert.strictEqual(R.guessCategory('Baby spinach'), 'leafy');
  assert.strictEqual(R.guessCategory('Spaghetti'), 'dry');
  assert.strictEqual(R.guessCategory('Mystery box'), 'other');
  assert.strictEqual(R.guessCategory('Crushed tomatoes', 'can'), 'canned');
});
test('units and names', () => {
  assert.strictEqual(Math.round(R.convert(1, 'lb', 'oz')), 16);
  assert.strictEqual(R.convert(2, 'cup', 'lb'), null);
  assert.strictEqual(R.normUnit('count'), '');
  assert.strictEqual(R.matchScore('chicken breasts', 'Chicken breast'), 2);
  assert.strictEqual(R.matchScore('fresh basil', 'Basil'), 2);
  assert.strictEqual(R.matchScore('ground beef', 'Beef steak'), 0);
  assert.strictEqual(R.matchScore('onion', 'Red onions'), 1);
});
test('planCook: soonest-expiring first, missing, short and unsure', () => {
  const items = [
    { id: 'a', name: 'Chicken breast', qty: 1, unit: 'lb', expiresOn: '2026-11-26' },
    { id: 'b', name: 'Chicken breast', qty: 2, unit: 'lb', expiresOn: '2026-12-30' },
    { id: 'c', name: 'Rice', qty: 1, unit: 'bag' },
    { id: 'd', name: 'Soy sauce', qty: 10, unit: 'tbsp' },
  ];
  const r = { ingredients: [{ name: 'chicken breasts', qty: 1.5, unit: 'lb' }, { name: 'rice', qty: 2, unit: 'cup' }, { name: 'soy sauce', qty: 3, unit: 'tbsp' }, { name: 'broccoli', qty: 1, unit: 'head' }, { name: 'salt', qty: 0, unit: '' }] };
  const p = R.planCook(r, items);
  assert.deepStrictEqual(p.uses.filter((u) => u.ingredient === 'chicken breasts').map((u) => [u.itemId, u.take]), [['a', 1], ['b', 0.5]]);
  assert.deepStrictEqual(p.missing.map((m) => m.ingredient), ['broccoli']);
  assert.deepStrictEqual(p.unsure.map((m) => m.ingredient), ['rice']);
  const short = R.planCook({ ingredients: [{ name: 'soy sauce', qty: 1, unit: 'cup' }] }, items);
  assert.strictEqual(short.missing[0].short, 0.38);   // 16 tbsp needed, 10 on hand: 6 tbsp short, in the recipe's unit (cups)
});
test('freshness and low stock', () => {
  assert.strictEqual(R.freshness({ expiresOn: '2026-11-23' }, '2026-11-24').status, 'expired');
  assert.strictEqual(R.freshness({ expiresOn: '2026-11-26' }, '2026-11-24').status, 'soon');
  assert.strictEqual(R.isLow({ qty: 1, lowAt: 2 }), true);
  assert.strictEqual(R.isLow({ qty: 1, lowAt: null }), false);
});

function server(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-test-'));
  const k = kitchen.create({ dataDir, clock: () => NOW, ...opts });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { username: req.get('x-user') || 'alex', role: req.get('x-role') || 'admin' }; next(); });
  k.mount(app, { ownerName: (req) => req.user.username });
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}/api/kitchen`;
  const call = async (method, url, b, headers = {}) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  return { k, s, call, dataDir };
}

test('items: expiry from the rules, package date wins, moving to the freezer restarts the clock', async () => {
  const { s, call } = server();
  try {
    let r = await call('POST', '/items', { name: 'Pork chops', qty: 4, unit: '', location: 'fridge' });
    assert.strictEqual(r.body.item.expiresOn, '2026-11-28');
    r = await call('POST', '/items', { name: 'Milk', qty: 1, unit: 'gallon', expiresOn: '2026-12-02' });
    assert.strictEqual(r.body.item.expirySource, 'label');
    const chops = r.body.state.items.find((i) => i.name === 'Pork chops');
    r = await call('PATCH', `/items/${chops.id}`, { location: 'freezer' });
    assert.strictEqual(r.body.state.items.find((i) => i.id === chops.id).expiresOn, R.addDays('2026-11-24', 180));
    r = await call('POST', '/items', { name: 'Pork chops', qty: 2, unit: '', location: 'freezer' });   // tops up the same row
    assert.strictEqual(r.body.state.items.filter((i) => i.name === 'Pork chops').length, 1);
    assert.strictEqual(r.body.state.items.find((i) => i.name === 'Pork chops').qty, 6);
    assert.strictEqual((await call('GET', '/state', null, { 'x-role': 'guest' })).status, 403);
    assert.strictEqual((await call('GET', '/state', null, { 'x-user': 'paige' })).body.items.length, 0);   // each person has their own kitchen
  } finally { s.close(); }
});

test('cooking: preview asks about missing items, apply with bought/skip deducts and marks the plan', async () => {
  const { s, call } = server();
  try {
    await call('POST', '/items', { name: 'Chicken breast', qty: 2, unit: 'lb', location: 'fridge' });
    await call('POST', '/items', { name: 'Garlic', qty: 6, unit: 'clove', location: 'pantry' });
    let r = await call('POST', '/recipes', { name: 'Garlic chicken', servings: 2, ingredients: [{ name: 'chicken breast', qty: 1, unit: 'lb' }, { name: 'garlic', qty: 3, unit: 'cloves' }, { name: 'lemon', qty: 1, unit: '' }, { name: 'parsley', qty: 0, unit: '' }] });
    const id = r.body.recipe.id;
    await call('POST', '/plan', { date: '2026-11-24', meal: 'dinner', recipeId: id });
    r = await call('GET', '/state');
    assert.ok(r.body.shopping.some((x) => x.name === 'lemon'));
    r = await call('POST', `/recipes/${id}/cook`, {});
    assert.strictEqual(r.body.applied, false);
    assert.deepStrictEqual(r.body.open.sort(), ['lemon', 'parsley']);
    const planId = (await call('GET', '/state')).body.plan[0].id;
    r = await call('POST', `/recipes/${id}/cook`, { apply: true, planId, resolve: { lemon: { bought: 3, unit: '' }, parsley: 'skip' } });
    assert.strictEqual(r.body.applied, true);
    const inv = r.body.state.items;
    assert.strictEqual(inv.find((i) => i.name === 'Chicken breast').qty, 1);
    assert.strictEqual(inv.find((i) => i.name === 'Garlic').qty, 3);
    assert.strictEqual(inv.find((i) => i.name === 'lemon').qty, 2);   // bought 3, used 1
    assert.strictEqual(r.body.state.plan[0].cooked, true);
  } finally { s.close(); }
});

test('assistant: block applied by the server, a cook with something missing turns into a question', async () => {
  const replies = [
    'Got it, adding those.\n<kitchen>{"add":[{"name":"Ground beef","qty":1,"unit":"lb","location":"fridge","category":"ground_meat"},{"name":"Spaghetti","qty":1,"unit":"box","location":"pantry"}],"recipe":{"name":"Spaghetti bolognese","servings":4,"ingredients":[{"name":"ground beef","qty":1,"unit":"lb"},{"name":"spaghetti","qty":1,"unit":"box"},{"name":"crushed tomatoes","qty":1,"unit":"can"}]}}</kitchen>',
    'Nice, let me take that out.\n<kitchen>{"cook":{"recipe":"Spaghetti bolognese"}}</kitchen>',
    'Great, cooking it now.\n<kitchen>{"cook":{"recipe":"Spaghetti bolognese","bought":[{"name":"crushed tomatoes","qty":1,"unit":"can"}]}}</kitchen>',
  ];
  let n = 0; const seen = [];
  const { s, call } = server({ runAssistant: async ({ system }) => { seen.push(system); return replies[n++]; } });
  const wait = async () => { for (let i = 0; i < 50; i++) { const r = await call('GET', '/assistant/status'); if (r.body.state !== 'running') return r.body; await new Promise((ok) => setTimeout(ok, 20)); } throw new Error('timeout'); };
  try {
    await call('POST', '/assistant', { message: 'Bought a pound of ground beef and a box of spaghetti. Save my bolognese recipe.' });
    let st = await wait();
    assert.strictEqual(st.view.items.length, 2);
    assert.strictEqual(st.view.items.find((i) => i.name === 'Ground beef').expiresOn, '2026-11-26');
    assert.strictEqual(st.view.recipes.length, 1);
    assert.ok(st.messages.at(-1).done.length >= 3);
    await call('POST', '/assistant', { message: 'Making the bolognese tonight' });
    st = await wait();
    assert.match(st.messages.at(-1).content, /crushed tomatoes/);
    assert.strictEqual(st.view.items.length, 2);   // nothing taken yet
    await call('POST', '/assistant', { message: 'Yes I bought a can' });
    st = await wait();
    assert.match(seen[2], /WAITING ON THE PERSON/);
    assert.strictEqual(st.view.items.length, 0);   // beef, spaghetti and the can all used up
  } finally { s.close(); }
});
