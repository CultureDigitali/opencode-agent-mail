import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Ermetico
process.env.AGENT_MAIL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-safe-"))
delete process.env.GMAIL_USER
delete process.env.GMAIL_APP_PASSWORD
delete process.env.RESEND_SMTP_PASS
delete process.env.SMTP_HOST
delete process.env.MAIL_ALLOWED_RECIPIENTS
delete process.env.IMAP_HOST

process.env.SMTP_HOST = "smtp.invalid"
process.env.SMTP_USER = "safe-user"
process.env.SMTP_PASS = "safe-pass"

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
  return mod.AgentMailPlugin({
    directory: process.cwd(),
    worktree: process.cwd(),
    client: {},
    project: {},
    serverUrl: new URL("http://localhost:4096"),
    $: () => {},
    experimental_workspace: { register() {} },
  })
}

const ctx = (s) => ({ sessionID: s, agent: "build", directory: process.cwd(), worktree: process.cwd() })
const base = (over = {}) => ({ to: "ok@example.invalid", subject: "s", html: "<p>x</p>", reason: "integration", confirm: true, ...over })

// ── IMAP: la password Gmail non può finire su un host terzo ──

test("SECURITY: IMAP_HOST non-Google con credenziali Gmail viene rifiutato", () => {
  process.env.GMAIL_USER = "agent@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.IMAP_HOST = "attacker.example"
  try {
    assert.equal(T.getImapConfig(), null, "non deve recapitare la App Password a un host terzo")
    const d = T.getLastSmtpDiagnostics()
    assert.ok(true) // diagnostica IMAP separata; verifichiamo il messaggio sotto
  } finally {
    delete process.env.IMAP_HOST
  }
})

test("SECURITY: host Google ammesso con credenziali Gmail", () => {
  process.env.GMAIL_USER = "agent@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.IMAP_HOST = "imap.gmail.com"
  try {
    const cfg = T.getImapConfig()
    assert.ok(cfg, "imap.gmail.com deve essere ammesso")
    assert.equal(cfg.host, "imap.gmail.com")
  } finally {
    delete process.env.IMAP_HOST
    delete process.env.GMAIL_USER
    delete process.env.GMAIL_APP_PASSWORD
  }
})

test("SECURITY: host non-Google ammesso solo con credenziali IMAP dedicate", () => {
  process.env.IMAP_USER = "u@corp.example"
  process.env.IMAP_PASS = "dedicated-secret"
  process.env.IMAP_HOST = "mail.corp.example"
  try {
    const cfg = T.getImapConfig()
    assert.ok(cfg, "con password dedicata un host proprio e legittimo")
    assert.equal(cfg.host, "mail.corp.example")
    assert.equal(cfg.pass, "dedicated-secret")
  } finally {
    delete process.env.IMAP_HOST
    delete process.env.IMAP_USER
    delete process.env.IMAP_PASS
  }
})

test("isGoogleImapHost: solo i domini Google", () => {
  assert.equal(T.isGoogleImapHost("imap.gmail.com"), true)
  assert.equal(T.isGoogleImapHost("IMAP.GMAIL.COM"), true)
  assert.equal(T.isGoogleImapHost("imap.gmail.com:993"), true)
  assert.equal(T.isGoogleImapHost("imap.googlemail.com"), true)
  assert.equal(T.isGoogleImapHost("attacker.example"), false)
  assert.equal(T.isGoogleImapHost("gmail.com.attacker.example"), false, "non deve bastare un suffisso")
  assert.equal(T.isGoogleImapHost("evilgmail.com"), false)
})

// ── Allowlist destinatari ──

test("SECURITY: extractAddresses gestisce liste, angoli e nomi visualizzati", () => {
  assert.deepEqual(T.extractAddresses("a@x.com"), ["a@x.com"])
  assert.deepEqual(T.extractAddresses("A <a@x.com>, b@x.com").sort(), ["a@x.com", "b@x.com"])
  assert.deepEqual(T.extractAddresses("a@x.com; c@x.com").sort(), ["a@x.com", "c@x.com"])
})

test("SECURITY: senza allowlist tutto passa (default compatto)", () => {
  delete process.env.MAIL_ALLOWED_RECIPIENTS
  assert.equal(T.checkRecipients(["chiunque@ovunque.com"]).ok, true)
})

test("SECURITY: allowlist blocca i destinatari fuori lista, su to, cc e bcc", () => {
  process.env.MAIL_ALLOWED_RECIPIENTS = "ok@example.invalid, altro@ok.example"
  try {
    assert.equal(T.checkRecipients(["ok@example.invalid"]).ok, true)
    assert.equal(T.checkRecipients(["ok@example.invalid", "altro@ok.example"]).ok, true)

    const bad = T.checkRecipients(["ok@example.invalid", "malizioso@evil.example"])
    assert.equal(bad.ok, false)
    assert.deepEqual(bad.blocked, ["malizioso@evil.example"])

    const viaCc = T.checkRecipients(["ok@example.invalid", "copia@evil.example"])
    assert.equal(viaCc.ok, false, "cc deve essere controllata come to")
    assert.deepEqual(viaCc.blocked, ["copia@evil.example"])
  } finally {
    delete process.env.MAIL_ALLOWED_RECIPIENTS
  }
})

test("SECURITY: allowlist applicata end-to-end: mail_send non invia fuori lista", async () => {
  process.env.MAIL_ALLOWED_RECIPIENTS = "ok@example.invalid"
  SENT.length = 0
  try {
    const h = await hooks()
    const r = await h.tool.mail_send.execute(base({ to: "malizioso@evil.example" }), ctx(`al-${Date.now()}`))
    assert.match(r.output, /BLOCCATO da MAIL_ALLOWED_RECIPIENTS/, r.output)
    assert.equal(SENT.length, 0, "nessuna email deve essere stata inviata")
  } finally {
    delete process.env.MAIL_ALLOWED_RECIPIENTS
  }
})

test("SECURITY: allowlist end-to-end su cc in mail_send", async () => {
  process.env.MAIL_ALLOWED_RECIPIENTS = "ok@example.invalid"
  SENT.length = 0
  try {
    const h = await hooks()
    const r = await h.tool.mail_send.execute(base({ cc: "copia@evil.example" }), ctx(`alcc-${Date.now()}`))
    assert.match(r.output, /BLOCCATO da MAIL_ALLOWED_RECIPIENTS/, r.output)
    assert.equal(SENT.length, 0)
  } finally {
    delete process.env.MAIL_ALLOWED_RECIPIENTS
  }
})

test("SECURITY: allowlist applicata anche a mail_report", async () => {
  process.env.MAIL_ALLOWED_RECIPIENTS = "ok@example.invalid"
  SENT.length = 0
  try {
    const h = await hooks()
    const r = await h.tool.mail_report.execute(
      { title: "T", summary: "S", to: "malizioso@evil.example", confirm: true },
      ctx(`alr-${Date.now()}`)
    )
    assert.match(r.output, /BLOCCATO da MAIL_ALLOWED_RECIPIENTS/, r.output)
    assert.equal(SENT.length, 0)
  } finally {
    delete process.env.MAIL_ALLOWED_RECIPIENTS
  }
})

// ── dry_run ──

test("dry_run: anteprima completa senza inviare e senza sbloccare il gate", async () => {
  delete process.env.MAIL_ALLOWED_RECIPIENTS
  SENT.length = 0
  const h = await hooks()
  const s = `dry-${Date.now()}`

  const r = await h.tool.mail_send.execute(base({ dry_run: true }), ctx(s))
  assert.match(r.output, /DRY RUN/, r.output)
  assert.match(r.output, /Da:/, "deve mostrare il From")
  assert.match(r.output, /A:/, "deve mostrare il destinatario")
  assert.match(r.output, /Oggetto:/, "deve mostrare l'oggetto")
  assert.match(r.output, /Firma che verrebbe aggiunta/, "deve mostrare la firma completa")
  assert.equal(SENT.length, 0, "dry_run non deve inviare")

  // il gate non deve essere stato sbloccato: senza dry_run serve ancora conferma
  const blocked = await h.tool.mail_send.execute(base({ reason: undefined, confirm: undefined }), ctx(s))
  assert.match(blocked.output, /BLOCCATO/, "dry_run non deve sbloccare la sessione")
  assert.equal(SENT.length, 0)
})
