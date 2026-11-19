/*
 * Nutrition 1.0.1: the safety rules for weight and waist goals, loss pace, and the burn / deficit estimates.
 * Pure functions, shared by the routes, the AI checks and the tests.
 *
 * Rules (Alex, 2026-11-18):
 *  - A weight target can't go below BMI 18.5 for the person's height; BMI 18.5-20 is allowed with a gentle note.
 *  - Under 18: no weight-loss goals.
 *  - Loss pace: at most about 1% of body weight a week and never more than 0.9 kg (2 lb); a deadline that would need
 *    more is refused with the earliest safe date.
 *  - A waist target can't go below 0.40 x height.
 */
const LB = 0.45359237;
const MAX_LOSS_KG_WEEK = 0.9;
const BMI_FLOOR = 18.5, BMI_SOFT = 20;
const WAIST_RATIO_FLOOR = 0.40;
const KCAL_PER_KG = 7700;
const WAIST_PACE_CAP_CM = 1;       // cm a week, used for estimates only

const r1 = (n) => Math.round(n * 10) / 10;
const kgToLb = (kg) => kg / LB;
const fmtKg = (kg, units) => (units === 'metric' ? `${r1(kg)} kg` : `${Math.round(kgToLb(kg))} lb`);
const fmtMinCm = (cm, units) => (units === 'metric' ? `${Math.ceil(cm * 10) / 10} cm` : `${Math.ceil((cm / 2.54) * 10) / 10} in`);
const fmtMin = (kg, units) => (units === 'metric' ? `${Math.ceil(kg * 10) / 10} kg` : `${Math.ceil(kg / LB)} lb`);
const fmtKgPace = (kg, units) => (units === 'metric' ? `${Math.round(kg * 100) / 100} kg` : `${Math.round(kgToLb(kg) * 10) / 10} lb`);
const fmtCm = (cm, units) => (units === 'metric' ? `${r1(cm)} cm` : `${r1(cm / 2.54)} in`);
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

const minHealthyKg = (heightCm) => BMI_FLOOR * (heightCm / 100) ** 2;
const softKg = (heightCm) => BMI_SOFT * (heightCm / 100) ** 2;
const maxLossKgPerWeek = (weightKg) => Math.min(MAX_LOSS_KG_WEEK, Math.max(0.1, 0.01 * weightKg));
const minWaistCm = (heightCm) => WAIST_RATIO_FLOOR * heightCm;

// Earliest date a loss from currentKg to targetKg can safely finish.
const earliestSafeDate = (currentKg, targetKg, today) => {
  const need = currentKg - targetKg;
  if (need <= 0) return today;
  return addDays(today, Math.ceil((need / maxLossKgPerWeek(currentKg)) * 7));
};

// A weight goal. g: { type, target (kg), deadline }, p: profile (age, heightCm, weightKg, units).
// Returns { error } or { note? }.
function checkWeightGoal(g, p, today, currentKg) {
  const units = p.units || 'imperial';
  if (g.type === 'lose_weight' && Number.isFinite(p.age) && p.age < 18) return { error: "Weight-loss goals aren't available under 18. Please talk to a doctor or dietitian. You can pick general health, strength or endurance instead." };
  if (!g.target) return {};
  const note = [];
  if (Number.isFinite(p.heightCm)) {
    const lo = minHealthyKg(p.heightCm);
    if (g.target < lo - 1e-9) return { error: `That target is below a healthy weight for your height. The lowest allowed is ${fmtMin(lo, units)} (BMI 18.5).`, minKg: lo };
    if (g.target < softKg(p.heightCm)) note.push(`That is near the low end of a healthy range for your height (BMI 18.5 to 20). Go gently, and check in with a doctor if you are unsure.`);
  }
  const cur = currentKg || p.weightKg;
  if (g.type === 'lose_weight' && g.deadline && Number.isFinite(cur) && cur > g.target) {
    const days = daysBetween(today, g.deadline);
    const cap = maxLossKgPerWeek(cur);
    const need = days > 0 ? (cur - g.target) / (days / 7) : Infinity;
    if (need > cap + 1e-9) {
      const ear = earliestSafeDate(cur, g.target, today);
      return { error: `That deadline needs about ${fmtKgPace(Math.min(need, 99), units)} a week, faster than the safe pace for you (${fmtKgPace(cap, units)} a week). The earliest safe date is ${ear}.`, earliest: ear };
    }
  }
  return note.length ? { note: note.join(' ') } : {};
}

function checkWaistTarget(targetCm, heightCm, units) {
  if (!Number.isFinite(heightCm)) return {};
  const lo = minWaistCm(heightCm);
  if (targetCm < lo - 1e-9) return { error: `That waist target is below a healthy ratio for your height. The lowest allowed is ${fmtMinCm(lo, units || 'imperial')} (0.40 x your height).`, minCm: lo };
  return targetCm < heightCm * 0.45 ? { note: `That is a low waist target for your height (below 0.45 x height). Go gently, and check in with a doctor if you are unsure.` } : {};
}

// ---- burn and deficit (estimates)
const MET = { strength: 4.0, cardio: 6.5, hiit: 8.5, mobility: 2.5, sport: 6.0, other: 4.0 };
// Net kcal of one logged workout: (MET - 1) x body weight x hours, the "-1" because normal daily activity is already in maintenance.
function workoutKcal(w, weightKg) {
  const minutes = w && w.minutes > 0 ? w.minutes : 30;
  const met = MET[w && w.type] || MET.other;
  return Math.round(Math.max(0, met - 1) * weightKg * (minutes / 60));
}
const dayBurn = (tdee, workouts, weightKg) => {
  const w = workouts.map((x) => ({ name: x.name, kcal: workoutKcal(x, weightKg), assumed: !(x.minutes > 0) }));
  const workoutKcalTotal = w.reduce((a, b) => a + b.kcal, 0);
  return { maintenance: tdee, workouts: w, workoutKcal: workoutKcalTotal, total: tdee + workoutKcalTotal };
};
const kgPerWeekFromDeficit = (kcalPerDay) => (kcalPerDay * 7) / KCAL_PER_KG;

module.exports = { fmtMinCm, fmtMin, LB, MAX_LOSS_KG_WEEK, KCAL_PER_KG, WAIST_PACE_CAP_CM, MET, minHealthyKg, softKg, maxLossKgPerWeek, minWaistCm, earliestSafeDate, checkWeightGoal, checkWaistTarget, workoutKcal, dayBurn, kgPerWeekFromDeficit, fmtKg, fmtKgPace, fmtCm, addDays, daysBetween };
