import { RATES, slabTax, surchargeRate, ageBand, hraExemption, d80D, computeRegime, breakEven } from './tax-engine.js';
import { drawGuilloche } from '../shared/guilloche.js';

/* ============================================================
   FORM DEFINITIONS
   ============================================================ */
const FORMS = {
  "ITR-1": {
    name:"ITR-1", sub:"Sahaj",
    note:"<b>ITR-1 (Sahaj)</b> — resident individuals with total income up to ₹50 lakh from salary or pension, one house property, other sources, and listed-equity LTCG up to ₹1.25 lakh. Not available if you are a company director, hold unlisted shares, have foreign income or assets, or carry losses forward.",
    heads:["salary","house","other","cg112Aonly"]
  },
  "ITR-2": {
    name:"ITR-2", sub:"Capital gains",
    note:"<b>ITR-2</b> — individuals and HUFs with any income except business or professional income. Use this when capital gains, more than one house property, or foreign income put you outside ITR-1.",
    heads:["salary","house","other","cgFull"]
  },
  "ITR-3": {
    name:"ITR-3", sub:"Business",
    note:"<b>ITR-3</b> — individuals and HUFs carrying on a business or profession with regular books of account. Enter your net profit after business expenses; this calculator does not compute the profit itself.",
    heads:["salary","house","other","cgFull","business"]
  },
  "ITR-4": {
    name:"ITR-4", sub:"Sugam",
    note:"<b>ITR-4 (Sugam)</b> — residents declaring business or professional income on a presumptive basis under 44AD, 44ADA or 44AE, with total income up to ₹50 lakh. Presumptive income is computed for you below.",
    heads:["salary","house","other","cg112Aonly","presumptive"]
  }
};

let state = {
  itr:"ITR-1", age:30, metro:true, parentsSenior:false, hpType:"none",
  salary:1200000, basicDA:600000, hra:240000, rent:240000, lta:0, profTax:2500,
  hpInterest:0, rentReceived:0, municipalTax:0,
  businessProfit:0, turnoverDigital:0, turnoverCash:0, receipts44ADA:0, income44AE:0,
  interestIncome:0, otherIncome:0,
  stcg111A:0, ltcg112A:0, ltcgOther:0, stcgSlab:0,
  d80C:0, d80CCD1B:0, d80CCD2:0, d80D_self:0, d80D_parents:0, d80TT:0, d80E:0, d80G:0, dOther:0
};

/* ============================================================
   RENDERING
   ============================================================ */
const fmt = n => "₹" + Math.round(Math.abs(n)).toLocaleString("en-IN");
const fmtSigned = n => (n < 0 ? "−" : "") + fmt(n);
const lakhs = n => n >= 10000000 ? (n/10000000).toFixed(2).replace(/\.00$/,"") + " Cr"
                 : n >= 100000 ? (n/100000).toFixed(2).replace(/\.00$/,"") + " L" : Math.round(n).toLocaleString("en-IN");

function money(key,label,sub){
  return `<div class="row"><label for="${key}">${label}${sub?`<small>${sub}</small>`:""}</label>
    <input class="inp" type="number" min="0" step="1000" id="${key}" value="${state[key]}"></div>`;
}

function buildForm(){
  const f = FORMS[state.itr];
  document.getElementById("scopeNote").innerHTML = f.note;
  const h = f.heads;
  let html = "";

  /* Personal */
  html += `<section class="panel"><h2>You</h2><div class="panel-body">
    <div class="row"><label for="age">Age on 31 March 2026<small>Old regime gives seniors a higher exemption limit</small></label>
      <input class="inp" type="number" min="0" max="120" id="age" value="${state.age}"></div>
  </div></section>`;

  /* Salary */
  if(h.includes("salary")){
    html += `<section class="panel"><h2>Salary <em>Standard deduction is applied automatically</em></h2><div class="panel-body">
      ${money("salary","Gross salary","Before any exemption or deduction")}
      <div class="subhead">House rent allowance <span style="text-transform:none;letter-spacing:0;font-weight:400">— old regime only</span></div>
      ${money("basicDA","Basic + dearness allowance")}
      ${money("hra","HRA received")}
      ${money("rent","Annual rent paid")}
      <div class="row"><label>City<small>Metro means Delhi, Mumbai, Kolkata or Chennai</small></label>
        <div class="seg"><button type="button" data-toggle="metro" data-val="1" aria-pressed="${state.metro}">Metro</button>
        <button type="button" data-toggle="metro" data-val="0" aria-pressed="${!state.metro}">Other</button></div></div>
      <p class="calc-out" id="hraOut"></p>
      ${money("lta","Leave travel allowance claimed")}
      ${money("profTax","Professional tax paid")}
    </div></section>`;
  }

  /* House property */
  if(h.includes("house")){
    html += `<section class="panel"><h2>House property</h2><div class="panel-body">
      <div class="row"><label>Property</label>
        <div class="seg">
          <button type="button" data-hp="none" aria-pressed="${state.hpType==="none"}">None</button>
          <button type="button" data-hp="self" aria-pressed="${state.hpType==="self"}">Self-occupied</button>
          <button type="button" data-hp="letout" aria-pressed="${state.hpType==="letout"}">Let out</button>
        </div></div>
      <div id="hpFields">
        ${state.hpType!=="none" ? money("hpInterest","Home loan interest paid","Self-occupied: capped at ₹2 lakh, old regime only") : ""}
        ${state.hpType==="letout" ? money("rentReceived","Annual rent received") + money("municipalTax","Municipal taxes paid") : ""}
      </div>
    </div></section>`;
  }

  /* Business */
  if(h.includes("business")){
    html += `<section class="panel"><h2>Business or profession <em>Net profit as per books</em></h2><div class="panel-body">
      ${money("businessProfit","Net profit","After all allowable business expenses and depreciation")}
    </div></section>`;
  }

  /* Presumptive */
  if(h.includes("presumptive")){
    html += `<section class="panel"><h2>Presumptive income <em>44AD · 44ADA · 44AE</em></h2><div class="panel-body">
      <div class="subhead">44AD — business</div>
      ${money("turnoverDigital","Turnover received digitally","Taxed on 6% of turnover")}
      ${money("turnoverCash","Turnover received in cash","Taxed on 8% of turnover")}
      <div class="subhead">44ADA — profession</div>
      ${money("receipts44ADA","Gross professional receipts","Taxed on 50% of receipts")}
      <div class="subhead">44AE — goods carriage</div>
      ${money("income44AE","Presumptive income from vehicles","Enter the computed figure")}
      <p class="calc-out" id="presOut"></p>
      <p class="hint">Turnover limits for presumptive taxation depend on your cash-receipt proportion. Confirm your eligibility before filing.</p>
    </div></section>`;
  }

  /* Capital gains */
  if(h.includes("cgFull") || h.includes("cg112Aonly")){
    const full = h.includes("cgFull");
    html += `<section class="panel"><h2>Capital gains</h2><div class="panel-body">
      ${money("ltcg112A","Long-term gains on listed equity","First ₹1.25 lakh exempt, then 12.5%")}
      ${full ? money("stcg111A","Short-term gains on listed equity","Taxed at 20%") : ""}
      ${full ? money("ltcgOther","Other long-term gains","Taxed at 12.5%") : ""}
      ${full ? money("stcgSlab","Other short-term gains","Taxed at your slab rate") : ""}
      ${!full ? `<p class="hint">ITR-1 and ITR-4 allow listed-equity long-term gains only, up to ₹1.25 lakh. Beyond that, or with any short-term gains, you need ITR-2 or ITR-3.</p>` : ""}
    </div></section>`;
  }

  /* Other sources */
  if(h.includes("other")){
    html += `<section class="panel"><h2>Other sources</h2><div class="panel-body">
      ${money("interestIncome","Interest from savings and deposits")}
      ${money("otherIncome","Other income","Dividends, family pension, anything else")}
    </div></section>`;
  }

  /* Deductions */
  html += `<section class="panel"><h2>Deductions <em>Most apply only under the old regime</em></h2><div class="panel-body">
    ${money("d80C","80C — PF, ELSS, LIC, tuition, principal","Capped at ₹1,50,000")}
    ${money("d80CCD1B","80CCD(1B) — additional NPS","Capped at ₹50,000")}
    ${money("d80D_self","80D — health insurance, self and family")}
    ${money("d80D_parents","80D — health insurance, parents")}
    <div class="row"><label>Parents are senior citizens<small>Raises the 80D cap to ₹50,000</small></label>
      <div class="seg"><button type="button" data-toggle="parentsSenior" data-val="1" aria-pressed="${state.parentsSenior}">Yes</button>
      <button type="button" data-toggle="parentsSenior" data-val="0" aria-pressed="${!state.parentsSenior}">No</button></div></div>
    ${money("d80TT","80TTA / 80TTB — interest on deposits","₹10,000, or ₹50,000 if you are 60 or over")}
    ${money("d80E","80E — education loan interest","No upper limit")}
    ${money("d80G","80G — eligible donations")}
    ${money("dOther","Other deductions","80U, 80DD, 80DDB, 80EEB and the rest")}
    <div class="subhead">Allowed under both regimes</div>
    ${money("d80CCD2","80CCD(2) — employer NPS contribution","Up to 14% of salary in the new regime")}
  </div></section>`;

  document.getElementById("inputs").innerHTML = html;
  wire();
  recalc();
}

function wire(){
  document.querySelectorAll("#inputs input[type=number]").forEach(el => {
    el.addEventListener("input", () => {
      state[el.id] = Number(el.value) || 0;
      recalc();
    });
  });
  document.querySelectorAll("[data-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      state[btn.dataset.toggle] = btn.dataset.val === "1";
      buildForm();
    });
  });
  document.querySelectorAll("[data-hp]").forEach(btn => {
    btn.addEventListener("click", () => { state.hpType = btn.dataset.hp; buildForm(); });
  });
}

function sheet(res){
  return res.line.map(([cls,label,val]) => {
    const c = cls.split(" ");
    const trCls = c.filter(x => x==="major"||x==="total"||x==="neg").join(" ");
    const tdCls = c.includes("sub") ? "sub" : "";
    return `<tr class="${trCls}"><td class="${tdCls}">${label}</td><td class="n">${fmtSigned(val)}</td></tr>`;
  }).join("");
}

function recalc(){
  const i = {...state, itr: state.itr};
  const oldR = computeRegime(i, "old");
  const newR = computeRegime(i, "new");

  const oldWins = oldR.total < newR.total;
  const tie = Math.abs(oldR.total - newR.total) < 1;
  const diff = Math.abs(oldR.total - newR.total);

  document.getElementById("oldTotal").textContent = fmt(oldR.total);
  document.getElementById("newTotal").textContent = fmt(newR.total);
  document.getElementById("colOld").className = "col " + (tie ? "" : oldWins ? "win" : "lose");
  document.getElementById("colNew").className = "col " + (tie ? "" : oldWins ? "lose" : "win");
  document.getElementById("oldDelta").textContent = oldWins && !tie ? "lower by " + fmt(diff) : "";
  document.getElementById("newDelta").textContent = !oldWins && !tie ? "lower by " + fmt(diff) : "";
  document.getElementById("cmpNote").textContent = "including 4% cess";

  const vT = document.getElementById("vTitle"), vS = document.getElementById("vSaving");
  if(oldR.total === 0 && newR.total === 0){
    vT.textContent = "No tax payable either way";
    vS.innerHTML = "Your income falls within the rebate under both regimes.";
  } else if(tie){
    vT.textContent = "Both regimes cost the same";
    vS.innerHTML = "Pick the new regime for simpler filing.";
  } else {
    vT.textContent = (oldWins ? "Old regime" : "New regime") + " is cheaper";
    vS.innerHTML = "Saves <b>" + fmt(diff) + "</b> this year";
  }

  document.getElementById("sbOldVal").textContent = fmt(oldR.total);
  document.getElementById("sbNewVal").textContent = fmt(newR.total);
  document.getElementById("sbOld").className = (!tie && oldWins) ? "w" : "";
  document.getElementById("sbNew").className = (!tie && !oldWins) ? "w" : "";

  document.getElementById("oldSheet").innerHTML = sheet(oldR);
  document.getElementById("newSheet").innerHTML = sheet(newR);

  /* Slab breakdown for whichever regime wins */
  const winner = oldWins ? oldR : newR;
  document.getElementById("slabBody").innerHTML =
    `<tr class="major"><td>${oldWins ? "Old" : "New"} regime slabs</td><td class="n">Tax</td></tr>` +
    winner.slabRows.map(r =>
      `<tr><td>${fmt(r.from)} – ${r.to===Infinity ? "above" : fmt(r.to)} @ ${(r.rate*100)}%</td><td class="n">${fmt(r.amt)}</td></tr>`
    ).join("");

  /* HRA readout */
  const hraOut = document.getElementById("hraOut");
  if(hraOut){
    const ex = hraExemption(state.basicDA, state.hra, state.rent, state.metro);
    hraOut.textContent = ex > 0
      ? "HRA exempt: " + fmt(ex) + "  ·  taxable: " + fmt(Math.max(0,state.hra - ex))
      : (state.hra > 0 ? "No HRA exemption with these figures" : "");
  }

  /* Presumptive readout */
  const presOut = document.getElementById("presOut");
  if(presOut){
    const p = state.turnoverDigital*.06 + state.turnoverCash*.08 + state.receipts44ADA*.5 + state.income44AE;
    presOut.textContent = p > 0 ? "Presumptive income: " + fmt(p) : "";
  }

  /* Break-even */
  const be = breakEven(i);
  const beFig = document.getElementById("beFigure"), beTxt = document.getElementById("beText");
  const claimed = oldR.ded;
  if(be.amount === 0){
    beFig.textContent = "Already there";
    beTxt.textContent = "Your deductions of " + fmt(claimed) + " are enough for the old regime to win.";
  } else if(!be.reachable){
    beFig.textContent = "Not reachable";
    beTxt.textContent = "At this income the new regime wins no matter how much you deduct.";
  } else {
    beFig.textContent = fmt(be.amount);
    beTxt.textContent = "Total deductions needed for the old regime to beat the new one. You have entered "
      + fmt(claimed) + ", so you are " + fmt(Math.max(0, be.amount - claimed)) + " short.";
  }
}

/* Form tabs */
function buildTabs(){
  document.getElementById("formbar").innerHTML = Object.keys(FORMS).map(k =>
    `<button class="formtab" role="tab" data-itr="${k}" aria-selected="${state.itr===k}">
      <b>${FORMS[k].name}</b><small>${FORMS[k].sub}</small></button>`
  ).join("");
  document.querySelectorAll("[data-itr]").forEach(b =>
    b.addEventListener("click", () => { state.itr = b.dataset.itr; buildTabs(); buildForm(); })
  );
}

drawGuilloche(document.getElementById("guilloche"));

buildTabs();
buildForm();
