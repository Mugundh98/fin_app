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
 * Responses are cached at the edge so repeated lookups of the same company do
 * not hammer the origin — the numbers change quarterly, not by the second.
 *
 * Deploy from this directory:
 *     npx wrangler deploy
 */

const ALLOW = [
  { host: "www.screener.in",            path: /^\/company\/[A-Za-z0-9&._-]+\/(consolidated\/)?$/ },
  { host: "screener.in",                path: /^\/company\/[A-Za-z0-9&._-]+\/(consolidated\/)?$/ },
  { host: "priceapi.moneycontrol.com",  path: /^\/pricefeed\/[a-z]+\/equitycash\/[A-Za-z0-9]+$/ }
];

/* Fundamentals move on results day. An hour is plenty, and keeps a page
   refresh from becoming a fresh origin hit. */
const CACHE_SECONDS = 3600;

const cors = origin => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
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

    const target = new URL(request.url).searchParams.get("url");
    if(!target) return refuse("Pass the page you want as ?url=", 400, origin);

    let url;
    try { url = new URL(target); }
    catch { return refuse("That is not a valid URL.", 400, origin); }

    if(url.protocol !== "https:"){
      return refuse("Only https targets are allowed.", 403, origin);
    }
    const permitted = ALLOW.some(a => a.host === url.hostname && a.path.test(url.pathname));
    if(!permitted){
      return refuse(`This proxy does not serve ${url.hostname}${url.pathname}.`, 403, origin);
    }

    let upstream;
    try {
      upstream = await fetch(url.toString(), {
        headers: {
          /* Some origins refuse a request with no user agent at all. */
          "user-agent": "Mozilla/5.0 (compatible; FinAppReader/1.0)",
          "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-IN,en;q=0.9"
        },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
      });
    } catch(err){
      return refuse("Could not reach " + url.hostname + ".", 502, origin);
    }

    if(!upstream.ok){
      return refuse(`${url.hostname} answered ${upstream.status}.`, upstream.status, origin);
    }

    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
        ...cors(origin)
      }
    });
  }
};
