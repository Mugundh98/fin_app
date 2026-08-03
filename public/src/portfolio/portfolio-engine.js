/* Portfolio engine — pure functions, no DOM, no framework, no file I/O.
   Spreadsheet decoding lives in xlsx.js; this file only ever sees rows that
   somebody else has already read.

   Informational only. It reports what a portfolio currently holds against a
   target the USER supplies, and does the arithmetic to close the gap. It does
   not choose the target, does not know what any specific fund is, and holds
   no view on what anyone should own. */

/* ============================================================
   ASSET CLASSES
   ============================================================ */

export const CLASS_KEYS = ["equity", "debt", "gold"];

export const CLASSES = {
  equity: { key:"equity", label:"Equity", note:"Shares and equity funds" },
  debt:   { key:"debt",   label:"Debt",   note:"Bonds, deposits, debt funds" },
  gold:   { key:"gold",   label:"Gold",   note:"Gold funds, ETFs and bonds" },
  other:  { key:"other",  label:"Unclassified",
            note:"Could not be placed — assign a class to include it" }
};

/* Words that identify a class when a holding declares one outright.
   Matched against the whole cell, lowercased and trimmed. */
const DECLARED = {
  equity: ["equity","equities","stock","stocks","share","shares","eq","e"],
  debt:   ["debt","fixed income","fixed-income","bond","bonds","fi","d"],
  gold:   ["gold","precious metal","precious metals","sgb"],
  other:  ["other","others","hybrid","balanced","cash","misc","unclassified"]
};

/* Substrings that identify a class from a holding's NAME when no class column
   exists. Checked gold -> debt -> equity, because a name like "Gold Savings
   Fund" contains cues for more than one. A guess is always marked as a guess
   so the UI can ask the user to confirm it. */
const GUESS = {
  gold:   ["gold","sovereign gold","sgb","gold etf","gold bees"],
  debt:   ["debt","liquid","gilt","bond","ppf","epf","nps-c","fixed deposit",
           "fd ","term deposit","nsc","corporate bond","money market","treasury",
           "overnight","ultra short","short duration","low duration","banking and psu",
           "banking & psu","dynamic bond","credit risk","income fund","savings certificate"],
  equity: ["equity","elss","nifty","sensex","index","large cap","largecap","mid cap",
           "midcap","small cap","smallcap","flexi cap","flexicap","multi cap","multicap",
           "bluechip","blue chip","focused","contra","value fund","dividend yield",
           "infrastructure","pharma","banking fund","technology fund","consumption",
           "opportunities","growth fund","shares","stock","ltd","limited"]
};

/* Allocation templates the user can start from and then edit. These are
   common textbook splits, offered as starting points only — the target used
   in every calculation is whatever the user ends up setting. */
export const TEMPLATES = [
  { key:"conservative", label:"Conservative", equity:.20, debt:.70, gold:.10 },
  { key:"balanced",     label:"Balanced",     equity:.50, debt:.40, gold:.10 },
  { key:"growth",       label:"Growth",       equity:.70, debt:.20, gold:.10 },
  { key:"aggressive",   label:"Aggressive",   equity:.80, debt:.10, gold:.10 }
];

/* Drift below this many percentage points is normally left alone rather than
   traded on. Overridable. */
export const DEFAULT_TOLERANCE_PP = 5;

/* ============================================================
   PARSING HELPERS
   ============================================================ */

/* "₹1,23,456.78" / "1 23 456" / 123456 -> 123456.78. Returns NaN for anything
   with no digits at all, so callers can tell "empty" from "zero". */
export function parseAmount(v){
  if(typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if(v == null) return NaN;
  const s = String(v).trim();
  if(!s) return NaN;
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  /* Extract the first number-like run rather than stripping unwanted
     characters. Stripping would fold the full stop in a "Rs." prefix into the
     digits and turn "Rs. 10,000/-" into 0.1. */
  const m = /\d[\d,\s']*(?:\.\d+)?/.exec(s);
  if(!m) return NaN;
  const n = Number(m[0].replace(/[,\s']/g, ""));
  if(!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}

export function classifyHolding(name, declared){
  const d = String(declared ?? "").trim().toLowerCase();
  if(d){
    for(const [key, words] of Object.entries(DECLARED)){
      if(words.includes(d)) return { key, source:"declared" };
    }
    /* A class column that says something we do not recognise still counts as
       the user having an opinion — fall through to the name guess, but do not
       silently pretend the column was blank. */
  }
  const n = String(name ?? "").toLowerCase();
  if(n){
    for(const key of ["gold","debt","equity"]){
      if(GUESS[key].some(w => n.includes(w))) return { key, source:"guessed" };
    }
  }
  return { key:"other", source:"unknown" };
}

const NAME_HEADERS  = ["name","holding","holdings","scheme","scheme name","fund",
                       "fund name","security","instrument","particulars","description",
                       "asset","investment"];
const VALUE_HEADERS = ["value","amount","current value","market value","market val",
                       "current amount","invested","invested value","worth","corpus",
                       "balance","total","present value","valuation"];
const CLASS_HEADERS = ["class","type","asset class","assetclass","asset type",
                       "category","segment","asset category","kind"];

const norm = s => String(s ?? "").trim().toLowerCase();

/* Find the header row and which column is which. Falls back to positional
   columns (A name, B value, C class) when there is no recognisable header. */
export function detectColumns(rows){
  const limit = Math.min(rows.length, 12);
  for(let r = 0; r < limit; r++){
    const cells = (rows[r] || []).map(norm);
    const name  = cells.findIndex(c => NAME_HEADERS.includes(c));
    const value = cells.findIndex(c => VALUE_HEADERS.includes(c));
    if(name !== -1 && value !== -1){
      return {
        headerRow: r, name, value,
        cls: cells.findIndex(c => CLASS_HEADERS.includes(c))
      };
    }
  }
  return { headerRow: -1, name: 0, value: 1, cls: 2 };
}

/* Spreadsheets almost always carry a "Total" line. Counting it would double
   the portfolio, so drop those rows. */
const TOTAL_ROW = /^\s*(grand\s+)?(total|sum|net\s+total)\b/i;

/* Raw sheet rows -> holdings. Rows without a usable positive amount are
   skipped, and the reason is reported so nothing disappears silently. */
export function normaliseRows(rows){
  const cols = detectColumns(rows || []);
  const start = cols.headerRow + 1;
  const holdings = [], skipped = [];

  for(let r = start; r < (rows || []).length; r++){
    const row = rows[r] || [];
    const rawName = row[cols.name];
    const name = String(rawName ?? "").trim();
    const amount = parseAmount(row[cols.value]);

    if(!name && !Number.isFinite(amount)) continue;          // blank line
    if(TOTAL_ROW.test(name)){ skipped.push({ row:r+1, name, why:"looks like a total row" }); continue; }
    if(!Number.isFinite(amount)){ skipped.push({ row:r+1, name, why:"no amount" }); continue; }
    if(amount <= 0){ skipped.push({ row:r+1, name, why:"amount is not positive" }); continue; }

    const declared = cols.cls === -1 ? "" : row[cols.cls];
    const { key, source } = classifyHolding(name, declared);
    holdings.push({ name: name || "(unnamed)", value: amount, cls: key, source });
  }
  return { holdings, skipped, columns: cols };
}

/* ============================================================
   TARGETS
   ============================================================ */

/* Targets arrive as percentages that users rarely make sum to exactly 100.
   Normalise to fractions summing to 1 and report what was done. */
export function normaliseTargets(t){
  const raw = {
    equity: Math.max(0, Number(t?.equity) || 0),
    debt:   Math.max(0, Number(t?.debt)   || 0),
    gold:   Math.max(0, Number(t?.gold)   || 0)
  };
  const sum = raw.equity + raw.debt + raw.gold;
  if(sum <= 0) return { equity:0, debt:0, gold:0, sum:0, valid:false };
  return {
    equity: raw.equity / sum,
    debt:   raw.debt   / sum,
    gold:   raw.gold   / sum,
    sum, valid: true
  };
}

/* ============================================================
   ANALYSIS
   ============================================================ */

/* Percentages are reported against the CLASSIFIED base (equity + debt + gold).
   Anything unclassified is held out and surfaced separately rather than being
   folded in — a portfolio that is 20% unrecognised should say so, not quietly
   report the other 80% as if it were the whole picture. */
export function analysePortfolio(holdings, targets, opts = {}){
  const list = Array.isArray(holdings) ? holdings : [];
  const tolerance = Number.isFinite(opts.tolerancePp) ? opts.tolerancePp : DEFAULT_TOLERANCE_PP;
  const tgt = normaliseTargets(targets);

  const value = { equity:0, debt:0, gold:0, other:0 };
  const count = { equity:0, debt:0, gold:0, other:0 };
  for(const h of list){
    const k = CLASSES[h.cls] ? h.cls : "other";
    value[k] += Number(h.value) || 0;
    count[k] += 1;
  }

  const base  = value.equity + value.debt + value.gold;
  const grand = base + value.other;

  const classes = CLASS_KEYS.map(key => {
    const current = value[key];
    const currentPct = base > 0 ? current / base : 0;
    const targetPct  = tgt.valid ? tgt[key] : 0;
    const targetValue = base * targetPct;
    const delta = targetValue - current;              // + buy, - sell
    return {
      key, label: CLASSES[key].label,
      value: current, count: count[key],
      currentPct, targetPct,
      driftPp: (currentPct - targetPct) * 100,
      targetValue, delta,
      action: Math.abs(delta) < 0.005 ? "hold" : (delta > 0 ? "buy" : "sell")
    };
  });

  const maxDriftPp = classes.reduce((m, c) => Math.max(m, Math.abs(c.driftPp)), 0);

  return {
    holdings: list,
    classes,
    byKey: Object.fromEntries(classes.map(c => [c.key, c])),
    base, grand,
    unclassified: { value: value.other, count: count.other,
                    pctOfGrand: grand > 0 ? value.other / grand : 0 },
    targets: tgt,
    tolerancePp: tolerance,
    maxDriftPp,
    needsRebalancing: tgt.valid && base > 0 && maxDriftPp > tolerance,
    /* Selling to rebalance realises gains and may attract exit loads, so the
       add-only route is offered alongside. */
    newMoney: newMoneyToRebalance(value, tgt, base)
  };
}

/* Rebalance by adding money only, never selling.
   Find the smallest total T at which every class is at or below its target
   share, then top up the ones that fall short. A class with a zero target but
   a non-zero holding can never be fixed this way — that is reported, not
   papered over. */
export function newMoneyToRebalance(value, tgt, base){
  if(!tgt.valid || base <= 0) return { possible:false, amount:0, add:{equity:0,debt:0,gold:0}, blockedBy:[] };

  const blockedBy = CLASS_KEYS.filter(k => tgt[k] === 0 && value[k] > 0);
  if(blockedBy.length) return { possible:false, amount:0, add:{equity:0,debt:0,gold:0}, blockedBy };

  let total = base;
  for(const k of CLASS_KEYS){
    if(tgt[k] > 0) total = Math.max(total, value[k] / tgt[k]);
  }
  const add = {};
  for(const k of CLASS_KEYS) add[k] = Math.max(0, tgt[k] * total - value[k]);

  return { possible:true, amount: total - base, add, newTotal: total, blockedBy:[] };
}
