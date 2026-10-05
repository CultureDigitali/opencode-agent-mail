import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as mod from "../dist/index.js"

// SICUREZZA: nessuna operazione di rete in questo file.
// Lo state dir è temporaneo e il transport viene iniettato finto PRIMA di
// qualunque chiamata, così anche su una macchina con Gmail configurato
// questo test non può mai inviare email vere.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-smoke-"))
process.env.AGENT_MAIL_STATE_DIR = STATE_DIR
if (!mod.AgentMailPlugin.__testing || typeof mod.AgentMailPlugin.__testing.setTransportFactory !== "function") {
  console.error("FAIL: dist/index.js non espone AgentMailPlugin.__testing (build non eseguito?)")
  process.exit(1)
}

const plugin = mod.AgentMailPlugin || mod.default
if (typeof plugin !== "function") {
  console.error("FAIL: il modulo non esporta una funzione plugin")
  process.exit(1)
}

const input = {
  directory: process.cwd(),
  worktree: process.cwd(),
  client: {},
  project: {},
  serverUrl: new URL("http://localhost:4096"),
  $: () => {},
  experimental_workspace: { register() {} },
}

const hooks = await plugin(input)

const expected = ["mail_send", "mail_report", "mail_preview_signature", "mail_status", "mail_verify", "mail_inbox"]
const missing = expected.filter((t) => !(t in hooks.tool))
if (missing.length) {
  console.error("FAIL: tool mancanti:", missing.join(","))
  process.exit(1)
}
console.log("OK: 6 tool registrati")

const fail = (msg) => {
  console.error("FAIL:", msg)
  process.exit(1)
}

// --- ramo 1: SMTP non configurato (transport factory → null) ---
mod.AgentMailPlugin.__testing.setTransportFactory(() => null)
const unconfigured = await hooks.tool.mail_send.execute(
  { to: "test@example.invalid", subject: "smoke", html: "<p>x</p>", reason: "smoke test", confirm: true },
  { sessionID: `smoke-off-${Date.now()}`, agent: "build", directory: process.cwd(), worktree: process.cwd() }
)
const offlineMsg = String(unconfigured.output)
console.log("ramo offline:", offlineMsg.split("\n")[0])
if (!/non configurato/i.test(offlineMsg)) fail("senza transport deve segnalare SMTP non configurato")

// --- ramo 2: gate di contesto (transport finto, zero rete) ---
const sent = []
mod.AgentMailPlugin.__testing.setTransportFactory(() => ({
  async sendMail(msg) {
    sent.push(msg)
    return { messageId: "smoke-id", accepted: [msg.to], rejected: [] }
  },
  async verify() {
    return true
  },
}))

const ctx = {
  sessionID: `smoke-gate-${Date.now()}`,
  agent: "build",
  directory: process.cwd(),
  worktree: process.cwd(),
}

const blocked = await hooks.tool.mail_send.execute({ to: "test@example.invalid", subject: "smoke", html: "<p>x</p>" }, ctx)
console.log("gate:", String(blocked.output).split("\n")[0])
if (!/BLOCCATO|PRIMO INVIO/.test(blocked.output)) fail("il gate non ha bloccato il primo invio senza reason/confirm")
if (sent.length !== 0) fail(`il gate ha comunque inviato ${sent.length} email`)

// whitespace-only reason: deve essere trattato come assente
const blockedWs = await hooks.tool.mail_send.execute(
  { to: "test@example.invalid", subject: "smoke", html: "<p>x</p>", reason: "   ", confirm: true },
  ctx
)
if (!/BLOCCATO/.test(blockedWs.output)) fail("un reason fatto solo di spazi deve bloccare")
if (sent.length !== 0) fail("reason vuoto ha comunque inviato")
console.log("OK: gate bloccato (reason assente e reason whitespace), zero invii")

const allowed = await hooks.tool.mail_send.execute(
  { to: "test@example.invalid", subject: "smoke", html: "<p>x</p>", reason: "smoke test", confirm: true },
  ctx
)
if (!/Email inviata/.test(allowed.output)) fail(`invio con reason+confirm non riuscito: ${allowed.output}`)
if (sent.length !== 1) fail(`attesi 1 invio, trovati ${sent.length}`)
console.log("OK: invio consentito dopo reason+confirm")

const msg = sent[0]
if (!msg.html.includes("Agent Mail")) fail("firma non presente")
if (!msg.headers["X-Agent-ID"]) fail("X-Agent-ID mancante")
if (/[\r\n]/.test(msg.subject)) fail("subject con CRLF")
console.log("OK: firma, header e subject sanificati")

// secondo invio nella stessa sessione: non deve più chiedere conferma
const second = await hooks.tool.mail_send.execute({ to: "test@example.invalid", subject: "smoke2", html: "<p>y</p>" }, ctx)
if (!/Email inviata/.test(second.output)) fail(`secondo invio bloccato erroneamente: ${second.output}`)
if (sent.length !== 2) fail(`attesi 2 invii, trovati ${sent.length}`)
console.log("OK: sessione sbloccata per i successivi invii")

console.log("SMOKE OK")