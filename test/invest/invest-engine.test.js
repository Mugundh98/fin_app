import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMPTIONS, monthlyRate, bandFor, futureCost,
  sipSchedule, sipFutureValue, requiredSip,
  ratesFor, defaultInflation, computePlan
} from "../../public/src/invest/invest-engine.js";

const close = (a, b, tol = 1e-6, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || "close"}: ${a} vs ${b} (tol ${tol})`);

/* An independent closed-form reimplementation of the stepped-up SIP, used to
   cross-check the engine's month-by-month loop. Derived differently: each
   year is a 12-payment ordinary annuity valued at that year's end, then
   compounded forward whole years. If this agrees with the engine's monthly
   recursion, the loop has no off-by-one in its month or year indexing. */
function closedFormSipFv(P, years, r, s){
  if(r === 0){
    let sum = 0;
    for(let k = 0; k < years; k++) sum += Math.pow(1 + s, k);
    return P * 12 * sum;
  }
  const i = Math.pow(1 + r, 1/12) - 1;
  const yearAnnuity = r / i;               // FV of twelve end-of-month ₹1 payments
  let sum = 0;
  for(let k = 0; k < years; k++){
    sum += Math.pow(1 + s, k) * Math.pow(1 + r, years - 1 - k);
  }
  return P * yearAnnuity * sum;
}

const base = {
  goal: "retirement", targetToday: 1000000, years: 10,
  alreadySaved: 0, monthlyBudget: 0, stepUp: 0
};

/* ------------------------------------------------------------------
   Horizon bands — the boundaries are the whole point of the rule.
   ------------------------------------------------------------------ */

test("horizon bands land on the right side of every boundary", () => {
  assert.equal(bandFor(1).key,    "debt");
  assert.equal(bandFor(2.99).key, "debt");
  assert.equal(bandFor(3).key,    "hybrid");
  assert.equal(bandFor(4.99).key, "hybrid");
  assert.equal(bandFor(5).key,    "equityTilted");
  assert.equal(bandFor(9.99).key, "equityTilted");
  assert.equal(bandFor(10).key,   "equity");
  assert.equal(bandFor(35).key,   "equity");
});

test("band expected returns match the stated model", () => {
  assert.equal(bandFor(2).expected,  .065);
  assert.equal(bandFor(4).expected,  .09);
  assert.equal(bandFor(7).expected,  .11);
  assert.equal(bandFor(20).expected, .12);
});

test("expected return rises monotonically with horizon", () => {
  let prev = -1;
  for(const y of [1, 2, 3, 4, 5, 8, 10, 15, 30]){
    const r = bandFor(y).expected;
    assert.ok(r >= prev, `return fell at ${y}y: ${r} after ${prev}`);
    prev = r;
  }
});

test("return is derived from the horizon, never taken from input", () => {
  const plan = computePlan({ ...base, years: 20, expected: .99, rate: .99 });
  assert.equal(plan.expected.rate, .12);
  assert.equal(plan.band.key, "equity");
});

/* ------------------------------------------------------------------
   Rate conversion
   ------------------------------------------------------------------ */

test("monthly rate compounds back to the annual rate exactly", () => {
  for(const r of [.055, .065, .09, .11, .12, .155]){
    close(Math.pow(1 + monthlyRate(r), 12), 1 + r, 1e-12, `annual ${r}`);
  }
});

test("monthly rate of zero is zero", () => {
  assert.equal(monthlyRate(0), 0);
});

test("monthly rate is not the naive r/12", () => {
  assert.ok(monthlyRate(.12) < .12 / 12);
  close(monthlyRate(.12), 0.00948879293, 1e-9);
});

/* ------------------------------------------------------------------
   Inflating the target
   ------------------------------------------------------------------ */

test("future cost matches compound inflation", () => {
  close(futureCost(1000000, .06, 10), 1000000 * Math.pow(1.06, 10), 1e-6);
  close(futureCost(2500000, .10, 12), 2500000 * Math.pow(1.10, 12), 1e-6);
  close(futureCost(1000000, .06, 10), 1790847.6965, 1e-3);
});

test("zero inflation leaves the target untouched", () => {
  close(futureCost(500000, 0, 15), 500000, 1e-9);
});

test("future cost rises strictly with inflation", () => {
  let prev = 0;
  for(let p = 0; p <= 15; p++){
    const v = futureCost(1000000, p / 100, 10);
    assert.ok(v > prev, `not increasing at ${p}%`);
    prev = v;
  }
});

/* ------------------------------------------------------------------
   SIP accumulation — cross-checked against the closed form
   ------------------------------------------------------------------ */

test("SIP with no return and no step-up is just the sum of payments", () => {
  const s = sipSchedule(10000, 10, 0, 0);
  close(s.fv, 10000 * 120, 1e-9);
  close(s.invested, 10000 * 120, 1e-9);
  close(s.growth, 0, 1e-9);
});

test("SIP loop agrees with the independent closed form", () => {
  const cases = [
    [10000, 10, .12, 0], [10000, 10, .12, .10], [5000, 3, .065, 0],
    [5000, 3, .065, .05], [25000, 20, .11, .07], [1000, 1, .09, 0],
    [1000, 1, .09, .10], [8000, 30, .12, .15], [7000, 5, 0, 0], [7000, 5, 0, .10]
  ];
  for(const [P, y, r, s] of cases){
    const mine = sipFutureValue(P, y, r, s);
    const theirs = closedFormSipFv(P, y, r, s);
    close(mine, theirs, Math.max(1e-6, Math.abs(theirs) * 1e-12),
      `P=${P} y=${y} r=${r} s=${s}`);
  }
});

test("step-up raises the instalment once a year, at the year boundary", () => {
  const s = sipSchedule(10000, 3, .12, .10);
  close(s.finalMonthly, 10000 * Math.pow(1.10, 2), 1e-9);
  const flat = sipSchedule(10000, 3, .12, 0);
  close(flat.finalMonthly, 10000, 1e-9);
});

test("a step-up always beats a flat SIP of the same opening amount", () => {
  for(const y of [2, 5, 10, 25]){
    assert.ok(sipFutureValue(10000, y, .11, .10) > sipFutureValue(10000, y, .11, 0));
  }
});

test("invested total equals the sum of every instalment", () => {
  const P = 10000, s = .10, years = 4;
  const sched = sipSchedule(P, years, .11, s);
  let expected = 0;
  for(let k = 0; k < years; k++) expected += 12 * P * Math.pow(1 + s, k);
  close(sched.invested, expected, 1e-9);
});

test("growth is positive whenever the return is", () => {
  const s = sipSchedule(10000, 10, .12, 0);
  assert.ok(s.growth > 0);
  close(s.growth, s.fv - s.invested, 1e-9);
});

test("future value scales linearly with the opening instalment", () => {
  const one = sipFutureValue(1, 12, .11, .08);
  close(sipFutureValue(7500, 12, .11, .08), one * 7500, 1e-6);
});

/* ------------------------------------------------------------------
   The inverse — required SIP
   ------------------------------------------------------------------ */

test("required SIP round-trips back to the gap", () => {
  const cases = [
    [5000000, 10, .12, 0], [5000000, 10, .12, .10], [800000, 3, .065, 0],
    [12000000, 25, .12, .12], [250000, 1, .09, 0]
  ];
  for(const [gap, y, r, s] of cases){
    const sip = requiredSip(gap, y, r, s);
    close(sipFutureValue(sip, y, r, s), gap, gap * 1e-9, `gap ${gap}`);
  }
});

test("required SIP is zero when there is no gap", () => {
  assert.equal(requiredSip(0, 10, .12, 0), 0);
  assert.equal(requiredSip(-5000, 10, .12, 0), 0);
});

test("required SIP falls strictly as the return rises", () => {
  let prev = Infinity;
  for(let p = 4; p <= 16; p++){
    const sip = requiredSip(5000000, 10, p / 100, 0);
    assert.ok(sip < prev, `not falling at ${p}%`);
    prev = sip;
  }
});

test("required SIP falls strictly as the step-up rises", () => {
  let prev = Infinity;
  for(let p = 0; p <= 20; p++){
    const sip = requiredSip(5000000, 10, .12, p / 100);
    assert.ok(sip < prev, `not falling at step-up ${p}%`);
    prev = sip;
  }
});

/* ------------------------------------------------------------------
   Goal defaults
   ------------------------------------------------------------------ */

test("goal inflation defaults match the stated model", () => {
  assert.equal(defaultInflation("education"),  .10);
  assert.equal(defaultInflation("marriage"),   .07);
  assert.equal(defaultInflation("retirement"), .06);
  assert.equal(defaultInflation("homeDown"),   .06);
  assert.equal(defaultInflation("emergency"),  .06);
  assert.equal(defaultInflation("financial"),  .06);
  assert.equal(ASSUMPTIONS.generalInflation,   .06);
});

test("an explicit inflation overrides the goal default", () => {
  const plan = computePlan({ ...base, goal: "education", inflation: .04 });
  assert.equal(plan.inflation, .04);
  close(plan.futureTarget, futureCost(1000000, .04, 10), 1e-6);
});

test("omitting inflation falls back to the goal default", () => {
  const plan = computePlan({ ...base, goal: "education" });
  assert.equal(plan.inflation, .10);
});

/* ------------------------------------------------------------------
   Emergency fund — the liquid override
   ------------------------------------------------------------------ */

test("emergency fund ignores the horizon bands and does not grow", () => {
  const plan = computePlan({ goal:"emergency", targetToday:600000, years:2,
                             alreadySaved:100000, monthlyBudget:0, stepUp:0 });
  assert.equal(plan.band.key, "liquid");
  for(const s of plan.scenarios) assert.equal(s.rate, 0);
  close(plan.expected.existingFV, 100000, 1e-9);
});

test("emergency fund required SIP is the plain gap divided by months", () => {
  const plan = computePlan({ goal:"emergency", targetToday:600000, years:2,
                             alreadySaved:0, monthlyBudget:0, stepUp:0 });
  close(plan.expected.requiredSip, plan.futureTarget / 24, 1e-9);
});

test("emergency fund target still inflates", () => {
  const plan = computePlan({ goal:"emergency", targetToday:600000, years:2,
                             alreadySaved:0, monthlyBudget:0, stepUp:0 });
  assert.ok(plan.futureTarget > 600000);
  close(plan.futureTarget, futureCost(600000, .06, 2), 1e-6);
});

test("a long horizon does not turn an emergency fund into equity", () => {
  const plan = computePlan({ goal:"emergency", targetToday:600000, years:20,
                             alreadySaved:0, monthlyBudget:0, stepUp:0 });
  assert.equal(plan.expected.rate, 0);
});

/* ------------------------------------------------------------------
   Scenarios read as a range
   ------------------------------------------------------------------ */

test("scenarios are ordered poor < expected < good on return", () => {
  const plan = computePlan({ ...base, years: 15 });
  const [poor, exp, good] = plan.scenarios;
  assert.ok(poor.rate < exp.rate && exp.rate < good.rate);
});

test("a worse return demands a bigger SIP and lands a smaller corpus", () => {
  const plan = computePlan({ ...base, years: 15, monthlyBudget: 10000 });
  const [poor, exp, good] = plan.scenarios;
  assert.ok(poor.requiredSip > exp.requiredSip);
  assert.ok(exp.requiredSip  > good.requiredSip);
  assert.ok(poor.projected   < exp.projected);
  assert.ok(exp.projected    < good.projected);
});

test("every scenario is present and labelled", () => {
  const plan = computePlan(base);
  assert.deepEqual(plan.scenarios.map(s => s.key), ["poor","expected","good"]);
  assert.deepEqual(plan.scenarios.map(s => s.label), ["Poor","Expected","Good"]);
  assert.equal(plan.expected, plan.byKey.expected);
});

/* ------------------------------------------------------------------
   Direction B — budget first
   ------------------------------------------------------------------ */

test("shortfall closes the gap between projection and target", () => {
  const plan = computePlan({ ...base, monthlyBudget: 3000 });
  const s = plan.expected;
  assert.ok(s.shortfall > 0);
  assert.equal(s.surplus, 0);
  close(s.projected + s.shortfall, plan.futureTarget, 1e-6);
});

test("an over-funded plan reports surplus and no shortfall", () => {
  const plan = computePlan({ ...base, monthlyBudget: 50000 });
  const s = plan.expected;
  assert.equal(s.shortfall, 0);
  assert.ok(s.surplus > 0);
  close(s.projected - s.surplus, plan.futureTarget, 1e-6);
  assert.ok(s.pctFunded > 100);
});

test("investing exactly the required SIP lands on the target", () => {
  const first = computePlan({ ...base, years: 12, stepUp: .05 });
  const sip = first.expected.requiredSip;
  const second = computePlan({ ...base, years: 12, stepUp: .05, monthlyBudget: sip });
  close(second.expected.projected, second.futureTarget, 1);
  close(second.expected.pctFunded, 100, 1e-6);
  assert.ok(second.expected.shortfall < 1e-6);
});

test("projected corpus rises strictly with the monthly budget", () => {
  let prev = -1;
  for(let m = 0; m <= 50000; m += 2500){
    const p = computePlan({ ...base, monthlyBudget: m }).expected.projected;
    assert.ok(p > prev, `not increasing at ₹${m}`);
    prev = p;
  }
});

/* ------------------------------------------------------------------
   Existing savings
   ------------------------------------------------------------------ */

test("existing savings compound at the scenario return", () => {
  const plan = computePlan({ ...base, years: 10, alreadySaved: 500000 });
  for(const s of plan.scenarios){
    close(s.existingFV, 500000 * Math.pow(1 + s.rate, 10), 1e-6);
  }
});

test("existing savings reduce the gap one for one", () => {
  const none = computePlan({ ...base, alreadySaved: 0 }).expected;
  const some = computePlan({ ...base, alreadySaved: 200000 }).expected;
  close(none.gap - some.gap, some.existingFV, 1e-6);
  assert.ok(some.requiredSip < none.requiredSip);
});

test("a fully funded goal needs no SIP", () => {
  const plan = computePlan({ ...base, alreadySaved: 10000000 });
  assert.equal(plan.expected.gap, 0);
  assert.equal(plan.expected.requiredSip, 0);
  assert.ok(plan.alreadyFunded);
});

/* ------------------------------------------------------------------
   Input hygiene
   ------------------------------------------------------------------ */

test("negative and missing inputs are clamped, never NaN", () => {
  const plan = computePlan({ goal:"retirement", targetToday:-5, years:-3,
                             alreadySaved:NaN, monthlyBudget:undefined, stepUp:-1 });
  assert.equal(plan.targetToday, 0);
  /* The horizon floors at one month, not one year — a dated goal can be
     weeks away, so a whole year would be the wrong minimum. */
  assert.equal(plan.months, 1);
  close(plan.years, 1/12);
  assert.equal(plan.alreadySaved, 0);
  assert.equal(plan.monthlyBudget, 0);
  assert.equal(plan.stepUp, 0);
  for(const s of plan.scenarios){
    for(const v of Object.values(s)) assert.ok(typeof v !== "number" || Number.isFinite(v));
  }
});

test("an unknown goal falls back to the general financial goal", () => {
  const plan = computePlan({ ...base, goal: "yacht" });
  assert.equal(plan.goalKey, "financial");
  assert.equal(plan.inflation, .06);
});

test("ratesFor honours the liquid override only for the liquid goal", () => {
  assert.equal(ratesFor(20, "emergency").band.key, "liquid");
  assert.equal(ratesFor(20, "retirement").band.key, "equity");
});

/* ------------------------------------------------------------------
   Worked end-to-end anchor, checked by hand
   ------------------------------------------------------------------ */

test("worked example: ₹10L in 10 years at 6% inflation", () => {
  const plan = computePlan({ goal:"retirement", targetToday:1000000, years:10,
                             alreadySaved:0, monthlyBudget:0, stepUp:0 });

  assert.equal(plan.band.key, "equity");       // 10 years -> equity
  assert.equal(plan.expected.rate, .12);
  close(plan.futureTarget, 1790847.70, 0.5);   // 10L x 1.06^10
  close(plan.expected.gap, 1790847.70, 0.5);   // nothing saved yet
  close(plan.expected.requiredSip, 8069, 10);  // hand-computed ~₹8,069/month

  // and that SIP, run forward, must land back on the inflated target
  close(sipFutureValue(plan.expected.requiredSip, 10, .12, 0), plan.futureTarget, 1);
});

test("worked example: education goal inflates far faster than the general index", () => {
  const edu = computePlan({ goal:"education", targetToday:2500000, years:12 });
  const gen = computePlan({ goal:"retirement",    targetToday:2500000, years:12 });
  close(edu.futureTarget, 2500000 * Math.pow(1.10, 12), 1e-6);
  close(gen.futureTarget, 2500000 * Math.pow(1.06, 12), 1e-6);
  assert.ok(edu.futureTarget > gen.futureTarget * 1.5);
});

/* ------------------------------------------------------------------
   The dated "financial goal" — its own ladder, and month horizons
   ------------------------------------------------------------------ */

const goal = { goal: "financial", targetToday: 500000, alreadySaved: 0,
               monthlyBudget: 0, stepUp: 0 };

test("the financial goal runs on its own ladder, not the standard one", () => {
  assert.equal(ratesFor(1, "financial").band.key, "fd");
  assert.equal(ratesFor(1, "retirement").band.key, "debt");
  assert.equal(ratesFor(7, "financial").band.key, "equity");
  assert.equal(ratesFor(7, "retirement").band.key, "equityTilted");
});

test("financial goal boundaries fall at two and five years", () => {
  const b = y => ratesFor(y, "financial").band.key;
  assert.equal(b(0.5),  "fd");
  assert.equal(b(1.99), "fd");
  assert.equal(b(2),    "aggressiveHybrid");
  assert.equal(b(4.99), "aggressiveHybrid");
  assert.equal(b(5),    "equity");
  assert.equal(b(20),   "equity");
});

test("the standard ladder is untouched by the financial one", () => {
  const b = y => ratesFor(y, "retirement").band.key;
  assert.equal(b(2.99), "debt");
  assert.equal(b(3),    "hybrid");
  assert.equal(b(5),    "equityTilted");
  assert.equal(b(10),   "equity");
});

test("a two-year goal is a deposit, not a market bet", () => {
  const plan = computePlan({ ...goal, months: 18 });
  assert.equal(plan.band.key, "fd");
  assert.equal(plan.expected.rate, .0675);
  /* a contractual rate should not carry a wide spread */
  const spread = plan.byKey.good.rate - plan.byKey.poor.rate;
  assert.ok(spread < .02, `fd spread too wide: ${spread}`);
});

test("returns rise across the financial ladder", () => {
  const r = m => computePlan({ ...goal, months: m }).expected.rate;
  assert.ok(r(12) < r(36));
  assert.ok(r(36) < r(72));
  assert.equal(r(12), .0675);
  assert.equal(r(36), .10);
  assert.equal(r(72), .12);
});

test("a horizon of months works, and is not floored at a year", () => {
  const plan = computePlan({ ...goal, months: 8 });
  assert.equal(plan.months, 8);
  close(plan.years, 8/12);
  assert.equal(plan.band.key, "fd");
  assert.ok(plan.expected.requiredSip > 0);
});

test("a laptop in eight months needs roughly an eighth of it each month", () => {
  const plan = computePlan({ ...goal, targetToday: 80000, months: 8 });
  /* inflated a little, then discounted a little by 6.75% growth — so close
     to a straight eighth, but not exactly */
  const sip = plan.expected.requiredSip;
  assert.ok(sip > 9000 && sip < 10500, `got ${sip}`);
});

test("months and years agree when they describe the same horizon", () => {
  const byMonths = computePlan({ ...goal, months: 36 });
  const byYears  = computePlan({ ...goal, years: 3 });
  assert.equal(byMonths.months, byYears.months);
  close(byMonths.expected.requiredSip, byYears.expected.requiredSip, 1e-9);
});

test("months take precedence over years when both are given", () => {
  const plan = computePlan({ ...goal, years: 10, months: 6 });
  assert.equal(plan.months, 6);
});

test("the financial goal is flagged as dated, the others are not", () => {
  assert.equal(computePlan({ ...goal, months: 12 }).dated, true);
  assert.equal(computePlan({ goal: "retirement", targetToday: 1, years: 10 }).dated, false);
});

test("the financial goal inflates at the general rate", () => {
  const plan = computePlan({ ...goal, months: 24 });
  assert.equal(plan.inflation, .06);
  close(plan.futureTarget, futureCost(500000, .06, 2), 1e-6);
});

test("a sub-year horizon still inflates the target, pro rata", () => {
  const plan = computePlan({ ...goal, targetToday: 100000, months: 6 });
  close(plan.futureTarget, 100000 * Math.pow(1.06, 0.5), 1e-6);
  assert.ok(plan.futureTarget > 100000 && plan.futureTarget < 103000);
});

test("every financial-goal band carries the fields the UI renders", () => {
  for(const y of [1, 3, 8]){
    const b = ratesFor(y, "financial").band;
    for(const f of ["key","mix","detail","equity","poor","expected","good"]){
      assert.ok(b[f] !== undefined, `band ${b.key} missing ${f}`);
    }
  }
});
