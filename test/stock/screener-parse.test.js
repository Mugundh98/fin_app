import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeEntities, stripTags, cell, toNumber,
  sectionOf, firstTable, parseDataTable, parseRatios,
  parseCompanyName, parseScreener, hasData
} from "../../public/src/stock/screener-parse.js";

/* ------------------------------------------------------------------
   Fixture modelled on the real page markup, right down to the nested
   value spans, the &nbsp; before the "+" affordance, and the blank
   first header cell.
   ------------------------------------------------------------------ */
const PAGE = `<!DOCTYPE html><html><body>
<h1 class="h2 shrink-text" style="margin: 0.5em 0">Reliance Industries Ltd</h1>

<ul id="top-ratios">
  <li class="flex flex-space-between" data-source="default">
    <span class="name"> Market Cap </span>
    <span class="nowrap value"> &#8377; <span class="number">17,60,260</span> Cr. </span>
  </li>
  <li class="flex flex-space-between">
    <span class="name"> Current Price </span>
    <span class="nowrap value"> &#8377; <span class="number">1,291</span> </span>
  </li>
  <li class="flex flex-space-between">
    <span class="name"> Stock P/E </span>
    <span class="nowrap value"> <span class="number">44.9</span> </span>
  </li>
  <li class="flex flex-space-between">
    <span class="name"> ROCE </span>
    <span class="nowrap value"> <span class="number">7.78</span> % </span>
  </li>
</ul>

<section id="profit-loss" class="card card-large">
<table class="data-table responsive-text-nowrap">
<thead><tr>
  <th class="text"></th>
  <th data-date-key="2024-03-31"> Mar 2024 </th>
  <th data-date-key="2025-03-31"> Mar 2025 </th>
  <th data-date-key="2026-03-31"> Mar 2026 </th>
  <th> TTM </th>
</tr></thead>
<tbody>
  <tr class="stripe"><td class="text">
    <button class="button-plain" onclick="Company.showSchedule('Sales','profit-loss',this)"> Sales&nbsp;<span class="blue-icon">+</span> </button>
  </td><td class=""> 531,908 </td><td class=""> 515,425 </td><td class=""> 504,026 </td><td class=""> 552,939 </td></tr>
  <tr><td class="text"><button class="button-plain"> Expenses&nbsp;<span class="blue-icon">+</span> </button></td>
    <td> 457,488 </td><td> 457,292 </td><td> 449,571 </td><td> 492,172 </td></tr>
  <tr><td class="text">Operating Profit</td>
    <td> 74,420 </td><td> 58,133 </td><td> 54,455 </td><td> 60,767 </td></tr>
  <tr><td class="text">Net Profit&nbsp;<span class="blue-icon">+</span></td>
    <td> 42,042 </td><td> 39,116 </td><td> 39,204 </td><td> 41,000 </td></tr>
  <tr><td class="text">EPS in Rs</td>
    <td> 62.10 </td><td> 57.80 </td><td> 28.97 </td><td> 30.29 </td></tr>
</tbody>
</table>
</section>

<section id="balance-sheet" class="card card-large">
<table class="data-table">
<thead><tr><th class="text"></th><th> Mar 2024 </th><th> Mar 2025 </th><th> Mar 2026 </th></tr></thead>
<tbody>
  <tr><td class="text">Equity Capital</td><td> 6,766 </td><td> 13,532 </td><td> 13,532 </td></tr>
  <tr><td class="text">Reserves</td><td> 508,330 </td><td> 529,555 </td><td> 552,703 </td></tr>
  <tr><td class="text">Borrowings&nbsp;<span class="blue-icon">+</span></td><td> 214,575 </td><td> 201,505 </td><td> 234,008 </td></tr>
  <tr><td class="text">Total Assets</td><td> 1,760,000 </td><td> 1,800,000 </td><td> 1,900,000 </td></tr>
</tbody>
</table>
</section>

<section id="shareholding" class="card card-large">
<table class="data-table">
<thead><tr><th class="text"></th><th> Sep 2025 </th><th> Dec 2025 </th><th> Mar 2026 </th><th> Jun 2026 </th></tr></thead>
<tbody>
  <tr><td class="text"><button class="button-plain"> Promoters&nbsp;<span class="blue-icon">+</span> </button></td>
    <td>50.01%</td><td>50.00%</td><td>50.00%</td><td>50.48%</td></tr>
  <tr><td class="text">FIIs&nbsp;<span class="blue-icon">+</span></td>
    <td>18.65%</td><td>19.09%</td><td>18.67%</td><td>17.19%</td></tr>
  <tr><td class="text">DIIs&nbsp;<span class="blue-icon">+</span></td>
    <td>20.25%</td><td>20.10%</td><td>20.46%</td><td>21.10%</td></tr>
</tbody>
</table>
</section>
</body></html>`;

/* ------------------------------------------------------------------
   Text handling
   ------------------------------------------------------------------ */

test("decodes the entities Screener actually emits", () => {
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("Sales&nbsp;+"), "Sales +");
  assert.equal(decodeEntities("&#8377;100"), "₹100");
  assert.equal(decodeEntities("&lt;b&gt;"), "<b>");
});

test("strips tags to the text a reader would see", () => {
  assert.equal(cell("<button> Sales&nbsp;<span class='blue-icon'>+</span> </button>"), "Sales +");
  assert.equal(cell("  <td>  531,908  </td> "), "531,908");
});

test("parses Indian-format numbers out of cells", () => {
  assert.equal(toNumber("17,60,260"), 1760260);
  assert.equal(toNumber("₹ 1,291"), 1291);
  assert.equal(toNumber("50.27%"), 50.27);
  assert.equal(toNumber("44.9"), 44.9);
  assert.equal(toNumber("-1,234"), -1234);
});

test("a blank or dash is null, not zero", () => {
  for(const v of ["", "  ", "-", "—", null, undefined, "n/a"]){
    assert.equal(toNumber(v), null, `expected null for ${JSON.stringify(v)}`);
  }
  assert.equal(toNumber("0"), 0);
});

/* ------------------------------------------------------------------
   Structure
   ------------------------------------------------------------------ */

test("finds a section by id and stops at its close", () => {
  const s = sectionOf(PAGE, "balance-sheet");
  assert.ok(s.includes("Equity Capital"));
  assert.ok(!s.includes("Promoters"), "ran past the end of the section");
});

test("a missing section is empty rather than an error", () => {
  assert.equal(sectionOf(PAGE, "does-not-exist"), "");
  assert.equal(firstTable(""), "");
  assert.deepEqual(parseDataTable("").rows, []);
});

test("reads the period headings, ignoring the blank label column", () => {
  const t = parseDataTable(firstTable(sectionOf(PAGE, "profit-loss")));
  assert.deepEqual(t.periods, ["Mar 2024", "Mar 2025", "Mar 2026", "TTM"]);
});

test("reads line items, stripping the + affordance from the label", () => {
  const t = parseDataTable(firstTable(sectionOf(PAGE, "profit-loss")));
  assert.deepEqual(t.rows.map(r => r.label),
    ["Sales", "Expenses", "Operating Profit", "Net Profit", "EPS in Rs"]);
});

test("values line up with their columns", () => {
  const t = parseDataTable(firstTable(sectionOf(PAGE, "profit-loss")));
  assert.deepEqual(t.byLabel["Sales"], [531908, 515425, 504026, 552939]);
  assert.deepEqual(t.byLabel["Net Profit"], [42042, 39116, 39204, 41000]);
  assert.equal(t.byLabel["Sales"].length, t.periods.length);
});

test("percentages in the shareholding table come through as numbers", () => {
  const t = parseDataTable(firstTable(sectionOf(PAGE, "shareholding")));
  assert.deepEqual(t.periods, ["Sep 2025", "Dec 2025", "Mar 2026", "Jun 2026"]);
  assert.deepEqual(t.byLabel["Promoters"], [50.01, 50, 50, 50.48]);
  assert.deepEqual(t.byLabel["FIIs"], [18.65, 19.09, 18.67, 17.19]);
});

/* ------------------------------------------------------------------
   Ratio strip
   ------------------------------------------------------------------ */

test("reads the headline ratios, nested value spans and all", () => {
  const r = parseRatios(PAGE);
  const by = Object.fromEntries(r.map(x => [x.label, x]));
  assert.equal(by["Market Cap"].value, 1760260);
  assert.equal(by["Market Cap"].unit, "Cr");
  assert.equal(by["Current Price"].value, 1291);
  assert.equal(by["Stock P/E"].value, 44.9);
  assert.equal(by["ROCE"].value, 7.78);
  assert.equal(by["ROCE"].unit, "%");
});

test("the raw ratio text is kept for display", () => {
  const by = Object.fromEntries(parseRatios(PAGE).map(x => [x.label, x]));
  assert.match(by["Market Cap"].raw, /17,60,260/);
  assert.match(by["Market Cap"].raw, /Cr/);
});

test("no ratio block gives an empty list, not a throw", () => {
  assert.deepEqual(parseRatios("<html><body>nothing</body></html>"), []);
});

/* ------------------------------------------------------------------
   Whole page
   ------------------------------------------------------------------ */

test("reads the company name", () => {
  assert.equal(parseCompanyName(PAGE), "Reliance Industries Ltd");
});

test("parses a whole page into its sections", () => {
  const p = parseScreener(PAGE);
  assert.equal(p.name, "Reliance Industries Ltd");
  assert.equal(p.pnl.rows.length, 5);
  assert.equal(p.balanceSheet.rows.length, 4);
  assert.equal(p.shareholding.rows.length, 3);
  assert.equal(p.usable, true);
});

test("sections that are absent are named rather than silently blank", () => {
  const p = parseScreener(PAGE);
  assert.ok(p.missing.includes("quarters"));
  assert.ok(p.missing.includes("cashFlow"));
  assert.ok(!p.missing.includes("pnl"));
});

test("a page that is nothing like Screener parses to unusable, not a crash", () => {
  const p = parseScreener("<html><body><p>Access denied</p></body></html>");
  assert.equal(p.usable, false);
  assert.equal(p.name, "");
  assert.equal(p.missing.length, 5);
});

test("markup changes degrade one section, not the whole page", () => {
  /* Screener renames the balance sheet section: everything else survives. */
  const broken = PAGE.replace('id="balance-sheet"', 'id="balance-sheet-v2"');
  const p = parseScreener(broken);
  assert.equal(p.pnl.rows.length, 5);
  assert.equal(p.balanceSheet.rows.length, 0);
  assert.ok(p.missing.includes("balanceSheet"));
  assert.equal(p.usable, true);
});

export { PAGE };

/* ------------------------------------------------------------------
   The empty-consolidated trap

   Screener serves /consolidated/ for every company, including the many
   Indian ones with no subsidiaries. For those it returns 200 with the
   table skeleton — labelled rows, no period columns, no values. Counting
   rows alone called that a successful read.
   ------------------------------------------------------------------ */

const SKELETON = `<h1>Castrol India Ltd</h1>
<section id="profit-loss"><table>
<thead><tr><th class="text"></th></tr></thead>
<tbody>
  <tr><td class="text">Sales&nbsp;<span class="blue-icon">+</span></td></tr>
  <tr><td class="text">Expenses&nbsp;<span class="blue-icon">+</span></td></tr>
  <tr><td class="text">Operating Profit</td></tr>
</tbody></table></section>
<section id="shareholding"><table>
<thead><tr><th class="text"></th><th>Mar 2026</th></tr></thead>
<tbody><tr><td class="text">Promoters</td><td>51.00%</td></tr></tbody>
</table></section>`;

test("a table of labels with no values is not usable data", () => {
  const p = parseScreener(SKELETON);
  assert.equal(p.pnl.rows.length, 3, "the labels are still read");
  assert.deepEqual(p.pnl.periods, [], "but there are no periods");
  assert.equal(hasData(p.pnl), false);
});

test("an empty consolidated page reports itself unusable", () => {
  const p = parseScreener(SKELETON);
  assert.equal(p.usable, false, "rows without values must not count as a read");
  assert.ok(p.missing.includes("pnl"));
});

test("a section with periods but every value blank is still unusable", () => {
  const blank = `<section id="profit-loss"><table>
    <thead><tr><th class="text"></th><th>Mar 2026</th></tr></thead>
    <tbody><tr><td class="text">Sales</td><td>-</td></tr></tbody></table></section>`;
  assert.equal(hasData(parseScreener(blank).pnl), false);
});

test("one real number anywhere makes a section usable", () => {
  const one = `<section id="profit-loss"><table>
    <thead><tr><th class="text"></th><th>Mar 2026</th></tr></thead>
    <tbody><tr><td class="text">Sales</td><td>-</td></tr>
           <tr><td class="text">Net Profit</td><td>1,234</td></tr></tbody></table></section>`;
  assert.equal(hasData(parseScreener(one).pnl), true);
});

test("hasData copes with rubbish rather than throwing", () => {
  for(const v of [undefined, null, {}, { periods: [] }, { periods: ["A"], rows: [] }]){
    assert.equal(hasData(v), false);
  }
});

test("a real page is still usable", () => {
  const p = parseScreener(PAGE);
  assert.equal(p.usable, true);
  assert.equal(hasData(p.pnl), true);
  assert.equal(hasData(p.shareholding), true);
});
