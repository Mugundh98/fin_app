/* Stock analysis — pure functions, no DOM, no network.

   Takes what the parser found and derives the things a page of tables does
   not show directly: growth rates, margin trends, leverage, and the direction
   of promoter holding.

   Informational only. Every figure here is arithmetic on the company's own
   reported numbers. Nothing is scored, rated, or recommended, and no view is
   taken on whether any share is worth owning. */

const isNum = v => Number.isFinite(v);

/* One line item as {period, value} pairs, so a value can never drift out of
   step with its column heading. */
export function series(table, label){
  const periods = table?.periods ?? [];
  const values = table?.byLabel?.[label] ?? [];
  return periods.map((period, i) => ({ period, value: isNum(values[i]) ? values[i] : null }));
}

/* Screener appends a TTM column to the P&L. It is useful to show but is not a
   financial year, so it must not take part in any year-on-year maths. */
export const isTtm = p => /^ttm$/i.test(String(p ?? "").trim());
export const annual = points => points.filter(p => !isTtm(p.period));

/* Compound growth across at most `years` of history, using however much is
   actually there — and reporting the span used, because a "5 year" figure
   computed over 3 years of data would be a lie by omission. */
export function cagr(points, years){
  const a = annual(points);
  /* Indices are measured in the ORIGINAL array, because an index gap is a
     year that elapsed. Compacting the usable points first would shorten the
     timeline and overstate growth — a loss year or a missing year would turn
     two years of 10% into one year of 21%. */
  const usable = i => isNum(a[i]?.value) && a[i].value > 0;

  let lastIdx = -1;
  for(let i = a.length - 1; i >= 0; i--) if(usable(i)){ lastIdx = i; break; }
  if(lastIdx < 1) return null;

  const target = Math.max(0, lastIdx - years);
  let firstIdx = -1;
  for(let i = target; i < lastIdx; i++) if(usable(i)){ firstIdx = i; break; }
  if(firstIdx === -1) return null;

  const span = lastIdx - firstIdx;
  const from = a[firstIdx], to = a[lastIdx];
  return {
    rate: Math.pow(to.value / from.value, 1 / span) - 1,
    years: span,
    from: from.period, to: to.period,
    fromValue: from.value, toValue: to.value,
    /* True when the window asked for was longer than the history available. */
    truncated: span < years
  };
}

/* Element-wise a/b as a percentage, null wherever either side is missing. */
export function ratioSeries(numerator, denominator){
  return numerator.map((p, i) => {
    const d = denominator[i]?.value;
    return {
      period: p.period,
      value: isNum(p.value) && isNum(d) && d !== 0 ? (p.value / d) * 100 : null
    };
  });
}

export const latest = points => {
  for(let i = points.length - 1; i >= 0; i--) if(isNum(points[i].value)) return points[i];
  return null;
};

/* Promoter holding matters as a direction, not just a level, so the change
   across the most recent four quarters is reported alongside. */
export function promoterTrend(points){
  const valid = points.filter(p => isNum(p.value));
  if(!valid.length) return { latest: null, changeQoQ: null, change4Q: null, direction: "unknown", points };

  const last = valid[valid.length - 1];
  const prev = valid[valid.length - 2] ?? null;
  const fourAgo = valid[Math.max(0, valid.length - 5)] ?? null;

  const changeQoQ = prev ? last.value - prev.value : null;
  const change4Q = fourAgo && fourAgo !== last ? last.value - fourAgo.value : null;

  /* A tenth of a point is noise from rounding and buybacks, not a move. */
  const direction = change4Q === null ? "unknown"
    : change4Q > 0.1 ? "rising"
    : change4Q < -0.1 ? "falling" : "steady";

  return { latest: last, previous: prev, from: fourAgo, changeQoQ, change4Q, direction, points };
}

export function analyseStock(parsed){
  const pnl = parsed?.pnl ?? { periods: [], byLabel: {} };
  const bs  = parsed?.balanceSheet ?? { periods: [], byLabel: {} };
  const sh  = parsed?.shareholding ?? { periods: [], byLabel: {} };

  const sales      = series(pnl, "Sales");
  const expenses   = series(pnl, "Expenses");
  const operating  = series(pnl, "Operating Profit");
  const netProfit  = series(pnl, "Net Profit");
  const eps        = series(pnl, "EPS in Rs");

  const equity     = series(bs, "Equity Capital");
  const reserves   = series(bs, "Reserves");
  const borrowings = series(bs, "Borrowings");
  const totalAssets= series(bs, "Total Assets");

  /* Net worth is share capital plus reserves; either alone would mislead. */
  const netWorth = equity.map((p, i) => ({
    period: p.period,
    value: isNum(p.value) && isNum(reserves[i]?.value) ? p.value + reserves[i].value : null
  }));

  const debtToEquity = borrowings.map((p, i) => {
    const nw = netWorth[i]?.value;
    return { period: p.period, value: isNum(p.value) && isNum(nw) && nw > 0 ? p.value / nw : null };
  });

  const promoters = promoterTrend(series(sh, "Promoters"));

  return {
    name: parsed?.name ?? "",
    ratios: parsed?.ratios ?? [],
    ratioByLabel: parsed?.ratioByLabel ?? {},
    missing: parsed?.missing ?? [],
    usable: !!parsed?.usable,

    sales, expenses, operating, netProfit, eps,
    operatingMargin: ratioSeries(operating, sales),
    netMargin: ratioSeries(netProfit, sales),

    equity, reserves, borrowings, totalAssets, netWorth, debtToEquity,

    growth: {
      sales3:   cagr(sales, 3),
      sales5:   cagr(sales, 5),
      sales10:  cagr(sales, 10),
      profit3:  cagr(netProfit, 3),
      profit5:  cagr(netProfit, 5),
      profit10: cagr(netProfit, 10)
    },

    latest: {
      sales: latest(sales),
      operating: latest(operating),
      netProfit: latest(netProfit),
      operatingMargin: latest(ratioSeries(operating, sales)),
      netMargin: latest(ratioSeries(netProfit, sales)),
      debtToEquity: latest(debtToEquity),
      netWorth: latest(netWorth),
      eps: latest(eps)
    },

    promoters,
    shareholding: {
      promoters: series(sh, "Promoters"),
      fiis: series(sh, "FIIs"),
      diis: series(sh, "DIIs"),
      public: series(sh, "Public"),
      government: series(sh, "Government"),
      periods: sh.periods ?? []
    }
  };
}
