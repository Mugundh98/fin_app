/* Screener page -> structured data. Pure functions, no DOM, no network.

   Deliberately not DOMParser, for the same reason as the xlsx and pdf
   readers: this way the parser runs under `node --test` against fixture
   markup, and the fragile part of a scraper is the part under test.

   Scraping is inherently brittle — it reads a page built for eyes, not for
   programs. Screener can change its markup at any time and owes nobody
   notice. Every extractor here fails soft, returning an empty table rather
   than throwing, so one moved section cannot take the whole page down; the UI
   shows what it did and did not find. */

const NAMED = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'", nbsp:" ", "#39":"'" };

export function decodeEntities(s){
  return String(s ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent) => {
    if(ent[0] === "#"){
      const hex = ent[1] === "x" || ent[1] === "X";
      const code = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ent] ?? whole;
  });
}

export const stripTags = s => String(s ?? "").replace(/<[^>]*>/g, " ");

/* Tag soup -> the text a reader would see. */
export const cell = s => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();

/* "17,60,260" -> 1760260 · "50.27%" -> 50.27 · "₹ 1,291" -> 1291 · "-" -> null.
   Returns null rather than 0 for a blank, so a missing year is distinguishable
   from a year that really was zero. */
export function toNumber(s){
  const t = String(s ?? "").trim();
  if(!t || t === "-" || t === "—" || t === "–") return null;
  const negative = t.startsWith("-") || /^\(.*\)$/.test(t);
  const m = /\d[\d,]*(?:\.\d+)?/.exec(t);
  if(!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  if(!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/* The markup inside <section id="..."> up to its closing tag. */
export function sectionOf(html, id){
  const open = new RegExp(`<section[^>]*\\bid=["']${id}["'][^>]*>`, "i").exec(String(html ?? ""));
  if(!open) return "";
  const start = open.index + open[0].length;
  const end = html.indexOf("</section>", start);
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

export function firstTable(html){
  const m = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(String(html ?? ""));
  return m ? m[1] : "";
}

/* Screener's financial tables all share one shape: a header row of periods
   whose first cell is blank, then one row per line item whose first cell is
   the label. The label carries a "+" affordance that is not part of it. */
export function parseDataTable(tableInner){
  const inner = String(tableInner ?? "");
  if(!inner) return { periods: [], rows: [], byLabel: {} };

  const thead = /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(inner)?.[1] ?? "";
  const periods = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(m => cell(m[1]))
    .filter(t => t !== "");            // drops the blank label-column header

  const tbody = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(inner)?.[1] ?? inner;
  const rows = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => cell(c[1]));
    const label = (cells[0] ?? "").replace(/\s*\+\s*$/, "").trim();
    const raw = cells.slice(1);
    return { label, raw, values: raw.map(toNumber) };
  }).filter(r => r.label);

  const byLabel = {};
  for(const r of rows) if(!(r.label in byLabel)) byLabel[r.label] = r.values;

  return { periods, rows, byLabel };
}

const table = (html, id) => parseDataTable(firstTable(sectionOf(html, id)));

/* The headline ratio strip. Each item is a name span followed by a value that
   may itself contain nested spans, so the value is taken as "everything after
   the name closes" rather than matched — a non-greedy match would stop at the
   inner </span> and return half the number. */
export function parseRatios(html){
  const s = String(html ?? "");
  const at = s.search(/id=["']top-ratios["']/i);
  if(at === -1) return [];
  const close = s.indexOf("</ul>", at);
  const block = s.slice(at, close === -1 ? at + 8000 : close);

  const out = [];
  for(const m of block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)){
    const li = m[1];
    const nameM = /<span[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(li);
    if(!nameM) continue;
    const label = cell(nameM[1]);
    const raw = cell(li.slice(nameM.index + nameM[0].length));
    if(!label) continue;
    out.push({
      label, raw,
      value: toNumber(raw),
      unit: /%/.test(raw) ? "%" : /\bCr\.?/i.test(raw) ? "Cr" : /₹/.test(raw) ? "₹" : ""
    });
  }
  return out;
}

export function parseCompanyName(html){
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html ?? ""));
  return m ? cell(m[1]) : "";
}

/* Whole page -> everything the analyser needs. */
export function parseScreener(html){
  const ratios = parseRatios(html);
  const ratioByLabel = Object.fromEntries(ratios.map(r => [r.label, r]));

  const parsed = {
    name: parseCompanyName(html),
    ratios, ratioByLabel,
    pnl:          table(html, "profit-loss"),
    quarters:     table(html, "quarters"),
    balanceSheet: table(html, "balance-sheet"),
    cashFlow:     table(html, "cash-flow"),
    shareholding: table(html, "shareholding")
  };

  /* Say plainly which sections came back empty, so the UI can report a
     partial read instead of quietly showing blank panels. */
  parsed.missing = ["pnl","quarters","balanceSheet","cashFlow","shareholding"]
    .filter(k => parsed[k].rows.length === 0);
  parsed.usable = parsed.pnl.rows.length > 0 || parsed.balanceSheet.rows.length > 0;

  return parsed;
}
