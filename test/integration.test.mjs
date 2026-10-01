import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

// Processo dedicato con limite 2: qui verifichiamo che il limite sia
// EFFETTIVAMENTE collegato al percorso di invio del tool, non solo alla
// funzione contatore isolato.
// Il test deve essere ERMETICO: senza questo, le credenziali Gmail presenti
// nell'ambiente della macchina farebbero vincere il provider gmail e il test
// passerebbe/fallirebbe in base alla macchina, non al codice.
process.env.MAIL_MAX_PER_HOUR = "2"
process.env.AGENT_MAIL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-int-"))
delete process.env.GMAIL_USER
delete process.env.GMAIL_APP_PASSWORD
delete process.env.RESEND_SMTP_PASS
process.env.MAIL_PROVIDER = "generic"
process.env.SMTP_HOST = "smtp.invalid"
process.env.SMTP_USER = "int-user"
process.env.SMTP_PASS = "int-pass-very-secret"

const mod = await import("../dist/index.js")
const T = mod.__testing

async function makeHooks() {
  const plugin = mod.AgentMailPlugin || mod.default
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

const SENT = []
let failMode = null

T.setTransportFactory(() => ({
  async sendMail(msg) {
    if (failMode) throw new Error(failMode)
    SENT.push(msg)
    return { messageId: "int-id", accepted: [msg.to], rejected: [] }
  },
  async verify() {
    return true
  },
}))

function ctx(session) {
  return { sessionID: session, agent: "build", directory: process.cwd(), worktree: process.cwd() }
}

test("default: senza MAIL_MAX_PER_HOUR il limite è 0 e non blocca mai (verificato in un processo figlio)", () => {
  const script = `
    import fs from "node:fs"; import os from "node:os"; import path from "node:path";
    delete process.env.MAIL_MAX_PER_HOUR;
    process.env.AGENT_MAIL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rl-off-"));
    const m = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    for (let i = 0; i < 50; i++) m.__testing.bumpRateLimit("agente");
    const r = m.__testing.checkRateLimit("agente");
    console.log(JSON.stringify(r));
  `
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
  assert.equal(out.status, 0, out.stderr)
  const r = JSON.parse(out.stdout.trim().split("\n").pop())
  assert.equal(r.limit, 0, "senza variabile il limite deve essere 0")
  assert.equal(r.allowed, true, "con limite 0 nessun invio deve essere bloccato, nemmeno dopo 50 bump")
})

test("il rate limit blocca davvero l'invio oltre la soglia, non solo il contatore", async () => {
  const hooks = await makeHooks()
  T.resetRateLimit()
  SENT.length = 0
  const s = `rate-${Date.now()}`

  const args = { to: "x@example.invalid", subject: "s", html: "<p>x</p>", reason: "integration", confirm: true }

  const r1 = await hooks.tool.mail_send.execute(args, ctx(s))
  const r2 = await hooks.tool.mail_send.execute(args, ctx(s + "b"))
  const r3 = await hooks.tool.mail_send.execute(args, ctx(s + "c"))

  assert.match(r1.output, /Email inviata/, "primo invio consentito")
  assert.match(r2.output, /Email inviata/, "secondo invio consentito")
  assert.match(r3.output, /Limite orario raggiunto/, "terzo invio deve essere bloccato dal rate limit")
  assert.equal(SENT.length, 2, "solo 2 email devono aver raggiunto il transport")
  console.log("  (rate limit verificato sul percorso reale del tool)")
})

test("sessioni diverse non condividono il budget orario dell'identità", async () => {
  const hooks = await makeHooks()
  T.resetRateLimit()
  SENT.length = 0
  const args = { to: "y@example.invalid", subject: "s", html: "<p>x</p>", reason: "integration", confirm: true }
  await hooks.tool.mail_send.execute(args, ctx(`iso-${Date.now()}`))
  await hooks.tool.mail_send.execute(args, ctx(`iso-${Date.now()}-2`))
  assert.equal(SENT.length, 2)
})

test("un invio fallito NON consuma il budget (bump solo dopo successo)", async () => {
  const hooks = await makeHooks()
  T.resetRateLimit()
  SENT.length = 0
  failMode = "535 authentication failed for int-pass-very-secret"
  const args = { to: "z@example.invalid", subject: "s", html: "<p>x</p>", reason: "integration", confirm: true }
  const s = `fail-${Date.now()}`

  const r = await hooks.tool.mail_send.execute(args, ctx(s))
  assert.match(r.output, /Errore invio/, "l'errore deve essere riportato")
  failMode = null

  // dopo il fallimento restano ancora 2 tentativi disponibili
  const a = await hooks.tool.mail_send.execute(args, ctx(s + "x"))
  const b = await hooks.tool.mail_send.execute(args, ctx(s + "y"))
  const c = await hooks.tool.mail_send.execute(args, ctx(s + "z"))
  assert.match(a.output, /Email inviata/)
  assert.match(b.output, /Email inviata/)
  assert.match(c.output, /Limite orario raggiunto/, "budget non consumato dal fallimento")
})

test("il contatore sopravvive a un nuovo processo (persistenza su disco)", () => {
  // È il motivo per cui il limite è passato da in-memory a su file:
  // un reload del plugin non deve azzerare il budget orario.
  T.resetRateLimit()
  T.bumpRateLimit("agente-persistente")
  const before = T.checkRateLimit("agente-persistente")
  assert.equal(before.count, 1, "dopo un bump il contatore deve essere 1")

  const script = `
    import fs from "node:fs"; import os from "node:os"; import path from "node:path";
    process.env.MAIL_MAX_PER_HOUR = "2";
    process.env.AGENT_MAIL_STATE_DIR = ${JSON.stringify(process.env.AGENT_MAIL_STATE_DIR)};
    delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
    delete process.env.RESEND_SMTP_PASS; delete process.env.SMTP_HOST;
    const m = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    console.log(JSON.stringify(m.__testing.checkRateLimit("agente-persistente")));
  `
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
  assert.equal(out.status, 0, out.stderr)
  const r = JSON.parse(out.stdout.trim().split("\n").pop())
  assert.equal(r.count, 1, "il nuovo processo deve leggere il conteggio da disco")
  assert.equal(r.allowed, true, "con 1/2 usati deve ancora consentire l'invio")
  T.resetRateLimit()
})

test("INTEGRATION: la password SMTP non compare nell'errore restituito all'agente", async () => {
  const hooks = await makeHooks()
  T.resetRateLimit()
  failMode = "535 auth failed: password int-pass-very-secret rejected"
  const r = await hooks.tool.mail_send.execute(
    { to: "w@example.invalid", subject: "s", html: "<p>x</p>", reason: "integration", confirm: true },
    ctx(`redact-${Date.now()}`)
  )
  failMode = null
  console.log("  errore restituito:", r.output)
  assert.ok(!r.output.includes("int-pass-very-secret"), "la password SMTP deve essere redatta")
  assert.ok(r.output.includes("***"), "la redazione deve essere visibile")
})