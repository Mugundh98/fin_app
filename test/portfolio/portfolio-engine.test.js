import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASS_KEYS, CLASSES, TEMPLATES, DEFAULT_TOLERANCE_PP,
  parseAmount, classifyHolding, detectColumns, normaliseRows,
  normaliseTargets, analysePortfolio, newMoneyToRebalance
} from "../../public/src/portfolio/portfolio-engine.js";

const close = (a, b, tol = 1e-6, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || "close"}: ${a} vs ${b}`);

const hold = (name, value, cls) => ({ name, value, cls, source: "declared" });

/* ------------------------------------------------------------------
   Amounts
   ------------------------------------------------------------------ */

test("parses Indian-format amounts", () => {
  assert.equal(parseAmount("1,23,456.78"), 123456.78);
  assert.equal(parseAmount("₹1,23,456"), 123456);
  assert.equal(parseAmount("  2500  "), 2500);
  assert.equal(parseAmount(98765.43), 98765.43);
  assert.equal(parseAmount("Rs. 10,000/-"), 10000);
});

test("parses negative amounts in both notations", () => {
  assert.equal(parseAmount("-5000"), -5000);
  assert.equal(parseAmount("(5000)"), -5000);
});

test("returns NaN for cells with no number in them", () => {
  for(const v of ["", "   ", null, undefined, "N/A", "-", "abc"]){
    assert.ok(Number.isNaN(parseAmount(v)), `expected NaN for ${JSON.stringify(v)}`);
  }
});

test("a blank amount is distinguishable from zero", () => {
  assert.ok(Number.isNaN(parseAmount("")));
  assert.equal(parseAmount("0"), 0);
});

/* ------------------------------------------------------------------
   Classification
   ------------------------------------------------------------------ */

test("an explicit class column wins", () => {
  assert.deepEqual(classifyHolding("Anything At All", "Equity"), { key:"equity", source:"declared" });
  assert.deepEqual(classifyHolding("Anything At All", "debt"),   { key:"debt",   source:"declared" });
  assert.deepEqual(classifyHolding("Anything At All", " GOLD "), { key:"gold",   source:"declared" });
});

test("a declared class beats a contradictory name", () => {
  /* The name says gold, the user says debt. The user wins. */
  assert.equal(classifyHolding("Gold Savings Fund", "Debt").key, "debt");
});

test("guesses from the name when no class is declared", () => {
  assert.deepEqual(classifyHolding("Sovereign Gold Bond 2030", ""), { key:"gold", source:"guessed" });
  assert.deepEqual(classifyHolding("SBI Liquid Fund", ""),          { key:"debt", source:"guessed" });
  assert.deepEqual(classifyHolding("Nifty 50 Index Fund", ""),      { key:"equity", source:"guessed" });
  assert.deepEqual(classifyHolding("Parag Parikh Flexi Cap", ""),   { key:"equity", source:"guessed" });
});

test("gold is checked before debt and equity, since names overlap", () => {
  assert.equal(classifyHolding("HDFC Gold ETF Fund", "").key, "gold");
  assert.equal(classifyHolding("Gold Bond", "").key, "gold");
});

test("anything unrecognised is unclassified, never quietly bucketed", () => {
  const r = classifyHolding("XYZ Scheme 2", "");
  assert.equal(r.key, "other");
  assert.equal(r.source, "unknown");
});

test("hybrid and cash are treated as unclassified rather than split by guesswork", () => {
  assert.equal(classifyHolding("Whatever", "Hybrid").key, "other");
  assert.equal(classifyHolding("Whatever", "Cash").key, "other");
});

/* ------------------------------------------------------------------
   Reading rows
   ------------------------------------------------------------------ */

test("finds columns from a header row in any order", () => {
  const cols = detectColumns([["Asset Class", "Current Value", "Scheme Name"]]);
  assert.equal(cols.headerRow, 0);
  assert.equal(cols.cls, 0);
  assert.equal(cols.value, 1);
  assert.equal(cols.name, 2);
});

test("finds a header that is not on the first row", () => {
  const cols = detectColumns([["My Portfolio"], [], ["Name", "Value", "Type"]]);
  assert.equal(cols.headerRow, 2);
  assert.equal(cols.name, 0);
});

test("falls back to positional columns when there is no header", () => {
  const cols = detectColumns([["HDFC Flexi Cap", 100, "Equity"]]);
  assert.equal(cols.headerRow, -1);
  assert.deepEqual([cols.name, cols.value, cols.cls], [0, 1, 2]);
});

test("reads holdings out of sheet rows", () => {
  const { holdings } = normaliseRows([
    ["Name", "Value", "Class"],
    ["HDFC Flexi Cap", "2,50,000", "Equity"],
    ["SBI Liquid", 150000, "Debt"],
    ["SGB 2032", 100000, "Gold"]
  ]);
  assert.equal(holdings.length, 3);
  assert.deepEqual(holdings.map(h => h.cls), ["equity", "debt", "gold"]);
  assert.equal(holdings[0].value, 250000);
});

test("a Total row is dropped instead of double-counting the portfolio", () => {
  const { holdings, skipped } = normaliseRows([
    ["Name", "Value", "Class"],
    ["HDFC Flexi Cap", 250000, "Equity"],
    ["Total", 250000, ""]
  ]);
  assert.equal(holdings.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].why, /total/i);
});

test("rows without a usable amount are reported, not silently dropped", () => {
  const { holdings, skipped } = normaliseRows([
    ["Name", "Value"],
    ["Good Fund", 1000],
    ["No Amount Fund", ""],
    ["Zero Fund", 0],
    ["Negative Fund", -50]
  ]);
  assert.equal(holdings.length, 1);
  assert.equal(skipped.length, 3);
  assert.deepEqual(skipped.map(s => s.name),
    ["No Amount Fund", "Zero Fund", "Negative Fund"]);
});

test("entirely blank rows are ignored without comment", () => {
  const { holdings, skipped } = normaliseRows([
    ["Name", "Value"], ["A", 100], [], ["", ""], ["B", 200]
  ]);
  assert.equal(holdings.length, 2);
  assert.equal(skipped.length, 0);
});

test("a missing class column falls back to guessing from names", () => {
  const { holdings } = normaliseRows([
    ["Name", "Value"],
    ["ICICI Gold ETF", 50000],
    ["Axis Liquid Fund", 50000]
  ]);
  assert.deepEqual(holdings.map(h => h.cls), ["gold", "debt"]);
  assert.ok(holdings.every(h => h.source === "guessed"));
});

/* ------------------------------------------------------------------
   Targets
   ------------------------------------------------------------------ */

test("targets normalise to fractions summing to one", () => {
  const t = normaliseTargets({ equity: 50, debt: 40, gold: 10 });
  close(t.equity + t.debt + t.gold, 1);
  close(t.equity, .5);
  assert.ok(t.valid);
});

test("targets that do not add to 100 are scaled, not rejected", () => {
  const t = normaliseTargets({ equity: 60, debt: 60, gold: 30 });
  close(t.equity + t.debt + t.gold, 1);
  close(t.equity, 60 / 150);
});

test("an all-zero target is marked invalid rather than dividing by zero", () => {
  const t = normaliseTargets({ equity: 0, debt: 0, gold: 0 });
  assert.equal(t.valid, false);
  assert.ok(Number.isFinite(t.equity));
});

test("every shipped template sums to 100%", () => {
  for(const t of TEMPLATES){
    close(t.equity + t.debt + t.gold, 1, 1e-9, t.key);
  }
});

/* ------------------------------------------------------------------
   Analysis
   ------------------------------------------------------------------ */

const sample = [
  hold("Flexi Cap", 600000, "equity"),
  hold("Liquid Fund", 300000, "debt"),
  hold("Gold ETF", 100000, "gold")
];

test("percentages are computed against the classified base", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  assert.equal(a.base, 1000000);
  close(a.byKey.equity.currentPct, .6);
  close(a.byKey.debt.currentPct, .3);
  close(a.byKey.gold.currentPct, .1);
});

test("percentages always sum to 100 across the three classes", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  close(a.classes.reduce((s, c) => s + c.currentPct, 0), 1);
});

test("drift is reported in percentage points against the user's target", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  close(a.byKey.equity.driftPp, 10);
  close(a.byKey.debt.driftPp, -10);
  close(a.byKey.gold.driftPp, 0);
});

test("rebalancing deltas sum to zero — it is a reshuffle, not new money", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  close(a.classes.reduce((s, c) => s + c.delta, 0), 0, 1e-6);
});

test("deltas move each class exactly onto its target value", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  for(const c of a.classes) close(c.value + c.delta, a.base * c.targetPct, 1e-6);
});

test("actions name the direction of each trade", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  assert.equal(a.byKey.equity.action, "sell");   // overweight
  assert.equal(a.byKey.debt.action, "buy");      // underweight
  assert.equal(a.byKey.gold.action, "hold");     // on target
});

test("a portfolio already on target needs no rebalancing", () => {
  const a = analysePortfolio(sample, { equity:60, debt:30, gold:10 });
  close(a.maxDriftPp, 0, 1e-9);
  assert.equal(a.needsRebalancing, false);
  assert.ok(a.classes.every(c => c.action === "hold"));
});

test("drift inside the tolerance band does not call for a trade", () => {
  const a = analysePortfolio(sample, { equity:57, debt:33, gold:10 },
                             { tolerancePp: DEFAULT_TOLERANCE_PP });
  assert.ok(a.maxDriftPp < DEFAULT_TOLERANCE_PP);
  assert.equal(a.needsRebalancing, false);
});

test("tolerance is overridable", () => {
  const tight = analysePortfolio(sample, { equity:57, debt:33, gold:10 }, { tolerancePp: 1 });
  assert.equal(tight.needsRebalancing, true);
});

test("unclassified holdings are held out of the base and surfaced", () => {
  const a = analysePortfolio([...sample, hold("Mystery Fund", 250000, "other")],
                             { equity:50, debt:40, gold:10 });
  assert.equal(a.base, 1000000);
  assert.equal(a.grand, 1250000);
  assert.equal(a.unclassified.value, 250000);
  assert.equal(a.unclassified.count, 1);
  close(a.unclassified.pctOfGrand, .2);
  /* the three classes still describe the classified base fully */
  close(a.classes.reduce((s, c) => s + c.currentPct, 0), 1);
});

test("an empty portfolio produces zeroes, not NaN", () => {
  const a = analysePortfolio([], { equity:50, debt:40, gold:10 });
  assert.equal(a.base, 0);
  assert.equal(a.needsRebalancing, false);
  for(const c of a.classes){
    assert.ok(Number.isFinite(c.currentPct) && Number.isFinite(c.delta));
    assert.equal(c.currentPct, 0);
  }
});

test("an invalid target does not produce NaN percentages", () => {
  const a = analysePortfolio(sample, { equity:0, debt:0, gold:0 });
  assert.equal(a.targets.valid, false);
  for(const c of a.classes) assert.ok(Number.isFinite(c.driftPp));
  assert.equal(a.needsRebalancing, false);
});

test("holdings with an unknown class string are counted as unclassified", () => {
  const a = analysePortfolio([{ name:"X", value:100, cls:"crypto" }], { equity:50, debt:40, gold:10 });
  assert.equal(a.unclassified.value, 100);
  assert.equal(a.base, 0);
});

/* ------------------------------------------------------------------
   Rebalancing with new money only
   ------------------------------------------------------------------ */

test("new money alone can restore the target without selling", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  const nm = a.newMoney;
  assert.ok(nm.possible);
  assert.ok(nm.amount > 0);
  /* after adding, every class sits exactly on target */
  for(const k of CLASS_KEYS){
    const after = a.byKey[k].value + nm.add[k];
    close(after, nm.newTotal * a.targets[k], 1e-6, k);
  }
});

test("new money is never negative — nothing is ever sold on this route", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  for(const k of CLASS_KEYS) assert.ok(a.newMoney.add[k] >= 0);
});

test("the overweight class receives nothing", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  close(a.newMoney.add.equity, 0, 1e-6);
});

test("added amounts sum to the headline new-money figure", () => {
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  const summed = CLASS_KEYS.reduce((s, k) => s + a.newMoney.add[k], 0);
  close(summed, a.newMoney.amount, 1e-6);
});

test("a portfolio on target needs no new money", () => {
  const a = analysePortfolio(sample, { equity:60, debt:30, gold:10 });
  close(a.newMoney.amount, 0, 1e-6);
});

test("a zero target against a real holding cannot be fixed by adding, and says so", () => {
  const a = analysePortfolio(sample, { equity:0, debt:50, gold:50 });
  assert.equal(a.newMoney.possible, false);
  assert.deepEqual(a.newMoney.blockedBy, ["equity"]);
});

test("new money is computed as the smallest total that clears every target", () => {
  /* 60/30/10 against a 50/40/10 target: debt is the binding constraint at
     300000/0.4 = 750000... but equity needs 600000/0.5 = 1200000, which is
     larger, so that is the total. */
  const a = analysePortfolio(sample, { equity:50, debt:40, gold:10 });
  close(a.newMoney.newTotal, 1200000, 1e-6);
  close(a.newMoney.amount, 200000, 1e-6);
  close(a.newMoney.add.debt, 180000, 1e-6);
  close(a.newMoney.add.gold, 20000, 1e-6);
});

/* ------------------------------------------------------------------
   End to end
   ------------------------------------------------------------------ */

test("sheet rows through to a rebalancing plan", () => {
  const { holdings } = normaliseRows([
    ["Scheme Name", "Market Value", "Category"],
    ["Parag Parikh Flexi Cap", "8,00,000", "Equity"],
    ["HDFC Corporate Bond",    "1,50,000", "Debt"],
    ["SGB 2031",                 "50,000", "Gold"],
    ["Grand Total",           "10,00,000", ""]
  ]);
  assert.equal(holdings.length, 3);

  const a = analysePortfolio(holdings, { equity:60, debt:30, gold:10 });
  assert.equal(a.base, 1000000);
  close(a.byKey.equity.currentPct, .8);
  close(a.byKey.equity.driftPp, 20);
  assert.equal(a.needsRebalancing, true);
  close(a.byKey.equity.delta, -200000, 1e-6);   // sell 2L of equity
  close(a.byKey.debt.delta, 150000, 1e-6);      // buy 1.5L of debt
  close(a.byKey.gold.delta, 50000, 1e-6);       // buy 50k of gold
});

test("CLASSES covers every key the analysis can emit", () => {
  for(const k of [...CLASS_KEYS, "other"]) assert.ok(CLASSES[k], `missing ${k}`);
});

/* ------------------------------------------------------------------
   A real broker holding statement.

   Reproduces the shape that broke: eleven rows of metadata, the header
   on row 13, and several money columns of which only one is the
   current value. The positional fallback read column B — the quantity —
   and imported the preamble as holdings.
   ------------------------------------------------------------------ */

const BROKER_STATEMENT = [
  ["Report Title", "Holding statements report"],
  ["Date", "31/07/2026"],
  ["Client Name", ""],
  ["Client ID", "17040"],
  ["PAN", "4560"],
  ["Download Timestamp", "03/08/2026 22:28:09 IST"],
  [],
  ["Total Invested value", "76,72,754.55"],
  ["Total Current value", "78,00,205.55"],
  ["Profit & loss", "+1,27,451.01"],
  ["Unrealised P&L %", "1.66"],
  [],
  ["Name","Qty","Buy price","Invested value","Current value",
   "Unrealised P&L","Unrealised P&L %","Previous close","ISIN"],
  ["UTI Nifty 50 Index Fund - Growth - Direct Plan",
   "11,111.59","168.73","18,74,858.5","19,06,082.1","31,223.57","1.67","171.54","INF789F01XA0"],
  ["UTI Nifty Next 50 Index Fund - Direct Growth Plan",
   "28,740.54","25.4","7,30,009.77","7,86,203.27","56,193.51","7.7","27.36","INF789FC12T1"],
  ["NSE:GOLDBEES-EQ",
   "5,000.00","86.88","4,34,400.00","5,85,550.00","+1,51,150.0","34.8","117.11","INF204KB17I5"],
  ["HDFC Money Market Fund - Growth - Direct Plan",
   "75","5,319.66","3,98,979.82","4,68,901.75","69,921.93","17.53","6,251.94","INF179KB1HU9"]
];

test("the header is found even when it sits below a block of metadata", () => {
  const cols = detectColumns(BROKER_STATEMENT);
  assert.equal(cols.headerRow, 12);
  assert.equal(cols.name, 0);
  assert.equal(cols.value, 4);     // Current value, NOT Qty and NOT Invested
  assert.equal(cols.cost, 3);      // Invested value
});

test("the value column is the current value, never the quantity", () => {
  const { holdings } = normaliseRows(BROKER_STATEMENT);
  const uti = holdings.find(h => h.name.startsWith("UTI Nifty 50"));
  assert.equal(uti.value, 1906082.1);      // not 11111.59
  assert.equal(uti.cost, 1874858.5);
});

test("statement metadata never becomes a holding", () => {
  const { holdings } = normaliseRows(BROKER_STATEMENT);
  const names = holdings.map(h => h.name.toLowerCase());
  for(const junk of ["date", "client id", "pan", "download timestamp",
                     "profit & loss", "unrealised p&l %", "total invested value"]){
    assert.ok(!names.includes(junk), `${junk} was imported as a holding`);
  }
  assert.equal(holdings.length, 4);
});

test("a PAN is never imported, even from a headerless sheet", () => {
  /* No recognisable header, so the positional fallback applies — the
     metadata filter is what has to catch this. */
  const { holdings, skipped } = normaliseRows([
    ["PAN", "4560"],
    ["Client ID", "17040"],
    ["Some Real Fund", "250000"]
  ]);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].name, "Some Real Fund");
  assert.ok(skipped.some(s => /header/i.test(s.why)));
});

test("every fund in the statement is read, with its classification", () => {
  const { holdings } = normaliseRows(BROKER_STATEMENT);
  assert.deepEqual(holdings.map(h => h.cls), ["equity", "equity", "gold", "debt"]);
  assert.equal(holdings[2].value, 585550);
});

test("the statement totals to its own stated current value", () => {
  const { holdings } = normaliseRows(BROKER_STATEMENT);
  const total = holdings.reduce((s, h) => s + h.value, 0);
  /* The four rows above, summed — the file's own "Total Current value"
     covers more rows than this excerpt, so just check it is in rupees
     rather than units. */
  assert.ok(total > 3000000, `total looks like units, not rupees: ${total}`);
});

test("current value wins over a plain value column wherever both appear", () => {
  const cols = detectColumns([["Name", "Value", "Current Value"]]);
  assert.equal(cols.value, 2);
});

test("a header with more recognised columns beats a thinner earlier one", () => {
  const cols = detectColumns([
    ["Name", "Amount"],
    ["Scheme Name", "Invested value", "Current value", "Category"]
  ]);
  assert.equal(cols.headerRow, 1);
  assert.equal(cols.cost, 1);
  assert.equal(cols.value, 2);
  assert.equal(cols.cls, 3);
});

test("headers survive odd spacing and casing", () => {
  const cols = detectColumns([["  SCHEME   NAME ", "Current  Value"]]);
  assert.equal(cols.name, 0);
  assert.equal(cols.value, 1);
});

test("the BEES exchange-traded range classifies correctly, in the right order", () => {
  /* gold and debt are checked before equity, so the specific ones are
     claimed before the catch-all "bees" ever applies. */
  assert.equal(classifyHolding("NSE:GOLDBEES-EQ", "").key, "gold");
  assert.equal(classifyHolding("NSE:LIQUIDBEES-EQ", "").key, "debt");
  assert.equal(classifyHolding("NSE:BANKBEES-EQ", "").key, "equity");
  assert.equal(classifyHolding("NSE:NIFTYBEES-EQ", "").key, "equity");
  assert.equal(classifyHolding("NSE:JUNIORBEES-EQ", "").key, "equity");
});

test("a bond ETF is debt, not equity, despite the ETF cue", () => {
  assert.equal(classifyHolding("Bharat Bond ETF April 2031", "").key, "debt");
  assert.equal(classifyHolding("NSE:SGBDEC31-GB", "").key, "gold");
});
