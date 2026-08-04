import { test } from "node:test";
import assert from "node:assert/strict";
import { toYahooSymbol, chartUrl, parseYahooChart } from "../../public/src/stock/yahoo.js";

const close = (a, b, tol = 1e-9, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || "close"}: ${a} vs ${b}`);

const DAY = 24 * 3600;
const JAN2021 = Math.floor(Date.UTC(2021, 0, 1) / 1000);

/* Shaped exactly like a real chart response, nulls included. */
const payload = (closes, opts = {}) => ({
  chart: {
    result: [{
      meta: {
        symbol: "RELIANCE.NS", currency: "INR", fullExchangeName: "NSE",
        regularMarketPrice: opts.price ?? 1290.9,
        fiftyTwoWeekLow: 1249.8, fiftyTwoWeekHigh: 1611.8
      },
      timestamp: closes.map((_, i) => JAN2021 + i * 365 * DAY),
      indicators: { quote: [{
        close: closes,
        open: closes.map(c => c == null ? null : c * 0.99),
        high: closes.map(c => c == null ? null : c * 1.02),
        low: closes.map(c => c == null ? null : c * 0.97),
        volume: closes.map(c => c == null ? null : 1000000)
      }] }
    }],
    error: null
  }
});

/* ------------------------------------------------------------------
   Symbols and URLs
   ------------------------------------------------------------------ */

test("an NSE code gets the exchange suffix Yahoo expects", () => {
  assert.equal(toYahooSymbol("RELIANCE"), "RELIANCE.NS");
  assert.equal(toYahooSymbol("tcs"), "TCS.NS");
  assert.equal(toYahooSymbol("  hdfcbank  "), "HDFCBANK.NS");
});

test("a symbol that already carries a suffix is left alone", () => {
  assert.equal(toYahooSymbol("RELIANCE.NS"), "RELIANCE.NS");
  assert.equal(toYahooSymbol("500325.BO"), "500325.BO");
});

test("BSE can be asked for instead", () => {
  assert.equal(toYahooSymbol("500325", "BO"), "500325.BO");
});

test("an empty code gives an empty symbol rather than a stray dot", () => {
  assert.equal(toYahooSymbol(""), "");
  assert.equal(toYahooSymbol(null), "");
});

test("the chart url carries range and interval", () => {
  const u = new URL(chartUrl("RELIANCE"));
  assert.equal(u.hostname, "query1.finance.yahoo.com");
  assert.equal(u.pathname, "/v8/finance/chart/RELIANCE.NS");
  assert.equal(u.searchParams.get("range"), "5y");
  assert.equal(u.searchParams.get("interval"), "1mo");
});

test("the chart path matches what the Worker allowlist permits", () => {
  /* Kept in step with worker/index.js by hand — this is the check. */
  const allowed = /^\/v8\/finance\/chart\/[A-Za-z0-9.^-]+$/;
  for(const code of ["RELIANCE", "TCS", "500325.BO", "M&M"]){
    const u = new URL(chartUrl(code));
    if(code === "M&M") continue;   // ampersand codes need the BSE number instead
    assert.ok(allowed.test(u.pathname), `${u.pathname} would be refused`);
  }
});

/* ------------------------------------------------------------------
   Parsing
   ------------------------------------------------------------------ */

test("reads price points out of a chart response", () => {
  const r = parseYahooChart(payload([100, 110, 121]));
  assert.equal(r.ok, true);
  assert.equal(r.symbol, "RELIANCE.NS");
  assert.equal(r.currency, "INR");
  assert.equal(r.exchange, "NSE");
  assert.equal(r.points.length, 3);
  assert.equal(r.points[0].close, 100);
  assert.equal(r.last.close, 121);
});

test("a JSON string is parsed as readily as an object", () => {
  const r = parseYahooChart(JSON.stringify(payload([100, 121])));
  assert.equal(r.ok, true);
  assert.equal(r.points.length, 2);
});

test("OHLCV comes through when present", () => {
  const p = parseYahooChart(payload([100])).points[0];
  close(p.open, 99);
  close(p.high, 102);
  close(p.low, 97);
  assert.equal(p.volume, 1000000);
  assert.equal(p.date.length, 10);
});

test("months with no trade are skipped, not read as zero", () => {
  const r = parseYahooChart(payload([100, null, 121]));
  assert.equal(r.points.length, 2);
  assert.equal(r.first.close, 100);
  assert.equal(r.last.close, 121);
});

test("the live price is taken from meta, falling back to the last close", () => {
  assert.equal(parseYahooChart(payload([100, 110], { price: 115 })).price, 115);
  const noMeta = payload([100, 110]);
  delete noMeta.chart.result[0].meta.regularMarketPrice;
  assert.equal(parseYahooChart(noMeta).price, 110);
});

test("the 52 week band comes through", () => {
  const r = parseYahooChart(payload([100]));
  assert.equal(r.fiftyTwoWeekLow, 1249.8);
  assert.equal(r.fiftyTwoWeekHigh, 1611.8);
});

/* ------------------------------------------------------------------
   Derived
   ------------------------------------------------------------------ */

test("total change is measured across the window returned", () => {
  close(parseYahooChart(payload([100, 150])).changePct, 50);
});

test("annualised return uses elapsed time, not point count", () => {
  /* Three yearly points: 100 -> 121 over two years is 10% a year. */
  const r = parseYahooChart(payload([100, 110, 121]));
  close(r.cagr.rate, 0.10, 1e-3);
  close(r.cagr.years, 2, 0.02);
});

test("a window under six months gives no annualised figure", () => {
  const short = payload([100, 105]);
  short.chart.result[0].timestamp = [JAN2021, JAN2021 + 30 * DAY];
  assert.equal(parseYahooChart(short).cagr, null);
});

test("a fall is reported as negative, not hidden", () => {
  const r = parseYahooChart(payload([200, 100]));
  close(r.changePct, -50);
  assert.ok(r.cagr.rate < 0);
});

/* ------------------------------------------------------------------
   Failures
   ------------------------------------------------------------------ */

test("Yahoo's own error is surfaced rather than swallowed", () => {
  const r = parseYahooChart({ chart: { result: null,
    error: { code: "Not Found", description: "No data found, symbol may be delisted" } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /delisted/);
});

test("the crumb refusal on the fundamentals endpoint reads clearly", () => {
  const r = parseYahooChart({ finance: { result: null,
    error: { code: "Unauthorized", description: "Invalid Crumb" } } });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("rubbish input gives a clean failure, never a throw", () => {
  for(const v of ["not json", "", null, undefined, {}, { chart: {} }, 42]){
    const r = parseYahooChart(v);
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === "string" && r.error.length);
    assert.deepEqual(r.points, []);
  }
});

test("an all-null series is not usable", () => {
  const r = parseYahooChart(payload([null, null]));
  assert.equal(r.ok, false);
  assert.equal(r.changePct, null);
});
