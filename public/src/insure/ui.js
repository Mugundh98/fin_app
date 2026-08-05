import { ASSUMPTIONS, computePolicy, compareTermPlusIndex } from './insure-engine.js';
import { drawGuilloche } from '../shared/guilloche.js';
import { groupIndian } from '../shared/format.js';

/* ============================================================
   FORMATTING
   ============================================================ */
const fmt = n => "₹" + groupIndian(Math.abs(n));
const fmtSigned = n => (n < 0 ? "−" : "") + fmt(n);
const compact = n => {
  const a = Math.abs(n);
  /* Sign goes before the rupee symbol, not between it and the digits —
     "₹-8.07 L" reads as a typo. */
  const sign = n < 0 ? "−" : "";
  if(a >= 10000000) return sign + "₹" + (a/10000000).toFixed(2).replace(/\.00$/,"") + " Cr";
  if(a >= 100000)   return sign + "₹" + (a/100000).toFixed(2).replace(/\.00$/,"") + " L";
  return sign + fmt(a);
};
/* Two decimals: at these rates the second one is the difference between
   plans, and rounding it away would hide that. */
const rate = r => r == null ? "—" : (r < 0 ? "−" : "") + (Math.abs(r) * 100).toFixed(2) + "%";

/* ============================================================
   STATE
   ============================================================ */
const state = {
  sumAssured: 1000000,
  annualPremium: 50000,
  policyTerm: 20,
  premiumTerm: 20,
  bonusPerThousand: ASSUMPTIONS.defaultBonusPerThousand,
  fabPerThousand: 0,
  addGst: false,
  termPremium: 3000,
  indexReturnPct: ASSUMPTIONS.defaultIndexReturn * 100
};

const FIELDS = ["sumAssured","annualPremium","policyTerm","premiumTerm",
                "bonusPerThousand","fabPerThousand","termPremium","indexReturnPct"];

/* ============================================================
   RENDER
   ============================================================ */
function renderVerdict(p){
  const s = p.declared;
  const title = document.getElementById("vTitle");
  const saving = document.getElementById("vSaving");
  const eyebrow = document.querySelector(".verdict .eyebrow");

  if(p.annualPremium <= 0 || p.sumAssured <= 0){
    eyebrow.textContent = "Effective return a year";
    title.textContent = "Enter your policy";
    saving.innerHTML = "A sum assured and an annual premium are enough to start.";
    return;
  }
  if(s.irr == null){
    eyebrow.textContent = "Effective return a year";
    title.textContent = "Not enough to work with";
    saving.innerHTML = "Check the premium and maturity figures.";
    return;
  }

  eyebrow.textContent = "Effective return a year";
  title.innerHTML = `<span class="figure">${rate(s.irr)}<small>a year</small></span>`;
  saving.innerHTML =
    `Turning <b>${compact(s.totalPaid)}</b> of premiums into <b>${compact(s.maturity)}</b> over ${p.policyTerm} years. ` +
    `If no bonus is ever declared it is ${rate(p.guaranteed.irr)}.`;
}

function renderMoney(p){
  const s = p.declared;
  const rows = [
    ["major", `Premiums paid over ${p.premiumTerm} year${p.premiumTerm === 1 ? "" : "s"}`, -s.totalPaid],
    ["", "Sum assured (guaranteed)", p.sumAssured],
    ["sub", `Accrued bonus at ₹${p.bonusPerThousand} per thousand`, s.accruedBonus]
  ];
  if(s.finalBonus > 0) rows.push(["sub", "Final additional bonus", s.finalBonus]);
  rows.push(["total", "Maturity value", s.maturity]);
  rows.push(["", "Gain over what you paid", s.gain]);

  document.getElementById("moneySheet").innerHTML = rows.map(([cls, label, val]) =>
    `<tr class="${cls}${val < 0 ? " neg" : ""}"><td class="${cls.includes("sub") ? "sub" : ""}">${label}</td>
      <td class="n">${fmtSigned(val)}</td></tr>`).join("");

  document.getElementById("matNote").textContent =
    s.totalPaid > 0 ? `${(s.maturity / s.totalPaid).toFixed(2)}× what you paid` : "";

  /* What the maturity is actually made of — the guaranteed slab against the
     parts that depend on the insurer declaring a bonus. */
  const parts = [
    { k:"sa",  label:"Sum assured (guaranteed)", v: p.sumAssured },
    { k:"bon", label:"Accrued bonus",            v: s.accruedBonus },
    { k:"fab", label:"Final bonus",              v: s.finalBonus }
  ].filter(x => x.v > 0);

  const total = s.maturity || 1;
  document.getElementById("mixBar").innerHTML = parts.map(x =>
    `<i class="${x.k}" style="width:${(x.v / total * 100).toFixed(3)}%" title="${x.label} ${fmt(x.v)}"></i>`).join("");
  document.getElementById("mixLegend").innerHTML = parts.map(x =>
    `<span><i class="${x.k}"></i>${x.label}</span>`).join("");

  const guaranteedShare = s.maturity > 0 ? p.sumAssured / s.maturity : 0;
  document.getElementById("mixNote").innerHTML = s.maturity > 0
    ? `<b>${Math.round(guaranteedShare * 100)}%</b> of the maturity figure is contractually guaranteed. The rest depends on bonuses the insurer declares between now and then.`
    : "";
}

function renderScenarios(p){
  document.getElementById("scnBody").innerHTML = p.scenarios.map(s => {
    const cls = s.key === "declared" ? "scn-declared" : "";
    const rcls = s.irr == null ? "" : s.irr < 0 ? "neg" : s.irr === 0 ? "zero" : "";
    return `<tr class="${cls}">
      <td>${s.label}</td>
      <td class="n">${compact(s.maturity)}</td>
      <td class="n rate ${rcls}">${rate(s.irr)}</td></tr>`;
  }).join("");
}

function renderCover(p){
  const first = p.schedule[0];
  const mid = p.schedule[Math.floor(p.schedule.length / 2) - 1] || first;
  const last = p.schedule[p.schedule.length - 1];

  const rows = [
    ["major", "Cover per rupee of annual premium", null,
      p.coverMultiple > 0 ? p.coverMultiple.toFixed(1) + "×" : "—"],
    ["", `Death benefit in year 1`, first.deathBenefit],
    ["sub", `in year ${mid.year}`, mid.deathBenefit],
    ["sub", `in year ${last.year}`, last.deathBenefit]
  ];

  document.getElementById("coverSheet").innerHTML = rows.map(([cls, label, val, raw]) =>
    `<tr class="${cls}"><td class="${cls.includes("sub") ? "sub" : ""}">${label}</td>
      <td class="n">${raw ?? fmt(val)}</td></tr>`).join("");

  document.getElementById("yearBody").innerHTML = p.schedule.map(r =>
    `<tr><td>${r.year}</td><td class="n">${r.premium > 0 ? fmt(r.premium) : "—"}</td>
      <td class="n">${compact(r.paidToDate)}</td>
      <td class="n">${compact(r.deathBenefit)}</td></tr>`).join("");
}

function renderSticky(p){
  document.getElementById("sbMat").textContent = compact(p.declared.maturity);
  document.getElementById("sbIrr").textContent = rate(p.declared.irr);
}

/* Two accumulation paths on one axis. The endowment line is what has ACCRUED
   — sum assured plus bonus to date — not a surrender value, which is far
   lower; the caveat under the chart says so. */
const CW = 380, CH = 160, CP = { l: 4, r: 4, t: 10, b: 20 };

function comparisonChart(c){
  const rows = c.rows;
  if(rows.length < 2) return `<p class="hint">Not enough years to chart.</p>`;

  const maxV = Math.max(...rows.map(r => Math.max(r.endowmentAccrued, r.corpus)), 1);
  const minV = Math.min(0, ...rows.map(r => r.corpus));
  const innerW = CW - CP.l - CP.r, innerH = CH - CP.t - CP.b;
  const y = v => CP.t + innerH - ((v - minV) / (maxV - minV)) * innerH;
  const x = i => CP.l + (innerW / (rows.length - 1)) * i;

  const path = key => rows.map((r, i) =>
    `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(" ");

  let svg = `<svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Endowment accrued value against term plus index fund">`;
  for(let i = 0; i <= 3; i++){
    const gy = CP.t + (innerH / 3) * i;
    svg += `<line class="grid" x1="${CP.l}" y1="${gy.toFixed(1)}" x2="${CW - CP.r}" y2="${gy.toFixed(1)}"/>`;
  }
  const idxPath = path("corpus");
  svg += `<path class="area-index" d="${idxPath} L${x(rows.length - 1).toFixed(1)},${y(Math.max(0, minV)).toFixed(1)} L${x(0).toFixed(1)},${y(Math.max(0, minV)).toFixed(1)} Z"/>`;
  svg += `<path class="line-endow" d="${path("endowmentAccrued")}"/>`;
  svg += `<path class="line-index" d="${idxPath}"/>`;

  if(c.crossover){
    const cx = x(c.crossover - 1);
    svg += `<line class="cross" x1="${cx.toFixed(1)}" y1="${CP.t}" x2="${cx.toFixed(1)}" y2="${CP.t + innerH}"/>`;
    svg += `<text class="axis" x="${cx.toFixed(1)}" y="${CP.t - 2}" text-anchor="middle">year ${c.crossover}</text>`;
  }
  svg += `<text class="axis" x="${CP.l}" y="${CH - 6}" text-anchor="start">year 1</text>`;
  svg += `<text class="axis" x="${CW - CP.r}" y="${CH - 6}" text-anchor="end">year ${rows.length}</text>`;
  return svg + `</svg>`;
}

function renderComparison(p){
  const c = compareTermPlusIndex(p, {
    termPremium: state.termPremium,
    indexReturn: state.indexReturnPct / 100
  });

  document.getElementById("coverEcho").textContent = groupIndian(p.sumAssured);

  const ahead = c.gap >= 0;
  document.getElementById("cmpTiles").innerHTML = [
    ["Endowment", compact(c.endowmentMaturity), ""],
    ["Term + index", compact(c.corpus), ahead ? "ahead" : "behind"],
    [ahead ? "Ahead by" : "Behind by", compact(Math.abs(c.gap)), ahead ? "ahead" : "behind"]
  ].map(([k, v, cls]) => `<div class="${cls}"><span>${k}</span><b>${v}</b></div>`).join("");

  document.getElementById("cmpNote").textContent =
    `${state.indexReturnPct}% assumed · same outlay`;
  document.getElementById("cmpChart").innerHTML = comparisonChart(c);

  const last = c.rows[c.rows.length - 1];
  document.getElementById("cmpBody").innerHTML = [
    `<tr class="major"><td>Out of pocket, either route</td><td class="n">${fmt(c.endowmentOutlayTotal)}</td></tr>`,
    `<tr><td class="sub">of which term cover</td><td class="n">${fmt(c.termOutlayTotal)}</td></tr>`,
    `<tr><td class="sub">of which invested</td><td class="n">${fmt(c.invested)}</td></tr>`,
    `<tr class="major"><td>On death in the final year</td><td class="n"></td></tr>`,
    `<tr><td class="sub">endowment pays</td><td class="n">${fmt(last.endowmentDeath)}</td></tr>`,
    `<tr><td class="sub">term + fund pays</td><td class="n">${fmt(last.termDeath)}</td></tr>`,
    `<tr class="total"><td>At maturity, difference</td><td class="n">${(ahead ? "+" : "−") + fmt(Math.abs(c.gap))}</td></tr>`
  ].join("");

  const bits = [];
  if(c.noHeadroom){
    bits.push(`The term premium you entered is <b>at or above</b> the endowment premium, so there is nothing left to invest — check the quote.`);
  } else if(c.crossover){
    bits.push(`The invested pot passes the endowment's accrued value in <b>year ${c.crossover}</b>.`);
  } else {
    bits.push(`At <b>${state.indexReturnPct}%</b> the invested pot never overtakes the endowment.`);
  }
  bits.push(`This weighs an <b>assumption against a contract</b>: the sum assured is promised, the ${state.indexReturnPct}% is not. The endowment line is what has accrued, not what surrendering early would pay — that is usually far less. Neither line is adjusted for tax.`);
  document.getElementById("cmpCaveat").innerHTML = bits.join(" ");
}

function recalc(){
  const p = computePolicy(state);
  /* The engine clamps the paying term to the policy term; reflect that back
     into the field so the form never disagrees with the result. */
  const pt = document.getElementById("premiumTerm");
  if(Number(pt.value) !== p.premiumTerm && document.activeElement !== pt){
    pt.value = p.premiumTerm;
    state.premiumTerm = p.premiumTerm;
  }
  renderVerdict(p);
  renderMoney(p);
  renderScenarios(p);
  renderCover(p);
  renderComparison(p);
  renderSticky(p);
}

/* ============================================================
   WIRING
   ============================================================ */
for(const id of FIELDS){
  const el = document.getElementById(id);
  el.value = state[id];
  el.addEventListener("input", () => { state[id] = Number(el.value) || 0; recalc(); });
}

document.querySelectorAll("[data-gst]").forEach(btn => btn.addEventListener("click", () => {
  state.addGst = btn.dataset.gst === "1";
  document.querySelectorAll("[data-gst]").forEach(b =>
    b.setAttribute("aria-pressed", String((b.dataset.gst === "1") === state.addGst)));
  recalc();
}));

/* The unbuilt plan types are visible for scope, but must not act like tabs. */
document.querySelectorAll('.formtab[aria-disabled="true"]').forEach(b =>
  b.addEventListener("click", e => e.preventDefault()));

drawGuilloche(document.getElementById("guilloche"));
recalc();
