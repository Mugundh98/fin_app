/* Investment engine — pure functions, no DOM, no framework.
   Same contract as tax-engine.js: imports nothing, touches no DOM, so it
   runs in Node for testing and ports unchanged.

   Informational only. This computes arithmetic on assumptions the user can
   see and change. It does not select, rank or recommend any investment
   product, and deliberately has no concept of one — asset classes only. */

/* ============================================================
   ASSUMPTIONS — the only place to edit when you revise the model.
   ============================================================ */

/* Horizon drives the asset mix, and the asset mix drives the return.
   Return is never a free field: it is derived from `years`.
   Bands are [previous, maxYears) — maxYears is exclusive. */
const BANDS = [
  { key:"debt", maxYears:3, mix:"Debt",
    detail:"Short-duration debt and liquid instruments",
    equity:"~0% equity",
    poor:.055, expected:.065, good:.075 },

  { key:"hybrid", maxYears:5, mix:"Hybrid",
    detail:"Balanced mix of equity and debt",
    equity:"~40% equity",
    poor:.07, expected:.09, good:.11 },

  { key:"equityTilted", maxYears:10, mix:"Equity-tilted",
    detail:"Majority equity with a debt cushion",
    equity:"~70% equity",
    poor:.08, expected:.11, good:.14 },

  { key:"equity", maxYears:Infinity, mix:"Equity",
    detail:"Predominantly equity",
    equity:"~90% equity",
    poor:.085, expected:.12, good:.155 }
];

/* An emergency fund is held liquid and assumed not to grow. It ignores the
   horizon bands entirely — the point of the money is availability, not return. */
const LIQUID_BAND = {
  key:"liquid", maxYears:Infinity, mix:"Liquid",
  detail:"Held available, assumed not to grow",
  equity:"no equity",
  poor:0, expected:0, good:0
};

export const ASSUMPTIONS = {
  label: "Horizon-linked assumptions",
  generalInflation: .06,
  bands: BANDS,
  liquidBand: LIQUID_BAND,
  scenarioKeys: ["poor","expected","good"],
  scenarioLabels: { poor:"Poor", expected:"Expected", good:"Good" },
  goals: {
    retirement: { label:"Retirement",        inflation:.06,
      note:"The cost of the life you want to fund, in today's money." },
    education:  { label:"Child's education", inflation:.10,
      note:"Education costs have historically run well above general inflation." },
    marriage:   { label:"Child's marriage",  inflation:.07,
      note:"Priced off gold, venues and catering rather than the general index." },
    homeDown:   { label:"Home down payment", inflation:.06,
      note:"The down payment portion only, not the full property price." },
    emergency:  { label:"Emergency fund",    inflation:.06, liquid:true,
      note:"Held liquid so it is there on the day you need it. Assumed not to grow." },
    wealth:     { label:"Wealth creation",   inflation:.06,
      note:"No fixed end date — a corpus target you are building toward." }
  }
};

/* ============================================================
   CORE MATHS
   ============================================================ */

/* Effective monthly rate, so that (1 + monthlyRate(r))^12 === 1 + r exactly.
   Deliberately NOT r/12: the band returns are quoted as annual compound
   figures, and r/12 would silently inflate 12% into 12.68% effective. */
export function monthlyRate(annual){
  return Math.pow(1 + annual, 1/12) - 1;
}

export function bandFor(years){
  for(const b of BANDS) if(years < b.maxYears) return b;
  return BANDS[BANDS.length - 1];
}

/* Today's money -> the same purchasing power at the goal date. */
export function futureCost(todayAmount, inflation, years){
  return todayAmount * Math.pow(1 + inflation, years);
}

/* Month-by-month SIP simulation.
   Contributions land at the END of each month (ordinary annuity), so a
   month's payment earns no return in the month it is made. This is the
   conservative reading and keeps the arithmetic easy to audit.
   The SIP amount steps up once every 12 months, at the year boundary. */
export function sipSchedule(monthly, years, annualReturn, stepUp = 0){
  const i = monthlyRate(annualReturn);
  const months = Math.round(years * 12);
  let fv = 0, amount = monthly, invested = 0;
  for(let m = 0; m < months; m++){
    if(m > 0 && m % 12 === 0) amount *= (1 + stepUp);
    fv = fv * (1 + i) + amount;
    invested += amount;
  }
  return { fv, invested, growth: fv - invested, finalMonthly: amount, months };
}

export function sipFutureValue(monthly, years, annualReturn, stepUp = 0){
  return sipSchedule(monthly, years, annualReturn, stepUp).fv;
}

/* Future value scales linearly with the opening SIP amount, so the inverse
   needs no solver — divide the gap by the future value of a ₹1 SIP. */
export function requiredSip(gap, years, annualReturn, stepUp = 0){
  if(gap <= 0) return 0;
  const unit = sipFutureValue(1, years, annualReturn, stepUp);
  return unit > 0 ? gap / unit : 0;
}

/* ============================================================
   PLAN
   ============================================================ */

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/* Resolve the return set for a horizon, honouring the liquid override. */
export function ratesFor(years, goalKey){
  const goal = ASSUMPTIONS.goals[goalKey];
  const band = goal && goal.liquid ? LIQUID_BAND : bandFor(years);
  return { band, poor: band.poor, expected: band.expected, good: band.good };
}

export function defaultInflation(goalKey){
  const goal = ASSUMPTIONS.goals[goalKey];
  return goal ? goal.inflation : ASSUMPTIONS.generalInflation;
}

/* Both directions are computed for every scenario:
     requiredSip  — "I need ₹X in N years, what monthly SIP?"
     projected    — "I can invest ₹Y a month, where do I land?"
   The UI shows whichever the user asked for; the other is free. */
export function computePlan(input){
  const goalKey = ASSUMPTIONS.goals[input.goal] ? input.goal : "wealth";
  const goalDef = ASSUMPTIONS.goals[goalKey];

  const years        = Math.max(1, Math.round(num(input.years, 1)));
  const targetToday  = Math.max(0, num(input.targetToday));
  const alreadySaved = Math.max(0, num(input.alreadySaved));
  const monthlyBudget= Math.max(0, num(input.monthlyBudget));
  const stepUp       = Math.max(0, num(input.stepUp));
  const inflation    = Number.isFinite(input.inflation)
    ? Math.max(0, input.inflation)
    : defaultInflation(goalKey);

  const rates = ratesFor(years, goalKey);
  const futureTarget = futureCost(targetToday, inflation, years);

  const scenarios = ASSUMPTIONS.scenarioKeys.map(key => {
    const rate = rates[key];

    const existingFV = alreadySaved * Math.pow(1 + rate, years);
    const gap = Math.max(0, futureTarget - existingFV);

    const sip = requiredSip(gap, years, rate, stepUp);
    const reqPlan = sipSchedule(sip, years, rate, stepUp);

    const budgetPlan = sipSchedule(monthlyBudget, years, rate, stepUp);
    const projected = existingFV + budgetPlan.fv;

    return {
      key, label: ASSUMPTIONS.scenarioLabels[key], rate,
      existingFV, gap,
      /* direction A — target first */
      requiredSip: sip,
      requiredInvested: reqPlan.invested,
      requiredGrowth: reqPlan.growth,
      requiredFinalMonthly: reqPlan.finalMonthly,
      /* direction B — budget first */
      projected,
      projectedInvested: budgetPlan.invested,
      projectedGrowth: budgetPlan.growth,
      shortfall: Math.max(0, futureTarget - projected),
      surplus: Math.max(0, projected - futureTarget),
      pctFunded: futureTarget > 0 ? (projected / futureTarget) * 100 : 100
    };
  });

  const byKey = Object.fromEntries(scenarios.map(s => [s.key, s]));

  return {
    goalKey, goalLabel: goalDef.label, goalNote: goalDef.note,
    liquid: !!goalDef.liquid,
    years, inflation, stepUp,
    band: rates.band,
    targetToday, futureTarget,
    inflationUplift: futureTarget - targetToday,
    alreadySaved, monthlyBudget,
    scenarios, byKey,
    expected: byKey.expected,
    alreadyFunded: byKey.expected.gap <= 0
  };
}
