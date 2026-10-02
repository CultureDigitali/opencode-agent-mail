import { test } from "node:test"
import assert from "node:assert/strict"

// ── Regressione: il plugin deve restare CARICABILE da opencode ──
//
// opencode scorre TUTTI gli export del modulo. Logica `lk`/`dk` trascritta
// dal binario installato (opencode-ai 1.18.x, stringa "Plugin export is not
// a function"), verificata riga per riga:
//
//   function lk(x){ if(typeof x==="function") return x;
//                    if(!x||typeof x!=="object"||!("server" in x)) return;
//                    if(typeof x.server!=="function") return; return x.server }
//   function dk(m){ const seen=new Set(), out=[];
//                    for(const v of Object.values(m)){ if(seen.has(v))continue;
//                      seen.add(v); const j=lk(v);
//                      if(!j) throw TypeError("Plugin export is not a function");
//                      out.push(j) } return out }
//
// Un export non-funzione (per esempio un `export const __testing = {...}`)
// fa fallire l'intero caricamento in silenzio: zero tool, nessun errore in UI.
// Questo test esiste perché quel bug è stato introdotto realmente.

function lk(x) {
  if (typeof x === "function") return x
  if (!x || typeof x !== "object" || !("server" in x)) return undefined
  if (typeof x.server !== "function") return undefined
  return x.server
}

function dk(mod) {
  const seen = new Set()
  const out = []
  for (const v of Object.values(mod)) {
    if (seen.has(v)) continue
    seen.add(v)
    const j = lk(v)
    if (!j) throw new TypeError("Plugin export is not a function")
    out.push(j)
  }
  return out
}

const mod = await import("../dist/index.js")

test("REGRESSION: il loader di opencode riesce a caricare il modulo", () => {
  let loaded
  try {
    loaded = dk(mod)
  } catch (e) {
    assert.fail(`il loader di opencode rigetta il modulo: ${e.message}. Nessun export non-funzione ammesso.`)
  }
  assert.ok(loaded.length >= 1, "deve risultare almeno un plugin")
})

test("REGRESSION: tutti gli export sono plugin validi o duplicati dello stesso plugin", () => {
  const nonFunction = Object.entries(mod).filter(([, v]) => typeof v !== "function")
  assert.deepEqual(
    nonFunction.map(([k]) => k),
    [],
    `export non-funzione trovati: ${nonFunction.map(([k]) => k).join(", ")} — rompono il caricamento`
  )
})

test("REGRESSION: default e named export sono lo stesso plugin (nessun doppio caricamento)", () => {
  assert.equal(typeof mod.default, "function")
  assert.equal(mod.default, mod.AgentMailPlugin, "default e AgentMailPlugin devono essere la stessa funzione")
  assert.equal(dk(mod).length, 1, "opencode deve istanziare il plugin una sola volta")
})

test("REGRESSION: la superficie di test è una PROPRIETÀ del plugin, non un export", () => {
  assert.equal(mod.__testing, undefined, "__testing non deve essere un export del modulo")
  assert.ok(mod.AgentMailPlugin.__testing, "deve essere raggiungibile come proprietà")
  assert.equal(typeof mod.AgentMailPlugin.__testing.evaluateGate, "function")
  assert.equal(typeof mod.default.__testing.evaluateGate, "function", "raggiungibile anche via default")
})