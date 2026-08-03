import { ASSUMPTIONS, computePolicy } from './insure-engine.js';
import { drawGuilloche } from '../shared/guilloche.js';

/* ============================================================
   FORMATTING
   ============================================================ */
const fmt = n => "₹" + Math.round(Math.abs(n)).toLocaleString("en-IN");
const fmtSigned = n => (n < 0 ? "−" : "") + fmt(n);
const compact = n => {
  const a = Math.abs(n);
  if(a >= 10000000) return "₹" + (n/10000000).toFixed(2).replace(/\.00$/,"") + " Cr";
  if(a >= 100000)   return "₹" + (n/100000).toFixed(2).replace(/\.00$/,"") + " L";
  return fmt(n);
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
  addGst: false
};

const FIELDS = ["sumAssured","annualPremium","policyTerm","premiumTerm",
                "bonusPerThousand","fabPerThousand"];

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
