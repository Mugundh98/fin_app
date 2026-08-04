import { test } from "node:test";
import assert from "node:assert/strict";
import { summarise, mergeHoldings } from "../../public/src/dash/dash-engine.js";

const close = (a, b, tol = 1e-6, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || "close"}: ${a} vs ${b}`);

const h = (name, value, cls, cost) => ({ name, value, cls, cost, source: "declared" });

const sample = [
  h("Flexi Cap", 500000, "equity"),
  h("Large Cap", 200000, "equity"),
  h("Gilt Fund", 200000, "debt"),
  h("Gold ETF", 100000, "gold")
];

/* ------------------------------------------------------------------
   Totals
   ------------------------------------------------------------------ */

test("totals the portfolio and counts the holdings", () => {
  const s = summarise(sample);
  assert.equal(s.total, 1000000);
  assert.equal(s.count, 4);
  assert.equal(s.empty, false);
});

test("an empty portfolio is all zeroes, never NaN", () => {
  const s = summarise([]);
  assert.equal(s.total, 0);
  assert.equal(s.count, 0);
  assert.equal(s.empty, true);
  assert.equal(s.concentration.largest, null);
  for(const c of s.classes) assert.ok(Number.isFinite(c.pct) && c.pct === 0);
});

test("undefined and rubbish input do not throw", () => {
  for(const v of [undefined, null, [], [{}], [{ value: "abc" }], [{ value: -5 }]]){
    const s = summarise(v);
    assert.ok(Number.isFinite(s.total));
    assert.ok(Number.isFinite(s.gainPct));
  }
});

test("holdings without a positive value are dropped", () => {
  const s = summarise([h("Good", 100, "equity"), h("Zero", 0, "equity"), h("Neg", -5, "debt")]);
  assert.equal(s.count, 1);
  assert.equal(s.total, 100);
});

test("a missing name is labelled rather than left blank", () => {
  const s = summarise([{ value: 100, cls: "equity" }]);
  assert.equal(s.holdings[0].name, "(unnamed)");
});

/* ------------------------------------------------------------------
   Class breakdown
   ------------------------------------------------------------------ */

test("splits by asset class with percentages of the whole", () => {
  const s = summarise(sample);
  close(s.byClass.equity.pct, 70);
  close(s.byClass.debt.pct, 20);
  close(s.byClass.gold.pct, 10);
  assert.equal(s.byClass.equity.count, 2);
});

test("class percentages sum to 100", () => {
  const s = summarise(sample);
  close(sum(s.classes.map(c => c.pct)), 100);
});

test("an unknown class is reported as unclassified, not dropped", () => {
  const s = summarise([...sample, h("Mystery", 250000, "crypto")]);
  assert.equal(s.total, 1250000);
  assert.equal(s.unclassified.value, 250000);
  close(s.unclassified.pct, 20);
});

test("every class appears even when empty, so the table never jumps", () => {
  const s = summarise([h("Only Equity", 100, "equity")]);
  assert.deepEqual(s.classes.map(c => c.key), ["equity", "debt", "gold", "other"]);
  assert.equal(s.byClass.gold.value, 0);
});

/* ------------------------------------------------------------------
   Ranking and concentration
   ------------------------------------------------------------------ */

test("holdings come back largest first, with weights", () => {
  const s = summarise(sample);
  assert.deepEqual(s.holdings.map(x => x.name),
    ["Flexi Cap", "Large Cap", "Gilt Fund", "Gold ETF"]);
  close(s.holdings[0].weight, 50);
  assert.equal(s.holdings[0].rank, 1);
});

test("weights sum to 100", () => {
  const s = summarise(sample);
  close(sum(s.holdings.map(x => x.weight)), 100);
});

test("concentration reports the top one, three and five", () => {
  const s = summarise(sample);
  close(s.concentration.top1, 50);
  close(s.concentration.top3, 90);
  close(s.concentration.top5, 100);   // only four holdings exist
  assert.equal(s.concentration.largest.name, "Flexi Cap");
  assert.equal(s.concentration.smallest.name, "Gold ETF");
});

test("concentration never exceeds 100 when there are fewer holdings than N", () => {
  const s = summarise([h("Only", 100, "equity")]);
  close(s.concentration.top1, 100);
  close(s.concentration.top5, 100);
});

test("top1 <= top3 <= top5, always", () => {
  const s = summarise(sample);
  assert.ok(s.concentration.top1 <= s.concentration.top3);
  assert.ok(s.concentration.top3 <= s.concentration.top5);
});

/* ------------------------------------------------------------------
   Gain, where a cost is known
   ------------------------------------------------------------------ */

test("with no cost column there is no gain, and it says so", () => {
  const s = summarise(sample);
  assert.equal(s.hasCost, false);
  assert.equal(s.gain, 0);
  assert.equal(s.gainPct, 0);
  assert.equal(s.costCoverage, 0);
});

test("gain is value less cost where both are known", () => {
  const s = summarise([
    h("A", 150000, "equity", 100000),
    h("B", 90000, "debt", 100000)
  ]);
  assert.equal(s.hasCost, true);
  assert.equal(s.invested, 200000);
  assert.equal(s.gain, 40000);
  close(s.gainPct, 20);
  close(s.costCoverage, 100);
});

test("gain covers only the holdings that carry a cost, and reports the coverage", () => {
  const s = summarise([
    h("Costed", 150000, "equity", 100000),
    h("Uncosted", 850000, "equity")
  ]);
  assert.equal(s.total, 1000000);
  assert.equal(s.invested, 100000);
  assert.equal(s.gain, 50000);          // NOT 900000
  close(s.gainPct, 50);
  close(s.costCoverage, 15);            // 150000 of 1000000
});

test("per-holding gain is attached where cost is known and left undefined otherwise", () => {
  const s = summarise([h("A", 150000, "equity", 100000), h("B", 50000, "debt")]);
  const a = s.holdings.find(x => x.name === "A");
  const b = s.holdings.find(x => x.name === "B");
  assert.equal(a.gain, 50000);
  close(a.gainPct, 50);
  assert.equal(b.gain, undefined);
  assert.equal(b.gainPct, undefined);
});

test("a loss is reported as a negative, not hidden", () => {
  const s = summarise([h("Down", 60000, "equity", 100000)]);
  assert.equal(s.gain, -40000);
  close(s.gainPct, -40);
});

test("a zero cost is treated as no cost rather than an infinite return", () => {
  const s = summarise([h("Free", 100000, "equity", 0)]);
  assert.equal(s.hasCost, false);
  assert.ok(Number.isFinite(s.gainPct));
});

/* ------------------------------------------------------------------
   Guessed classifications
   ------------------------------------------------------------------ */

test("counts holdings whose class was guessed rather than declared", () => {
  const s = summarise([
    { name: "A", value: 100, cls: "equity", source: "guessed" },
    { name: "B", value: 100, cls: "debt", source: "declared" },
    { name: "C", value: 100, cls: "gold", source: "guessed" }
  ]);
  assert.equal(s.guessed, 2);
});

/* ------------------------------------------------------------------
   Merging imports
   ------------------------------------------------------------------ */

test("merging adds new holdings", () => {
  const out = mergeHoldings([h("A", 100, "equity")], [h("B", 200, "debt")]);
  assert.equal(out.length, 2);
});

test("the same holding imported twice is summed, not duplicated", () => {
  const out = mergeHoldings([h("Flexi Cap", 100, "equity")], [h("Flexi Cap", 250, "equity")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 350);
});

test("matching ignores case and extra spacing", () => {
  const out = mergeHoldings([h("HDFC  Flexi Cap", 100, "equity")],
                            [h("hdfc flexi cap", 100, "equity")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 200);
});

test("costs are added too when both sides carry one", () => {
  const out = mergeHoldings([h("A", 100, "equity", 80)], [h("A", 100, "equity", 90)]);
  assert.equal(out[0].cost, 170);
});

test("merging into an empty list just takes the incoming", () => {
  const out = mergeHoldings([], [h("A", 100, "equity")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 100);
});

test("merging undefined either side does not throw", () => {
  assert.equal(mergeHoldings(undefined, undefined).length, 0);
  assert.equal(mergeHoldings(null, [h("A", 1, "equity")]).length, 1);
});

test("merging does not mutate the original list", () => {
  const original = [h("A", 100, "equity")];
  mergeHoldings(original, [h("A", 100, "equity")]);
  assert.equal(original[0].value, 100);
});

function sum(ns){ return ns.reduce((a, b) => a + b, 0); }
