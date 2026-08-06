# FinApp

Six personal-finance planners behind one index page:

| Planner | Status |
| --- | --- |
| **Investment — GoalPlan** | **working** |
| **Tax — RegimeCheck** | **working** |
| **Portfolio — SplitCheck** | **working** |
| **Insurance — PolicyCheck** | **working** (endowment plans only) |
| **Dashboard — FolioView** | **working** |
| **Stocks — LedgerRead** | **working** (needs the proxy Worker) |

**RegimeCheck** is the Indian income tax calculator: old regime vs new, worked
line by line, with the deduction figure that would flip the answer.

**AY 2026-27 (FY 2025-26).** Rates taken from the Income Tax Department's
published tables: <https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1>

**GoalPlan** is the goal-based investment calculator: the horizon picks the
asset mix, the asset mix picks the return, and the answer comes back as a
range rather than a single number.

**SplitCheck** reads a portfolio — from an `.xlsx`, a CSV, a paste, or typed in
by hand — and reports the equity / debt / gold split against a target you set,
with the trades that would close the gap.

**PolicyCheck** works out what an endowment policy actually returns, given the
premiums, the bonuses and when each rupee moves, and sets it against buying the
same cover as pure term and investing the difference. Endowment plans only for
now; term, money-back and ULIP are stubbed in the tab strip but not built.

**FolioView** is the dashboard: total value, asset-class mix, largest holdings,
concentration and gain, read out of a **PDF**, CSV or Excel statement, or typed
in by hand. SplitCheck answers "am I off my target"; FolioView answers "what do
I actually own".

**LedgerRead** analyses a listed company: ten years of P&L and balance sheet,
growth and margin trends, gearing, and promoter holding over time. It reads
Screener.in through a proxy Worker you deploy yourself — see
[The stock analyser](#the-stock-analyser), which is worth reading before you
rely on it.

---

## Run it

No build step, no dependencies to install.

```bash
npm run dev      # serves on http://localhost:3000
npm test         # runs the tax engine test suite
```

`npm run dev` uses `npx serve`, which downloads on first use. In VS Code the
**Live Server** extension does the same thing with one click on `index.html`.

You need a server rather than opening the file directly, because
`public/src/tax/ui.js` is an ES module and browsers block module imports over
`file://`.

---

## Layout

**Everything that gets published lives under `public/`, and nothing else does.**
That boundary is load-bearing — see [Deploying](#deploying). One HTML file per
planner, with everything it needs under a matching folder in `public/src/`.

```
public/                     <- the entire deployed site, and only that
  index.html                home — the planner index
  tax.html                  tax planner markup
  invest.html               investment planner markup
  portfolio.html            portfolio analyser markup
  insure.html               insurance planner markup
  src/
    shared/
      theme.css             tokens, masthead, form controls, panels, footer
      guilloche.js          the masthead engraving
      format.js             Indian grouping, amounts in words, month maths
      xlsx.js               .xlsx and .csv reader, no dependencies
      pdf.js                PDF text extraction, no dependencies
    home/
      home.css              planner index cards
    tax/
      tax-engine.js         all the tax logic — pure functions, no DOM
      ui.js                 form building, state, rendering
      tax.css               old-vs-new comparison, break-even box
    invest/
      invest-engine.js      all the goal maths — pure functions, no DOM
      ui.js                 form building, state, rendering
      invest.css            horizon readout, funded gauge
    portfolio/
      portfolio-engine.js   classification, drift, rebalancing — pure, no DOM
      ui.js                 form building, state, rendering
      portfolio.css         import box, editable rows, allocation bars
    insure/
      insure-engine.js      bonus accrual and the IRR solver — pure, no DOM
      ui.js                 form building, state, rendering
      insure.css            maturity composition bar, year-by-year table
    dash/
      dash-engine.js        totals, weights, concentration, gain — pure, no DOM
      ui.js                 form building, state, rendering
      dash.css              stat tiles, mix bar, editable rows
    stock/
      screener-parse.js     Screener page -> tables — pure, no DOM
      yahoo.js              Yahoo chart JSON -> price series — pure, no DOM
      stock-engine.js       growth, margins, gearing, promoter trend — pure
      ui.js                 form building, state, SVG charts
      stock.css             ratio grid, charts, financial tables

test/                       <- never published
  shared/format.test.js              21 tests
  tax/tax-engine.test.js             22 tests
  invest/invest-engine.test.js       56 tests
  portfolio/portfolio-engine.test.js 40 tests
  portfolio/xlsx.test.js             26 tests
  insure/insure-engine.test.js       53 tests
  shared/pdf.test.js                 35 tests
  dash/dash-engine.test.js           28 tests
  stock/screener-parse.test.js       24 tests
  stock/stock-engine.test.js         30 tests
  stock/yahoo.test.js                20 tests
worker/                     <- never published, deployed separately
  index.js                  allowlisted CORS proxy (Cloudflare Worker)
  wrangler.toml
package.json                <- never published
```

`shared/format.js` implements Indian digit grouping itself rather than calling
`toLocaleString("en-IN")`, so the output cannot vary with whichever ICU data a
runtime happens to ship, and can be tested in Node exactly as it renders in a
browser. Money fields group as you type and spell the amount out underneath
(`₹12 lakh 76 thousand`) — a seven-digit figure is unreadable as bare digits,
and the two together make a mistyped zero obvious.

`shared/theme.css` carries the whole design system — tokens, masthead, `.panel`,
`.row`, `.inp`, `.seg`, `.ledger-tbl`, the sticky mobile bar. A planner's own
stylesheet holds only what nothing else uses. Adding a page should not mean
copying a form control.

`npm test` takes no path argument — `node --test` discovers every
`*.test.js` under the project itself, so new subdirectories are picked up
without touching `package.json`.

**The split matters.** Both engines import nothing and touch no DOM. That
means they run in Node for testing today, and drop into React Native unchanged
if you ship an app later. Keep it that way — no `document`, no `window`, no
fetch. Everything that renders belongs in `ui.js`.

---

## The investment model

Everything lives in one exported object at the top of
`src/invest/invest-engine.js`:

```js
export const ASSUMPTIONS = { ... }
```

**The horizon picks the return — it is never a free field.** Bands are
`[lower, maxYears)`, so a 5-year goal is equity-tilted, not hybrid:

| Horizon | Mix | Poor | Expected | Good |
| --- | --- | --- | --- | --- |
| under 3 years | debt | 5.5% | 6.5% | 7.5% |
| 3 to 5 | hybrid | 7% | 9% | 11% |
| 5 to 10 | equity-tilted | 8% | 11% | 14% |
| 10 or more | equity | 8.5% | 12% | 15.5% |

The poor/good spread widens with the equity share, because that is where the
dispersion actually is. Three columns exist so the output reads as a range —
a single figure would read as a promise.

**The general "Financial goal" runs on a second, shorter ladder.** It is the
catch-all for anything with a date on it — a car, a holiday, a laptop, a
deposit — and those goals are often under a year away, so it uses:

| Horizon | Mix | Poor | Expected | Good |
| --- | --- | --- | --- | --- |
| under 2 years | fixed deposit | 6.25% | 6.75% | 7.25% |
| 2 to 5 | aggressive hybrid | 8% | 10% | 12% |
| 5 or more | equity | 8.5% | 12% | 15.5% |

The deposit band is deliberately narrow: it is a contractual rate, so the
spread reflects what rate you can book, not what a market might do. Money
needed inside two years does not belong in a market at all, and past five
years there is no reason to hold equity back.

That goal takes a **start and target date** rather than a number of years, and
the horizon is carried in **months** — a laptop eight months away cannot be
expressed in whole years. The other five goals keep the years box and the
standard ladder above; the two ladders never mix.

**Each goal carries its own inflation default,** overridable in the form:
education 10%, marriage 7%, everything else the general 6%. An emergency fund
overrides the horizon table entirely and is modelled as liquid at 0% — the
point of that money is availability, not return. Its target still inflates.

Two conventions worth knowing before you change anything:

- Annual returns convert to a monthly rate via `(1+r)^(1/12) − 1`, so twelve
  months compound back to exactly `r`. Deliberately not `r/12`, which would
  quietly turn 12% into 12.68% effective.
- Instalments land at the **end** of each month, and the step-up applies once
  every twelve months. Both are the conservative reading.

The planner computes arithmetic on visible assumptions. It has no concept of a
fund, scheme or product, and must not acquire one — asset-class labels only.

---

## The portfolio analyser

### Reading spreadsheets without a dependency

`src/portfolio/xlsx.js` opens a real `.xlsx`. That file is a ZIP of XML parts,
and both halves are now platform primitives: `DataView` walks the ZIP central
directory, and `DecompressionStream("deflate-raw")` inflates the members. No
SheetJS, no build step, nothing to install.

It deliberately avoids `DOMParser` so the same code runs under `node --test`.
The XML shapes inside a workbook are narrow and stable, so it scans them
directly. The worksheet is resolved through `workbook.xml` and its rels part —
`sheet1.xml` is **not** reliably the first tab, and guessing would silently
read the wrong data.

Not supported, and reported as errors rather than guessed at: ZIP64, encrypted
workbooks, and the old binary `.xls`. Formula cells yield their last cached
value, which is what Excel stores.

### What the file needs

A **Name**, a **Value** and ideally a **Class** column, plus **Invested** if
the sheet has one. Headers can also be called Scheme, Fund, Amount, Market
Value, Type or Category, in any order. Amounts survive `₹`, `Rs.`, commas in
the Indian grouping and a trailing `/-`.

**The header does not have to be on row 1.** A broker statement opens with a
block of metadata — report title, client name, PAN, download timestamp,
portfolio totals — and the real header can sit a dozen rows down. Up to 60 rows
are scanned, and each candidate is *scored* rather than taking the first that
matches, so a full header beats a thin coincidental one.

Two rules exist because getting them wrong is silent rather than loud:

- **`VALUE_HEADERS` is a priority list, not a column search.** A statement has
  several money columns — buy price, invested value, current value, previous
  close — and taking whichever sits leftmost picks the wrong one. The specific
  "what it is worth today" names are matched first. `Invested` is deliberately
  excluded from it and read as cost instead.
- **Statement preamble is filtered out by name.** Rows called *Date*,
  *Client ID*, *PAN*, *Profit & loss*, *Unrealised P&L* and so on look exactly
  like holdings to a positional reader — a label and a number. They are dropped
  and reported, along with *Total* rows. Your PAN has no business being
  imported as a position.

Without those, a statement whose header sits below the scan window falls back
to positional columns and reads column B — which on most broker exports is the
**quantity**. Units then masquerade as rupees, and the total looks plausible
enough to believe. There is a regression test built from a real statement.

### Classification

A class column is taken at face value — the user's word beats any guess. With
no class column the class is inferred from the holding's name and **marked as a
guess**, shown in amber in the UI for confirmation. Checks run gold, then debt,
then equity, because names overlap ("Gold Savings Fund" contains cues for
more than one).

Anything unrecognised, plus anything declared hybrid, balanced or cash, lands
in **Unclassified** and is held out of the base rather than split by guesswork.
Percentages are reported against the classified base, with the unclassified
amount shown separately — a portfolio that is 20% unrecognised should say so,
not quietly report the other 80% as if it were the whole picture.

### Rebalancing

Two routes, because they have different tax consequences:

- **Move money between classes** — sell the overweight, buy the underweight.
  The deltas sum to zero.
- **Add new money only** — find the smallest total at which every class sits
  at or below its target, then top up the shortfalls. Nothing is sold, so no
  gains are realised and no exit load is triggered. If a class has a zero
  target but a non-zero holding, this is impossible and the app says so
  instead of pretending.

Drift inside the tolerance band (5 pp by default, editable) is reported but not
traded on. The target mix is always the user's; the shipped templates are
common textbook splits offered as starting points, never recommendations.

---

## The endowment calculator

An endowment bundles life cover with a savings pot, which makes the return it
earns hard to read off the brochure. The calculator works it out from the
policy's own figures.

**Only the sum assured is contractually guaranteed.** Reversionary and final
additional bonuses are declared annually out of the insurer's surplus and can
be cut. That is why the floor scenario assumes none is ever declared — it is
what the contract actually obliges the insurer to pay. The maturity bar breaks
out the guaranteed slab against the parts that depend on a future declaration.

Simple reversionary bonus accrues on the sum assured at a rate per ₹1,000 per
year and **does not compound** — twenty years of bonus is exactly twenty times
one year of it. Final additional bonus is a one-off at maturity.

The headline figure is an **IRR**, solved by bisection in
`src/insure/insure-engine.js`. Bisection rather than Newton-Raphson because the
sign pattern here — a run of premium outflows then a single maturity inflow —
guarantees exactly one root, and bisection cannot diverge. IRR is not the total
gain: a policy paying back 1.9× over twenty years is earning well under 10% a
year, because most of the money was invested for far less than the full term.

Two facts the tests pin down, both easy to get wrong by intuition:

- When premiums and maturity are equal in nominal terms the IRR is **exactly
  zero**, not negative — at r = 0 discounting is the identity, so the timing
  drops out. Add GST and it goes properly negative.
- Paying the same total over *fewer* years gives a *lower* IRR, because the
  money goes in earlier and works for longer.

GST is optional (4.5% first year, 2.25% after) and off by default, since most
people quote the premium they actually pay.

### Against term plus an index fund

The same cover, bought as pure term, with whatever is left of the premium put
into an index fund.

**The comparison is only worth anything if the outlay matches**, so it is
constructed that way: each year the endowment premium would have left the
account, the other route pays a term premium and invests the remainder. Out of
pocket is identical every year, and there is a test asserting it — otherwise
the result is just an argument for spending more.

Three details that are easy to get wrong and are handled:

- **Term attracts 18% GST**, not the 4.5%/2.25% a traditional plan pays. The
  two routes cannot share one rate.
- **When a limited-pay endowment stops collecting**, the term plan still has
  years to run, so its premium is drawn from the invested pot. Ignoring that
  would hand the other route a free ride.
- **The endowment line on the chart is what has accrued** — sum assured plus
  bonus to date — not a surrender value, which is usually far lower. The
  caveat under the chart says so.

This weighs an assumption against a contract, and the page says that where it
cannot be missed: the sum assured is promised, the assumed return is not. No
recommendation is offered either way, and neither line is adjusted for tax.

Not handled: surrender and paid-up values, policy loans, riders, money-back
survival benefits, ULIPs, and the 80C / 10(10D) tax treatment. Mortality
charges are not separated out — the tool prices the bundle as a whole.

---

## Reading a PDF without a dependency

`shared/pdf.js` extracts text from a PDF. This is harder than the spreadsheet
readers and worth understanding before trusting it.

**A PDF is not a table.** There are no rows, columns or cells in the file. Text
is drawn by content-stream operators at coordinates, and any structure is
something the reader has to infer. So it:

1. Finds every `stream` in the file and inflates the FlateDecode ones — note
   `DecompressionStream("deflate")`, the zlib-wrapped form, where a ZIP member
   needs `"deflate-raw"`.
2. Walks the text operators (`Tj`, `TJ`, `Td`, `TD`, `Tm`, `T*`), tracking the
   pen position, and emits positioned runs of text.
3. Groups runs sharing a baseline into a row, then splits each row into cells
   wherever the horizontal gap exceeds a threshold.

Streams are located by scanning for the keyword rather than by parsing the
cross-reference table, because real files are full of incremental updates and
broken xrefs. Subset fonts map bytes to arbitrary glyph ids, so every
`ToUnicode` CMap in the file is merged into one table and applied — resolving
which font is active per run would mean walking page resource dictionaries,
and in practice the subsets agree.

**What it cannot do, reported as errors rather than guessed at:**

| Input | What happens |
| --- | --- |
| Password-protected PDF | Named and refused. CAMS and KFintech CAS statements always are — save an unprotected copy, or export CSV. |
| Scanned or photographed statement | Explained: a picture has no text in it. There is no OCR here. |
| Screenshot (PNG/JPEG/HEIC) | Detected by magic bytes and explained, rather than silently finding nothing. |
| Exotic font with no ToUnicode | May come back as mojibake. |

Because the result is an inference, the dashboard shows what it read next to
the holdings it produced, flags the import as one to check, and makes every row
editable. **The manual path is not a fallback for failure — it is the same
path.** An import just pre-fills it.

---

## The stock analyser

### Why it needs a Worker

Screener, Trendlyne and Yahoo Finance all refuse cross-origin reads, so a page
on this site cannot fetch them — the browser blocks it before the request is
even made. This was measured, not assumed:

| Source | Cross-origin fetch |
| --- | --- |
| screener.in | blocked |
| trendlyne.com | blocked |
| Yahoo Finance | blocked (chart data reachable via the Worker) |
| moneycontrol.com | allowed |

MoneyControl is the exception and has a working JSON price feed, but its
financials live in 1.2 MB HTML pages and its historical-chart endpoint returns
403. Promoter holding is the real gap: it is an India-specific disclosure and
no free API carries it, which is exactly why Screener is worth reading.

**Yahoo is used for the price series and nothing else.** Its chart endpoint is
open and gives five years of monthly OHLCV in rupees — the one thing Screener
does not hand over cheaply, and the reason the analyser has a price chart at
all. Its fundamentals endpoint (`quoteSummary`) answers `401 Invalid Crumb`:
Yahoo put it behind a cookie-and-crumb handshake. That is an access control
somebody deliberately added, and working around it is a different thing from
reading a page served to anyone who asks, so the Worker allowlist covers
`/v8/finance/chart/` only. Statements and promoter holding come from Screener.

The price fetch runs after the financials and its failures are swallowed —
a delisted ticker or a Yahoo outage hides the price panel and costs nothing
else. There are tests for both paths.

So `worker/` holds a small Cloudflare Worker that fetches server-side, where
the cross-origin rule does not apply, and returns the page with permissive
CORS headers. Deploy it once:

```bash
cd worker && npx wrangler deploy
```

Paste the URL it prints into the analyser's proxy box. It is stored in your
browser only.

**The Worker is not an open proxy.** It serves an allowlist of exact host and
path patterns — Screener company pages, the Yahoo chart endpoint and the
MoneyControl price feed — and refuses everything else with a 403, so it cannot
be found and used as a general-purpose relay. Set `ALLOWED_ORIGIN` in
`wrangler.toml` to pin it to your own site as well.

### Caching, and why it matters

Volume is the thing most likely to get a scraper blocked, and a company's
financials are restated **once a quarter**. Re-reading the page on every
lookup is pure waste.

Bind a KV namespace and the Worker caches bodies for seven days (Screener) and
an hour (Yahoo prices, which actually move):

```bash
npx wrangler kv namespace create CACHE
```

Paste the id into `wrangler.toml` under `[[kv_namespaces]]`. Without the
binding the Worker still runs — it just goes to the origin every time and
reports `x-cache: BYPASS`.

Because a cached page can be days old, the Worker returns `x-cache` and
`x-cache-age`, and the analyser says so: *"Served from the proxy cache,
fetched 3 days ago."* The financials will not have changed; the price strip
will be that stale. Append `&fresh=1` to bypass the cache for one request.

The upstream request also sends an ordinary browser `User-Agent`. Sites vary
their markup — or refuse outright — for clients they do not recognise, and an
unfamiliar agent string is the quickest way to start collecting 403s. Override
with the `USER_AGENT` var.

### What it does and does not promise

This is **scraping**: reading a page built for human eyes. Three consequences
worth stating plainly.

- **It will break.** Screener owes nobody notice before changing its markup.
  Every extractor fails soft — a section that cannot be read comes back empty
  rather than throwing, the page names which sections it failed to read, and
  the corresponding panel is hidden rather than shown as a convincing zero.
  There is a test that renames a section and asserts the rest still parses.
- **It may sit outside their terms of use.** That is a matter between you and
  them; the code takes no view.
- **The numbers are Screener's**, built from company filings. Nothing here
  restates or verifies them.

The parser is regex-based rather than `DOMParser` for the same reason as the
xlsx and pdf readers: that way the fragile part runs under `node --test`
against fixture markup, so a change in Screener's HTML shows up as a failing
test rather than a blank page.

### Consolidated, and when it does not exist

Plenty of Indian companies have no subsidiaries, so there is nothing to
consolidate. Screener still serves `/consolidated/` for them — **200, with the
table skeleton**: twelve labelled rows, no period columns, no values. A reader
that counts rows calls that a successful read and renders a clean, entirely
blank page.

So `hasData()` requires actual numbers, not merely labels, and a consolidated
page that fails it triggers an automatic retry on standalone. The analyser
says which basis it ended up using and why.

The fallback is **per lookup**. It reflects the toggle back to what was
actually shown, but does not change what you asked for — otherwise one
standalone-only company would silently turn every later lookup standalone, and
Reliance would quietly report ₹5.5 lakh crore of sales instead of ₹11.2.

### Banks and NBFCs report different line names

Screener names the same lines differently by industry, so the engine takes the
first label that exists:

| Manufacturer | Lender |
| --- | --- |
| Sales | Revenue |
| Operating Profit | Financing Profit |
| Borrowings | Borrowing |

Two consequences are handled rather than ignored. **Deposits are not counted as
borrowing** — for a bank they are the business, not leverage, so gearing is
struck on borrowings alone. And **a lender's margin is struck after interest
expense**, so it is routinely negative and is not comparable to a
manufacturer's operating margin; the analyser carries the source's own name for
it, "Financing margin", and says so under the chart rather than flattening both
into one label.

### One arithmetic rule worth knowing

Growth is compound annual growth between the two years actually used, and both
are named in the output. Two things it deliberately does:

- **A TTM column never takes part.** It is a part year; counted as a full one
  it would flatter growth badly.
- **A missing or loss-making year is skipped as an endpoint but still counted
  as a year elapsed.** Compacting the usable points first would shorten the
  timeline — `100 → (loss year) → 121` would read as one year of 21% instead
  of two years of 10%. That was a real bug, and there is a regression test.

Where the window asked for is longer than the history available, the figure is
labelled with the span actually used rather than quietly pretending.

---

## Adding a planner

All four cards are live. To add a fifth:

1. Create `src/<name>/` with an engine (`*-engine.js`, pure, no DOM), a `ui.js`,
   and a `<name>.css`.
2. Create `<name>.html` at the root. Link `src/shared/theme.css` first, then
   your own stylesheet. Copy the masthead out of `tax.html` — including the
   `← All planners` crumb and the empty `<svg id="guilloche">`.
3. Add a card to the home page:
   `<a class="planner is-live" href="./<name>.html">`. A card that is not
   built yet is the same markup as a `<div class="planner is-soon">` with the
   status line reading `In preparation`.
4. Add `test/<name>/` — `node --test` picks it up with no config change.
5. Widen the `.planners` grid in `src/home/home.css` if the row is full.

Keep the engine/UI split. It is the reason every engine is testable in Node
without a browser, and the reason the tests keep catching real bugs.

---

## Changing the rates

Every rate, slab, cap and threshold lives in one exported object at the top of
`src/tax/tax-engine.js`:

```js
export const RATES = { ... }
```

When the Budget changes something, that object is the only place to edit. Then
run `npm test` — the suite is anchored to the department's own worked examples
and will tell you if you broke a boundary.

To support more than one assessment year later, turn `RATES` into a map keyed
by year and pass the year into `computeRegime`. Don't do that until you need it.

---

## The tests are load-bearing

Two real bugs turned up while this was being built, both of which produce
plausible-looking wrong numbers rather than obvious crashes:

1. **Missing marginal relief on the rebate.** Income of ₹12,76,000 showed
   ₹62,556 of tax instead of ₹1,040. This is the provision that stops the new
   regime having a cliff at ₹12 lakh.
2. **Surcharge marginal relief computed against the wrong ceiling.** Tax *fell*
   as income crossed ₹1 crore, because the ceiling ignored the surcharge
   already payable at the threshold itself.

Both have regression tests. The monotonicity tests sweep ~12,000 income points
in each regime and assert tax never decreases as income rises — that is what
caught the second bug, and it will catch the next one of its kind.

Run `npm test` before every push. It takes under two seconds.

---

## Deploying

Hosted on Cloudflare Pages. Connect the repo once, then every `git push`
deploys automatically. There's nothing to run and nothing to remember, which is
the point — if shipping takes effort you'll batch changes, and batches get scary.

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | **`public`** |

**The output directory must be `public`, never `/`.** Pointing a host at the
repo root looks harmless because there is no build step, but the host runs
`npm install` when it sees a `package.json`, and then uploads whatever it
finds — including the `node_modules` it just created. That is how the first
deploy failed: 29 files became 2,060, and Wrangler's own 40 MB `workerd`
binary tripped the 25 MB per-asset limit.

`public/` exists to draw that line. Nothing outside it is served, so tests,
config and tooling can never leak into the deployed site.

The same setting works anywhere: publish directory `public` on Netlify, or the
`/public` folder option on GitHub Pages. Nothing in the repo is
provider-specific, so moving hosts is a five-minute job.

---

## Not handled yet

Deliberately out of scope for now. Don't add these until someone asks:

- Relief u/s 89 for arrears
- Set-off and carry-forward of losses
- Foreign income and foreign tax credit
- Clubbing of income
- AMT
- Capital gains indexation elections
- Partial-year residency

Marginal relief on surcharge is computed on total income and may differ by a
few rupees from the department's utility where special-rate income is involved.

Presumptive turnover limits (44AD, 44ADA) depend on your cash-receipt
proportion and are **not** enforced — verify eligibility separately.

---

## Next task

<!-- Before you close VS Code, replace this line with the single next thing to do.
     Not a backlog — one line, specific enough to start from cold.
     e.g. "Add NPS employer-contribution % cap to the 80CCD(2) field in ui.js" -->

Nothing in progress.
