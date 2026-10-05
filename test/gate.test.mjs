import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Ermetico: nessuna credenziale dell'ambiente può influenzare il risultato.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-gate-"))
process.env.AGENT_MAIL_STATE_DIR = STATE_DIR
delete process.env.GMAIL_USER
delete process.env.GMAIL_APP_PASSWORD
delete process.env.RESEND_SMTP_PASS
delete process.env.SMTP_HOST
delete process.env.MAIL_TO
delete process.env.AGENT_ID

process.env.SMTP_HOST = "smtp.invalid"
process.env.SMTP_USER = "gate-user"
process.env.SMTP_PASS = "gate-pass"

const mod = await import("../dist/index.js")
const T = mod.AgentMailPlugin.__testing

const SENT = []
T.setTransportFactory(() => ({
  async sendMail(msg) {
    SENT.push(msg)
    return { messageId: `id-${SENT.length}`, accepted: [msg.to], rejected: [] }
  },
  async verify() {
    return true
  },
}))

async function hooks() {
  const plugin = mod.AgentMailPlugin
  return plugin({
    directory: process.cwd(),
    worktree: process.cwd(),
    client: {},
    project: {},
    serverUrl: new URL("http://localhost:4096"),
    $: () => {},
    experimental_workspace: { register() {} },
  })
}

const session = () => `gate-${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}`
const ctx = (s) => ({ sessionID: s, agent: "build", directory: process.cwd(), worktree: process.cwd() })
const args = (over = {}) => ({ to: "dest@example.invalid", subject: "s", html: "<p>x</p>", reason: "integration", confirm: true, ...over })

// ── Stato del gate: markSent DEVE essere collegato a mail_send ──
// Prima questi non erano testati: eliminando markSent la suite restava verde.

test("il primo invio è bloccato senza reason/confirm e non invia", async () => {
  const h = await hooks()
  const s = session()
  SENT.length = 0
  const r = await h.tool.mail_send.execute(args({ reason: undefined, confirm: undefined }), ctx(s))
  assert.match(r.output, /BLOCCATO/)
  assert.equal(SENT.length, 0)
})

test("dopo il primo invio autorizzato la sessione resta sbloccata (markSent persistito)", async () => {
  const h = await hooks()
  const s = session()
  SENT.length = 0

  const first = await h.tool.mail_send.execute(args(), ctx(s))
  assert.match(first.output, /Email inviata/, first.output)
  assert.equal(SENT.length, 1)

  // secondo invio SENZA reason/confirm: deve passare perché la sessione è sbloccata
  const second = await h.tool.mail_send.execute(args({ reason: undefined, confirm: undefined }), ctx(s))
  assert.match(second.output, /Email inviata/, `la sessione doveva essere sbloccata: ${second.output}`)
  assert.equal(SENT.length, 2)
})

test("una sessione NUOVA resta bloccata anche dopo un invio riuscito in un'altra", async () => {
  const h = await hooks()
  SENT.length = 0
  await h.tool.mail_send.execute(args(), ctx(session()))
  const fresh = session()
  const r = await h.tool.mail_send.execute(args({ reason: undefined, confirm: undefined }), ctx(fresh))
  assert.match(r.output, /BLOCCATO/, "una sessione nuova non eredita lo sblocco")
})

test("mail_report: il gate usa summary come reason e poi sblocca la sessione", async () => {
  const h = await hooks()
  const s = session()
  SENT.length = 0

  const blocked = await h.tool.mail_report.execute({ title: "T", summary: "S", to: "d@example.invalid" }, ctx(s))
  assert.match(blocked.output, /BLOCCATO/, "primo report senza confirm deve essere bloccato")
  assert.equal(SENT.length, 0)

  const ok = await h.tool.mail_report.execute(
    { title: "T", summary: "S", to: "d@example.invalid", confirm: true },
    ctx(s)
  )
  assert.match(ok.output, /Report inviato/, ok.output)
  assert.equal(SENT.length, 1)

  const second = await h.tool.mail_report.execute({ title: "T2", summary: "S2", to: "d@example.invalid" }, ctx(s))
  assert.match(second.output, /Report inviato/, "la sessione deve restare sbloccata")
})

test("mail_report: summary vuoto o solo spazi viene rifiutato", async () => {
  const h = await hooks()
  SENT.length = 0
  for (const summary of ["", "   \n\t "]) {
    const r = await h.tool.mail_report.execute({ title: "T", summary, to: "d@example.invalid", confirm: true }, ctx(session()))
    assert.ok(/Summary mancante|vuoto/.test(r.output), `summary "${summary}" doveva essere rifiutato: ${r.output}`)
  }
  assert.equal(SENT.length, 0)
})

test("REGRESSION: il lock cross-processo protegge davvero il conteggio", async () => {
  // I processi devono partire CONCORRENTI: con spawnSync non ci sarebbe
  // contesa e il test passerebbe anche senza lock (verificato).
  const CONC = 12
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    process.env.MAIL_MAX_PER_HOUR = "1000";
    process.env.AGENT_MAIL_STATE_DIR = ${JSON.stringify(STATE_DIR)};
    delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
    delete process.env.RESEND_SMTP_PASS; delete process.env.SMTP_HOST;
    const m = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    // piccolo ritardo random per massimizzare la sovrapposizione delle sezioni critiche
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 25)));
    m.AgentMailPlugin.__testing.bumpRateLimit("race-agent");
  `
  const { spawn } = await import("node:child_process")
  const run = () =>
    new Promise((resolve) => {
      const cp = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" })
      cp.on("exit", (code) => resolve(code))
    })
  const codes = await Promise.all(Array.from({ length: CONC }, run))
  assert.deepEqual(
    codes.filter((c) => c !== 0),
    [],
    "tutti i processi devono terminare senza errore"
  )

  // Il padre ha MAIL_MAX_PER_HOUR=0 (impostato altrove in questo file), quindi
  // checkRateLimit nel padre restituirebbe sempre count 0: il conteggio va letto
  // dal file, che è la prova reale della persistenza.
  const store = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "agent-mail-ratelimit.json"), "utf8"))
  const rec = store["race-agent"]
  assert.ok(rec, "il rate store deve contenere un record per race-agent")
  assert.equal(rec.count, CONC, `attesi ${CONC} incrementi, trovati ${rec.count}: il lock perde scritture`)
})

test("REGRESSION: il file .lock non resta orfano dopo le operazioni", () => {
  const leftovers = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".lock"))
  assert.deepEqual(leftovers, [], `file di lock rimasti: ${leftovers.join(", ")}`)
})
