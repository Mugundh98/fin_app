# FinApp

Three personal-finance planners behind one index page:

| Planner | Status |
| --- | --- |
| **Investment — GoalPlan** | **working** |
| **Tax — RegimeCheck** | **working** |
| Insurance | not built |

**RegimeCheck** is the Indian income tax calculator: old regime vs new, worked
line by line, with the deduction figure that would flip the answer.

**AY 2026-27 (FY 2025-26).** Rates taken from the Income Tax Department's
published tables: <https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1>

**GoalPlan** is the goal-based investment calculator: the horizon picks the
asset mix, the asset mix picks the return, and the answer comes back as a
range rather than a single number.

---

## Run it

No build step, no dependencies to install.

```bash
npm run dev      # serves on http://localhost:3000
npm test         # runs the tax engine test suite
```

`npm run dev` uses `npx serve`, which downloads on first use. In VS Code the
**Live Server** extension does the same thing with one click on `index.html`.

You need a server rather than opening the file directly, because `src/tax/ui.js`
is an ES module and browsers block module imports over `file://`.

---

## Layout

One HTML file per planner at the root; everything it needs lives under a
matching folder in `src/`.

```
index.html                  home — the planner index
tax.html                    tax planner markup
invest.html                 investment planner markup
src/
  shared/
    theme.css               tokens, masthead, form controls, panels, footer
    guilloche.js            the masthead engraving
  home/
    home.css                planner index cards
  tax/
    tax-engine.js           all the tax logic — pure functions, no DOM
    ui.js                   form building, state, rendering
    tax.css                 old-vs-new comparison, break-even box
  invest/
    invest-engine.js        all the goal maths — pure functions, no DOM
    ui.js                   form building, state, rendering
    invest.css              horizon readout, funded gauge
test/
  tax/tax-engine.test.js       22 tests
  invest/invest-engine.test.js 43 tests
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

## Adding a planner

The insurance card on the home page is a placeholder — a plain
`<div class="planner is-soon">` block. To make it real:

1. Create `src/<name>/` with an engine (`*-engine.js`, pure, no DOM), a `ui.js`,
   and a `<name>.css`.
2. Create `<name>.html` at the root. Link `src/shared/theme.css` first, then
   your own stylesheet. Copy the masthead out of `tax.html` — including the
   `← All planners` crumb and the empty `<svg id="guilloche">`.
3. In the home page, swap the placeholder `<div>` for an anchor:
   `<a class="planner is-live" href="./<name>.html">`, and change the status
   line from `In preparation` to `Open`.
4. Add `test/<name>/` — `node --test` picks it up with no config change.

Keep the engine/UI split. It is the reason both engines are testable in Node
without a browser, and the reason the tests caught two real bugs.

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

Push to GitHub, then connect the repo once at
[app.netlify.com](https://app.netlify.com) or [vercel.com](https://vercel.com).
Leave the build command empty and the publish directory as `/`.

After that, every `git push` deploys automatically. There's nothing to run and
nothing to remember, which is the point — if shipping takes effort you'll batch
changes, and batches get scary.

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
