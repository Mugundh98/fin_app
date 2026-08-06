/* Cloudflare Worker — a deliberately narrow CORS proxy.
 *
 * The site is static, so a page on it cannot fetch screener.in: the browser
 * blocks any cross-origin read the target does not explicitly permit. This
 * Worker sits in between, fetches server-side where that rule does not apply,
 * and returns the body with permissive CORS headers.
 *
 * It is NOT a general proxy. Only the exact host-and-path pairs below are
 * allowed through, so it cannot be discovered and used as an open relay for
 * anything else. Everything else is refused with a 403.
 *
 * Deploy from this directory:
 *     npx wrangler deploy
 */

/* Per-host settings. `ttl` is how long a body stays in KV.

   A day for Screener. The financials on that page are restated once a
   quarter, so a longer cache would cost nothing there — but the same page
   carries the ratio strip, and a week-old Current Price, P/E and Market Cap
   at the top of the analyser is worse than the saved requests are worth. A
   day still collapses repeated lookups to one origin hit, which is the point.

   Prices move constantly, hence the much shorter one for Yahoo. */
const ALLOW = [
  { host: "www.screener.in",           path: /^\/company\/[A-Za-z0-9&._-]+\/(consolidated\/)?$/, ttl: 86400 },
  { host: "screener.in",               path: /^\/company\/[A-Za-z0-9&._-]+\/(consolidated\/)?$/, ttl: 86400 },
  { host: "priceapi.moneycontrol.com", path: /^\/pricefeed\/[a-z]+\/equitycash\/[A-Za-z0-9]+$/,   ttl: 900 },
  /* Yahoo's chart endpoint is open and gives price history, which nothing
     else free does — MoneyControl's equivalent returns 403. Its fundamentals
     endpoint is NOT here: Yahoo put that behind a cookie-and-crumb handshake,
     and working around an access control is a different thing from reading a
     page that is served to anyone who asks. Financials come from Screener. */
  { host: "query1.finance.yahoo.com",  path: /^\/v8\/finance\/chart\/[A-Za-z0-9.^-]+$/,          ttl: 3600 },
  { host: "query2.finance.yahoo.com",  path: /^\/v8\/finance\/chart\/[A-Za-z0-9.^-]+$/,          ttl: 3600 }
];

/* A plain browser string. Some origins vary their markup — or refuse
   outright — for clients they do not recognise, and an unfamiliar agent is
   the quickest way to start collecting 403s. Override with USER_AGENT if a
   target ever wants something different. */
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* KV holds at most this much per entry. Screener pages run ~230KB; the cap
   is a guard against a target suddenly returning something enormous. */
const MAX_CACHE_BYTES = 2_000_000;

const cors = origin => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  /* Without this the browser hides x-cache from page scripts, and the UI
     cannot tell the user how old the figures are. */
  "access-control-expose-headers": "x-cache, x-cache-age, x-cache-ttl",
  "access-control-max-age": "86400"
});

function refuse(message, status, origin){
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(origin) }
  });
}

export default {
  async fetch(request, env){
    /* ALLOWED_ORIGIN pins this to your own site once you know its URL.
       Left unset it answers anyone, which is fine while the host allowlist
       is doing the real work. */
    const origin = env?.ALLOWED_ORIGIN || "*";

    if(request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if(request.method !== "GET"){
      return refuse("Only GET is supported.", 405, origin);
    }

    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get("url");
    if(!target) return refuse("Pass the page you want as ?url=", 400, origin);

    let url;
    try { url = new URL(target); }
    catch { return refuse("That is not a valid URL.", 400, origin); }

    if(url.protocol !== "https:"){
      return refuse("Only https targets are allowed.", 403, origin);
    }
    const rule = ALLOW.find(a => a.host === url.hostname && a.path.test(url.pathname));
    if(!rule){
      return refuse(`This proxy does not serve ${url.hostname}${url.pathname}.`, 403, origin);
    }

    const ttl = Number(env?.CACHE_TTL) > 0 ? Number(env.CACHE_TTL) : rule.ttl;
    /* Version the key so a change to what we store cannot collide with
       entries written by an older deploy. */
    const key = `v1:${url.toString()}`;
    const fresh = requestUrl.searchParams.get("fresh") === "1";

    const send = (body, contentType, cacheState, age) => new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType || "text/plain; charset=utf-8",
        "cache-control": `public, max-age=${ttl}`,
        "x-cache": cacheState,
        "x-cache-age": String(age ?? 0),
        "x-cache-ttl": String(ttl),
        ...cors(origin)
      }
    });

    /* ---- served from KV ---- */
    if(env?.CACHE && !fresh){
      try {
        const hit = await env.CACHE.get(key, { type: "json" });
        if(hit?.body){
          const age = Math.max(0, Math.round((Date.now() - (hit.at || 0)) / 1000));
          return send(hit.body, hit.contentType, "HIT", age);
        }
      } catch { /* a cache miss must never be fatal */ }
    }

    /* ---- fetched from the origin ---- */
    let upstream;
    try {
      upstream = await fetch(url.toString(), {
        headers: {
          "user-agent": env?.USER_AGENT || DEFAULT_UA,
          "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-IN,en;q=0.9",
          "cache-control": "no-cache"
        },
        cf: { cacheTtl: Math.min(ttl, 3600), cacheEverything: true }
      });
    } catch {
      return refuse("Could not reach " + url.hostname + ".", 502, origin);
    }

    if(!upstream.ok){
      return refuse(`${url.hostname} answered ${upstream.status}.`, upstream.status, origin);
    }

    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "text/plain; charset=utf-8";

    if(env?.CACHE && body.length <= MAX_CACHE_BYTES){
      /* waitUntil is not available here, and the write is quick — but a KV
         failure must not cost the caller their answer. */
      try {
        await env.CACHE.put(key, JSON.stringify({ body, contentType, at: Date.now() }),
                            { expirationTtl: Math.max(60, ttl) });
      } catch { /* over quota, or KV having a moment */ }
    }

    return send(body, contentType, env?.CACHE ? "MISS" : "BYPASS", 0);
  }
};
