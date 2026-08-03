import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRegime, breakEven, hraExemption, slabTax, RATES } from "../../public/src/tax/tax-engine.js";

/* A taxpayer with nothing filled in. Spread over it to build a case. */
const blank = {
  itr: "ITR-1", age: 30, metro: true, parentsSenior: false, hpType: "none",
  salary: 0, basicDA: 0, hra: 0, rent: 0, lta: 0, profTax: 0,
  hpInterest: 0, rentReceived: 0, municipalTax: 0,
  businessProfit: 0, turnoverDigital: 0, turnoverCash: 0, receipts44ADA: 0, income44AE: 0,
  interestIncome: 0, otherIncome: 0,
  stcg111A: 0, ltcg112A: 0, ltcgOther: 0, stcgSlab: 0,
  d80C: 0, d80CCD1B: 0, d80CCD2: 0, d80D_self: 0, d80D_parents: 0,
  d80TT: 0, d80E: 0, d80G: 0, dOther: 0
};

const tax = (o, regime) => Math.round(computeRegime({ ...blank, ...o }, regime).total);

/* ------------------------------------------------------------------
   Anchored to the Income Tax Department's own published example.
   If this breaks, the rate table is wrong.
   ------------------------------------------------------------------ */
test("ITD worked example: ₹15L salary, new regime, = ₹97,500", () => {
  assert.equal(tax({ salary: 1500000 }, "new"), 97500);
});

test("salaried income up to ₹12.75L is tax-free under the new regime", () => {
  assert.equal(tax({ salary: 1275000 }, "new"), 0);
});

test("old regime: ₹10L salary with full 80C = ₹75,400", () => {
  assert.equal(tax({ salary: 1000000, d80C: 150000 }, "old"), 75400);
});

/* ------------------------------------------------------------------
   REGRESSION — bug 1.
   Marginal relief on the rebate was missing, so income just over ₹12L
   showed ₹62,556 of tax instead of ₹1,040. This is the provision that
   stops the new regime having a cliff at ₹12 lakh.
   ------------------------------------------------------------------ */
test("rebate marginal relief: ₹1,000 over the limit costs ₹1,000 + cess", () => {
  assert.equal(tax({ salary: 1276000 }, "new"), 1040);
});

test("rebate marginal relief tapers out and stops applying", () => {
  assert.equal(tax({ salary: 1285000 }, "new"), 10400);
  assert.equal(tax({ salary: 1375000 }, "new"), 78000); // relief exhausted
});

/* ------------------------------------------------------------------
   REGRESSION — bug 2.
   The surcharge marginal-relief ceiling ignored the surcharge already
   payable AT the threshold, so tax FELL as income crossed ₹1 crore.
   ------------------------------------------------------------------ */
test("tax never decreases as income rises — new regime, up to ₹6cr", () => {
  let prev = -1;
  for (let s = 200000; s <= 60000000; s += 5000) {
    const t = computeRegime({ ...blank, salary: s }, "new").total;
    assert.ok(t >= prev - 0.5, `tax dropped at salary ${s}: ${prev} -> ${t}`);
    prev = t;
  }
});

test("tax never decreases as income rises — old regime, up to ₹6cr", () => {
  let prev = -1;
  for (let s = 200000; s <= 60000000; s += 5000) {
    const t = computeRegime({ ...blank, salary: s, d80C: 150000 }, "old").total;
    assert.ok(t >= prev - 0.5, `tax dropped at salary ${s}: ${prev} -> ${t}`);
    prev = t;
  }
});

/* ------------------------------------------------------------------
   Slabs and age bands
   ------------------------------------------------------------------ */
test("senior citizens get the ₹3L exemption under the old regime", () => {
  assert.equal(tax({ salary: 600000, age: 65 }, "old"), 20800);
});

test("super seniors get the ₹5L exemption under the old regime", () => {
  assert.equal(tax({ salary: 1000000, age: 82 }, "old"), 93600);
});

test("the new regime gives seniors no separate slab", () => {
  assert.equal(tax({ salary: 1500000, age: 30 }, "new"), tax({ salary: 1500000, age: 82 }, "new"));
});

/* ------------------------------------------------------------------
   Deduction caps
   ------------------------------------------------------------------ */
test("80C is capped at ₹1.5 lakh however much is claimed", () => {
  assert.equal(
    tax({ salary: 1000000, d80C: 5000000 }, "old"),
    tax({ salary: 1000000, d80C: 150000 }, "old")
  );
});

test("old-regime deductions do nothing under the new regime", () => {
  assert.equal(
    tax({ salary: 1500000, d80C: 150000, d80D_self: 25000 }, "new"),
    tax({ salary: 1500000 }, "new")
  );
});

test("80CCD(2) employer NPS is allowed under BOTH regimes", () => {
  assert.ok(tax({ salary: 1500000, d80CCD2: 100000 }, "new") < tax({ salary: 1500000 }, "new"));
  assert.ok(tax({ salary: 1500000, d80CCD2: 100000 }, "old") < tax({ salary: 1500000 }, "old"));
});

/* ------------------------------------------------------------------
   HRA — the three-way minimum that trips people up
   ------------------------------------------------------------------ */
test("HRA exemption takes the least of the three tests", () => {
  // received 2.4L / rent-10% = 1.8L / 50% of basic = 3L  -> 1.8L wins
  assert.equal(hraExemption(600000, 240000, 240000, true), 180000);
  // non-metro drops the third test to 40%
  assert.equal(hraExemption(600000, 240000, 120000, false), 60000);
  // no rent paid means no exemption
  assert.equal(hraExemption(600000, 240000, 0, true), 0);
});

/* ------------------------------------------------------------------
   Capital gains
   ------------------------------------------------------------------ */
test("first ₹1.25L of listed-equity LTCG is exempt", () => {
  assert.equal(tax({ ltcg112A: 125000 }, "new"), 0);
});

test("LTCG above the exemption is taxed at 12.5%", () => {
  assert.equal(tax({ ltcg112A: 225000 }, "new"), 13000); // 1L * 12.5% * 1.04
});

test("listed-equity STCG is taxed at 20%", () => {
  assert.equal(tax({ stcg111A: 500000 }, "new"), 104000); // 5L * 20% * 1.04
});

/* ------------------------------------------------------------------
   Presumptive income (ITR-4)
   ------------------------------------------------------------------ */
test("44AD: 6% on digital turnover, 8% on cash", () => {
  const r = computeRegime({ ...blank, itr: "ITR-4", turnoverDigital: 5000000, turnoverCash: 1000000 }, "new");
  assert.equal(r.gtiSlab, 5000000 * 0.06 + 1000000 * 0.08);
});

test("44ADA: 50% of professional receipts", () => {
  const r = computeRegime({ ...blank, itr: "ITR-4", receipts44ADA: 4000000 }, "new");
  assert.equal(r.gtiSlab, 2000000);
});

/* ------------------------------------------------------------------
   Break-even solver
   ------------------------------------------------------------------ */
test("break-even figure actually makes the old regime win", () => {
  for (const salary of [900000, 1500000, 2000000, 2500000, 5000000]) {
    const input = { ...blank, salary };
    const be = breakEven(input);
    if (be.amount === null || be.amount === 0) continue;
    const newTax = computeRegime(input, "new").total;
    const atBE = computeRegime({ ...input, dOther: be.amount }, "old").total;
    const justBelow = computeRegime({ ...input, dOther: be.amount - 5000 }, "old").total;
    assert.ok(atBE <= newTax + 1, `at ₹${salary} the break-even does not win`);
    assert.ok(justBelow > newTax, `at ₹${salary} the break-even is not tight`);
  }
});

/* ------------------------------------------------------------------
   Sanity
   ------------------------------------------------------------------ */
test("zero income means zero tax", () => {
  assert.equal(tax({}, "old"), 0);
  assert.equal(tax({}, "new"), 0);
});

test("slab bands sum to the total tax", () => {
  const { tax: t, rows } = slabTax(1425000, RATES.new.slabs.below60);
  assert.equal(Math.round(rows.reduce((a, r) => a + r.amt, 0)), Math.round(t));
  assert.equal(Math.round(t), 93750);
});
