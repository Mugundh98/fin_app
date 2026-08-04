import { summarise, mergeHoldings } from './dash-engine.js';
import { CLASSES, CLASS_KEYS, normaliseRows } from '../portfolio/portfolio-engine.js';
import { readSpreadsheet, parseCsv } from '../shared/xlsx.js';
import { isPdf, extractPdfRows } from '../shared/pdf.js';
import { drawGuilloche } from '../shared/guilloche.js';
import { groupIndian } from '../shared/format.js';

/* ============================================================
   FORMATTING
   ============================================================ */
const fmt = n => "₹" + groupIndian(Math.abs(n));
const signed = n => (n < 0 ? "−" : "") + fmt(n);
const compact = n => {
  const a = Math.abs(n);
  if(a >= 10000000) return (n < 0 ? "−" : "") + "₹" + (Math.abs(n)/10000000).toFixed(2).replace(/\.00$/,"") + " Cr";
  if(a >= 100000)   return (n < 0 ? "−" : "") + "₹" + (Math.abs(n)/100000).toFixed(2).replace(/\.00$/,"") + " L";
  return signed(n);
};
const pct1 = n => (Math.round(n * 10) / 10).toFixed(1) + "%";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

/* ============================================================
   STATE
   ============================================================ */
const state = {
  holdings: [
    { name:"Parag Parikh Flexi Cap", value:500000, cost:380000, cls:"equity", source:"declared" },
    { name:"HDFC Corporate Bond",    value:200000, cost:185000, cls:"debt",   source:"declared" },
    { name:"SGB 2032",               value:100000, cost:78000,  cls:"gold",   source:"declared" }
  ],
  rawText: ""
};

/* ============================================================
   EDITABLE ROWS  (structural — rebuilt on add/remove/import only)
   ============================================================ */
function renderRows(){
  const box = document.getElementById("rows");
  if(!state.holdings.length){
    box.innerHTML = `<p class="hint" style="padding:10px 0">Nothing loaded yet. Add a holding, or load a statement above.</p>`;
  } else {
    box.innerHTML = state.holdings.map((h, i) => `
      <div class="hrow ${h.source === "guessed" ? "guessed" : ""}" data-i="${i}">
        <input class="inp" type="text" data-f="name" value="${esc(h.name)}" aria-label="Name">
        <input class="inp" type="number" data-f="value" value="${h.value}" min="0" step="any" aria-label="Value">
        <input class="inp" type="number" data-f="cost" value="${h.cost ?? ""}" min="0" step="any"
          placeholder="—" aria-label="Invested">
        <select class="inp" data-f="cls" aria-label="Asset class">
          ${[...CLASS_KEYS, "other"].map(k =>
            `<option value="${k}" ${h.cls === k ? "selected" : ""}>${CLASSES[k].label}</option>`).join("")}
        </select>
        <button type="button" class="kill" data-del="${i}" aria-label="Remove ${esc(h.name)}">&times;</button>
      </div>`).join("");
  }

  const n = state.holdings.length;
  document.getElementById("holdCount").textContent = n ? `${n} holding${n === 1 ? "" : "s"}` : "";

  box.querySelectorAll("[data-f]").forEach(el => {
    el.addEventListener("input", () => {
      const i = Number(el.closest(".hrow").dataset.i);
      const f = el.dataset.f;
      if(f === "value") state.holdings[i].value = Number(el.value) || 0;
      else if(f === "cost"){
        const v = Number(el.value);
        /* Blank means "not known", which is different from bought for nothing. */
        if(el.value === "" || !Number.isFinite(v) || v <= 0) delete state.holdings[i].cost;
        else state.holdings[i].cost = v;
      }
      else if(f === "cls"){
        state.holdings[i].cls = el.value;
        state.holdings[i].source = "declared";
        el.closest(".hrow").classList.remove("guessed");
        updateGuessNote();
      }
      else state.holdings[i].name = el.value;
      recalc();
    });
  });
  box.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    state.holdings.splice(Number(b.dataset.del), 1);
    renderRows(); recalc();
  }));

  updateGuessNote();
}

function updateGuessNote(){
  const n = state.holdings.filter(h => h.source === "guessed").length;
  document.getElementById("guessNote").innerHTML = n
    ? `<b>${n}</b> holding${n === 1 ? " was" : "s were"} classified by name rather than from a class column, shown in amber. Confirm ${n === 1 ? "it" : "them"} before trusting the split.`
    : "";
}

function setNotice(html, bad){
  document.getElementById("notice").innerHTML = html
    ? `<div class="notice ${bad ? "bad" : ""}">${html}${
        state.rawText
          ? `<details class="raw"><summary>See what was read from the file</summary><pre>${esc(state.rawText.slice(0, 4000))}</pre></details>`
          : ""}</div>`
    : "";
}

/* ============================================================
   IMPORT
   ============================================================ */
function ingest(rows, label, { merge = false } = {}){
  const { holdings, skipped } = normaliseRows(rows);
  if(!holdings.length){
    setNotice(`Read ${label}, but found nothing that looked like a holding with a value.`, true);
    return;
  }
  state.holdings = merge ? mergeHoldings(state.holdings, holdings) : holdings;

  const guessed = holdings.filter(h => h.source === "guessed").length;
  const bits = [`Read <b>${holdings.length}</b> holding${holdings.length === 1 ? "" : "s"} from ${label}.`];
  if(guessed) bits.push(`${guessed} classified by name — confirm below.`);
  if(skipped.length) bits.push(`${skipped.length} row${skipped.length === 1 ? "" : "s"} skipped.`);
  setNotice(bits.join(" "));
  renderRows(); recalc();
}

/* Photographing or screenshotting a statement is the obvious thing to try, so
   say why it cannot work rather than reporting an empty result. */
function looksLikeImage(b){
  if(b.length < 12) return false;
  const is = (...sig) => sig.every((v, i) => b[i] === v);
  return is(0xFF,0xD8,0xFF)                        // JPEG
      || is(0x89,0x50,0x4E,0x47)                   // PNG
      || is(0x47,0x49,0x46,0x38)                   // GIF
      || (is(0x52,0x49,0x46,0x46) && b[8] === 0x57 && b[9] === 0x45)   // WebP
      || (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70); // HEIC/MP4
}

async function handleFile(file){
  if(!file) return;
  state.rawText = "";
  try{
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = `<b>${esc(file.name)}</b>`;

    if(looksLikeImage(bytes)){
      setNotice(`${name} is an image. There is no text inside a picture to read — a screenshot or photo of a statement has to be typed in by hand.`, true);
      return;
    }

    if(isPdf(bytes)){
      const rows = await extractPdfRows(bytes);
      /* A PDF import is a guess at a table, so show the raw reading next to
         the result — that is the only way to tell a misread from a mistake. */
      state.rawText = rows.map(r => r.join("  |  ")).join("\n");
      ingest(rows, `${name} — <b>check this one</b>, it came out of a PDF`);
      return;
    }

    const { rows, sheetName } = await readSpreadsheet(bytes, file.name);
    if(!rows.length){ setNotice(`${name} appears to be empty.`, true); return; }
    ingest(rows, name + (sheetName ? ` (sheet “${esc(sheetName)}”)` : ""));
  } catch(err){
    setNotice(esc(err.message || "Could not read that file."), true);
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function renderTiles(s){
  document.getElementById("tTotal").textContent = compact(s.total);
  document.getElementById("tCount").textContent =
    s.count ? `${s.count} holding${s.count === 1 ? "" : "s"}` : "no holdings";

  const tile = document.getElementById("tileGain");
  const gain = document.getElementById("tGain");
  const sub = document.getElementById("tGainSub");
  tile.classList.remove("up", "down");
  if(!s.hasCost){
    gain.textContent = "—";
    sub.textContent = "no invested figure";
  } else {
    gain.textContent = compact(s.gain);
    tile.classList.add(s.gain >= 0 ? "up" : "down");
    sub.textContent = `${pct1(s.gainPct)}` +
      (s.costCoverage < 99.5 ? ` · on ${pct1(s.costCoverage)} of the book` : "");
  }

  const top = s.concentration.largest;
  document.getElementById("tTop").textContent = top ? pct1(top.weight) : "—";
  document.getElementById("tTopName").textContent = top ? top.name : "";
  document.getElementById("asOf").textContent = s.count ? "as you entered it" : "";
}

function renderClasses(s){
  document.getElementById("mixbar").innerHTML = s.classes
    .filter(c => c.value > 0)
    .map(c => `<i class="${c.key}" style="width:${c.pct.toFixed(3)}%" title="${c.label} ${pct1(c.pct)}"></i>`)
    .join("");

  document.getElementById("classBody").innerHTML = s.classes.map(c =>
    `<tr${c.value === 0 ? ' style="opacity:.5"' : ""}>
      <td><i class="swatch ${c.key}"></i>${c.label}</td>
      <td class="n">${compact(c.value)}</td>
      <td class="n">${pct1(c.pct)}</td>
    </tr>`).join("") +
    `<tr class="total"><td>Total</td><td class="n">${compact(s.total)}</td><td class="n">100.0%</td></tr>`;

  document.getElementById("classNote").textContent =
    s.unclassified.value > 0 ? `${pct1(s.unclassified.pct)} unclassified` : "";
}

function renderTop(s){
  const body = document.getElementById("topBody");
  if(!s.count){ body.innerHTML = `<tr><td colspan="2">Nothing to show yet.</td></tr>`; return; }
  body.innerHTML = s.holdings.slice(0, 5).map(h =>
    `<tr><td>${esc(h.name)}
        <span class="wbar"><i class="${h.cls}" style="width:${Math.min(100, h.weight).toFixed(2)}%"></i></span></td>
      <td class="n">${compact(h.value)}<br><small style="color:var(--ink-faint)">${pct1(h.weight)}</small></td>
    </tr>`).join("");
}

function renderConcentration(s){
  const body = document.getElementById("concBody");
  if(!s.count){ body.innerHTML = `<tr><td colspan="2">Nothing to show yet.</td></tr>`; return; }
  const c = s.concentration;
  const rows = [
    ["Largest holding", c.top1],
    ["Top 3 holdings", c.top3],
    ["Top 5 holdings", c.top5]
  ];
  body.innerHTML = rows.map(([label, v]) =>
    `<tr><td>${label}</td><td class="n">${pct1(v)}</td></tr>`).join("") +
    `<tr class="total"><td>Spread across</td><td class="n">${s.count} holding${s.count === 1 ? "" : "s"}</td></tr>`;
}

function renderAll(s){
  const body = document.getElementById("allBody");
  if(!s.count){ body.innerHTML = `<tr><td colspan="4">Nothing to show yet.</td></tr>`; return; }
  body.innerHTML = s.holdings.map(h =>
    `<tr>
      <td>${esc(h.name)}</td>
      <td class="n">${compact(h.value)}</td>
      <td class="n">${pct1(h.weight)}</td>
      <td class="n ${h.gain === undefined ? "" : h.gain >= 0 ? "gain-up" : "gain-down"}">${
        h.gain === undefined ? "—" : compact(h.gain)}</td>
    </tr>`).join("");
  document.getElementById("allNote").textContent = `${s.count} row${s.count === 1 ? "" : "s"}`;
}

function renderSticky(s){
  document.getElementById("sbTotal").textContent = compact(s.total);
  document.getElementById("sbCount").textContent = String(s.count);
}

function recalc(){
  const s = summarise(state.holdings);
  renderTiles(s);
  renderClasses(s);
  renderTop(s);
  renderConcentration(s);
  renderAll(s);
  renderSticky(s);
}

/* ============================================================
   WIRING
   ============================================================ */
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
  state.rawText = "";
  ingest(parseCsv(text), "the pasted rows");
});

document.getElementById("addRow").addEventListener("click", () => {
  state.holdings.push({ name:"", value:0, cls:"other", source:"unknown" });
  renderRows(); recalc();
});
document.getElementById("clearAll").addEventListener("click", () => {
  state.holdings = []; state.rawText = "";
  setNotice(""); renderRows(); recalc();
});

drawGuilloche(document.getElementById("guilloche"));
renderRows();
recalc();
