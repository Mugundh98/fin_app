import { parseScreener } from './screener-parse.js';
import { analyseStock } from './stock-engine.js';
import { chartUrl, parseYahooChart } from './yahoo.js';
import { drawGuilloche } from '../shared/guilloche.js';
import { groupIndian } from '../shared/format.js';

/* ============================================================
   FORMATTING
   ============================================================ */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const cr = n => n == null ? "—" : "₹" + groupIndian(n) + " Cr";
const pct = (n, dp = 1) => n == null ? "—" : n.toFixed(dp) + "%";
const pp  = n => n == null ? "—" : (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2) + " pp";
/* groupIndian rounds to whole rupees, which is right for an amount and wrong
   for a ratio — debt/equity of 0.45 would render as 0. Small numbers keep
   their decimals; large ones get grouped. */
const num = (n, dp = 2) => {
  if(n == null) return "—";
  return Math.abs(n) < 1000 ? n.toFixed(dp) : groupIndian(n);
};

const PROXY_KEY = "finapp.proxyUrl";
const state = { basis: "consolidated", analysis: null, busy: false };

/* ============================================================
   SVG CHARTS  (no library — the app has no dependencies)
   ============================================================ */
const W = 380, H = 150, PAD = { l: 4, r: 4, t: 8, b: 18 };

function combinedChart(sales, profit, margin){
  const pts = sales.filter(p => p.value != null);
  if(pts.length < 2) return `<p class="hint">Not enough history to chart.</p>`;

  const periods = pts.map(p => p.period);
  const vals = periods.map(pd => ({
    period: pd,
    sales: sales.find(x => x.period === pd)?.value ?? 0,
    profit: profit.find(x => x.period === pd)?.value ?? 0,
    margin: margin.find(x => x.period === pd)?.value ?? null
  }));

  const maxV = Math.max(...vals.map(v => Math.max(v.sales, v.profit)), 1);
  const marginVals = vals.map(v => v.margin).filter(m => m != null);
  const maxM = Math.max(...marginVals, 1);

  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;
  const slot = innerW / vals.length;
  const barW = Math.max(3, slot * 0.32);
  const y = v => PAD.t + innerH - (v / maxV) * innerH;
  const ym = m => PAD.t + innerH - (m / maxM) * innerH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales, net profit and operating margin by year">`;
  for(let i = 0; i <= 3; i++){
    const gy = PAD.t + (innerH / 3) * i;
    svg += `<line class="grid" x1="${PAD.l}" y1="${gy.toFixed(1)}" x2="${W - PAD.r}" y2="${gy.toFixed(1)}"/>`;
  }
  vals.forEach((v, i) => {
    const cx = PAD.l + slot * i + slot / 2;
    svg += `<rect class="bar-sales" x="${(cx - barW).toFixed(1)}" y="${y(v.sales).toFixed(1)}"
              width="${barW.toFixed(1)}" height="${(PAD.t + innerH - y(v.sales)).toFixed(1)}"><title>${esc(v.period)} sales ${cr(v.sales)}</title></rect>`;
    svg += `<rect class="bar-profit" x="${cx.toFixed(1)}" y="${y(v.profit).toFixed(1)}"
              width="${barW.toFixed(1)}" height="${(PAD.t + innerH - y(v.profit)).toFixed(1)}"><title>${esc(v.period)} net profit ${cr(v.profit)}</title></rect>`;
    /* Only every other label on a crowded axis, so they do not collide. */
    if(vals.length <= 8 || i % 2 === 0){
      svg += `<text class="axis" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(v.period.replace(/^\w+ /, ""))}</text>`;
    }
  });
  const line = vals.filter(v => v.margin != null)
    .map((v, i, arr) => {
      const idx = vals.indexOf(v);
      const cx = PAD.l + slot * idx + slot / 2;
      return `${i === 0 ? "M" : "L"}${cx.toFixed(1)},${ym(v.margin).toFixed(1)}`;
    }).join(" ");
  if(line) svg += `<path class="line-margin" d="${line}"/>`;
  vals.forEach((v, i) => {
    if(v.margin == null) return;
    const cx = PAD.l + slot * i + slot / 2;
    svg += `<circle class="dot-margin" cx="${cx.toFixed(1)}" cy="${ym(v.margin).toFixed(1)}" r="2"><title>${esc(v.period)} margin ${pct(v.margin)}</title></circle>`;
  });
  return svg + `</svg>`;
}

/* Price is a dense series with no meaningful zero, so it gets a zoomed band
   and no bars — a 0-based axis would flatten five years into a stripe. */
function priceChart(points){
  if(points.length < 2) return `<p class="hint">Not enough price history to chart.</p>`;

  const h = 130, innerW = W - PAD.l - PAD.r, innerH = h - PAD.t - PAD.b;
  const closes = points.map(p => p.close);
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const span = Math.max(hi - lo, hi * 0.02);
  const y = v => PAD.t + innerH - ((v - lo + span * 0.08) / (span * 1.16)) * innerH;
  const x = i => PAD.l + (innerW / (points.length - 1)) * i;

  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(" ");
  const area = `${d} L${x(points.length - 1).toFixed(1)},${PAD.t + innerH} L${x(0).toFixed(1)},${PAD.t + innerH} Z`;

  let svg = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Share price history">`;
  svg += `<path class="area-price" d="${area}"/><path class="line-price" d="${d}"/>`;
  /* Label only the extremes and the ends — a monthly series has too many
     points to label each. */
  const hiIdx = closes.indexOf(hi), loIdx = closes.indexOf(lo);
  for(const [i, anchor] of [[hiIdx, "middle"], [loIdx, "middle"]]){
    svg += `<circle class="dot-price" cx="${x(i).toFixed(1)}" cy="${y(closes[i]).toFixed(1)}" r="2.4"/>`;
    svg += `<text class="axis" x="${x(i).toFixed(1)}" y="${(y(closes[i]) + (i === hiIdx ? -5 : 11)).toFixed(1)}" text-anchor="${anchor}">${Math.round(closes[i])}</text>`;
  }
  svg += `<text class="axis" x="${PAD.l}" y="${h - 4}" text-anchor="start">${esc(points[0].date.slice(0, 7))}</text>`;
  svg += `<text class="axis" x="${W - PAD.r}" y="${h - 4}" text-anchor="end">${esc(points.at(-1).date.slice(0, 7))}</text>`;
  return svg + `</svg>`;
}

function promoterChart(points){
  const pts = points.filter(p => p.value != null);
  if(pts.length < 2) return `<p class="hint">No shareholding history found.</p>`;

  const h = 96, innerW = W - PAD.l - PAD.r, innerH = h - PAD.t - PAD.b;
  const lo = Math.min(...pts.map(p => p.value)), hi = Math.max(...pts.map(p => p.value));
  /* A promoter stake moves in tenths, so a 0..100 axis would draw a flat
     line. The band is zoomed, with a floor so a truly flat series still
     renders sensibly. */
  const span = Math.max(hi - lo, 1);
  const y = v => PAD.t + innerH - ((v - lo + span * 0.15) / (span * 1.3)) * innerH;
  const x = i => PAD.l + (innerW / Math.max(1, pts.length - 1)) * i;

  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${d} L${x(pts.length - 1).toFixed(1)},${PAD.t + innerH} L${x(0).toFixed(1)},${PAD.t + innerH} Z`;

  let svg = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Promoter holding over time">`;
  svg += `<path class="area-promo" d="${area}"/><path class="line-promo" d="${d}"/>`;
  pts.forEach((p, i) => {
    svg += `<circle class="dot-promo" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.2"><title>${esc(p.period)} ${pct(p.value, 2)}</title></circle>`;
    if(i === 0 || i === pts.length - 1){
      svg += `<text class="axis" x="${x(i).toFixed(1)}" y="${h - 5}" text-anchor="${i === 0 ? "start" : "end"}">${esc(p.period)}</text>`;
    }
  });
  return svg + `</svg>`;
}

/* ============================================================
   RENDER
   ============================================================ */
const show = (id, on) => { document.getElementById(id).hidden = !on; };

function finTable(el, table, keyRows = []){
  if(!table || !table.rows.length){ el.innerHTML = ""; return false; }
  el.innerHTML =
    `<thead><tr><th>${""}</th>${table.periods.map(p => `<th>${esc(p)}</th>`).join("")}</tr></thead>` +
    `<tbody>${table.rows.map(r =>
      `<tr class="${keyRows.includes(r.label) ? "key" : ""}"><td>${esc(r.label)}</td>${
        r.raw.map(v => `<td>${esc(v || "—")}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return true;
}

function renderGrowth(a){
  const row = (label, g) => {
    if(!g) return `<tr><td>${label}</td><td class="n">—</td></tr>`;
    return `<tr><td>${label}${g.truncated ? ` <small style="color:var(--ink-faint)">(${g.years}y available)</small>` : ""}</td>
      <td class="n">${pct(g.rate * 100)}</td></tr>`;
  };
  document.getElementById("growthBody").innerHTML = [
    `<tr class="major"><td>Sales</td><td class="n"></td></tr>`,
    row("3 years", a.growth.sales3), row("5 years", a.growth.sales5), row("10 years", a.growth.sales10),
    `<tr class="major"><td>Net profit</td><td class="n"></td></tr>`,
    row("3 years", a.growth.profit3), row("5 years", a.growth.profit5), row("10 years", a.growth.profit10)
  ].join("");
}

function render(a){
  state.analysis = a;

  document.getElementById("vTitle").textContent = a.name || "Company";
  const bits = [];
  if(a.latest.sales) bits.push(`Sales <b>${cr(a.latest.sales.value)}</b>`);
  if(a.latest.netMargin?.value != null) bits.push(`net margin <b>${pct(a.latest.netMargin.value)}</b>`);
  if(a.latest.debtToEquity?.value != null) bits.push(`debt/equity <b>${num(a.latest.debtToEquity.value)}</b>`);
  document.getElementById("vSaving").innerHTML = bits.join(" · ") || "Loaded, but no figures were found.";

  const rat = a.ratios.filter(r => r.raw);
  show("ratioPanel", rat.length > 0);
  document.getElementById("ratios").innerHTML = rat.slice(0, 12)
    .map(r => `<div><span>${esc(r.label)}</span><b>${esc(r.raw)}</b></div>`).join("");

  const ml = document.getElementById("marginLabel");
  if(ml) ml.textContent = a.marginLabel;

  const hasChart = a.sales.filter(p => p.value != null).length >= 2;
  show("chartPanel", hasChart);
  if(hasChart){
    document.getElementById("chart").innerHTML =
      combinedChart(a.sales, a.netProfit, a.operatingMargin);
    document.getElementById("chartNote").textContent = a.financing
      ? "₹ Cr — margin is struck after interest, as a lender reports it"
      : "₹ Cr, by year";
  }

  show("growthPanel", !!(a.growth.sales3 || a.growth.profit3));
  renderGrowth(a);

  const promo = a.promoters;
  show("promoPanel", !!promo.latest);
  if(promo.latest){
    document.getElementById("promoChart").innerHTML = promoterChart(promo.points);
    document.getElementById("promoNote").textContent = promo.latest.period;
    document.getElementById("promoBody").innerHTML = [
      `<tr class="major"><td>Latest holding</td><td class="n">${pct(promo.latest.value, 2)}</td></tr>`,
      `<tr><td class="sub">Change over last quarter</td><td class="n">${pp(promo.changeQoQ)}</td></tr>`,
      `<tr><td class="sub">Change over four quarters</td><td class="n">${pp(promo.change4Q)}</td></tr>`,
      `<tr class="total"><td>Direction</td><td class="n"><span class="trend ${promo.direction}">${promo.direction}</span></td></tr>`
    ].join("");
  }

  const sh = a.shareholding;
  const latestOf = s => { for(let i = s.length - 1; i >= 0; i--) if(s[i].value != null) return s[i].value; return null; };
  const shRows = [["Promoters", sh.promoters], ["FIIs", sh.fiis], ["DIIs", sh.diis],
                  ["Government", sh.government], ["Public", sh.public]]
    .map(([label, s]) => [label, latestOf(s)]).filter(([, v]) => v != null);
  show("shPanel", shRows.length > 0);
  document.getElementById("shBody").innerHTML = shRows
    .map(([label, v]) => `<tr><td>${label}</td><td class="n">${pct(v, 2)}</td></tr>`).join("");

  show("pnlPanel", finTable(document.getElementById("pnlTable"), a.raw?.pnl,
    ["Sales", "Operating Profit", "Net Profit"]));
  document.getElementById("pnlNote").textContent = "₹ Cr";
  show("bsPanel", finTable(document.getElementById("bsTable"), a.raw?.balanceSheet,
    ["Total Assets", "Borrowings"]));
  document.getElementById("bsNote").textContent = "₹ Cr";
  show("qtrPanel", finTable(document.getElementById("qtrTable"), a.raw?.quarters, ["Sales", "Net Profit"]));
}

function renderPrice(p){
  show("pricePanel", !!(p && p.ok));
  if(!p || !p.ok) return;

  const tiles = [
    ["Price", p.price == null ? "—" : "₹" + groupIndian(Math.round(p.price))],
    ["52 week", p.fiftyTwoWeekLow == null ? "—"
      : `₹${groupIndian(Math.round(p.fiftyTwoWeekLow))} – ₹${groupIndian(Math.round(p.fiftyTwoWeekHigh))}`],
    ["Change", p.changePct == null ? "—" : (p.changePct >= 0 ? "+" : "−") + Math.abs(p.changePct).toFixed(1) + "%"]
  ];
  if(p.cagr) tiles.push(["Annualised", (p.cagr.rate >= 0 ? "+" : "−") + Math.abs(p.cagr.rate * 100).toFixed(2) + "%"]);

  document.getElementById("priceTiles").innerHTML = tiles
    .map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  document.getElementById("priceChart").innerHTML = priceChart(p.points);
  document.getElementById("priceNote").textContent =
    `${p.exchange || "NSE"} · ${p.cagr ? p.cagr.years.toFixed(1) + " years" : "history"}`;
}

/* Price is a bonus, not a requirement — a failure here must not cost the
   user the financials they came for. */
async function loadPrice(code){
  show("pricePanel", false);
  try{
    const res = await fetch(`${proxy()}/?url=${encodeURIComponent(chartUrl(code))}`);
    if(!res.ok) return null;
    const p = parseYahooChart(await res.text());
    renderPrice(p);
    return p;
  } catch { return null; }
}

/* Wipe every panel. Called before each lookup so a failed fetch can never
   leave the previous company's figures on screen under a new ticker — the
   worst kind of wrong, because it looks entirely convincing. */
function clearResults(){
  state.analysis = null;
  for(const id of ["pricePanel","ratioPanel","chartPanel","growthPanel",
                   "promoPanel","shPanel","pnlPanel","bsPanel","qtrPanel"]){
    show(id, false);
  }
  document.getElementById("vTitle").textContent = "Nothing loaded";
  document.getElementById("vSaving").textContent = "";
}

function setNotice(html, kind){
  document.getElementById("notice").innerHTML =
    html ? `<div class="notice ${kind || ""}">${html}</div>` : "";
}

/* ============================================================
   FETCH
   ============================================================ */
const proxy = () => (localStorage.getItem(PROXY_KEY) || "").replace(/\/+$/, "");

async function lookup(){
  const code = document.getElementById("ticker").value.trim().toUpperCase();
  if(!code) return setNotice("Enter an NSE code first.", "bad");
  if(!proxy()){
    document.getElementById("setup").open = true;
    return setNotice("No proxy set. Screener blocks direct reads from other sites, so deploy the Worker in <code>worker/</code> and paste its URL below.", "warn");
  }

  const target = `https://www.screener.in/company/${encodeURIComponent(code)}/` +
                 (state.basis === "consolidated" ? "consolidated/" : "");
  const url = `${proxy()}/?url=${encodeURIComponent(target)}`;

  state.busy = true;
  document.getElementById("go").disabled = true;
  clearResults();
  setNotice(`Fetching <b>${esc(code)}</b>…`);

  try{
    const res = await fetch(url);
    const text = await res.text();
    if(!res.ok){
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(msg.slice(0, 300));
    }

    const parsed = parseScreener(text);
    if(!parsed.usable){
      setNotice(`Fetched <b>${esc(code)}</b>, but no financial tables were found. Screener may have changed its markup, or that code may not exist — try it on screener.in first.`, "bad");
      return;
    }

    const a = analyseStock(parsed);
    a.raw = parsed;
    render(a);

    const missing = parsed.missing.filter(m => m !== "cashFlow");
    setNotice(missing.length
      ? `Read <b>${esc(parsed.name || code)}</b>. Could not find: ${missing.join(", ")} — those panels are hidden rather than shown empty.`
      : `Read <b>${esc(parsed.name || code)}</b>.`,
      missing.length ? "warn" : "");

    /* Financials come from Screener; the price series comes from Yahoo,
       which is the only free source that gives one. Fetched after, so a
       price failure never delays or blocks the statements. */
    loadPrice(code);
  } catch(err){
    setNotice(`Could not fetch ${esc(code)}: ${esc(err.message || "network error")}.
      If the proxy URL is right, check it is deployed and that the Worker allowlist covers screener.in.`, "bad");
  } finally {
    state.busy = false;
    document.getElementById("go").disabled = false;
  }
}

/* ============================================================
   WIRING
   ============================================================ */
document.getElementById("go").addEventListener("click", lookup);
document.getElementById("ticker").addEventListener("keydown", e => {
  if(e.key === "Enter") lookup();
});

document.querySelectorAll("[data-basis]").forEach(b => b.addEventListener("click", () => {
  state.basis = b.dataset.basis;
  document.querySelectorAll("[data-basis]").forEach(x =>
    x.setAttribute("aria-pressed", String(x.dataset.basis === state.basis)));
  if(state.analysis) lookup();
}));

document.getElementById("saveProxy").addEventListener("click", () => {
  const v = document.getElementById("proxy").value.trim();
  localStorage.setItem(PROXY_KEY, v);
  setNotice(v ? `Proxy saved. Enter a code and fetch.` : `Proxy cleared.`);
});

document.getElementById("proxy").value = proxy();
if(!proxy()) document.getElementById("setup").open = true;

drawGuilloche(document.getElementById("guilloche"));
