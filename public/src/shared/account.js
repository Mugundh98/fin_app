/* Sign-in and server sync.
 *
 * The rules, in one place, because "which copy wins" is where sync bugs live:
 *
 *   - Signed out: nothing changes. Everything is local, exactly as before.
 *   - Signed in:  the server is authoritative on load. Whatever is on the
 *                 account replaces the local copy, so a second device shows
 *                 the same figures rather than two half-portfolios.
 *   - First sign-in on an account with nothing saved: the local data is
 *     pushed up, so signing in does not appear to erase your work.
 *
 * Every network call fails soft. The planners are useful with no account and
 * no connection, and an outage must not cost anyone their page.
 */

import { load, clearAll, setSyncHandler } from './store.js';

/* Kept in step with the server's allowlist in server/auth.js. Sending a key
   it does not know would be refused for the whole batch. */
const SYNCED_KEYS = [
  "invest", "insure",
  "portfolioHoldings", "portfolioSettings",
  "dashHoldings", "proxyUrl"
];

let session = null;

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...options
  });
  if(!res.ok) throw new Error(String(res.status));
  return res.json();
};

export const currentUser = () => session;

/* ============================================================
   SYNC
   ============================================================ */

const dirty = new Set();
let pushTimer = null;

function queuePush(key){
  if(!session || !SYNCED_KEYS.includes(key)) return;
  dirty.add(key);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1200);
}

async function pushNow(){
  if(!session || !dirty.size) return;
  const body = {};
  for(const key of dirty){
    const value = load(key, null);
    if(value !== null) body[key] = value;
  }
  dirty.clear();
  if(!Object.keys(body).length) return;
  try { await api("/api/state", { method: "PUT", body: JSON.stringify(body) }); }
  catch { /* the local copy still holds it; the next save retries */ }
}

/* Runs before any planner module loads, so nothing reads local state and
   then has it changed underneath. */
export async function syncBeforeStart(){
  try {
    const me = await api("/api/me");
    session = me.user ?? null;
  } catch { session = null; }

  if(!session) return null;

  setSyncHandler(queuePush);
  addEventListener("pagehide", () => { clearTimeout(pushTimer); pushNow(); });

  try {
    const { state } = await api("/api/state");
    const serverKeys = Object.keys(state ?? {});

    if(serverKeys.length){
      /* Server wins. Written straight to localStorage so every planner picks
         it up through the path it already uses. */
      for(const key of serverKeys) if(SYNCED_KEYS.includes(key)) writeLocal(key, state[key]);
    } else {
      /* Nothing on the account yet — adopt whatever this browser has, so
         signing in never looks like it wiped your work. */
      const local = {};
      for(const key of SYNCED_KEYS){
        const value = load(key, null);
        if(value !== null) local[key] = value;
      }
      if(Object.keys(local).length){
        await api("/api/state", { method: "PUT", body: JSON.stringify(local) });
      }
    }
  } catch { /* keep going with the local copy */ }

  return session;
}

/* Bypasses save() so restoring from the server does not immediately queue a
   push of what we just received. */
function writeLocal(key, value){
  try { localStorage.setItem("finapp.v1." + key, JSON.stringify(value)); }
  catch { /* storage unavailable; the page still renders from defaults */ }
}

/* ============================================================
   ACTIONS
   ============================================================ */

export const signIn = () => { location.href = "/api/auth/google"; };

export async function signOut(){
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  session = null;
  setSyncHandler(null);
  /* The local copy is cleared too. Leaving one person's portfolio behind on
     a shared machine after they signed out would be indefensible. */
  clearAll();
  location.reload();
}

export async function deleteAccount(){
  try { await api("/api/account", { method: "DELETE" }); } catch {}
  session = null;
  setSyncHandler(null);
  clearAll();
  location.reload();
}

/* ============================================================
   UI
   ============================================================ */

/* Appends itself to the masthead of whichever page loaded it, so no page
   needs markup for this. */
export function mountAccountBar(){
  const host = document.querySelector(".masthead-in");
  if(!host || document.getElementById("accountBar")) return;

  const el = document.createElement("div");
  el.className = "account-bar";
  el.id = "accountBar";
  host.appendChild(el);
  renderBar(el);
}

function renderBar(el){
  if(session){
    const who = session.name || session.email || "your account";
    el.innerHTML =
      `<span class="who">Signed in as <b>${escapeHtml(who)}</b></span>` +
      `<button type="button" id="signOutBtn">Sign out</button>`;
    el.querySelector("#signOutBtn").addEventListener("click", signOut);
  } else {
    el.innerHTML =
      `<span class="who">Saving to this browser only</span>` +
      `<button type="button" id="signInBtn" class="primary">Sign in with Google</button>`;
    el.querySelector("#signInBtn").addEventListener("click", signIn);
  }
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

/* Reports the outcome of a redirect back from Google. */
export function signInNotice(){
  const params = new URLSearchParams(location.search);
  const status = params.get("signin");
  if(!status) return null;
  history.replaceState({}, "", location.pathname);
  return status === "ok"
    ? { ok: true, message: "Signed in. Your planners will follow you to any browser." }
    : { ok: false, message: params.get("why") || "Sign-in did not complete." };
}
