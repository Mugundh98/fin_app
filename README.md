# FinApp

Four personal-finance planners behind one index page:

| Planner | Status |
| --- | --- |
| **Investment — GoalPlan** | **working** |
| **Tax — RegimeCheck** | **working** |
| **Portfolio — SplitCheck** | **working** |
| **Insurance — PolicyCheck** | **working** (endowment plans only) |

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
premiums, the bonuses and when each rupee moves. Endowment plans only for now;
term, money-back and ULIP are stubbed in the tab strip but not built.

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
      xlsx.js               .xlsx and .csv reader, no dependencies
      ui.js                 form building, state, rendering
      portfolio.css         import box, editable rows, allocation bars
    insure/
      insure-engine.js      bonus accrual and the IRR solver — pure, no DOM
      ui.js                 form building, state, rendering
      insure.css            maturity composition bar, year-by-year table

test/                       <- never published
  tax/tax-engine.test.js             22 tests
  invest/invest-engine.test.js       43 tests
  portfolio/portfolio-engine.test.js 40 tests
  portfolio/xlsx.test.js             26 tests
  insure/insure-engine.test.js       38 tests
package.json                <- never published
```

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

A **Name**, a **Value** and ideally a **Class** column. Headers can also be
called Scheme, Fund, Amount, Market Value, Type or Category, in any order, and
need not be on row 1. Amounts survive `₹`, `Rs.`, commas in the Indian grouping
and a trailing `/-`. Rows whose name reads *Total* or *Grand Total* are dropped
so the portfolio is not counted twice.

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

Not handled: surrender and paid-up values, policy loans, riders, money-back
survival benefits, ULIPs, and the 80C / 10(10D) tax treatment. Mortality
charges are not separated out — the tool prices the bundle as a whole.

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
