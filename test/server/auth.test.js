import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COOKIE, SESSION_DAYS, STATE_KEYS, MAX_VALUE_BYTES,
  randomToken, base64url, hashToken, timingSafeEqual,
  parseCookies, serialiseCookie, clearCookie,
  decodeIdToken, validateIdToken, isStateKey, validateStatePayload, sessionExpiry
} from "../../server/auth.js";

const CLIENT_ID = "1234.apps.googleusercontent.com";
const now = 1_800_000_000;

/* Builds an unsigned JWT the way Google's token endpoint would, minus the
   signature — which this server never checks, and does not need to. */
const jwt = payload => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.signature-not-checked`;
};

const goodPayload = (over = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "108124098124098",
  email: "someone@example.com",
  email_verified: true,
  name: "Someone",
  iat: now - 10,
  exp: now + 3600,
  ...over
});

/* ------------------------------------------------------------------
   Tokens
   ------------------------------------------------------------------ */

test("session tokens are long, url-safe and unique", () => {
  const seen = new Set();
  for(let i = 0; i < 200; i++){
    const t = randomToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/, "must survive a cookie unencoded");
    assert.ok(t.length >= 40, `too short: ${t.length}`);
    assert.ok(!seen.has(t), "a token repeated");
    seen.add(t);
  }
});

test("base64url emits no padding or url-hostile characters", () => {
  const out = base64url(new Uint8Array([251, 255, 254, 0, 1, 2]));
  assert.ok(!out.includes("="));
  assert.ok(!out.includes("+"));
  assert.ok(!out.includes("/"));
});

test("hashing is stable, and one-way in the sense that matters", async () => {
  const token = randomToken();
  const a = await hashToken(token);
  const b = await hashToken(token);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, "sha-256 hex");
  assert.notEqual(a, token, "the stored value must not be the cookie value");
});

test("different tokens hash differently", async () => {
  assert.notEqual(await hashToken("a"), await hashToken("b"));
});

test("timingSafeEqual matches only identical strings", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
  assert.equal(timingSafeEqual("", ""), true);
  assert.equal(timingSafeEqual(null, undefined), true);   // both empty
  assert.equal(timingSafeEqual("abc", null), false);
});

/* ------------------------------------------------------------------
   Cookies
   ------------------------------------------------------------------ */

test("parses a cookie header", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
});

test("parses values containing = and url-encoding", () => {
  assert.deepEqual(parseCookies("t=ab%3Dcd"), { t: "ab=cd" });
  assert.equal(parseCookies("t=a=b").t, "a=b");
});

test("a missing or malformed header is an empty object, not a throw", () => {
  for(const h of [undefined, null, "", "   ", "novalue", "=orphan"]){
    assert.deepEqual(parseCookies(h), {});
  }
});

test("the session cookie carries every flag that protects it", () => {
  const c = serialiseCookie(SESSION_COOKIE, "tok", { maxAge: 3600 });
  assert.match(c, /HttpOnly/,        "a page script must not be able to read it");
  assert.match(c, /Secure/,          "it must never travel in clear");
  assert.match(c, /SameSite=Lax/,    "another site must not be able to use it");
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=3600/);
});

test("clearing a cookie expires it immediately", () => {
  assert.match(clearCookie(SESSION_COOKIE), /Max-Age=0/);
});

test("cookie values are encoded so a stray semicolon cannot inject an attribute", () => {
  const c = serialiseCookie("x", "a; HttpOnly=no; b");
  assert.equal(c.split(";")[0], "x=a%3B%20HttpOnly%3Dno%3B%20b");
});

/* ------------------------------------------------------------------
   Google identity token
   ------------------------------------------------------------------ */

test("decodes the payload of a well-formed token", () => {
  const p = decodeIdToken(jwt(goodPayload()));
  assert.equal(p.sub, "108124098124098");
  assert.equal(p.email, "someone@example.com");
});

test("anything that is not a three-part token decodes to null", () => {
  for(const v of ["", "abc", "a.b", "a.b.c.d", null, undefined, 42, "a.!!!.c"]){
    assert.equal(decodeIdToken(v), null);
  }
});

test("a valid token yields the user", () => {
  const r = validateIdToken(goodPayload(), CLIENT_ID, now);
  assert.equal(r.ok, true);
  assert.deepEqual(r.user, { id: "108124098124098", email: "someone@example.com", name: "Someone" });
});

test("a token minted for another application is refused", () => {
  /* The check that matters most: without it, any Google token would sign
     someone in here. */
  const r = validateIdToken(goodPayload({ aud: "9999.apps.googleusercontent.com" }), CLIENT_ID, now);
  assert.equal(r.ok, false);
  assert.match(r.reason, /different application/i);
});

test("a token from another issuer is refused", () => {
  const r = validateIdToken(goodPayload({ iss: "https://evil.example" }), CLIENT_ID, now);
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not come from Google/i);
});

test("both of Google's issuer spellings are accepted", () => {
  for(const iss of ["accounts.google.com", "https://accounts.google.com"]){
    assert.equal(validateIdToken(goodPayload({ iss }), CLIENT_ID, now).ok, true);
  }
});

test("an expired token is refused", () => {
  const r = validateIdToken(goodPayload({ exp: now - 1 }), CLIENT_ID, now);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/i);
});

test("a token with no expiry is refused rather than treated as eternal", () => {
  const p = goodPayload(); delete p.exp;
  assert.equal(validateIdToken(p, CLIENT_ID, now).ok, false);
});

test("a token issued in the future is refused", () => {
  const r = validateIdToken(goodPayload({ iat: now + 600 }), CLIENT_ID, now);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not valid yet/i);
});

test("small clock skew is tolerated", () => {
  assert.equal(validateIdToken(goodPayload({ iat: now + 30 }), CLIENT_ID, now).ok, true);
});

test("an unverified email address is refused", () => {
  const r = validateIdToken(goodPayload({ email_verified: false }), CLIENT_ID, now);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unverified/i);
});

test("a token with no subject is refused", () => {
  const p = goodPayload(); delete p.sub;
  assert.equal(validateIdToken(p, CLIENT_ID, now).ok, false);
});

test("validation refuses when no client id is configured", () => {
  /* A missing GOOGLE_CLIENT_ID must fail closed, not accept everything. */
  assert.equal(validateIdToken(goodPayload(), undefined, now).ok, false);
  assert.equal(validateIdToken(goodPayload(), "", now).ok, false);
});

test("null and rubbish payloads are refused", () => {
  for(const v of [null, undefined, "string", 42]){
    assert.equal(validateIdToken(v, CLIENT_ID, now).ok, false);
  }
});

test("an absurdly long display name is truncated, not stored whole", () => {
  const r = validateIdToken(goodPayload({ name: "x".repeat(5000) }), CLIENT_ID, now);
  assert.ok(r.user.name.length <= 120);
});

/* ------------------------------------------------------------------
   What may be stored
   ------------------------------------------------------------------ */

test("only known planner keys are accepted", () => {
  assert.equal(isStateKey("invest"), true);
  assert.equal(isStateKey("dashHoldings"), true);
  assert.equal(isStateKey("anything-else"), false);
  assert.equal(isStateKey("__proto__"), false);
});

test("tax is not a storable key, anywhere", () => {
  /* Deliberate: tax figures are never persisted, locally or on the server. */
  for(const k of ["tax", "taxInputs", "salary"]) assert.equal(isStateKey(k), false);
  assert.ok(!STATE_KEYS.has("tax"));
});

test("a valid payload comes back serialised", () => {
  const r = validateStatePayload({ invest: { years: 10 } });
  assert.equal(r.ok, true);
  assert.equal(r.clean.invest, '{"years":10}');
});

test("an unknown key is refused, naming it", () => {
  const r = validateStatePayload({ invest: {}, sneaky: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sneaky/);
});

test("an oversized value is refused", () => {
  const r = validateStatePayload({ invest: { blob: "x".repeat(MAX_VALUE_BYTES + 100) } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too large/i);
});

test("a value that cannot be serialised is refused rather than throwing", () => {
  const cyclic = {}; cyclic.self = cyclic;
  const r = validateStatePayload({ invest: cyclic });
  assert.equal(r.ok, false);
});

test("undefined values are refused rather than stored as the string undefined", () => {
  assert.equal(validateStatePayload({ invest: undefined }).ok, false);
});

test("empty and non-object bodies are refused", () => {
  for(const v of [null, undefined, {}, [], "string", 42]){
    assert.equal(validateStatePayload(v).ok, false);
  }
});

/* ------------------------------------------------------------------
   Session lifetime
   ------------------------------------------------------------------ */

test("sessions expire, and not immediately", () => {
  const base = 1_000_000_000_000;
  const exp = sessionExpiry(base);
  assert.ok(exp > base, "must be in the future");
  assert.equal(exp, base + SESSION_DAYS * 24 * 3600 * 1000);
  assert.ok(SESSION_DAYS >= 7 && SESSION_DAYS <= 90, "a sane window");
});
