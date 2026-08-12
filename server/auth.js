/* Auth primitives — pure functions plus WebCrypto, no D1, no request handling.

   Kept separate from the routes so the parts that must not be wrong can be
   tested directly: token generation, cookie handling, and what a Google
   identity token is allowed to claim.

   Two decisions worth stating plainly, because both look like shortcuts and
   neither is:

   1. The session token is stored HASHED. What lands in D1 is SHA-256 of the
      value in the cookie, so reading the database gives you nothing you can
      log in with. Same reasoning as a password hash, for the same reason.

   2. The Google ID token's SIGNATURE is not verified here, and does not need
      to be. It is fetched by this server directly from Google's token
      endpoint over TLS in exchange for a one-time code — not accepted from
      the browser. That is the whole point of the authorization-code flow.
      What DOES get checked is that the claims are for us and are current;
      an unchecked `aud` would let a token minted for another site sign
      someone in here. */

const encoder = new TextEncoder();

export const SESSION_COOKIE = "fa_session";
export const OAUTH_STATE_COOKIE = "fa_oauth";
export const SESSION_DAYS = 60;

/* ============================================================
   TOKENS
   ============================================================ */

/* 256 bits from the CSPRNG. Not Math.random, which is predictable and would
   make sessions guessable. */
export function randomToken(bytes = 32){
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export function base64url(bytes){
  let s = "";
  for(const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token){
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(token)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* Constant-time comparison, so a mismatch cannot be located by timing.
   Used for the OAuth state check. */
export function timingSafeEqual(a, b){
  const x = String(a ?? ""), y = String(b ?? "");
  if(x.length !== y.length) return false;
  let diff = 0;
  for(let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ============================================================
   COOKIES
   ============================================================ */

export function parseCookies(header){
  const out = {};
  for(const part of String(header ?? "").split(";")){
    const eq = part.indexOf("=");
    if(eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if(!name) continue;
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch { out[name] = part.slice(eq + 1).trim(); }
  }
  return out;
}

/* HttpOnly so page scripts cannot read it — an XSS bug should not hand over
   the session. Secure so it never travels in clear. SameSite=Lax so another
   site cannot make an authenticated request on the user's behalf, while a
   normal top-level return from Google still carries it. */
export function serialiseCookie(name, value, { maxAge, expires } = {}){
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ];
  if(expires === 0 || maxAge === 0) bits.push("Max-Age=0");
  else if(Number.isFinite(maxAge)) bits.push(`Max-Age=${Math.floor(maxAge)}`);
  return bits.join("; ");
}

export const clearCookie = name => serialiseCookie(name, "", { maxAge: 0 });

/* ============================================================
   GOOGLE IDENTITY TOKEN
   ============================================================ */

/* Decode only — see the note at the top of this file for why that is
   sufficient here and where the trust actually comes from. */
export function decodeIdToken(jwt){
  const parts = String(jwt ?? "").split(".");
  if(parts.length !== 3) return null;
  try{
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    const json = decodeURIComponent(
      [...atob(padded)].map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    );
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch { return null; }
}

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/* Every check here exists because of a specific way this could be abused.
   `aud` is the important one: without it, an ID token Google minted for a
   completely different application would be accepted as a login here. */
export function validateIdToken(payload, clientId, nowSeconds = Math.floor(Date.now() / 1000)){
  if(!payload) return { ok: false, reason: "The sign-in response could not be read." };
  if(!GOOGLE_ISSUERS.has(payload.iss)) return { ok: false, reason: "That token did not come from Google." };
  if(!clientId || payload.aud !== clientId) return { ok: false, reason: "That token was issued for a different application." };
  if(!payload.sub) return { ok: false, reason: "The token carries no account id." };
  if(!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return { ok: false, reason: "The sign-in response has expired." };
  /* iat in the future by more than a minute means clocks disagree badly
     enough that exp cannot be trusted either. */
  if(Number.isFinite(payload.iat) && payload.iat > nowSeconds + 60) return { ok: false, reason: "The sign-in response is not valid yet." };
  if(payload.email && payload.email_verified === false) return { ok: false, reason: "That Google account has an unverified email address." };

  return {
    ok: true,
    user: {
      id: String(payload.sub),
      email: String(payload.email ?? ""),
      name: String(payload.name ?? "").slice(0, 120)
    }
  };
}

/* ============================================================
   WHAT MAY BE STORED
   ============================================================ */

/* An allowlist, not a pattern. The state endpoint takes a key from the
   client, and without this a caller could write arbitrary rows and use the
   account as free storage. Tax is absent on purpose — it is never persisted
   anywhere, locally or here. */
export const STATE_KEYS = new Set([
  "invest",
  "insure",
  "portfolioHoldings",
  "portfolioSettings",
  "dashHoldings",
  "proxyUrl"
]);

export const isStateKey = key => STATE_KEYS.has(String(key));

/* A planner's state is small. This is a guard against someone using the
   account as a file host, not a limit anyone will meet honestly. */
export const MAX_VALUE_BYTES = 128 * 1024;

export function validateStatePayload(body){
  if(!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "Expected an object of keys." };

  const entries = Object.entries(body);
  if(!entries.length) return { ok: false, reason: "Nothing to save." };
  if(entries.length > STATE_KEYS.size) return { ok: false, reason: "Too many keys." };

  const clean = {};
  for(const [key, value] of entries){
    if(!isStateKey(key)) return { ok: false, reason: `Unknown key: ${key}` };
    let json;
    try { json = JSON.stringify(value); }
    catch { return { ok: false, reason: `Value for ${key} is not serialisable.` }; }
    if(json === undefined) return { ok: false, reason: `Value for ${key} is not serialisable.` };
    if(json.length > MAX_VALUE_BYTES) return { ok: false, reason: `Value for ${key} is too large.` };
    clean[key] = json;
  }
  return { ok: true, clean };
}

export const sessionExpiry = (now = Date.now()) => now + SESSION_DAYS * 24 * 3600 * 1000;
