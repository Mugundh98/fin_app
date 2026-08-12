import {
  CLASSES, CLASS_KEYS, TEMPLATES, DEFAULT_TOLERANCE_PP,
  normaliseRows, analysePortfolio, classifyHolding
} from './portfolio-engine.js';
import { readSpreadsheet, parseCsv } from '../shared/xlsx.js';
import { drawGuilloche } from '../shared/guilloche.js';
import { loadState, loadList, saveSoon, flush } from '../shared/store.js';

/* ============================================================
   FORMATTING
   ============================================================ */
const fmt = n => "₹" + Math.round(Math.abs(n)).toLocaleString("en-IN");
const compact = n => {
  const a = Math.abs(n);
  if(a >= 10000000) return "₹" + (n/10000000).toFixed(2).replace(/\.00$/,"") + " Cr";
  if(a >= 100000)   return "₹" + (n/100000).toFixed(2).replace(/\.00$/,"") + " L";
  return fmt(n);
};
const pct1 = f => (Math.round(f * 1000) / 10).toFixed(1) + "%";
const pp = n => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1) + " pp";
const SHORT = { equity:"eq", debt:"dt", gold:"gd", other:"ot" };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

/* ============================================================
   STATE
   ============================================================ */
const state = {
  mode: "manual",
  /* Seeded with a small example so the page shows its shape immediately.
     Clear all wipes it. */
  holdings: [
    { name:"Parag Parikh Flexi Cap", value:600000, cls:"equity", source:"declared" },
    { name:"HDFC Corporate Bond",    value:300000, cls:"debt",   source:"declared" },
    { name:"SGB 2032",               value:100000, cls:"gold",   source:"declared" }
  ],
  targets: { equity:50, debt:40, gold:10 },
  template: "balanced",
  tolerancePp: DEFAULT_TOLERANCE_PP,
  notice: null,
  guessed: 0
};

/* Holdings are user data, not settings: one corrupt row should cost that row
   and nothing else, so each is validated on the way in. A stored list that is
   entirely unusable leaves the seeded example in place. */
const validHolding = h => {
  if(!h || typeof h !== "object") return null;
  const value = Number(h.value);
  if(!Number.isFinite(value) || value <= 0) return null;
  return {
    name: String(h.name ?? "").slice(0, 200),
    value,
    cls: CLASSES[h.cls] ? h.cls : "other",
    source: h.source === "guessed" ? "guessed" : "declared"
  };
};

/* Settings restore key by key; the list is separate so a bad row cannot take
   the target mix down with it. */
Object.assign(state, loadState("portfolioSettings", {
  targets: state.targets, template: state.template, tolerancePp: state.tolerancePp
}));
const savedHoldings = loadList("portfolioHoldings", validHolding);
if(savedHoldings && savedHoldings.length) state.holdings = savedHoldings;

const persist = () => {
  saveSoon("portfolioHoldings", () => state.holdings);
  saveSoon("portfolioSettings", () => ({
    targets: state.targets, template: state.template, tolerancePp: state.tolerancePp
  }));
};

const analyse = () => analysePortfolio(state.holdings, state.targets, { tolerancePp: state.tolerancePp });

/* ============================================================
   HOLDINGS TABLE  (structural — rebuilt only on add/remove/import)
   ============================================================ */
function renderHoldings(){
  const box = document.getElementById("holdRows");
  if(!state.holdings.length){
    box.innerHTML = `<p class="hint" style="padding:10px 0">No holdings yet. Add one, or import a file.</p>`;
  } else {
    box.innerHTML = state.holdings.map((h, i) => `
      <div class="hold ${h.source === "guessed" ? "guessed" : ""}" data-i="${i}">
        <input class="inp" type="text" data-f="name" value="${esc(h.name)}" aria-label="Holding name">
        <input class="inp" type="number" data-f="value" value="${h.value}" min="0" step="any" aria-label="Value">
        <select class="inp" data-f="cls" aria-label="Asset class">
          ${[...CLASS_KEYS, "other"].map(k =>
            `<option value="${k}" ${h.cls === k ? "selected" : ""}>${CLASSES[k].label}</option>`).join("")}
        </select>
        <button type="button" class="drop-row" data-del="${i}" aria-label="Remove ${esc(h.name)}">&times;</button>
      </div>`).join("");
  }

  document.getElementById("holdCount").textContent =
    state.holdings.length ? `${state.holdings.length} holding${state.holdings.length === 1 ? "" : "s"}` : "";

  state.guessed = state.holdings.filter(h => h.source === "guessed").length;
  document.getElementById("guessNote").innerHTML = state.guessed
    ? `<b>${state.guessed}</b> holding${state.guessed === 1 ? " was" : "s were"} classified by name rather than from a class column, shown in amber. Confirm ${state.guessed === 1 ? "it" : "them"} before trusting the split.`
    : "";

  box.querySelectorAll("[data-f]").forEach(el => {
    el.addEventListener("input", () => {
      const i = Number(el.closest(".hold").dataset.i);
      const f = el.dataset.f;
      if(f === "value") state.holdings[i].value = Number(el.value) || 0;
      else if(f === "cls"){
        state.holdings[i].cls = el.value;
        state.holdings[i].source = "declared";     // the user has now said so
        el.closest(".hold").classList.remove("guessed");
        renderGuessCount();
      }
      else state.holdings[i].name = el.value;
      recalc();
    });
  });
  box.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.holdings.splice(Number(btn.dataset.del), 1);
      renderHoldings(); recalc();
    });
  });
}

function renderGuessCount(){
  state.guessed = state.holdings.filter(h => h.source === "guessed").length;
  document.getElementById("guessNote").innerHTML = state.guessed
    ? `<b>${state.guessed}</b> holding${state.guessed === 1 ? " is" : "s are"} still classified by name, shown in amber.`
    : "";
}

function setNotice(text, bad){
  state.notice = text ? { text, bad } : null;
  document.getElementById("notice").innerHTML = text
    ? `<div class="notice ${bad ? "bad" : ""}">${text}</div>` : "";
}

/* ============================================================
   IMPORT
   ============================================================ */
async function ingest(rows, label){
  const { holdings, skipped } = normaliseRows(rows);
  if(!holdings.length){
    setNotice(`Read ${label}, but found no rows with both a name and a positive amount. Check that the sheet has a header row.`, true);
    return;
  }
  state.holdings = holdings;
  const guessed = holdings.filter(h => h.source === "guessed").length;
  const bits = [`Read <b>${holdings.length}</b> holding${holdings.length === 1 ? "" : "s"} from ${label}.`];
  if(guessed) bits.push(`${guessed} classified by name — confirm below.`);
  if(skipped.length) bits.push(`${skipped.length} row${skipped.length === 1 ? "" : "s"} skipped (${[...new Set(skipped.map(s => s.why))].join("; ")}).`);
  setNotice(bits.join(" "));
  renderHoldings();
  recalc();
}

async function handleFile(file){
  if(!file) return;
  try{
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { rows, sheetName, kind } = await readSpreadsheet(bytes, file.name);
    const label = `<b>${esc(file.name)}</b>${sheetName ? ` (sheet “${esc(sheetName)}”)` : ""}`;
    if(!rows.length){ setNotice(`${label} appears to be empty.`, true); return; }
    await ingest(rows, label + (kind === "csv" ? "" : ""));
  } catch(err){
    setNotice(esc(err.message || "Could not read that file."), true);
  }
}

function templateCsv(){
  const csv = [
    "Name,Value,Class",
    "Parag Parikh Flexi Cap,600000,Equity",
    "HDFC Corporate Bond,300000,Debt",
    "SGB 2032,100000,Gold"
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type:"text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = "portfolio-template.csv";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   TARGETS
   ============================================================ */
function renderTemplates(){
  document.getElementById("templates").innerHTML = TEMPLATES.map(t =>
    `<button type="button" data-tmpl="${t.key}" aria-pressed="${state.template === t.key}">
      ${t.label} <span class="num">${t.equity*100}/${t.debt*100}/${t.gold*100}</span></button>`
  ).join("") + `<button type="button" data-tmpl="custom" aria-pressed="${state.template === "custom"}">Custom</button>`;

  document.querySelectorAll("[data-tmpl]").forEach(b => b.addEventListener("click", () => {
    const key = b.dataset.tmpl;
    state.template = key;
    const t = TEMPLATES.find(x => x.key === key);
    if(t){
      state.targets = { equity: t.equity*100, debt: t.debt*100, gold: t.gold*100 };
      syncTargetInputs();
    }
    renderTemplates(); recalc();
  }));
}

function syncTargetInputs(){
  document.getElementById("tEquity").value = state.targets.equity;
  document.getElementById("tDebt").value   = state.targets.debt;
  document.getElementById("tGold").value   = state.targets.gold;
}

/* ============================================================
   RESULTS
   ============================================================ */
function bar(el, shares){
  el.innerHTML = shares
    .filter(s => s.frac > 0)
    .map(s => `<i class="${SHORT[s.key]}" style="width:${(s.frac*100).toFixed(3)}%" title="${CLASSES[s.key].label} ${pct1(s.frac)}"></i>`)
    .join("");
}

function renderAllocation(a){
  const withOther = a.grand > 0 && a.unclassified.value > 0;

  bar(document.getElementById("barNow"),
    [...CLASS_KEYS.map(k => ({ key:k, frac: a.grand > 0 ? a.byKey[k].value / a.grand : 0 })),
     { key:"other", frac: a.grand > 0 ? a.unclassified.value / a.grand : 0 }]);

  bar(document.getElementById("barTarget"),
    CLASS_KEYS.map(k => ({ key:k, frac: a.byKey[k].targetPct * (a.grand > 0 ? a.base / a.grand : 1) }))
      .concat(withOther ? [{ key:"other", frac: a.unclassified.value / a.grand }] : []));

  document.getElementById("legend").innerHTML =
    [...CLASS_KEYS, ...(withOther ? ["other"] : [])].map(k =>
      `<span><i class="${SHORT[k]}"></i>${CLASSES[k].label}</span>`).join("");

  document.getElementById("allocNote").textContent =
    a.base > 0 ? `${compact(a.base)} classified` : "";

  const rows = a.classes.map(c => {
    const cls = Math.abs(c.driftPp) <= a.tolerancePp ? "drift-ok"
              : (c.driftPp > 0 ? "drift-over" : "drift-under");
    return `<tr><td>${c.label}</td><td class="n">${compact(c.value)}</td>
      <td class="n">${pct1(c.currentPct)}</td><td class="n">${pct1(c.targetPct)}</td>
      <td class="n ${cls}">${pp(c.driftPp)}</td></tr>`;
  });

  if(a.unclassified.value > 0){
    rows.push(`<tr class="neg"><td>${CLASSES.other.label}</td>
      <td class="n">${compact(a.unclassified.value)}</td>
      <td class="n">${pct1(a.unclassified.pctOfGrand)}<small> of all</small></td>
      <td class="n">—</td><td class="n">—</td></tr>`);
  }
  rows.push(`<tr class="total"><td>Classified total</td><td class="n">${compact(a.base)}</td>
    <td class="n">100.0%</td><td class="n">100.0%</td><td class="n"></td></tr>`);

  document.getElementById("allocBody").innerHTML = rows.join("");
}

function renderTrades(a){
  const body = document.getElementById("tradeBody");
  if(a.base <= 0 || !a.targets.valid){
    body.innerHTML = `<tr><td colspan="2">Add holdings and a target mix to see this.</td></tr>`;
    return;
  }
  if(!a.needsRebalancing){
    body.innerHTML = `<tr class="major"><td>Within your ${a.tolerancePp} pp band</td>
      <td class="n">no trades</td></tr>
      <tr><td class="sub">Largest drift</td><td class="n">${pp(a.maxDriftPp)}</td></tr>`;
    return;
  }
  const rows = a.classes.filter(c => c.action !== "hold").map(c =>
    `<tr class="trade-${c.action}"><td>${c.action === "buy" ? "Buy" : "Sell"} ${c.label}</td>
      <td class="n">${fmt(Math.abs(c.delta))}</td></tr>`);
  rows.push(`<tr class="total"><td>Portfolio value after</td><td class="n">${fmt(a.base)}</td></tr>`);
  document.getElementById("tradeBody").innerHTML = rows.join("");
}

function renderAddMoney(a){
  const body = document.getElementById("addBody");
  const nm = a.newMoney;

  if(a.base <= 0 || !a.targets.valid){
    body.innerHTML = `<tr><td colspan="2">Add holdings and a target mix to see this.</td></tr>`;
    return;
  }
  if(!nm.possible){
    const names = nm.blockedBy.map(k => CLASSES[k].label).join(" and ");
    body.innerHTML = `<tr><td colspan="2">Your target is 0% ${names}, but you hold some.
      That cannot be fixed by adding money — it needs a sale.</td></tr>`;
    return;
  }
  if(nm.amount < 1){
    body.innerHTML = `<tr class="major"><td>Already on target</td><td class="n">nothing to add</td></tr>`;
    return;
  }
  const rows = [`<tr class="major"><td>Add in total</td><td class="n">${fmt(nm.amount)}</td></tr>`];
  for(const k of CLASS_KEYS){
    if(nm.add[k] > 0.5) rows.push(`<tr><td class="sub">into ${CLASSES[k].label}</td>
      <td class="n">${fmt(nm.add[k])}</td></tr>`);
  }
  rows.push(`<tr class="total"><td>Portfolio value after</td><td class="n">${fmt(nm.newTotal)}</td></tr>`);
  body.innerHTML = rows.join("");
}

function renderVerdict(a){
  const title = document.getElementById("vTitle");
  const saving = document.getElementById("vSaving");
  const eyebrow = document.querySelector(".verdict .eyebrow");

  if(a.base <= 0){
    eyebrow.textContent = "Largest drift from your target";
    title.textContent = state.holdings.length ? "Nothing classified yet" : "Add some holdings";
    saving.innerHTML = state.holdings.length
      ? "Every holding is unclassified. Set a class on each row to get a split."
      : "";
    return;
  }
  if(!a.targets.valid){
    eyebrow.textContent = "Your target mix";
    title.textContent = "Set a target";
    saving.innerHTML = "All three target percentages are zero, so there is nothing to compare against.";
    return;
  }

  /* Drift is symmetric when only two classes are off, so ties are common.
     Compare with a tolerance — otherwise floating-point noise decides — and
     name the overweight side, which is the more actionable half of the pair. */
  const worst = a.classes.reduce((w, c) => {
    const dc = Math.abs(c.driftPp), dw = Math.abs(w.driftPp);
    if(dc > dw + 1e-9) return c;
    if(dc < dw - 1e-9) return w;
    return c.driftPp > w.driftPp ? c : w;
  }, a.classes[0]);
  eyebrow.textContent = "Largest drift from your target";

  if(!a.needsRebalancing){
    title.textContent = "Within your band";
    saving.innerHTML = `Biggest gap is <b>${pp(worst.driftPp)}</b> on ${worst.label.toLowerCase()}, inside the ${a.tolerancePp} pp band you set.`;
    return;
  }
  title.innerHTML = `<span class="figure">${pp(worst.driftPp)}<small>${worst.label.toLowerCase()}</small></span>`;
  saving.innerHTML = `${worst.driftPp > 0 ? "Overweight" : "Underweight"} ${worst.label.toLowerCase()} against your target. Moving <b>${fmt(Math.abs(worst.delta))}</b> would put it back.`;
}

function renderSticky(a){
  document.getElementById("sbSplit").textContent = a.base > 0
    ? CLASS_KEYS.map(k => Math.round(a.byKey[k].currentPct * 100)).join(" / ")
    : "—";
  document.getElementById("sbDrift").textContent = a.base > 0 && a.targets.valid
    ? pp(a.maxDriftPp) : "—";
}

function renderSumNote(){
  const sum = (Number(state.targets.equity) || 0) + (Number(state.targets.debt) || 0) + (Number(state.targets.gold) || 0);
  const el = document.getElementById("sumNote");
  if(Math.abs(sum - 100) < 0.01){ el.className = "sum-note"; el.textContent = "Adds up to 100%."; }
  else if(sum <= 0){ el.className = "sum-note off"; el.textContent = "Set at least one target above zero."; }
  else { el.className = "sum-note off"; el.textContent = `Adds up to ${sum}% — scaled to 100% for the comparison.`; }
}

function recalc(){
  const a = analyse();
  persist();
  renderSumNote();
  renderVerdict(a);
  renderAllocation(a);
  renderTrades(a);
  renderAddMoney(a);
  renderSticky(a);
}

/* ============================================================
   WIRING
   ============================================================ */
document.querySelectorAll("[data-mode]").forEach(btn => btn.addEventListener("click", () => {
  state.mode = btn.dataset.mode;
  document.querySelectorAll("[data-mode]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  document.getElementById("importBox").hidden = state.mode !== "import";
}));

document.getElementById("file").addEventListener("change", e => handleFile(e.target.files[0]));

const drop = document.getElementById("drop");
["dragenter","dragover"].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave","drop"].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", e => handleFile(e.dataTransfer?.files?.[0]));

document.getElementById("paste").addEventListener("input", e => {
  const text = e.target.value.trim();
  if(!text) return;
  /* Must go through parseCsv, which picks the delimiter from the first line.
     Splitting on tab OR comma would tear "8,00,000" into three fields. */
  ingest(parseCsv(text), "the pasted rows");
});

document.getElementById("tmplBtn").addEventListener("click", templateCsv);

document.getElementById("addRow").addEventListener("click", () => {
  state.holdings.push({ name:"", value:0, cls:"other", source:"unknown" });
  renderHoldings(); recalc();
});
document.getElementById("clearAll").addEventListener("click", () => {
  state.holdings = [];
  setNotice("");
  renderHoldings(); recalc();
});

for(const [id, key] of [["tEquity","equity"], ["tDebt","debt"], ["tGold","gold"]]){
  document.getElementById(id).addEventListener("input", e => {
    state.targets[key] = Number(e.target.value) || 0;
    state.template = "custom";
    renderTemplates();
    recalc();
  });
}
document.getElementById("tol").addEventListener("input", e => {
  state.tolerancePp = Math.max(0, Number(e.target.value) || 0);
  recalc();
});

addEventListener("pagehide", flush);

drawGuilloche(document.getElementById("guilloche"));

document.getElementById("tol").value = state.tolerancePp;
syncTargetInputs();
renderTemplates();
renderHoldings();
recalc();
