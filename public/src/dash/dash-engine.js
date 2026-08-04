/* Dashboard engine — pure functions, no DOM, no file I/O.

   Summarises a set of holdings: what it is worth, how it is spread, what is
   concentrated, and what it has gained where a cost is known.

   Classification is imported from the analyser rather than reimplemented —
   two copies of the same keyword lists would drift apart within a month.

   Informational only. It reports what the numbers say and does not judge the
   portfolio, name products, or suggest changes. */

import { CLASSES, CLASS_KEYS } from '../portfolio/portfolio-engine.js';

const sum = ns => ns.reduce((a, b) => a + b, 0);
const pos = v => Number.isFinite(v) && v > 0;

/* Order used for the class breakdown — the three real classes, then whatever
   could not be placed. */
const ALL_CLASSES = [...CLASS_KEYS, "other"];

export function summarise(holdings){
  const list = (holdings || []).filter(h => pos(Number(h?.value)))
    .map(h => ({
      name: String(h.name ?? "").trim() || "(unnamed)",
      value: Number(h.value),
      cost: pos(Number(h?.cost)) ? Number(h.cost) : undefined,
      cls: CLASSES[h?.cls] ? h.cls : "other",
      source: h?.source ?? "unknown"
    }));

  const total = sum(list.map(h => h.value));
  const count = list.length;

  /* Gain is computed only across holdings that actually carry a cost, and the
     share of the portfolio that covers is reported alongside. Comparing a
     full market value against a partial cost would invent a profit. */
  const costed = list.filter(h => h.cost !== undefined);
  const invested = sum(costed.map(h => h.cost));
  const costedValue = sum(costed.map(h => h.value));
  const hasCost = costed.length > 0 && invested > 0;

  const classes = ALL_CLASSES.map(key => {
    const members = list.filter(h => h.cls === key);
    const value = sum(members.map(h => h.value));
    return {
      key, label: CLASSES[key].label,
      value, count: members.length,
      pct: total > 0 ? (value / total) * 100 : 0
    };
  });

  const ranked = [...list]
    .sort((a, b) => b.value - a.value)
    .map((h, i) => ({
      ...h, rank: i + 1,
      weight: total > 0 ? (h.value / total) * 100 : 0,
      gain: h.cost !== undefined ? h.value - h.cost : undefined,
      gainPct: h.cost !== undefined && h.cost > 0
        ? ((h.value - h.cost) / h.cost) * 100 : undefined
    }));

  const topWeight = n => sum(ranked.slice(0, n).map(h => h.weight));

  return {
    holdings: ranked,
    total, count,
    classes,
    byClass: Object.fromEntries(classes.map(c => [c.key, c])),
    unclassified: classes.find(c => c.key === "other"),

    hasCost,
    invested: hasCost ? invested : 0,
    costedValue: hasCost ? costedValue : 0,
    /* How much of the portfolio the gain figure actually speaks for. */
    costCoverage: hasCost && total > 0 ? (costedValue / total) * 100 : 0,
    gain: hasCost ? costedValue - invested : 0,
    gainPct: hasCost ? ((costedValue - invested) / invested) * 100 : 0,

    concentration: {
      top1: topWeight(1),
      top3: topWeight(3),
      top5: topWeight(5),
      largest: ranked[0] ?? null,
      smallest: ranked[ranked.length - 1] ?? null
    },

    /* A count of holdings whose class was inferred from the name rather than
       declared, so the UI can ask for confirmation. */
    guessed: ranked.filter(h => h.source === "guessed").length,
    empty: count === 0
  };
}

/* Merge two sets of holdings, adding up anything with the same name so a
   statement imported twice does not double-count. Case and spacing are
   ignored when matching. */
export function mergeHoldings(existing, incoming){
  const key = h => String(h.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const out = [...(existing || [])];
  const index = new Map(out.map((h, i) => [key(h), i]));

  for(const h of (incoming || [])){
    const k = key(h);
    const at = index.get(k);
    if(k && at !== undefined){
      const prev = out[at];
      out[at] = {
        ...prev,
        value: Number(prev.value || 0) + Number(h.value || 0),
        cost: pos(prev.cost) || pos(h.cost)
          ? Number(prev.cost || 0) + Number(h.cost || 0)
          : undefined
      };
    } else {
      out.push({ ...h });
      if(k) index.set(k, out.length - 1);
    }
  }
  return out;
}
