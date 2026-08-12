import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------
   A localStorage stand-in. Node has none, and the interesting cases —
   storage disabled, quota exhausted, corrupt values — are exactly the
   ones a real browser makes hard to reproduce.
   ------------------------------------------------------------------ */
function makeStorage({ throwOnWrite = false, quotaAfter = Infinity } = {}){
  const map = new Map();
  let writes = 0;
  const store = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if(throwOnWrite) throw new Error("SecurityError: storage disabled");
      if(++writes > quotaAfter){
        const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e;
      }
      map.set(k, String(v));
    },
    removeItem: k => { map.delete(k); },
    get length(){ return map.size; },
    /* Object.keys(localStorage) walks own enumerable properties, so the
       stub has to expose keys the same way a real one does. */
    _map: map
  };
  return new Proxy(store, {
    ownKeys: t => [...map.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (t, p) => (p in t ? t[p] : map.get(p))
  });
}

const install = opts => { globalThis.localStorage = makeStorage(opts); };

/* Imported once; every function probes storage at call time rather than
   caching, so swapping the global between tests works. */
const {
  isAvailable, load, save, remove, clearAll, hasAny,
  loadState, loadList, saveSoon, flush
} = await import("../../public/src/shared/store.js");

beforeEach(() => install());

/* ------------------------------------------------------------------
   Round trip
   ------------------------------------------------------------------ */

test("saves and loads a value", () => {
  assert.equal(save("thing", { a: 1 }), true);
  assert.deepEqual(load("thing"), { a: 1 });
});

test("a key never written returns the fallback", () => {
  assert.equal(load("nope", "fallback"), "fallback");
  assert.equal(load("nope"), null);
});

test("keys are namespaced so other apps on the origin are untouched", () => {
  save("thing", 1);
  assert.ok(Object.keys(localStorage).every(k => k.startsWith("finapp.v1.")));
});

test("remove deletes just that key", () => {
  save("a", 1); save("b", 2);
  remove("a");
  assert.equal(load("a"), null);
  assert.equal(load("b"), 2);
});

/* ------------------------------------------------------------------
   Storage that is not there
   ------------------------------------------------------------------ */

test("storage that throws on write is reported unavailable, not fatal", () => {
  install({ throwOnWrite: true });
  assert.equal(isAvailable(), false);
  assert.equal(save("x", 1), false);
  assert.equal(load("x", "default"), "default");
  assert.equal(clearAll(), 0);
  assert.equal(hasAny(), false);
});

test("a missing localStorage entirely does not throw", () => {
  delete globalThis.localStorage;
  assert.equal(isAvailable(), false);
  assert.equal(save("x", 1), false);
  assert.deepEqual(loadState("x", { a: 1 }), { a: 1 });
  install();
});

test("a quota error is caught and reported as a failed save", () => {
  install({ quotaAfter: 1 });
  isAvailable();               // burns the probe write
  assert.equal(save("big", "x"), false);
});

/* ------------------------------------------------------------------
   Data that cannot be trusted
   ------------------------------------------------------------------ */

test("corrupt JSON falls back instead of throwing", () => {
  localStorage.setItem("finapp.v1.broken", "{not json");
  assert.equal(load("broken", "safe"), "safe");
});

test("a stored null gives the fallback, not null", () => {
  localStorage.setItem("finapp.v1.nulled", "null");
  assert.equal(load("nulled", "fallback"), "fallback");
});

/* ------------------------------------------------------------------
   loadState — settings
   ------------------------------------------------------------------ */

const defaults = { years: 20, name: "x", flag: true };

test("loadState returns the defaults when nothing is stored", () => {
  assert.deepEqual(loadState("s", defaults), defaults);
});

test("loadState merges stored values over the defaults", () => {
  save("s", { years: 5, name: "saved" });
  assert.deepEqual(loadState("s", defaults), { years: 5, name: "saved", flag: true });
});

test("loadState ignores keys the defaults do not declare", () => {
  save("s", { years: 5, injected: "should not appear" });
  const out = loadState("s", defaults);
  assert.equal(out.injected, undefined);
  assert.equal(out.years, 5);
});

test("loadState drops a value whose type no longer matches", () => {
  /* An older build stored a string where a number now lives. */
  save("s", { years: "twenty", name: "kept" });
  const out = loadState("s", defaults);
  assert.equal(out.years, 20, "the default must win");
  assert.equal(out.name, "kept");
});

test("loadState rejects NaN and Infinity for numbers", () => {
  /* JSON turns both into null, but a hand-edited value could be anything. */
  localStorage.setItem("finapp.v1.s", JSON.stringify({ years: null }));
  assert.equal(loadState("s", defaults).years, 20);
});

test("loadState survives an array or a primitive where an object was expected", () => {
  save("s", [1, 2, 3]);
  assert.deepEqual(loadState("s", defaults), defaults);
  save("s", "just a string");
  assert.deepEqual(loadState("s", defaults), defaults);
});

test("loadState does not hand back the defaults object itself", () => {
  const out = loadState("s", defaults);
  out.years = 999;
  assert.equal(defaults.years, 20, "defaults were mutated");
});

/* ------------------------------------------------------------------
   loadList — user data
   ------------------------------------------------------------------ */

const validHolding = h =>
  h && typeof h.name === "string" && Number.isFinite(h.value) && h.value > 0
    ? { name: h.name, value: h.value } : null;

test("loadList returns null when nothing is stored", () => {
  assert.equal(loadList("h", validHolding), null);
});

test("loadList keeps the good rows and drops the bad", () => {
  save("h", [
    { name: "Good", value: 100 },
    { name: "No value" },
    { value: 50 },
    null,
    { name: "Negative", value: -5 },
    { name: "Also good", value: 200 }
  ]);
  assert.deepEqual(loadList("h", validHolding),
    [{ name: "Good", value: 100 }, { name: "Also good", value: 200 }]);
});

test("one row that throws in the validator does not lose the rest", () => {
  save("h", [{ name: "A", value: 1 }, { boom: true }, { name: "B", value: 2 }]);
  const out = loadList("h", h => {
    if(h.boom) throw new Error("bad row");
    return validHolding(h);
  });
  assert.deepEqual(out.map(x => x.name), ["A", "B"]);
});

test("loadList rejects anything that is not an array", () => {
  save("h", { not: "an array" });
  assert.equal(loadList("h", validHolding), null);
});

test("loadList can legitimately return an empty list", () => {
  save("h", []);
  assert.deepEqual(loadList("h", validHolding), []);
});

/* ------------------------------------------------------------------
   Clearing
   ------------------------------------------------------------------ */

test("clearAll removes every key this app owns and reports the count", () => {
  save("a", 1); save("b", 2); save("c", 3);
  localStorage.setItem("someoneElse.key", "keep me");
  assert.equal(hasAny(), true);
  assert.equal(clearAll(), 3);
  assert.equal(hasAny(), false);
  assert.equal(localStorage.getItem("someoneElse.key"), "keep me");
});

test("clearAll on empty storage is zero, not an error", () => {
  assert.equal(clearAll(), 0);
});

/* ------------------------------------------------------------------
   Debounced writes
   ------------------------------------------------------------------ */

test("saveSoon defers the write", async () => {
  saveSoon("d", () => "written", 20);
  assert.equal(load("d"), null, "wrote immediately");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(load("d"), "written");
});

test("rapid calls collapse to one write of the latest value", async () => {
  let n = 0;
  for(const v of ["a", "b", "c"]) saveSoon("d", () => { n++; return v; }, 20);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(load("d"), "c");
  assert.equal(n, 1, "the value was read more than once");
});

test("flush commits pending writes rather than cancelling them", () => {
  saveSoon("d", () => "pending", 10000);
  assert.equal(load("d"), null);
  flush();
  assert.equal(load("d"), "pending", "a queued write was lost on flush");
});

test("flush with nothing queued is harmless", () => {
  flush();
  assert.equal(hasAny(), false);
});

test("a save that throws inside the timer does not escape", async () => {
  saveSoon("d", () => { throw new Error("getValue blew up"); }, 10);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(load("d"), null);
});
