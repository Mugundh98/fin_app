/* Insurance engine — pure functions, no DOM, no framework.
   Same contract as the other engines: imports nothing, touches no DOM.

   Endowment plans only, for now. A traditional endowment bundles life cover
   with a savings pot, which makes the return it earns hard to see from the
   brochure. This works it out from the numbers on the policy document.

   Informational only. It reports what a policy's own figures imply. It does
   not name insurers, rank products, or hold a view on whether anyone should
   buy, keep or surrender a policy. */

export const ASSUMPTIONS = {
  /* GST on traditional life premiums: higher in year one, lower after. */
  gst: { firstYear: .045, subsequent: .0225 },

  /* Simple reversionary bonus is quoted per ₹1,000 of sum assured per year,
     and accrues on the SUM ASSURED — it does not compound. */
  defaultBonusPerThousand: 45,
  defaultFabPerThousand: 0,

  /* Only the sum assured is contractual. Bonus rates are declared each year
     and can be cut, so the floor scenario assumes none is ever declared. */
  scenarioKeys: ["guaranteed", "declared", "improved"],
  scenarioLabels: {
    guaranteed: "If no bonus is declared",
    declared:   "At the bonus you entered",
    improved:   "If the bonus runs higher"
  },
  improvedMultiplier: 1.2
};

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/* ============================================================
   BUILDING BLOCKS
   ============================================================ */

/* Simple reversionary bonus: rate per ₹1,000 of sum assured, per year,
   accrued on the sum assured and never compounded. */
export function accruedBonus(sumAssured, perThousand, years){
  return (sumAssured / 1000) * perThousand * years;
}

/* Final additional bonus, a one-off at maturity, also quoted per ₹1,000. */
export function finalBonus(sumAssured, perThousand){
  return (sumAssured / 1000) * perThousand;
}

/* What leaves your bank account in a given policy year (1-based).
   Zero once the premium paying term is over. */
export function premiumInYear(year, annualPremium, premiumTerm, addGst){
  if(year < 1 || year > premiumTerm) return 0;
  if(!addGst) return annualPremium;
  const rate = year === 1 ? ASSUMPTIONS.gst.firstYear : ASSUMPTIONS.gst.subsequent;
  return annualPremium * (1 + rate);
}

/* Internal rate of return by bisection.
   `cashflows[t]` is the net flow at the START of year t: premiums are
   negative, the maturity payout positive. Bisection rather than
   Newton-Raphson because the sign pattern here (a run of outflows then one
   inflow) guarantees exactly one root, and bisection cannot diverge. */
export function irr(cashflows, lo = -0.9999, hi = 10){
  const npv = r => cashflows.reduce((s, cf, t) => s + cf / Math.pow(1 + r, t), 0);
  let a = lo, b = hi, fa = npv(a), fb = npv(b);
  if(!Number.isFinite(fa) || !Number.isFinite(fb)) return null;
  if(fa === 0) return a;
  if(fb === 0) return b;
  if(fa * fb > 0) return null;                 // no sign change: no root here
  for(let i = 0; i < 300; i++){
    const m = (a + b) / 2, fm = npv(m);
    if(fm === 0 || (b - a) < 1e-12) return m;
    if(fa * fm < 0){ b = m; } else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

/* ============================================================
   POLICY
   ============================================================ */

/* Year-by-year view. Death benefit is the sum assured plus bonus accrued so
   far — the final additional bonus is a maturity-only item and is not
   included in it. */
export function schedule(p, perThousand){
  const rows = [];
  let paid = 0;
  for(let y = 1; y <= p.policyTerm; y++){
    const premium = premiumInYear(y, p.annualPremium, p.premiumTerm, p.addGst);
    paid += premium;
    const bonus = accruedBonus(p.sumAssured, perThousand, y);
    rows.push({
      year: y, premium, paidToDate: paid,
      accruedBonus: bonus,
      deathBenefit: p.sumAssured + bonus,
      maturityIfNow: y === p.policyTerm
        ? p.sumAssured + bonus + finalBonus(p.sumAssured, p.fabPerThousand)
        : null
    });
  }
  return rows;
}

function scenarioFor(p, perThousand, key){
  const bonus = accruedBonus(p.sumAssured, perThousand, p.policyTerm);
  const fab = key === "guaranteed" ? 0 : finalBonus(p.sumAssured, p.fabPerThousand);
  const maturity = p.sumAssured + bonus + fab;

  /* Premiums leave at the start of each policy year, maturity arrives at the
     end of the last one — hence index policyTerm, not policyTerm - 1. */
  const flows = new Array(p.policyTerm + 1).fill(0);
  let totalPaid = 0;
  for(let y = 1; y <= p.policyTerm; y++){
    const premium = premiumInYear(y, p.annualPremium, p.premiumTerm, p.addGst);
    flows[y - 1] -= premium;
    totalPaid += premium;
  }
  flows[p.policyTerm] += maturity;

  const rate = totalPaid > 0 && maturity > 0 ? irr(flows) : null;

  return {
    key, label: ASSUMPTIONS.scenarioLabels[key],
    bonusPerThousand: perThousand,
    accruedBonus: bonus, finalBonus: fab,
    maturity, totalPaid,
    gain: maturity - totalPaid,
    multiple: totalPaid > 0 ? maturity / totalPaid : 0,
    irr: rate
  };
}

export function computePolicy(input){
  const policyTerm  = Math.max(1, Math.round(num(input.policyTerm, 20)));
  /* You cannot pay premiums for longer than the policy runs. */
  const premiumTerm = Math.min(policyTerm, Math.max(1, Math.round(num(input.premiumTerm, policyTerm))));

  const p = {
    sumAssured:       Math.max(0, num(input.sumAssured)),
    annualPremium:    Math.max(0, num(input.annualPremium)),
    policyTerm, premiumTerm,
    bonusPerThousand: Math.max(0, num(input.bonusPerThousand, ASSUMPTIONS.defaultBonusPerThousand)),
    fabPerThousand:   Math.max(0, num(input.fabPerThousand, ASSUMPTIONS.defaultFabPerThousand)),
    addGst:           !!input.addGst
  };

  const rates = {
    guaranteed: 0,
    declared:   p.bonusPerThousand,
    improved:   p.bonusPerThousand * ASSUMPTIONS.improvedMultiplier
  };

  const scenarios = ASSUMPTIONS.scenarioKeys.map(k => scenarioFor(p, rates[k], k));
  const byKey = Object.fromEntries(scenarios.map(s => [s.key, s]));

  return {
    ...p,
    limitedPay: premiumTerm < policyTerm,
    scenarios, byKey,
    declared: byKey.declared,
    guaranteed: byKey.guaranteed,
    schedule: schedule(p, p.bonusPerThousand),
    /* Cover per rupee of annual premium — the single number that shows how
       much of the premium is buying protection rather than savings. */
    coverMultiple: p.annualPremium > 0 ? p.sumAssured / p.annualPremium : 0
  };
}
