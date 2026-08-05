import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMPTIONS, accruedBonus, finalBonus, premiumInYear,
  irr, schedule, computePolicy, compareTermPlusIndex
} from "../../public/src/insure/insure-engine.js";

const close = (a, b, tol = 1e-6, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || "close"}: ${a} vs ${b} (tol ${tol})`);

/* A plain 20-year endowment: ₹10L cover, ₹50k a year, ₹45 per thousand. */
const base = {
  sumAssured: 1000000, annualPremium: 50000,
  policyTerm: 20, premiumTerm: 20,
  bonusPerThousand: 45, fabPerThousand: 0, addGst: false
};

/* Independent NPV, used to confirm the IRR the engine returns really is a
   root rather than merely plausible. */
const npvAt = (flows, r) => flows.reduce((s, cf, t) => s + cf / Math.pow(1 + r, t), 0);

function policyFlows(p){
  const flows = new Array(p.policyTerm + 1).fill(0);
  for(let y = 1; y <= p.policyTerm; y++){
    flows[y - 1] -= premiumInYear(y, p.annualPremium, p.premiumTerm, p.addGst);
  }
  return flows;
}

/* ------------------------------------------------------------------
   Bonus accrual
   ------------------------------------------------------------------ */

test("simple reversionary bonus accrues on the sum assured, not compounded", () => {
  close(accruedBonus(1000000, 45, 20), 900000);
  close(accruedBonus(1000000, 45, 1), 45000);
  /* twenty years of bonus is exactly twenty times one year of it */
  close(accruedBonus(1000000, 45, 20), 20 * accruedBonus(1000000, 45, 1));
});

test("bonus scales linearly with the sum assured", () => {
  close(accruedBonus(2000000, 45, 10), 2 * accruedBonus(1000000, 45, 10));
});

test("a zero bonus rate accrues nothing", () => {
  close(accruedBonus(1000000, 0, 30), 0);
});

test("final additional bonus is a one-off per thousand of cover", () => {
  close(finalBonus(1000000, 100), 100000);
  close(finalBonus(1000000, 0), 0);
});

/* ------------------------------------------------------------------
   Premiums and GST
   ------------------------------------------------------------------ */

test("no premium is due after the paying term ends", () => {
  assert.equal(premiumInYear(11, 50000, 10, false), 0);
  assert.equal(premiumInYear(10, 50000, 10, false), 50000);
  assert.equal(premiumInYear(0, 50000, 10, false), 0);
});

test("GST is charged at the higher rate in year one only", () => {
  close(premiumInYear(1, 50000, 20, true), 50000 * 1.045);
  close(premiumInYear(2, 50000, 20, true), 50000 * 1.0225);
  close(premiumInYear(20, 50000, 20, true), 50000 * 1.0225);
});

test("GST off means the premium is taken exactly as entered", () => {
  close(premiumInYear(1, 50000, 20, false), 50000);
});

test("total paid without GST is simply premium times paying term", () => {
  const p = computePolicy(base);
  close(p.declared.totalPaid, 50000 * 20);
});

test("adding GST raises the total paid and lowers the return", () => {
  const without = computePolicy(base);
  const with_ = computePolicy({ ...base, addGst: true });
  assert.ok(with_.declared.totalPaid > without.declared.totalPaid);
  assert.ok(with_.declared.irr < without.declared.irr);
  /* maturity is untouched by GST — it is a cost, not a benefit */
  close(with_.declared.maturity, without.declared.maturity);
});

/* ------------------------------------------------------------------
   IRR solver
   ------------------------------------------------------------------ */

test("irr recovers a rate it was built from", () => {
  close(irr([-100, 0, 121]), 0.10, 1e-9);        // 100 -> 121 over two years
  close(irr([-100, 110]), 0.10, 1e-9);           // one year
  close(irr([-100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 259.374246]), 0.10, 1e-6);
});

test("irr handles a level annuity of outflows", () => {
  /* ₹1 at the start of each of 3 years, ₹3.3101 at the end of year 3 is
     exactly 10%: 1.331 + 1.21 + 1.1 = 3.641... check by NPV instead. */
  const flows = [-1, -1, -1, 3.641];
  const r = irr(flows);
  close(npvAt(flows, r), 0, 1e-9);
  close(r, 0.10, 1e-6);
});

test("irr returns a genuine root for the policy cash flows", () => {
  const p = computePolicy(base);
  const flows = policyFlows(base);
  flows[base.policyTerm] += p.declared.maturity;
  /* Tolerance scales with the size of the flows — an absolute epsilon is
     meaningless against sums in the millions. */
  close(npvAt(flows, p.declared.irr), 0, p.declared.maturity * 1e-9);
});

test("irr can be negative when the payout is less than what went in", () => {
  const r = irr([-100, -100, 150]);
  assert.ok(r !== null && r < 0);
  close(npvAt([-100, -100, 150], r), 0, 1e-9);
});

test("irr returns null rather than a wrong number when there is no root", () => {
  assert.equal(irr([-100, -100, -100]), null);   // never any inflow
  assert.equal(irr([100, 100]), null);           // never any outflow
});

/* ------------------------------------------------------------------
   The worked policy
   ------------------------------------------------------------------ */

test("maturity is sum assured plus accrued bonus plus final bonus", () => {
  const p = computePolicy(base);
  close(p.declared.accruedBonus, 900000);
  close(p.declared.maturity, 1900000);
  close(p.declared.gain, 900000);               // 19L out, 10L in
  close(p.declared.multiple, 1.9);
});

test("a final additional bonus lands on top of maturity", () => {
  const p = computePolicy({ ...base, fabPerThousand: 100 });
  close(p.declared.maturity, 1000000 + 900000 + 100000);
});

test("worked example: ₹50k a year for 20 years returning ₹19L is about 5.8%", () => {
  const p = computePolicy(base);
  assert.ok(p.declared.irr > 0.055 && p.declared.irr < 0.060,
    `expected roughly 5.8%, got ${(p.declared.irr * 100).toFixed(3)}%`);
});

test("the headline return is the effective annual rate, not the total gain", () => {
  const p = computePolicy(base);
  /* 90% total gain over 20 years is nowhere near 90% a year */
  close(p.declared.multiple, 1.9);
  assert.ok(p.declared.irr < 0.10);
});

/* ------------------------------------------------------------------
   Scenarios — only the sum assured is contractual
   ------------------------------------------------------------------ */

test("the guaranteed floor pays the sum assured and nothing else", () => {
  const p = computePolicy({ ...base, fabPerThousand: 100 });
  close(p.guaranteed.accruedBonus, 0);
  close(p.guaranteed.finalBonus, 0);
  close(p.guaranteed.maturity, 1000000);
});

test("the guaranteed floor on this policy returns exactly nothing", () => {
  const p = computePolicy(base);
  /* ₹10L of premiums returning ₹10L twenty years later. At r = 0 discounting
     is the identity, so equal nominal flows give a rate of exactly zero
     however they are spread — you get your money back and no more. */
  close(p.guaranteed.totalPaid, 1000000);
  close(p.guaranteed.maturity, 1000000);
  close(p.guaranteed.irr, 0, 1e-9);
});

test("with GST the guaranteed floor is an outright loss", () => {
  const p = computePolicy({ ...base, addGst: true });
  assert.ok(p.guaranteed.totalPaid > p.guaranteed.maturity);
  assert.ok(p.guaranteed.irr < 0);
});

test("scenarios are ordered guaranteed < declared < improved", () => {
  const p = computePolicy(base);
  const [g, d, i] = p.scenarios;
  assert.ok(g.maturity < d.maturity && d.maturity < i.maturity);
  assert.ok(g.irr < d.irr && d.irr < i.irr);
});

test("the improved scenario uses the stated multiplier on the bonus rate", () => {
  const p = computePolicy(base);
  close(p.byKey.improved.bonusPerThousand, 45 * ASSUMPTIONS.improvedMultiplier);
});

test("every scenario is present and labelled", () => {
  const p = computePolicy(base);
  assert.deepEqual(p.scenarios.map(s => s.key), ["guaranteed", "declared", "improved"]);
  assert.ok(p.scenarios.every(s => typeof s.label === "string" && s.label.length));
});

test("total paid is identical across scenarios — bonuses change only the payout", () => {
  const p = computePolicy(base);
  const paid = p.scenarios.map(s => s.totalPaid);
  close(paid[0], paid[1]);
  close(paid[1], paid[2]);
});

/* ------------------------------------------------------------------
   Monotonicity
   ------------------------------------------------------------------ */

test("a higher bonus rate always means a higher return", () => {
  let prev = -Infinity;
  for(let rate = 0; rate <= 80; rate += 5){
    const r = computePolicy({ ...base, bonusPerThousand: rate }).declared.irr;
    assert.ok(r > prev, `return did not rise at ₹${rate} per thousand`);
    prev = r;
  }
});

test("a higher premium for the same benefits always means a lower return", () => {
  let prev = Infinity;
  for(let prem = 30000; prem <= 90000; prem += 10000){
    const r = computePolicy({ ...base, annualPremium: prem }).declared.irr;
    assert.ok(r < prev, `return did not fall at a premium of ${prem}`);
    prev = r;
  }
});

test("more cover for the same premium always means a higher return", () => {
  let prev = -Infinity;
  for(const sa of [500000, 1000000, 1500000, 2000000]){
    const r = computePolicy({ ...base, sumAssured: sa }).declared.irr;
    assert.ok(r > prev, `return did not rise at cover of ${sa}`);
    prev = r;
  }
});

/* ------------------------------------------------------------------
   Limited premium paying term
   ------------------------------------------------------------------ */

test("a limited paying term stops the premiums early but not the policy", () => {
  const p = computePolicy({ ...base, premiumTerm: 10 });
  assert.ok(p.limitedPay);
  close(p.declared.totalPaid, 50000 * 10);
  close(p.declared.accruedBonus, 900000);        // bonus still runs the full 20
  assert.equal(p.schedule.length, 20);
  assert.equal(p.schedule[10].premium, 0);       // year 11
});

test("paying for fewer years beats paying the same amount over more", () => {
  const short = computePolicy({ ...base, premiumTerm: 10, annualPremium: 100000 });
  const long  = computePolicy({ ...base, premiumTerm: 20, annualPremium: 50000 });
  close(short.declared.totalPaid, long.declared.totalPaid);
  /* same total outlay and same maturity, but paid later, so the longer
     schedule is worth more in rate terms */
  assert.ok(long.declared.irr > short.declared.irr);
});

test("a paying term longer than the policy is clamped to the policy term", () => {
  const p = computePolicy({ ...base, policyTerm: 15, premiumTerm: 25 });
  assert.equal(p.premiumTerm, 15);
  assert.equal(p.limitedPay, false);
});

/* ------------------------------------------------------------------
   Schedule
   ------------------------------------------------------------------ */

test("the schedule runs one row per policy year", () => {
  const p = computePolicy(base);
  assert.equal(p.schedule.length, 20);
  assert.equal(p.schedule[0].year, 1);
  assert.equal(p.schedule[19].year, 20);
});

test("death benefit is cover plus bonus accrued to that point", () => {
  const p = computePolicy(base);
  for(const row of p.schedule){
    close(row.deathBenefit, 1000000 + accruedBonus(1000000, 45, row.year));
  }
});

test("paid-to-date accumulates and stops with the paying term", () => {
  const p = computePolicy({ ...base, premiumTerm: 10 });
  close(p.schedule[9].paidToDate, 500000);
  close(p.schedule[19].paidToDate, 500000);
});

test("only the final row carries a maturity figure", () => {
  const p = computePolicy(base);
  assert.equal(p.schedule[0].maturityIfNow, null);
  close(p.schedule[19].maturityIfNow, p.declared.maturity);
});

/* ------------------------------------------------------------------
   Input hygiene
   ------------------------------------------------------------------ */

test("negative and missing inputs are clamped, never NaN", () => {
  const p = computePolicy({ sumAssured: -5, annualPremium: NaN, policyTerm: -3,
                            premiumTerm: undefined, bonusPerThousand: -10 });
  assert.equal(p.sumAssured, 0);
  assert.equal(p.annualPremium, 0);
  assert.equal(p.policyTerm, 1);
  assert.equal(p.premiumTerm, 1);
  assert.equal(p.bonusPerThousand, 0);
  for(const s of p.scenarios){
    for(const [k, v] of Object.entries(s)){
      if(typeof v === "number") assert.ok(Number.isFinite(v), `${k} was ${v}`);
    }
  }
});

test("a policy with no premium reports no return rather than infinity", () => {
  const p = computePolicy({ ...base, annualPremium: 0 });
  assert.equal(p.declared.irr, null);
  assert.equal(p.coverMultiple, 0);
});

test("cover multiple states how much cover each premium rupee buys", () => {
  const p = computePolicy(base);
  close(p.coverMultiple, 20);                    // ₹10L cover for ₹50k a year
});

/* ------------------------------------------------------------------
   Term cover plus an index fund — the other route
   ------------------------------------------------------------------ */

const cmp = (over = {}, opts = {}) =>
  compareTermPlusIndex(computePolicy({ ...base, ...over }),
    { termPremium: 3000, indexReturn: .12, ...opts });

test("the same money leaves your pocket every year, both routes", () => {
  /* This is the whole basis of the comparison. If it does not hold, the
     result is just an argument for spending more. */
  const c = cmp();
  for(const r of c.rows){
    close(r.termOutlay + r.invested, r.endowmentOutlay, 1e-9, `year ${r.year}`);
  }
  close(c.termOutlayTotal + c.invested, c.endowmentOutlayTotal, 1e-6);
});

test("the leftover is the endowment premium less the term premium", () => {
  const c = cmp();
  close(c.rows[0].invested, 50000 - 3000, 1e-9);
});

test("the corpus compounds at the return given", () => {
  const c = cmp({ policyTerm: 2, premiumTerm: 2 }, { indexReturn: .10 });
  const d = 50000 - 3000;
  close(c.rows[0].corpus, d * 1.1, 1e-6);
  close(c.rows[1].corpus, (d * 1.1 + d) * 1.1, 1e-6);
});

test("a zero return leaves exactly what was put in", () => {
  const c = cmp({}, { indexReturn: 0 });
  close(c.corpus, (50000 - 3000) * 20, 1e-6);
});

test("term GST is 18%, not the traditional-plan rate", () => {
  const withGst = cmp({ addGst: true });
  close(withGst.termOutlay, 3000 * 1.18, 1e-9);
  close(cmp({ addGst: false }).termOutlay, 3000, 1e-9);
});

test("after a limited-pay endowment stops, the term premium comes out of the pot", () => {
  const c = cmp({ premiumTerm: 10 });
  const year11 = c.rows[10];
  assert.equal(year11.endowmentOutlay, 0);
  close(year11.invested, -year11.termOutlay, 1e-9);
  /* out of pocket is still matched — at zero */
  close(year11.termOutlay + year11.invested, 0, 1e-9);
});

test("the corpus still grows after the premiums stop", () => {
  const c = cmp({ premiumTerm: 10 });
  assert.ok(c.rows[19].corpus > c.rows[10].corpus);
});

test("death benefit on the other route is cover plus the pot", () => {
  const c = cmp();
  const r = c.rows[9];
  close(r.termDeath, 1000000 + r.corpus, 1e-9);
  close(r.endowmentDeath, 1000000 + 900000 * (10 / 20), 1e-6);
});

test("the crossover year is the first the pot beats the accrued policy", () => {
  const c = cmp();
  assert.ok(c.crossover > 0 && c.crossover <= 20);
  const at = c.rows[c.crossover - 1];
  assert.ok(at.corpus > at.endowmentAccrued);
  if(c.crossover > 1){
    const before = c.rows[c.crossover - 2];
    assert.ok(before.corpus <= before.endowmentAccrued);
  }
});

test("a return low enough loses to the endowment, and says so", () => {
  const c = cmp({}, { indexReturn: .01 });
  assert.ok(c.corpus < c.endowmentMaturity);
  assert.ok(c.gap < 0);
  assert.equal(c.crossover, null);
});

test("the endowment maturity used is the same one the policy reports", () => {
  const p = computePolicy(base);
  const c = compareTermPlusIndex(p, { termPremium: 3000, indexReturn: .12 });
  close(c.endowmentMaturity, p.declared.maturity, 1e-6);
});

test("a final additional bonus counts on the endowment side", () => {
  const p = computePolicy({ ...base, fabPerThousand: 100 });
  const c = compareTermPlusIndex(p, { termPremium: 3000, indexReturn: .12 });
  close(c.endowmentMaturity, p.declared.maturity, 1e-6);
});

test("a term premium above the endowment premium leaves no headroom, and is flagged", () => {
  const c = cmp({}, { termPremium: 60000 });
  assert.equal(c.noHeadroom, true);
  assert.equal(c.everNegative, true);
  assert.ok(c.corpus < 0);
});

test("comparison inputs are clamped, never NaN", () => {
  const c = cmp({}, { termPremium: -100, indexReturn: NaN });
  assert.equal(c.termPremium, 0);
  assert.equal(c.indexReturn, ASSUMPTIONS.defaultIndexReturn);
  for(const r of c.rows) assert.ok(Number.isFinite(r.corpus));
});

test("a zero-premium policy does not divide by zero", () => {
  const c = cmp({ annualPremium: 0 }, { termPremium: 0 });
  assert.ok(Number.isFinite(c.corpus));
  assert.equal(c.noHeadroom, false);
});
