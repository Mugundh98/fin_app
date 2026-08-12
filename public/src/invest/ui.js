import { ASSUMPTIONS, computePlan, defaultInflation, sipSchedule } from './invest-engine.js';
import { drawGuilloche } from '../shared/guilloche.js';
import { groupIndian, digitsOnly, amountInWords, monthsBetween, describeMonths }
  from '../shared/format.js';
import { loadState, saveSoon, flush } from '../shared/store.js';

/* ============================================================
   FORMATTING
   ============================================================ */
const fmt = n => "₹" + groupIndian(Math.abs(n));
const fmtSigned = n => (n < 0 ? "−" : "") + fmt(n);
const compact = n => {
  const a = Math.abs(n);
  if(a >= 10000000) return "₹" + (n/10000000).toFixed(2).replace(/\.00$/,"") + " Cr";
  if(a >= 100000)   return "₹" + (n/100000).toFixed(2).replace(/\.00$/,"") + " L";
  return fmt(n);
};
const pct = n => (Math.round(n * 1000) / 10) + "%";
/* A fraction as a percentage NUMBER for a form field. Rounded, because
   0.07 * 100 is 7.000000000000001 and that is what the user would see. */
const pctOf = f => Math.round(f * 10000) / 100;
/* Required instalments are rounded UP to the next ₹100 — rounding down would
   quietly land the plan short of its target. */
const sipRound = n => Math.ceil(n / 100) * 100;

/* ============================================================
   STATE
   ============================================================ */
/* Today and a default target date, as YYYY-MM-DD in local terms. Only used to
   seed the form — every calculation goes through monthsBetween. */
const isoToday = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
};
const isoPlusYears = n => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
};

const state = {
  goal: "retirement",
  targetToday: 10000000,
  years: 25,
  startDate: isoToday(),
  endDate: isoPlusYears(3),
  alreadySaved: 0,
  inflationPct: pctOf(defaultInflation("retirement")),
  stepUpPct: 0,
  mode: "target",          // "target" = solve for SIP | "budget" = test an amount
  monthlyBudget: 20000
};

/* Restore whatever was last entered on this machine. loadState keeps only
   keys declared above, and only where the type still matches, so a stored
   value from an older build cannot reach the engine. */
Object.assign(state, loadState("invest", { ...state }));

const isDated = () => !!ASSUMPTIONS.goals[state.goal]?.dated;
const datesInvalid = () => isDated() && monthsBetween(state.startDate, state.endDate) <= 0;

const plan = () => computePlan({
  goal: state.goal,
  targetToday: state.targetToday,
  /* A dated goal derives its horizon from the two dates; everything else
     still takes a plain number of years. */
  years: state.years,
  months: isDated() ? monthsBetween(state.startDate, state.endDate) : undefined,
  alreadySaved: state.alreadySaved,
  monthlyBudget: state.monthlyBudget,
  inflation: state.inflationPct / 100,
  stepUp: state.stepUpPct / 100
});

/* ============================================================
   FORM
   ============================================================ */
/* Plain numeric row — percentages, years. */
function row(key, label, sub){
  return `<div class="row">
    <label for="${key}">${label}${sub ? `<small>${sub}</small>` : ""}</label>
    <input class="inp" type="number" id="${key}" value="${state[key]}" min="0" step="any">
  </div>`;
}

const wordsFor = n => n > 0 ? "₹" + amountInWords(n) : "";

/* Money row. A rupee figure with six or seven zeroes is unreadable as a bare
   string of digits, so the field groups as you type and spells the amount out
   underneath — the two together make a mistyped zero obvious at a glance.
   type=text, because a number input will not accept the commas. */
function money(key, label, sub){
  return `<div class="row">
    <label for="${key}">${label}${sub ? `<small>${sub}</small>` : ""}</label>
    <input class="inp" type="text" inputmode="numeric" autocomplete="off"
      id="${key}" data-money value="${groupIndian(state[key])}">
  </div>
  <p class="words" id="${key}-words">${wordsFor(state[key])}</p>`;
}

function dateRow(key, label, sub){
  return `<div class="row">
    <label for="${key}">${label}${sub ? `<small>${sub}</small>` : ""}</label>
    <input class="inp date" type="date" id="${key}" data-date value="${state[key]}">
  </div>`;
}

function buildTabs(){
  document.getElementById("formbar").innerHTML = Object.entries(ASSUMPTIONS.goals).map(([k, g]) =>
    `<button class="formtab" role="tab" data-goal="${k}" aria-selected="${state.goal === k}">
      <b>${g.label}</b><small>${g.liquid ? "Liquid" : "Inflation " + pct(g.inflation)}</small></button>`
  ).join("");
  document.querySelectorAll("[data-goal]").forEach(b =>
    b.addEventListener("click", () => {
      state.goal = b.dataset.goal;
      /* Switching goal resets inflation to that goal's default. Override it
         afterwards if you disagree — the field stays editable. */
      state.inflationPct = pctOf(defaultInflation(state.goal));
      buildTabs(); buildForm();
    })
  );
}

function buildForm(){
  const g = ASSUMPTIONS.goals[state.goal];
  document.getElementById("scopeNote").innerHTML =
    `<b>${g.label}.</b> ${g.note} Enter the amount in <b>today's money</b> — the cost at the goal date is worked out for you.`;

  const budgetMode = state.mode === "budget";

  let html = `<section class="panel"><h2>The goal</h2><div class="panel-body">
    ${money("targetToday", "Target amount", "In today's money, at today's prices")}
    ${g.dated
      ? dateRow("startDate", "Start date", "When you begin putting money aside") +
        dateRow("endDate", "Target date", "When you need the money in hand") +
        `<p class="horizon" id="horizonNote"></p>`
      : row("years", "Years until you need it", "This alone sets the asset mix and the return")}
  </div></section>`;

  html += `<section class="panel"><h2>What you already have</h2><div class="panel-body">
    ${money("alreadySaved", "Amount already saved for this goal", "Grows at the same return as the plan")}
  </div></section>`;

  html += `<section class="panel"><h2>Assumptions <em>Change any of these</em></h2><div class="panel-body">
    ${row("inflationPct", "Inflation on this goal", `Default for ${g.label.toLowerCase()} is ${pct(g.inflation)} a year`)}
    ${row("stepUpPct", "Annual SIP step-up", "Raise the instalment by this much every 12 months")}
    <p class="hint">A step-up of 0% assumes you never increase the instalment. If your SIP will rise with your income, put that number here — it lowers the amount you need to start with.</p>
    <div class="subhead">Derived from your horizon</div>
    <div class="derived" id="derived"></div>
  </div></section>`;

  html += `<section class="panel"><h2>What do you want to work out?</h2><div class="panel-body">
    <div class="row">
      <label>Direction<small>Solve for the instalment, or test one you have in mind</small></label>
      <div class="seg">
        <button type="button" data-mode="target" aria-pressed="${!budgetMode}">Find SIP</button>
        <button type="button" data-mode="budget" aria-pressed="${budgetMode}">Test amount</button>
      </div>
    </div>
    ${budgetMode
      ? money("monthlyBudget", "Amount you can invest monthly", "The opening instalment, before any step-up")
      : `<p class="hint">Switch to <b>Test amount</b> to enter a monthly figure you can manage and see how far it gets you.</p>`}
  </div></section>`;

  document.getElementById("inputs").innerHTML = html;
  wire();
  recalc();
}

/* Regroup a money field in place, keeping the caret where the typist left it.
   The caret is tracked by how many DIGITS precede it, not by character
   offset, so inserting a comma cannot make it drift. */
function regroup(el){
  const digitsBefore = digitsOnly(el.value.slice(0, el.selectionStart)).length;
  const digits = digitsOnly(el.value);
  const n = digits ? Number(digits) : 0;
  el.value = digits ? groupIndian(n) : "";

  let seen = 0, pos = digitsBefore === 0 ? 0 : el.value.length;
  if(digitsBefore > 0){
    for(let i = 0; i < el.value.length; i++){
      if(el.value[i] >= "0" && el.value[i] <= "9" && ++seen === digitsBefore){ pos = i + 1; break; }
    }
  }
  el.setSelectionRange(pos, pos);
  return n;
}

function wire(){
  document.querySelectorAll("#inputs input[type=number]").forEach(el => {
    el.addEventListener("input", () => {
      state[el.id] = Number(el.value) || 0;
      recalc();
    });
  });
  document.querySelectorAll("#inputs input[data-money]").forEach(el => {
    el.addEventListener("input", () => {
      state[el.id] = regroup(el);
      const words = document.getElementById(el.id + "-words");
      if(words) words.textContent = wordsFor(state[el.id]);
      recalc();
    });
  });
  document.querySelectorAll("#inputs input[data-date]").forEach(el => {
    el.addEventListener("input", () => { state[el.id] = el.value; recalc(); });
  });
  document.querySelectorAll("[data-mode]").forEach(btn => {
    btn.addEventListener("click", () => { state.mode = btn.dataset.mode; buildForm(); });
  });
}

/* ============================================================
   RENDER
   ============================================================ */
function renderDerived(p){
  const r = p.band;
  document.getElementById("derived").innerHTML = `
    <p class="eyebrow">${describeMonths(p.months)} &rarr; asset mix &rarr; return</p>
    <p class="mix">${r.mix}<span class="pill">${r.equity}</span></p>
    <p class="detail">${r.detail}. ${p.liquid
      ? "Availability is the point, so no growth is assumed."
      : "The return below follows from this mix, not from anything you typed."}</p>
    <div class="rates">
      ${p.scenarios.map(s =>
        `<div class="${s.key === "expected" ? "exp" : ""}"><span>${s.label}</span><b>${pct(s.rate)}</b></div>`
      ).join("")}
    </div>`;
}

function renderCost(p){
  const rows = [
    ["major", "Target in today's money", p.targetToday],
    ["sub", `Add: ${pct(p.inflation)} inflation over ${describeMonths(p.months)}`, p.inflationUplift],
    ["total", `What it costs in ${describeMonths(p.months)}`, p.futureTarget]
  ];
  if(p.alreadySaved > 0){
    rows.push(["neg sub", "Less: your savings grow to", -p.expected.existingFV]);
    rows.push(["total", "Still to be funded", p.expected.gap]);
  }
  document.getElementById("costSheet").innerHTML = rows.map(([cls, label, val]) =>
    `<tr class="${cls}"><td class="${cls.includes("sub") ? "sub" : ""}">${label}</td>
      <td class="n">${fmtSigned(val)}</td></tr>`
  ).join("");
  document.getElementById("costNote").textContent =
    p.inflation > 0 ? `${pct(p.inflation)} a year` : "no inflation assumed";
}

function renderScenarios(p){
  const budgetMode = state.mode === "budget";
  document.getElementById("scnHead").innerHTML = budgetMode
    ? `<th>Scenario</th><th class="n">Return</th><th class="n">You reach</th><th class="n">Short by</th>`
    : `<th>Scenario</th><th class="n">Return</th><th class="n">Monthly SIP</th>`;

  document.getElementById("scnBody").innerHTML = p.scenarios.map(s => {
    const cls = s.key === "expected" ? "scn-exp" : "";
    return budgetMode
      ? `<tr class="${cls}"><td>${s.label}</td><td class="n rate">${pct(s.rate)}</td>
         <td class="n">${compact(s.projected)}</td>
         <td class="n">${s.shortfall > 0 ? compact(s.shortfall) : "—"}</td></tr>`
      : `<tr class="${cls}"><td>${s.label}</td><td class="n rate">${pct(s.rate)}</td>
         <td class="n">${s.requiredSip > 0 ? fmt(sipRound(s.requiredSip)) : "—"}</td></tr>`;
  }).join("");
}

function renderGauge(p){
  const panel = document.getElementById("gaugePanel");
  if(state.mode !== "budget"){ panel.hidden = true; return; }
  panel.hidden = false;

  const s = p.expected;
  const capped = Math.max(0, Math.min(100, s.pctFunded));
  const fill = document.getElementById("gaugeFill");
  fill.style.width = capped + "%";
  fill.classList.toggle("short", s.shortfall > 0);

  document.getElementById("gaugeNote").textContent = "Expected return";
  document.getElementById("gaugeLeft").innerHTML =
    `Reaches <b>${compact(s.projected)}</b> of <b>${compact(p.futureTarget)}</b>`;
  document.getElementById("gaugeRight").innerHTML =
    `<b>${Math.round(s.pctFunded)}%</b> funded`;
}

function renderSplit(p){
  const s = p.expected;
  const budgetMode = state.mode === "budget";
  const monthly = budgetMode ? p.monthlyBudget : sipRound(s.requiredSip);

  /* Re-run the schedule from the instalment actually shown. The headline
     figure is rounded up to the next ₹100, so reusing the unrounded solve
     here would leave the rows failing to multiply out. */
  const sched = sipSchedule(monthly, p.years, s.rate, p.stepUp);

  const rows = [
    ["major", "Opening monthly instalment", monthly]
  ];
  if(p.stepUp > 0){
    rows.push(["sub", `Final instalment after ${pct(p.stepUp)} step-up`, sched.finalMonthly]);
  }
  rows.push(["", `Total you put in over ${describeMonths(p.months)}`, sched.invested]);
  rows.push(["", "Growth on it", sched.growth]);
  if(p.alreadySaved > 0) rows.push(["", "Existing savings grow to", s.existingFV]);
  rows.push(["total", "Corpus at the goal date",
    sched.fv + (p.alreadySaved > 0 ? s.existingFV : 0)]);

  document.getElementById("splitSheet").innerHTML = rows.map(([cls, label, val]) =>
    `<tr class="${cls}"><td class="${cls.includes("sub") ? "sub" : ""}">${label}</td>
      <td class="n">${fmt(val)}</td></tr>`
  ).join("");
}

function renderVerdict(p){
  const s = p.expected;
  const eyebrow = document.getElementById("vEyebrow");
  const title = document.getElementById("vTitle");
  const saving = document.getElementById("vSaving");

  if(p.targetToday <= 0){
    eyebrow.textContent = "Monthly investment needed";
    title.textContent = "Enter your target";
    saving.innerHTML = "";
    return;
  }

  /* The engine floors the horizon at one month, so an end date on or before
     the start would still yield a figure — an enormous one. Better to say the
     dates are wrong than to answer a question that was not asked. */
  if(datesInvalid()){
    eyebrow.textContent = "Monthly investment needed";
    title.textContent = "Check the dates";
    saving.innerHTML = "The target date needs to be at least a month after the start date.";
    return;
  }

  if(state.mode === "budget"){
    eyebrow.textContent = "Testing " + fmt(p.monthlyBudget) + " a month";
    if(s.shortfall <= 0){
      title.textContent = "On track";
      saving.innerHTML = `Ahead of the goal by <b>${compact(s.surplus)}</b> on the expected return. Poor case reaches ${compact(p.byKey.poor.projected)}.`;
    } else {
      title.innerHTML = `${Math.round(s.pctFunded)}% of the way there`;
      saving.innerHTML = `Short by <b>${compact(s.shortfall)}</b>. Closing it needs about <b>${fmt(sipRound(s.requiredSip))}</b> a month instead.`;
    }
    return;
  }

  eyebrow.textContent = "Monthly investment needed";
  if(p.alreadyFunded){
    title.textContent = "Already funded";
    saving.innerHTML = `What you have saved already grows to <b>${compact(s.existingFV)}</b>, past the ${compact(p.futureTarget)} you need.`;
    return;
  }
  title.innerHTML = `<span class="figure">${fmt(sipRound(s.requiredSip))}<small>/month</small></span>`;
  saving.innerHTML = p.liquid
    ? `Set aside every month for ${describeMonths(p.months)}. No growth assumed — this money is held available.`
    : `On the expected return. A poor run needs <b>${fmt(sipRound(p.byKey.poor.requiredSip))}</b>, a good one <b>${fmt(sipRound(p.byKey.good.requiredSip))}</b>.`;
}

function renderSticky(p){
  const s = p.expected;
  const budgetMode = state.mode === "budget";
  if(datesInvalid()){
    document.getElementById("sbALabel").textContent = "Monthly SIP";
    document.getElementById("sbAVal").textContent = "—";
    document.getElementById("sbBLabel").textContent = "Future cost";
    document.getElementById("sbBVal").textContent = "—";
    return;
  }
  document.getElementById("sbALabel").textContent = budgetMode ? "You reach" : "Monthly SIP";
  document.getElementById("sbAVal").textContent = budgetMode
    ? compact(s.projected) : fmt(sipRound(s.requiredSip));
  document.getElementById("sbBLabel").textContent = budgetMode ? "Short by" : "Future cost";
  document.getElementById("sbBVal").textContent = budgetMode
    ? (s.shortfall > 0 ? compact(s.shortfall) : "On track") : compact(p.futureTarget);
}

/* Dated goals only: spell out what the two dates came to, and say so plainly
   when they do not describe a horizon at all. */
function renderHorizon(p){
  const el = document.getElementById("horizonNote");
  if(!el) return;
  const raw = monthsBetween(state.startDate, state.endDate);
  if(raw <= 0){
    el.className = "horizon bad";
    el.textContent = "The target date needs to be at least a month after the start date.";
    return;
  }
  el.className = "horizon";
  el.innerHTML = `That is <b>${describeMonths(raw)}</b> to save — ${p.band.mix.toLowerCase()} territory.`;
}

function recalc(){
  const p = plan();
  /* Debounced, so typing a figure does not write on every keystroke. */
  saveSoon("invest", () => ({ ...state }));
  renderHorizon(p);
  renderDerived(p);
  renderVerdict(p);
  renderCost(p);
  renderGauge(p);
  renderScenarios(p);
  renderSplit(p);
  renderSticky(p);
}

/* A debounced write with time still on the clock would be lost when the tab
   closes. Commit it instead. */
addEventListener("pagehide", flush);

drawGuilloche(document.getElementById("guilloche"));

buildTabs();
buildForm();
