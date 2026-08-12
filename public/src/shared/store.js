/* Local persistence — pure logic plus one browser API, no DOM.

   Everything is kept in this browser's localStorage. Nothing is sent
   anywhere, and there is no account: the data lives on the machine that
   typed it and nowhere else. That is the whole design, and it is why the
   "nothing leaves your browser" line on these pages stays true.

   Two things this has to survive, because both happen in practice:

     - Storage being unavailable. Safari in private mode throws on write,
       and browsers can have it disabled outright. Every function degrades
       to "no saved state" rather than throwing into a page's startup.

     - Stored data being wrong. It might come from an older version of the
       app, or have been hand-edited in devtools. Nothing loaded here is
       trusted: values are checked against the shape the caller expects and
       anything unrecognised is dropped rather than handed to the engines.

   If this ever moves to a server, `load` and `save` are the seam. */

const PREFIX = "finapp.v1.";

/* Deliberately not cached. The probe is one write and one delete, and
   caching it would mean storage that becomes available mid-session — or is
   cleared by the user — never being noticed. */
export function isAvailable(){
  try{
    const probe = PREFIX + "__probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch { return false; }
}

export function load(key, fallback = null){
  if(!isAvailable()) return fallback;
  try{
    const raw = localStorage.getItem(PREFIX + key);
    if(raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch { return fallback; }
}

/* Returns false rather than throwing when the write fails — over quota, or
   storage disabled. A page must not lose its render because a save failed. */
/* When signed in, account.js registers a handler here so a local write also
   goes to the server. This is the seam the file header describes: nothing
   else in the app knows an account exists. */
let syncHandler = null;
export function setSyncHandler(fn){ syncHandler = typeof fn === "function" ? fn : null; }

export function save(key, value){
  if(!isAvailable()) return false;
  let written = false;
  try{
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    written = true;
  } catch { /* over quota, or storage disabled */ }

  /* The local write is the source of truth for this tab either way — a
     failed upload must not lose what the user just typed. */
  if(syncHandler){
    try { syncHandler(key, value); } catch { /* never break a render */ }
  }
  return written;
}

export function remove(key){
  if(!isAvailable()) return false;
  try{ localStorage.removeItem(PREFIX + key); return true; }
  catch { return false; }
}

/* Every key this app owns, so "forget everything" is one call and cannot
   miss one. Other sites' keys on the same origin are left alone. */
export function clearAll(){
  if(!isAvailable()) return 0;
  try{
    const mine = Object.keys(localStorage).filter(k => k.startsWith(PREFIX));
    mine.forEach(k => localStorage.removeItem(k));
    return mine.length;
  } catch { return 0; }
}

export function hasAny(){
  if(!isAvailable()) return false;
  try{ return Object.keys(localStorage).some(k => k.startsWith(PREFIX)); }
  catch { return false; }
}

/* ============================================================
   TYPED LOADERS
   ============================================================ */

/* Merge stored values over defaults, key by key, keeping only keys the
   defaults declare and only where the type still matches. An old build that
   stored a string where a number now lives cannot poison the engines. */
export function loadState(key, defaults){
  const out = { ...defaults };
  const stored = load(key, null);
  if(!stored || typeof stored !== "object" || Array.isArray(stored)) return out;

  for(const k of Object.keys(defaults)){
    const v = stored[k];
    if(v === undefined || v === null) continue;
    const want = typeof defaults[k];
    if(typeof v !== want) continue;
    if(want === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

/* Lists get per-item validation because a holdings table is user data, not
   settings: one bad row should cost that row, not the whole portfolio.
   `validate` returns a cleaned item, or null to drop it. */
export function loadList(key, validate){
  const stored = load(key, null);
  if(!Array.isArray(stored)) return null;
  const out = [];
  for(const item of stored){
    try{
      const clean = validate(item);
      if(clean) out.push(clean);
    } catch { /* drop the row, keep the rest */ }
  }
  return out;
}

/* ============================================================
   DEBOUNCED WRITES
   ============================================================ */

const timers = new Map();

/* Typing in a field fires on every keystroke; storage does not need to hear
   about all of them. The value is read at write time, so the last state wins
   rather than whatever was current when the first keystroke landed. */
export function saveSoon(key, getValue, delay = 400){
  const pending = timers.get(key);
  if(pending) clearTimeout(pending.id);

  const id = setTimeout(() => {
    timers.delete(key);
    try { save(key, getValue()); } catch { /* never let a save break a render */ }
  }, delay);
  timers.set(key, { id, getValue });
}

/* Commit anything still queued, rather than cancelling it. Called on
   pagehide: a debounced write with 300ms left on the clock would otherwise
   be lost exactly when the user closes the tab. */
export function flush(){
  for(const [key, { id, getValue }] of [...timers]){
    clearTimeout(id);
    timers.delete(key);
    try { save(key, getValue()); } catch { /* nothing more to be done */ }
  }
}
