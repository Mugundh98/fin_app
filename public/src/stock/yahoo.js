/* Yahoo Finance chart payload -> a price series. Pure, no DOM, no network.

   Only the chart endpoint is used. Yahoo's fundamentals endpoint
   (quoteSummary) sits behind a cookie-and-crumb handshake and answers 401
   without it; financial statements and promoter holding come from Screener
   instead. This file exists for one thing Screener does not give cheaply:
   what the share price actually did.

   The payload is generous with nulls — a month with no trading has a null
   close, and a thin series can have nulls at either end — so every accessor
   here treats a null as "no data" rather than zero. */

/* Screener works in NSE codes; Yahoo wants an exchange suffix. */
export function toYahooSymbol(code, exchange = "NS"){
  const c = String(code ?? "").trim().toUpperCase();
  if(!c) return "";
  return /\.(NS|BO)$/.test(c) ? c : `${c}.${exchange}`;
}

export function chartUrl(code, { range = "5y", interval = "1mo", exchange = "NS" } = {}){
  const symbol = toYahooSymbol(code, exchange);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
         `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
}

const isNum = v => Number.isFinite(v);

export function parseYahooChart(payload){
  let json = payload;
  if(typeof payload === "string"){
    try { json = JSON.parse(payload); }
    catch { return empty("That did not look like a Yahoo chart response."); }
  }

  const err = json?.chart?.error;
  if(err) return empty(err.description || err.code || "Yahoo refused the request.");

  const result = json?.chart?.result?.[0];
  if(!result) return empty("No price data in the response.");

  const meta = result.meta ?? {};
  const stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const closes = Array.isArray(quote.close) ? quote.close : [];

  const points = [];
  for(let i = 0; i < stamps.length; i++){
    const close = closes[i];
    if(!isNum(stamps[i]) || !isNum(close)) continue;
    points.push({
      t: stamps[i] * 1000,
      date: new Date(stamps[i] * 1000).toISOString().slice(0, 10),
      close,
      open: isNum(quote.open?.[i]) ? quote.open[i] : null,
      high: isNum(quote.high?.[i]) ? quote.high[i] : null,
      low: isNum(quote.low?.[i]) ? quote.low[i] : null,
      volume: isNum(quote.volume?.[i]) ? quote.volume[i] : null
    });
  }

  const first = points[0] ?? null, last = points[points.length - 1] ?? null;

  return {
    ok: points.length > 0,
    error: points.length ? null : "No usable price points.",
    symbol: meta.symbol ?? "",
    currency: meta.currency ?? "",
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
    price: isNum(meta.regularMarketPrice) ? meta.regularMarketPrice : (last?.close ?? null),
    fiftyTwoWeekLow: isNum(meta.fiftyTwoWeekLow) ? meta.fiftyTwoWeekLow : null,
    fiftyTwoWeekHigh: isNum(meta.fiftyTwoWeekHigh) ? meta.fiftyTwoWeekHigh : null,
    points, first, last,
    /* Total move across the window actually returned, which may be shorter
       than the range asked for if the company listed recently. */
    changePct: first && last && first.close > 0
      ? ((last.close - first.close) / first.close) * 100 : null,
    /* Compound annual return over the same window, for comparison against
       the earnings growth alongside it. */
    cagr: annualised(first, last)
  };
}

function annualised(first, last){
  if(!first || !last || first.close <= 0) return null;
  const years = (last.t - first.t) / (365.25 * 24 * 3600 * 1000);
  if(years < 0.5) return null;
  return { rate: Math.pow(last.close / first.close, 1 / years) - 1, years };
}

function empty(error){
  return {
    ok: false, error,
    symbol: "", currency: "", exchange: "",
    price: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null,
    points: [], first: null, last: null, changePct: null, cagr: null
  };
}
