import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScreener } from "../../public/src/stock/screener-parse.js";
import {
  series, pickSeries, isTtm, annual, cagr, ratioSeries, latest, promoterTrend, analyseStock
} from "../../public/src/stock/stock-engine.js";
import { PAGE } from "./screener-parse.test.js";

const close = (a, b, tol = 1e-9, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || "close"}: ${a} vs ${b}`);

const pts = (...vals) => vals.map((value, i) => ({ period: "Y" + i, value }));

/* ------------------------------------------------------------------
   Series handling
   ------------------------------------------------------------------ */

test("a series pairs each value with its own period", () => {
  const t = { periods: ["Mar 2024", "Mar 2025"], byLabel: { Sales: [100, 200] } };
  assert.deepEqual(series(t, "Sales"),
    [{ period: "Mar 2024", value: 100 }, { period: "Mar 2025", value: 200 }]);
});

test("a missing line item is an empty series, not a throw", () => {
  assert.deepEqual(series({ periods: ["A"], byLabel: {} }, "Nope"), [{ period: "A", value: null }]);
  assert.deepEqual(series(undefined, "Nope"), []);
});

test("TTM is recognised and excluded from year-on-year maths", () => {
  assert.equal(isTtm("TTM"), true);
  assert.equal(isTtm(" ttm "), true);
  assert.equal(isTtm("Mar 2026"), false);
  const p = [{ period: "Mar 2025", value: 1 }, { period: "TTM", value: 2 }];
  assert.equal(annual(p).length, 1);
});

/* ------------------------------------------------------------------
   Growth
   ------------------------------------------------------------------ */

test("cagr recovers a rate it was built from", () => {
  /* 100 -> 121 across two years is 10% */
  const g = cagr(pts(100, 110, 121), 2);
  close(g.rate, 0.10, 1e-12);
  assert.equal(g.years, 2);
});

test("cagr uses only as much history as exists, and says so", () => {
  const g = cagr(pts(100, 110, 121), 10);
  assert.equal(g.years, 2);
  assert.equal(g.truncated, true);
  close(g.rate, 0.10, 1e-12);
});

test("cagr over the full window is not marked truncated", () => {
  const g = cagr(pts(100, 110, 121), 2);
  assert.equal(g.truncated, false);
});

test("cagr reports the endpoints it actually used", () => {
  const g = cagr(pts(100, 110, 121), 2);
  assert.equal(g.from, "Y0");
  assert.equal(g.to, "Y2");
  assert.equal(g.fromValue, 100);
  assert.equal(g.toValue, 121);
});

test("cagr ignores TTM so a part year cannot inflate growth", () => {
  const withTtm = [
    { period: "Mar 2024", value: 100 },
    { period: "Mar 2025", value: 121 },
    { period: "TTM", value: 400 }
  ];
  /* One financial year elapsed, so 100 -> 121 is 21%. The 400 in the TTM
     column must not touch it — counted, it would read as enormous growth. */
  const g = cagr(withTtm, 5);
  close(g.rate, 0.21, 1e-12);
  assert.equal(g.to, "Mar 2025");
  assert.equal(g.years, 1);
});

test("cagr needs two usable points and returns null otherwise", () => {
  assert.equal(cagr(pts(100), 3), null);
  assert.equal(cagr(pts(null, null), 3), null);
  assert.equal(cagr([], 3), null);
});

test("cagr skips holes rather than treating them as zero", () => {
  const g = cagr(pts(100, null, 121), 5);
  close(g.rate, 0.10, 1e-12);
});

test("a loss-making endpoint gives null rather than a complex root", () => {
  assert.equal(cagr(pts(-50, -20), 3), null);
  const g = cagr(pts(100, -50, 121), 5);
  close(g.rate, 0.10, 1e-12);   // the negative year is skipped
});

/* ------------------------------------------------------------------
   Derived series
   ------------------------------------------------------------------ */

test("ratio series divides element by element", () => {
  const r = ratioSeries(pts(50, 60), pts(200, 200));
  close(r[0].value, 25);
  close(r[1].value, 30);
});

test("a ratio is null where either side is missing or zero", () => {
  const r = ratioSeries(pts(50, 60, 70), pts(null, 0, 200));
  assert.equal(r[0].value, null);
  assert.equal(r[1].value, null);
  close(r[2].value, 35);
});

test("latest finds the last real value, skipping trailing holes", () => {
  assert.equal(latest(pts(1, 2, null)).value, 2);
  assert.equal(latest(pts(null, null)), null);
  assert.equal(latest([]), null);
});

/* ------------------------------------------------------------------
   Promoter holding
   ------------------------------------------------------------------ */

test("promoter trend reports level and direction", () => {
  const t = promoterTrend(pts(55, 54, 53, 52, 51));
  assert.equal(t.latest.value, 51);
  close(t.changeQoQ, -1);
  close(t.change4Q, -4);
  assert.equal(t.direction, "falling");
});

test("a rise is reported as rising", () => {
  assert.equal(promoterTrend(pts(50, 50, 50, 50, 52)).direction, "rising");
});

test("rounding noise is not a trend", () => {
  assert.equal(promoterTrend(pts(50.00, 50.01, 50.00, 49.99, 50.02)).direction, "steady");
});

test("promoter trend with no data does not throw", () => {
  const t = promoterTrend([]);
  assert.equal(t.latest, null);
  assert.equal(t.direction, "unknown");
});

/* ------------------------------------------------------------------
   End to end, from the parsed fixture page
   ------------------------------------------------------------------ */

test("analyses a parsed page into headline figures", () => {
  const a = analyseStock(parseScreener(PAGE));
  assert.equal(a.name, "Reliance Industries Ltd");
  assert.equal(a.usable, true);
  assert.equal(a.latest.sales.value, 552939);      // TTM is the latest reported
  assert.equal(a.latest.netProfit.value, 41000);
});

test("operating margin is computed from the company's own lines", () => {
  const a = analyseStock(parseScreener(PAGE));
  /* Mar 2026: 54,455 / 504,026 */
  const mar26 = a.operatingMargin.find(p => p.period === "Mar 2026");
  close(mar26.value, (54455 / 504026) * 100, 1e-9);
});

test("net worth is share capital plus reserves", () => {
  const a = analyseStock(parseScreener(PAGE));
  const mar26 = a.netWorth.find(p => p.period === "Mar 2026");
  assert.equal(mar26.value, 13532 + 552703);
});

test("debt to equity uses net worth, not share capital alone", () => {
  const a = analyseStock(parseScreener(PAGE));
  const mar26 = a.debtToEquity.find(p => p.period === "Mar 2026");
  close(mar26.value, 234008 / (13532 + 552703), 1e-12);
  assert.ok(mar26.value < 1, "a sane gearing figure");
});

test("growth is computed on annual columns only", () => {
  const a = analyseStock(parseScreener(PAGE));
  assert.ok(a.growth.sales3);
  assert.equal(a.growth.sales3.to, "Mar 2026");   // not TTM
  assert.equal(a.growth.sales3.truncated, true);  // only 3 annual columns exist
});

test("promoter holding is read off the shareholding table", () => {
  const a = analyseStock(parseScreener(PAGE));
  assert.equal(a.promoters.latest.value, 50.48);
  assert.equal(a.promoters.latest.period, "Jun 2026");
  assert.equal(a.promoters.direction, "rising");
});

test("FII and DII series come through alongside", () => {
  const a = analyseStock(parseScreener(PAGE));
  assert.equal(a.shareholding.fiis.at(-1).value, 17.19);
  assert.equal(a.shareholding.diis.at(-1).value, 21.10);
});

test("an unusable page analyses to empty rather than throwing", () => {
  const a = analyseStock(parseScreener("<html><body>Access denied</body></html>"));
  assert.equal(a.usable, false);
  assert.equal(a.latest.sales, null);
  assert.equal(a.promoters.direction, "unknown");
  assert.deepEqual(a.sales, []);
});

test("analysing undefined does not throw", () => {
  const a = analyseStock(undefined);
  assert.equal(a.usable, false);
  assert.deepEqual(a.sales, []);
});

test("a gap year still counts as a year elapsed", () => {
  /* The regression: compacting usable points before measuring the span
     turned two years of 10% growth into one year of 21%. */
  const g = cagr(pts(100, null, 121), 5);
  close(g.rate, 0.10, 1e-12);
  assert.equal(g.years, 2);
});

test("a loss year in the middle does not shorten the timeline", () => {
  const g = cagr(pts(100, -50, 121), 5);
  close(g.rate, 0.10, 1e-12);
  assert.equal(g.years, 2);
});

test("the window is measured back from the latest year, not the first usable one", () => {
  /* Ten years of history, three-year window: must start at Y7. */
  const g = cagr(pts(10, 20, 30, 40, 50, 60, 70, 80, 90, 100), 3);
  assert.equal(g.from, "Y6");
  assert.equal(g.to, "Y9");
  assert.equal(g.years, 3);
  assert.equal(g.truncated, false);
});

/* ------------------------------------------------------------------
   Banks and NBFCs label the same lines differently
   ------------------------------------------------------------------ */

const BANK = parseScreener(`<h1>HDFC Bank Ltd</h1>
<section id="profit-loss"><table>
<thead><tr><th class="text"></th><th>Mar 2024</th><th>Mar 2025</th><th>Mar 2026</th></tr></thead>
<tbody>
<tr><td class="text">Revenue</td><td>283,649</td><td>335,000</td><td>380,000</td></tr>
<tr><td class="text">Financing Profit</td><td>52,000</td><td>58,000</td><td>64,000</td></tr>
<tr><td class="text">Net Profit</td><td>60,812</td><td>67,000</td><td>73,000</td></tr>
</tbody></table></section>
<section id="balance-sheet"><table>
<thead><tr><th class="text"></th><th>Mar 2026</th></tr></thead>
<tbody>
<tr><td class="text">Equity Capital</td><td>765</td></tr>
<tr><td class="text">Reserves</td><td>500,000</td></tr>
<tr><td class="text">Deposits</td><td>2,500,000</td></tr>
<tr><td class="text">Borrowing</td><td>700,000</td></tr>
</tbody></table></section>`);

test("pickSeries takes the first label that exists", () => {
  const t = { periods: ["A"], byLabel: { Revenue: [10] } };
  assert.equal(pickSeries(t, ["Sales", "Revenue"])[0].value, 10);
  const t2 = { periods: ["A"], byLabel: { Sales: [20] } };
  assert.equal(pickSeries(t2, ["Sales", "Revenue"])[0].value, 20);
});

test("pickSeries with no match gives an empty series, not a throw", () => {
  const t = { periods: ["A"], byLabel: {} };
  assert.equal(pickSeries(t, ["Sales", "Revenue"])[0].value, null);
});

test("a bank's Revenue is read as sales", () => {
  const a = analyseStock(BANK);
  assert.equal(a.latest.sales.value, 380000);
  assert.ok(a.growth.sales3, "no growth computed for a bank");
});

test("a bank's Financing Profit is read as operating profit", () => {
  const a = analyseStock(BANK);
  assert.equal(a.latest.operating.value, 64000);
  close(a.latest.operatingMargin.value, (64000 / 380000) * 100, 1e-9);
});

test("Borrowing in the singular is still borrowing", () => {
  const a = analyseStock(BANK);
  const mar26 = a.borrowings.find(p => p.period === "Mar 2026");
  assert.equal(mar26.value, 700000);
});

test("deposits are not counted as leverage for a bank", () => {
  const a = analyseStock(BANK);
  const de = a.latest.debtToEquity.value;
  /* 700,000 / (765 + 500,000) — deposits of 2.5m must not be in there */
  close(de, 700000 / 500765, 1e-9);
  assert.ok(de < 2, "deposits leaked into the gearing figure");
});

test("a manufacturer still reads Sales and Operating Profit", () => {
  const a = analyseStock(parseScreener(PAGE));
  assert.equal(a.latest.sales.value, 552939);
  assert.equal(a.latest.operating.value, 60767);
});

test("a lender's margin carries the source's own name", () => {
  const bank = analyseStock(BANK);
  assert.equal(bank.financing, true);
  assert.equal(bank.marginLabel, "Financing margin");
});

test("a manufacturer's margin is still called operating margin", () => {
  const co = analyseStock(parseScreener(PAGE));
  assert.equal(co.financing, false);
  assert.equal(co.marginLabel, "Operating margin");
});
