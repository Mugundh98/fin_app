/* Tax engine — pure functions, no DOM, no framework.
   This is the part worth protecting: it ports straight to React Native,
   a server, or a test runner without modification. */

export const RATES = {
  label: "AY 2026-27 (FY 2025-26)",
  cess: 0.04,
  old: {
    slabs: {
      below60:     [[250000,0],[500000,.05],[1000000,.20],[Infinity,.30]],
      senior:      [[300000,0],[500000,.05],[1000000,.20],[Infinity,.30]],
      superSenior: [[500000,0],[1000000,.20],[Infinity,.30]]
    },
    standardDeduction: 50000,
    rebate: { incomeLimit: 500000, max: 12500 },
    surcharge: [[5000000,0],[10000000,.10],[20000000,.15],[50000000,.25],[Infinity,.37]],
    reliefThresholds: [5000000,10000000,20000000,50000000]
  },
  new: {
    slabs: {
      below60:     [[400000,0],[800000,.05],[1200000,.10],[1600000,.15],[2000000,.20],[2400000,.25],[Infinity,.30]],
      senior:      [[400000,0],[800000,.05],[1200000,.10],[1600000,.15],[2000000,.20],[2400000,.25],[Infinity,.30]],
      superSenior: [[400000,0],[800000,.05],[1200000,.10],[1600000,.15],[2000000,.20],[2400000,.25],[Infinity,.30]]
    },
    standardDeduction: 75000,
    rebate: { incomeLimit: 1200000, max: 60000 },
    surcharge: [[5000000,0],[10000000,.10],[20000000,.15],[Infinity,.25]],
    reliefThresholds: [5000000,10000000,20000000]
  },
  special: {
    stcg111A: .20,          // listed equity STCG
    ltcg112A: .125,         // listed equity LTCG
    ltcg112ARelief: 125000, // annual exemption on 112A gains
    ltcgOther: .125,
    surchargeCap: .15       // enhanced surcharge does not apply to special-rate income
  },
  presumptive: { s44AD_digital: .06, s44AD_cash: .08, s44ADA: .50 },
  deductionCaps: {
    s80C: 150000, s80CCD1B: 50000, s80D_self: 25000, s80D_selfSenior: 50000,
    s80D_parents: 25000, s80D_parentsSenior: 50000, s80TTA: 10000, s80TTB: 50000,
    selfOccupiedInterest: 200000
  }
};

/* ============================================================
   TAX ENGINE — pure functions, no DOM. Portable to React Native.
   ============================================================ */
export function slabTax(income, slabs){
  let tax = 0, lower = 0, rows = [];
  for(const [upper, rate] of slabs){
    if(income <= lower) break;
    const band = Math.min(income, upper) - lower;
    const amt = band * rate;
    tax += amt;
    rows.push({ from: lower, to: upper, rate, band, amt });
    lower = upper;
  }
  return { tax, rows };
}

export function surchargeRate(income, table){
  for(const [upper, rate] of table) if(income <= upper) return rate;
  return 0;
}

export function ageBand(age){
  if(age >= 80) return "superSenior";
  if(age >= 60) return "senior";
  return "below60";
}

export function hraExemption(basicDA, hraReceived, rentPaid, isMetro){
  if(hraReceived <= 0 || rentPaid <= 0) return 0;
  return Math.max(0, Math.min(
    hraReceived,
    rentPaid - 0.10 * basicDA,
    (isMetro ? 0.50 : 0.40) * basicDA
  ));
}

/* Least-of rule for 80D across self and parents */
export function d80D(selfPrem, parentPrem, selfSenior, parentSenior){
  const c = RATES.deductionCaps;
  return Math.min(selfPrem, selfSenior ? c.s80D_selfSenior : c.s80D_self)
       + Math.min(parentPrem, parentSenior ? c.s80D_parentsSenior : c.s80D_parents);
}

export function computeRegime(i, regime){
  const R = RATES[regime];
  const isOld = regime === "old";
  const band = ageBand(i.age);
  const line = [];

  /* ---- Salary ---- */
  let salaryGross = i.salary;
  let exemptions = 0;
  if(isOld && salaryGross > 0){
    exemptions = hraExemption(i.basicDA, i.hra, i.rent, i.metro) + i.lta + i.profTax;
  }
  const stdDed = salaryGross > 0 ? R.standardDeduction : 0;
  const salaryNet = Math.max(0, salaryGross - exemptions - stdDed);

  /* ---- House property ---- */
  let hp = 0;
  if(i.hpType === "self"){
    // Self-occupied interest is allowed only under the old regime
    hp = isOld ? -Math.min(i.hpInterest, RATES.deductionCaps.selfOccupiedInterest) : 0;
  } else if(i.hpType === "letout"){
    const nav = Math.max(0, i.rentReceived - i.municipalTax);
    hp = nav - 0.30 * nav - i.hpInterest;
    // Loss from let-out property: set-off capped at 2L under both regimes
    if(hp < 0) hp = Math.max(hp, -200000);
  }

  /* ---- Business / profession ---- */
  let business = 0;
  if(i.itr === "ITR-4"){
    const digital = i.turnoverDigital * RATES.presumptive.s44AD_digital;
    const cash    = i.turnoverCash * RATES.presumptive.s44AD_cash;
    const prof    = i.receipts44ADA * RATES.presumptive.s44ADA;
    business = digital + cash + prof + i.income44AE;
  } else if(i.itr === "ITR-3"){
    business = i.businessProfit;
  }

  /* ---- Other sources ---- */
  const other = i.interestIncome + i.otherIncome;

  /* ---- Capital gains ---- */
  const stcg111A = i.stcg111A;
  const ltcg112ATaxable = Math.max(0, i.ltcg112A - RATES.special.ltcg112ARelief);
  const ltcgOther = i.ltcgOther;
  const stcgSlab = i.stcgSlab;   // taxed at normal slab rates

  const specialIncome = stcg111A + i.ltcg112A + ltcgOther;

  /* ---- Gross total income (slab-rate portion) ---- */
  const gtiSlab = salaryNet + hp + business + other + stcgSlab;

  /* ---- Chapter VI-A deductions ---- */
  const c = RATES.deductionCaps;
  let ded = 0;
  const dedLines = [];
  const push = (n,v) => { if(v>0){ dedLines.push([n,v]); ded += v; } };

  if(isOld){
    push("80C — PF, ELSS, LIC, tuition", Math.min(i.d80C, c.s80C));
    push("80CCD(1B) — NPS additional", Math.min(i.d80CCD1B, c.s80CCD1B));
    push("80D — health insurance", d80D(i.d80D_self, i.d80D_parents, i.age>=60, i.parentsSenior));
    push(i.age>=60 ? "80TTB — deposit interest" : "80TTA — savings interest",
         Math.min(i.d80TT, i.age>=60 ? c.s80TTB : c.s80TTA));
    push("80E — education loan interest", i.d80E);
    push("80G — donations", i.d80G);
    push("Other Chapter VI-A", i.dOther);
  }
  // 80CCD(2) — employer NPS — allowed under BOTH regimes
  push("80CCD(2) — employer NPS", i.d80CCD2);

  /* Chapter VI-A cannot be set off against special-rate income */
  const taxableSlab = Math.max(0, gtiSlab - ded);
  const taxableTotal = taxableSlab + specialIncome;

  /* ---- Tax ---- */
  const st = slabTax(taxableSlab, R.slabs[band]);
  const taxSlab = st.tax;
  const taxSpecial = stcg111A * RATES.special.stcg111A
                   + ltcg112ATaxable * RATES.special.ltcg112A
                   + ltcgOther * RATES.special.ltcgOther;
  const taxBefore = taxSlab + taxSpecial;

  /* ---- Rebate ----
     Not available against LTCG u/s 112A in either regime.
     Under the new regime it applies only to slab-rate tax. */
  let rebate = 0, rebateRelief = 0;
  if(taxableTotal <= R.rebate.incomeLimit){
    const rebateable = isOld
      ? taxSlab + stcg111A * RATES.special.stcg111A
      : taxSlab;
    rebate = Math.min(rebateable, R.rebate.max);
  } else if(!isOld){
    /* Marginal relief on the rebate: just above ₹12 lakh, tax on slab-rate
       income cannot exceed the amount by which income crosses ₹12 lakh.
       This is why the new regime has no cliff at ₹12 lakh. */
    const excess = taxableTotal - R.rebate.incomeLimit;
    if(taxSlab > excess){
      rebateRelief = taxSlab - excess;
      rebate = rebateRelief;
    }
  }
  const taxAfterRebate = Math.max(0, taxBefore - rebate);

  /* ---- Surcharge with marginal relief ---- */
  let surcharge = 0, reliefApplied = 0;
  const scRate = surchargeRate(taxableTotal, R.surcharge);
  if(scRate > 0 && taxAfterRebate > 0){
    const specialPortion = Math.min(taxSpecial, taxAfterRebate);
    const normalPortion = taxAfterRebate - specialPortion;
    surcharge = normalPortion * scRate
              + specialPortion * Math.min(scRate, RATES.special.surchargeCap);

    // Marginal relief at the threshold just crossed.
    // The ceiling is the tax AND surcharge payable on income exactly at the
    // threshold, plus the excess. At ₹1 crore and above the threshold itself
    // already carries surcharge, so it must be included or relief overshoots.
    const th = [...R.reliefThresholds].reverse().find(t => taxableTotal > t);
    if(th !== undefined){
      const taxAtTh = slabTax(th, R.slabs[band]).tax;
      const scAtTh  = surchargeRate(th, R.surcharge);
      const ceiling = taxAtTh * (1 + scAtTh) + (taxableTotal - th);
      if(taxAfterRebate + surcharge > ceiling){
        const relieved = Math.max(0, ceiling - taxAfterRebate);
        reliefApplied = surcharge - relieved;
        surcharge = relieved;
      }
    }
  }

  const cess = (taxAfterRebate + surcharge) * RATES.cess;
  const total = taxAfterRebate + surcharge + cess;

  /* ---- Ledger for display ---- */
  if(salaryGross > 0){
    line.push(["major","Salary / pension", salaryGross]);
    if(exemptions > 0) line.push(["sub neg","Less: HRA, LTA, professional tax", -exemptions]);
    line.push(["sub neg","Less: standard deduction", -stdDed]);
  }
  if(hp !== 0) line.push(["major", i.hpType==="self" ? "House property (self-occupied)" : "House property (let out)", hp]);
  if(business > 0) line.push(["major", i.itr==="ITR-4" ? "Business — presumptive" : "Business / profession", business]);
  if(other > 0) line.push(["major","Income from other sources", other]);
  if(stcgSlab > 0) line.push(["major","Short-term capital gains (slab)", stcgSlab]);
  line.push(["major","Gross total income (slab rate)", gtiSlab]);
  dedLines.forEach(([n,v]) => line.push(["sub neg","Less: " + n, -v]));
  line.push(["major","Taxable income (slab rate)", taxableSlab]);
  if(specialIncome > 0) line.push(["major","Add: special-rate income", specialIncome]);

  line.push(["","Tax on slab income", taxSlab]);
  if(taxSpecial > 0) line.push(["","Tax on capital gains", taxSpecial]);
  if(rebate > 0) line.push(["neg", rebateRelief > 0 ? "Less: rebate (marginal relief)" : "Less: rebate", -rebate]);
  if(surcharge > 0){
    line.push(["","Surcharge @ " + (scRate*100) + "%", surcharge]);
    if(reliefApplied > 0) line.push(["sub","(marginal relief applied)", -reliefApplied]);
  }
  line.push(["","Health & education cess @ 4%", cess]);
  line.push(["total","Total tax payable", total]);

  return {
    total, taxableSlab, taxableTotal, ded, slabRows: st.rows,
    rebate, surcharge, cess, line, band, gtiSlab, specialIncome
  };
}

/* Break-even: the old-regime deduction total at which the two regimes tie. */
export function breakEven(i){
  const newTax = computeRegime(i, "new").total;
  let lo = 0, hi = 2500000;
  /* Search on the uncapped "other deductions" field so the solver can explore
     freely, rather than hitting the ₹1.5 lakh cap on 80C. */
  const taxWith = d => computeRegime({
    ...i, d80C:0, d80CCD1B:0, d80D_self:0, d80D_parents:0, d80TT:0, d80E:0, d80G:0, dOther:d
  }, "old").total;

  if(taxWith(0) <= newTax) return { amount: 0, reachable: true };
  if(taxWith(hi) > newTax) return { amount: null, reachable: false };
  for(let k=0;k<60;k++){
    const mid = (lo+hi)/2;
    if(taxWith(mid) > newTax) lo = mid; else hi = mid;
  }
  return { amount: Math.ceil(hi/100)*100, reachable: true };
}
