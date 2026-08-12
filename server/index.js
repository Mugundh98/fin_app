/* The site Worker: static pages, plus a small API for sign-in and saved state.
 *
 * The API lives on the SAME ORIGIN as the pages, deliberately. A session
 * cookie set from a different origin needs SameSite=None, which Safari and
 * Firefox drop by default — logins would fail for a large share of users
 * with no obvious cause. Everything under /api/ is handled here; everything
 * else falls through to the files in public/.
 *
 * Bindings expected (see wrangler.toml):
 *   ASSETS               the static site
 *   DB                   D1
 *   GOOGLE_CLIENT_ID     var, public
 *   GOOGLE_CLIENT_SECRET secret — npx wrangler secret put GOOGLE_CLIENT_SECRET
 */

import {
  SESSION_COOKIE, OAUTH_STATE_COOKIE, SESSION_DAYS,
  randomToken, hashToken, timingSafeEqual,
  parseCookies, serialiseCookie, clearCookie,
  decodeIdToken, validateIdToken, validateStatePayload, sessionExpiry
} from "./auth.js";

const GOOGLE_AUTH  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
});

const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, ...headers } });

/* ============================================================
   SESSIONS
   ============================================================ */

async function currentUser(request, env){
  if(!env.DB) return null;
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if(!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(await hashToken(token)).first();

  if(!row) return null;
  if(Number(row.expires_at) <= Date.now()){
    /* Expired sessions are removed on encounter rather than left to
       accumulate; there is no cron here to sweep them. */
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`)
      .bind(await hashToken(token)).run();
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

/* SameSite=Lax already blocks a cross-site form POST from carrying the
   cookie. This is a second, independent check, because getting CSRF wrong
   costs the user their data. */
function sameOrigin(request){
  const origin = request.headers.get("origin");
  if(!origin) return true;                 // same-origin GETs often omit it
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

/* ============================================================
   ROUTES
   ============================================================ */

async function handleApi(request, env, url){
  const path = url.pathname;
  const method = request.method;

  /* ---- who am I ---- */
  if(path === "/api/me" && method === "GET"){
    return json({ user: await currentUser(request, env) });
  }

  /* ---- start sign-in ---- */
  if(path === "/api/auth/google" && method === "GET"){
    if(!env.GOOGLE_CLIENT_ID){
      return json({ error: "Sign-in is not configured on this deployment." }, 503);
    }
    /* The state parameter is echoed back by Google and compared against a
       cookie, so a callback the user did not initiate cannot log them in. */
    const state = randomToken(16);
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/api/auth/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account"
    });
    return redirect(`${GOOGLE_AUTH}?${params}`, {
      "set-cookie": serialiseCookie(OAUTH_STATE_COOKIE, state, { maxAge: 600 })
    });
  }

  /* ---- return from Google ---- */
  if(path === "/api/auth/callback" && method === "GET"){
    const fail = reason => redirect(`/?signin=failed&why=${encodeURIComponent(reason)}`, {
      "set-cookie": clearCookie(OAUTH_STATE_COOKIE)
    });

    if(url.searchParams.get("error")) return fail("You cancelled sign-in.");

    const expected = parseCookies(request.headers.get("cookie"))[OAUTH_STATE_COOKIE];
    if(!expected || !timingSafeEqual(expected, url.searchParams.get("state") ?? "")){
      return fail("That sign-in did not start here.");
    }

    const code = url.searchParams.get("code");
    if(!code) return fail("Google sent no authorisation code.");
    if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.DB){
      return fail("Sign-in is not configured on this deployment.");
    }

    let tokens;
    try{
      const res = await fetch(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/api/auth/callback`,
          grant_type: "authorization_code"
        })
      });
      if(!res.ok) return fail("Google refused the sign-in.");
      tokens = await res.json();
    } catch { return fail("Could not reach Google."); }

    /* This token came from Google directly over TLS in exchange for a
       one-time code, so its origin is established; the claims still have to
       be checked. See the note in auth.js. */
    const check = validateIdToken(decodeIdToken(tokens?.id_token), env.GOOGLE_CLIENT_ID);
    if(!check.ok) return fail(check.reason);

    const now = Date.now();
    const { id, email, name } = check.user;

    await env.DB.prepare(
      `INSERT INTO users (id, email, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, last_seen = excluded.last_seen`
    ).bind(id, email, name, now, now).run();

    const token = randomToken();
    await env.DB.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
    ).bind(await hashToken(token), id, now, sessionExpiry(now)).run();

    return new Response(null, {
      status: 302,
      headers: [
        ["location", "/?signin=ok"],
        ["set-cookie", clearCookie(OAUTH_STATE_COOKIE)],
        ["set-cookie", serialiseCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 24 * 3600 })]
      ]
    });
  }

  /* ---- sign out ---- */
  if(path === "/api/auth/logout" && method === "POST"){
    if(!sameOrigin(request)) return json({ error: "Cross-origin request refused." }, 403);
    const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
    if(token && env.DB){
      await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`)
        .bind(await hashToken(token)).run();
    }
    return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
  }

  /* ---- saved state ---- */
  if(path === "/api/state"){
    const user = await currentUser(request, env);
    if(!user) return json({ error: "Not signed in." }, 401);

    if(method === "GET"){
      const { results } = await env.DB.prepare(
        `SELECT key, value, updated_at FROM state WHERE user_id = ?`
      ).bind(user.id).all();

      const state = {};
      let updatedAt = 0;
      for(const row of results ?? []){
        try { state[row.key] = JSON.parse(row.value); } catch { /* skip a corrupt row */ }
        updatedAt = Math.max(updatedAt, Number(row.updated_at) || 0);
      }
      return json({ state, updatedAt });
    }

    if(method === "PUT"){
      if(!sameOrigin(request)) return json({ error: "Cross-origin request refused." }, 403);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Expected JSON." }, 400); }

      const check = validateStatePayload(body);
      if(!check.ok) return json({ error: check.reason }, 400);

      const now = Date.now();
      const statements = Object.entries(check.clean).map(([key, value]) =>
        env.DB.prepare(
          `INSERT INTO state (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).bind(user.id, key, value, now)
      );
      await env.DB.batch(statements);
      return json({ ok: true, updatedAt: now });
    }

    return json({ error: "Method not allowed." }, 405);
  }

  /* ---- delete everything ---- */
  if(path === "/api/account" && method === "DELETE"){
    if(!sameOrigin(request)) return json({ error: "Cross-origin request refused." }, 403);
    const user = await currentUser(request, env);
    if(!user) return json({ error: "Not signed in." }, 401);

    /* Rows cascade from users, but D1 does not enforce foreign keys by
       default, so each table is cleared explicitly. */
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM state    WHERE user_id = ?`).bind(user.id),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id),
      env.DB.prepare(`DELETE FROM users    WHERE id = ?`).bind(user.id)
    ]);
    return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
  }

  return json({ error: "No such endpoint." }, 404);
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if(url.pathname.startsWith("/api/")){
      try { return await handleApi(request, env, url); }
      catch (err) {
        /* Never leak a stack trace or SQL to the client. */
        console.error("api error", err?.message);
        return json({ error: "Something went wrong on the server." }, 500);
      }
    }

    /* Everything else is the static site. */
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
};
