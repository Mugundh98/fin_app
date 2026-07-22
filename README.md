# RegimeCheck

Indian income tax calculator. Old regime vs new, worked line by line, with the
deduction figure that would flip the answer.

**AY 2026-27 (FY 2025-26).** Rates taken from the Income Tax Department's
published tables: <https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1>

---

## Run it

No build step, no dependencies to install.

```bash
npm run dev      # serves on http://localhost:3000
npm test         # runs the tax engine test suite
```

`npm run dev` uses `npx serve`, which downloads on first use. In VS Code the
**Live Server** extension does the same thing with one click on `index.html`.

You need a server rather than opening the file directly, because `src/ui.js`
is an ES module and browsers block module imports over `file://`.

---

## Layout

```
index.html              markup only
src/
  tax-engine.js         all the tax logic — pure functions, no DOM
  ui.js                 form building, state, rendering
test/
  tax-engine.test.js    22 tests, no dependencies
```

**The split matters.** `tax-engine.js` imports nothing and touches no DOM. That
means it runs in Node for testing today, and drops into React Native unchanged
if you ship an app later. Keep it that way — no `document`, no `window`, no
fetch. Everything that renders belongs in `ui.js`.

---

## Changing the rates

Every rate, slab, cap and threshold lives in one exported object at the top of
`src/tax-engine.js`:

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
