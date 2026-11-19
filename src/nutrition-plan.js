/*
 * Nutrition: everything the AI is allowed to change, and the checks it has to pass first.
 * The model only ever answers with JSON (or an <adjust>{…}</adjust> block in chat). Nothing it writes
 * reaches a stored field except through the functions here: whitelisted keys, strict types,
 * numbers clamped to the same guardrails as the formula, free text stripped. Anything malformed
 * is rejected whole and nothing changes.
 */
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SESSION_TYPES = ['strength', 'cardio', 'hiit', 'mobility', 'sport', 'other'];
const GOAL_TYPES = ['lose_weight', 'gain_weight', 'reduce_waist', 'strength', 'endurance', 'general_health', 'other'];
const REVIEW_STEP = 0.10;          // calories move at most 10% per review
const PROTEIN_STEP = 0.20;
const INITIAL_BAND = 0.15;         // the first AI plan may sit within 15% of the formula
const MAX_SESSION_MIN = 150;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Longer free text is cut at a sentence end when it has to be cut, never mid-word.
const trimText = (v, max) => { const t = clean(v, 100000); if (t.length <= max) return t; const cut = t.slice(0, max); const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? ')); return i > max * 0.5 ? cut.slice(0, i + 1) : cut.replace(/\s+\S*$/, '') + '…'; };
const clean = (v, max) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN));

// First JSON object in a model reply (it may come in a code fence or with a line of prose around it).
function extractJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(t.slice(a, b + 1)); return isObj(v) ? v : null; } catch (e) { return null; }
}
// Chat: the coach may end a reply with <adjust>{…}</adjust>. Returns the reply without it, and the parsed block (or null).
function splitAdjust(text) {
  const s = String(text || '');
  const m = /<adjust>([\s\S]*?)<\/adjust>/i.exec(s);
  const visible = s.replace(/<adjust>[\s\S]*?<\/adjust>/gi, '').trim();
  if (!m) return { visible, block: null, present: false };
  return { visible, block: extractJson(m[1]), present: true };
}

// ---- targets
// ctx: { formula, current, floor, weightKg, age, mode }
function checkTargets(raw, ctx) {
  const notes = [];
  if (!isObj(raw)) return { error: 'targets must be an object' };
  const f = ctx.formula;
  if (!f) return { error: 'no formula to check against' };
  const kcalIn = fin(raw.calories);
  if (Number.isNaN(kcalIn)) return { error: 'calories missing' };
  const kg = ctx.weightKg;
  let kcal = kcalIn;
  const base = ctx.mode === 'initial' || !ctx.current || !ctx.current.calories ? f.calories : ctx.current.calories;
  const step = ctx.mode === 'initial' ? INITIAL_BAND : REVIEW_STEP;
  let lo = base * (1 - step), hi = base * (1 + step);
  if (ctx.age < 18) { lo = Math.max(lo, f.tdee * 0.95); hi = Math.min(hi, f.tdee * 1.05); }
  else {
    lo = Math.max(lo, ctx.floor, f.tdee * 0.75);
    if (ctx.maxLossKgWeek) lo = Math.max(lo, f.tdee - (ctx.maxLossKgWeek * 7700) / 7);   // never a deficit beyond the safe loss pace
    hi = Math.min(hi, f.tdee * 1.2);
  }
  if (lo > hi) lo = hi;
  kcal = clamp(kcal, lo, hi);
  kcal = Math.round(kcal / 10) * 10;
  if (Math.abs(kcal - kcalIn) > 5) notes.push(`Calories limited to ${kcal} (asked ${Math.round(kcalIn)}).`);
  let protein = fin(raw.protein);
  if (Number.isNaN(protein)) protein = ctx.current && ctx.current.protein ? ctx.current.protein : f.protein;
  let pLo = 0.8 * kg, pHi = Math.min(2.4 * kg, (kcal * 0.35) / 4);
  if (ctx.mode !== 'initial' && ctx.current && ctx.current.protein) { pLo = Math.max(pLo, ctx.current.protein * (1 - PROTEIN_STEP)); pHi = Math.min(pHi, ctx.current.protein * (1 + PROTEIN_STEP)); }
  if (pLo > pHi) pLo = pHi;
  protein = Math.round(clamp(protein, pLo, pHi));
  let fat = fin(raw.fat);
  if (Number.isNaN(fat)) fat = ctx.current && ctx.current.fat ? ctx.current.fat : f.fat;
  const fLo = Math.max(0.6 * kg, (kcal * 0.15) / 9), fHi = Math.max(fLo, (kcal * 0.45) / 9);
  fat = Math.round(clamp(fat, fLo, fHi));
  let carbs = Math.round((kcal - protein * 4 - fat * 9) / 4);
  if (carbs < 50 && fat > fLo) { fat = Math.max(Math.round(fLo), Math.round((kcal - protein * 4 - 200) / 9)); carbs = Math.round((kcal - protein * 4 - fat * 9) / 4); }
  carbs = Math.max(0, carbs);
  const out = { calories: kcal, protein, carbs, fat };
  const fib = fin(raw.fiber);
  if (!Number.isNaN(fib)) out.fiber = Math.round(clamp(fib, 20, 60));
  return { targets: out, reason: clean(raw.reason, 300), notes };
}

// ---- workout plan
const AVOID = {
  knee: /jump|plyo|burpee|box|deep squat|lunge|sprint/i,
  back: /deadlift|good morning|bent[- ]over|barbell row|sit[- ]?up|heavy squat/i,
  shoulder: /overhead|military|snatch|upright row|dips?\b|handstand/i,
  wrist: /push[- ]?up|plank|handstand|burpee/i,
  ankle: /jump|plyo|sprint|skipping|burpee/i,
  hip: /deep squat|lunge|sumo/i,
  neck: /shrug|headstand|bridge/i,
};
const avoidFor = (limits) => { const t = String(limits || '').toLowerCase(); return Object.keys(AVOID).filter((k) => t.includes(k)).map((k) => AVOID[k]); };

// ctx: { currentPlan (existing plan or null), daysPerWeek, minutes, limits, mode }
function checkWorkoutPlan(raw, ctx) {
  const notes = [];
  if (!isObj(raw) || !Array.isArray(raw.days) || !raw.days.length) return { error: 'workout plan needs a list of days' };
  if (raw.days.length > 7) return { error: 'too many days' };
  const avoid = avoidFor(ctx.limits);
  const seen = new Set();
  const maxHard = clamp((ctx.daysPerWeek || 4) + 1, 1, 6);   // days with real training; easy cardio and mobility days do not count
  const hardDay = (d) => d.sessions.some((x) => !['cardio', 'mobility'].includes(x.type) || x.minutes > 60);
  const maxMin = Math.min(MAX_SESSION_MIN, ctx.minutes ? ctx.minutes + 15 : MAX_SESSION_MIN);
  let days = [];
  for (const d of raw.days) {
    if (!isObj(d) || !DAYS.includes(String(d.day || '').toLowerCase().slice(0, 3)) || !Array.isArray(d.sessions)) return { error: 'a day is malformed' };
    const day = String(d.day).toLowerCase().slice(0, 3);
    if (seen.has(day)) return { error: 'duplicate day' };
    seen.add(day);
    if (d.sessions.length > 2) return { error: 'too many sessions in a day' };
    const sessions = [];
    for (const s of d.sessions) {
      if (!isObj(s) || !Array.isArray(s.exercises) || !s.exercises.length || s.exercises.length > 14) return { error: 'a session is malformed' };
      const name = clean(s.name, 60);
      if (!name) return { error: 'a session has no name' };
      const type = SESSION_TYPES.includes(String(s.type)) ? String(s.type) : 'other';
      let minutes = fin(s.minutes); minutes = Number.isNaN(minutes) ? 45 : Math.round(clamp(minutes, 5, maxMin));
      const exercises = [];
      for (const e of s.exercises) {
        if (!isObj(e)) return { error: 'an exercise is malformed' };
        const en = clean(e.name, 80);
        if (!en) return { error: 'an exercise has no name' };
        if (avoid.some((re) => re.test(en))) { notes.push(`Dropped "${en}" because of your stated limits.`); continue; }
        const x = { name: en };
        const sets = fin(e.sets); if (!Number.isNaN(sets)) x.sets = Math.round(clamp(sets, 1, 10));
        if (e.reps !== undefined && e.reps !== null && e.reps !== '') {
          const r = typeof e.reps === 'string' ? e.reps.trim() : fin(e.reps);
          if (typeof r === 'string' ? /^\d{1,3}(-\d{1,3})?$/.test(r) : !Number.isNaN(r)) x.reps = typeof r === 'string' ? r : Math.round(clamp(r, 1, 100)); else return { error: 'reps are malformed' };
        }
        const dm = fin(e.minutes); if (!Number.isNaN(dm)) x.minutes = Math.round(clamp(dm, 1, 180));
        if (e.note) x.note = clean(e.note, 120);
        if (x.sets === undefined && x.minutes === undefined && x.reps === undefined) x.minutes = 10;
        exercises.push(x);
      }
      if (!exercises.length) continue;
      sessions.push({ name, type, minutes, exercises });
    }
    if (sessions.length) days.push({ day, sessions });
  }
  if (!days.length) return { error: 'no usable sessions' };
  days.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
  let hard = 0; const kept = [];
  for (const d of days) { if (hardDay(d)) { if (hard >= maxHard) continue; hard++; } kept.push(d); }
  if (kept.length < days.length) notes.push(`Limited to ${maxHard} hard training days a week.`);
  days = kept.slice(0, 6);   // always at least one rest day
  const total = (p) => p.reduce((a, d) => a + d.sessions.reduce((b, s) => b + s.minutes, 0), 0);
  if (ctx.mode !== 'initial' && ctx.currentPlan && ctx.currentPlan.days && ctx.currentPlan.days.length) {
    const old = total(ctx.currentPlan.days);
    while (days.length > 1 && total(days) > old * 1.25 + 20) { days.pop(); notes.push('Trimmed so the weekly training time rises by at most about 25% in one step.'); }
  }
  return { plan: { title: clean(raw.title, 80) || 'Weekly workout plan', notes: clean(raw.notes, 300), days }, notes };
}

function checkGoalUpdates(raw, goals, ctx) {
  if (!Array.isArray(raw) || raw.length > 10) return { error: 'goal updates malformed' };
  const out = [], notes = [];
  for (const u of raw) {
    if (!isObj(u) || typeof u.id !== 'string') return { error: 'a goal update is malformed' };
    const g = goals.find((x) => x.id === u.id); if (!g) continue;
    const upd = { id: g.id };
    if (u.status !== undefined) { if (!['active', 'done'].includes(u.status)) return { error: 'goal status malformed' }; upd.status = u.status; }
    if (u.deadline !== undefined) {
      if (u.deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(u.deadline))) return { error: 'goal deadline malformed' };
      upd.deadline = u.deadline;
    }
    if (u.target !== undefined) { const t = fin(u.target); if (Number.isNaN(t)) return { error: 'goal target malformed' }; upd.target = t; }
    // Weight and waist targets and deadlines go through the same safety rules as the goal editor; unsafe values are pulled back or dropped.
    if ((upd.target !== undefined || upd.deadline) && ctx && ctx.clampGoal) {
      const c = ctx.clampGoal(g, upd);
      if (!c) { notes.push('A goal change was not allowed and was skipped.'); delete upd.target; delete upd.deadline; }
      else { Object.assign(upd, c.upd); notes.push(...c.notes); }
    }
    if (upd.status !== undefined || upd.deadline !== undefined || upd.target !== undefined) out.push(upd);
  }
  return { updates: out, notes };
}

// The whole reply: { explanation, targets?, workout_plan?, goal_updates? }. Returns what is safe to apply.
function checkAdjustment(raw, ctx) {
  if (!isObj(raw)) return { error: 'not an object' };
  const out = { explanation: trimText(raw.explanation || raw.summary, 6000), notes: [] };
  let any = false;
  if (raw.targets !== undefined && raw.targets !== null) {
    const t = checkTargets(raw.targets, ctx);
    if (t.error) return { error: 'targets: ' + t.error };
    out.targets = t.targets; out.targetReason = t.reason; out.notes.push(...t.notes); any = true;
  }
  if (raw.workout_plan !== undefined && raw.workout_plan !== null) {
    const w = checkWorkoutPlan(raw.workout_plan, ctx);
    if (w.error) return { error: 'workout plan: ' + w.error };
    out.workoutPlan = w.plan; out.notes.push(...w.notes); any = true;
  }
  if (raw.goal_updates !== undefined && raw.goal_updates !== null) {
    const g = checkGoalUpdates(raw.goal_updates, ctx.goals || [], ctx);
    if (g.error) return { error: g.error };
    out.notes.push(...(g.notes || []));
    if (g.updates.length) { out.goalUpdates = g.updates; any = true; }
  }
  out.any = any;
  return out;
}

// ---- chat logging: <log>{"items":[…]}</log>
const LOG_KINDS = ['food', 'workout', 'weight', 'waist'];
const MEAL_OK = ['breakfast', 'lunch', 'dinner', 'snack'];
const isDateStr = (d) => { try { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d; } catch (e) { return false; } };
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
function splitLog(text) {
  const s = String(text || '');
  const m = /<log>([\s\S]*?)<\/log>/i.exec(s);
  return { present: !!m, block: m ? extractJson(m[1]) : null, visible: s.replace(/<log>[\s\S]*?<\/log>/gi, '').trim() };
}
const mealForHour = (h) => (h < 10.5 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snack');
// ctx: { today (YYYY-MM-DD), hour (Eastern, 0-24 decimal), weightKg, lastWaistCm }
// Returns { items } or { error }. A malformed item rejects the whole block; numbers out of range are pulled back and noted.
function checkLog(raw, ctx) {
  if (!isObj(raw) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 12) return { error: 'items malformed' };
  const items = [], notes = [];
  for (const it of raw.items) {
    if (!isObj(it) || !LOG_KINDS.includes(it.kind)) return { error: 'unknown kind' };
    let date = ctx.today;
    if (it.date !== undefined && it.date !== null) { if (!isDateStr(it.date)) return { error: 'bad date' }; date = it.date; }
    const back = dayDiff(ctx.today, date);
    if (back < 0 || back > 7) return { error: 'date outside the last 7 days' };
    if (it.kind === 'food') {
      const name = clean(it.name, 120); if (!name) return { error: 'food has no name' };
      let servings = it.servings === undefined ? 1 : fin(it.servings); if (Number.isNaN(servings) || servings <= 0) return { error: 'bad servings' };
      servings = Math.round(clamp(servings, 0.1, 20) * 100) / 100;
      const per = {};
      for (const [k, key, hi] of [['calories', 'kcal', 3000], ['protein', 'protein', 300], ['carbs', 'carbs', 600], ['fat', 'fat', 300], ['fiber', 'fiber', 200], ['sugar', 'sugar', 400], ['sodium', 'sodium', 10000]]) {
        const v = it[key] === undefined || it[key] === null ? (k === 'calories' ? NaN : 0) : fin(it[key]);
        if (Number.isNaN(v) || v < 0) return { error: `bad ${key}` };
        per[k] = Math.round(Math.min(v, hi) * 10) / 10;
        if (v > hi) notes.push(`${name}: ${key} limited to ${hi}.`);
      }
      if (per.calories * servings > 3000) { per.calories = Math.floor(3000 / servings); notes.push(`${name}: calories limited to 3000 for one item.`); }
      const meal = it.meal === undefined || it.meal === null ? mealForHour(ctx.hour) : String(it.meal).toLowerCase();
      if (!MEAL_OK.includes(meal)) return { error: 'bad meal' };
      const grams = it.grams === undefined || it.grams === null ? null : fin(it.grams);
      if (grams !== null && (Number.isNaN(grams) || grams <= 0 || grams > 3000)) return { error: 'bad grams' };
      items.push({ kind: 'food', date, meal, name, serving: clean(it.serving, 60), servings, per, grams, source: it.source === 'usda' ? 'usda' : 'estimate' });
    } else if (it.kind === 'workout') {
      const name = clean(it.name, 80); if (!name) return { error: 'workout has no name' };
      const minutes = fin(it.minutes); if (Number.isNaN(minutes) || minutes < 1 || minutes > 600) return { error: 'bad minutes' };
      let effort = null; if (it.effort !== undefined && it.effort !== null) { effort = fin(it.effort); if (Number.isNaN(effort) || effort < 1 || effort > 10) return { error: 'bad effort' }; effort = Math.round(effort); }
      items.push({ kind: 'workout', date, name, type: SESSION_TYPES.includes(it.type) ? it.type : 'other', minutes: Math.round(minutes), effort, notes: clean(it.notes, 300) });
    } else if (it.kind === 'weight') {
      const kg = fin(it.kg); if (Number.isNaN(kg) || kg < 25 || kg > 350) return { error: 'bad weight' };
      if (ctx.weightKg && (kg < ctx.weightKg * 0.8 || kg > ctx.weightKg * 1.2)) return { error: 'weight is not plausible next to the last one' };
      items.push({ kind: 'weight', date, kg: Math.round(kg * 10) / 10 });
    } else {
      const cm = fin(it.cm); if (Number.isNaN(cm) || cm < 40 || cm > 250) return { error: 'bad waist' };
      if (ctx.lastWaistCm && (cm < ctx.lastWaistCm * 0.75 || cm > ctx.lastWaistCm * 1.25)) return { error: 'waist is not plausible next to the last one' };
      items.push({ kind: 'waist', date, cm: Math.round(cm * 10) / 10 });
    }
  }
  return { items, notes };
}

module.exports = { splitLog, checkLog, trimText, DAYS, SESSION_TYPES, GOAL_TYPES, extractJson, splitAdjust, checkTargets, checkWorkoutPlan, checkGoalUpdates, checkAdjustment, clean, avoidFor };
