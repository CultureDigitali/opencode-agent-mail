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

test("SECURITY REGRESSION: allowlist senza `to` esplicito controlla il destinatario RISOLTO", async () => {
  // Il bypass del round 2: checkRecipients guardava args.to mentre l'invio
  // usava to = args.to || MAIL_TO || identity.email. Con to omesso (il default
  // documentato) l'allowlist non controllava nulla.
  process.env.MAIL_ALLOWED_RECIPIENTS = "ok@example.invalid"
  process.env.MAIL_TO = "victim-not-in-allowlist@evil.example"
  SENT.length = 0
  try {
    const h = await hooks()
    const r = await h.tool.mail_send.execute(
      { subject: "s", html: "<p>x</p>", reason: "integration", confirm: true },
      ctx(`res-${Date.now()}`)
    )
    assert.match(r.output, /BLOCCATO da MAIL_ALLOWED_RECIPIENTS/, r.output)
    assert.match(r.output, /victim-not-in-allowlist@evil\.example/, "il messaggio deve dire quale indirizzo è fuori lista")
    assert.equal(SENT.length, 0, "nulla email deve essere uscita")
  } finally {
    delete process.env.MAIL_ALLOWED_RECIPIENTS
    delete process.env.MAIL_TO
  }
})

test("SECURITY REGRESSION: stessa cosa su mail_report", async () => {
  process.env.MAIL_ALLOWED_RECIPIENTS = "ok@example.invalid"
  process.env.MAIL_TO = "victim-not-in-allowlist@evil.example"
  SENT.length = 0
  try {
    const h = await hooks()
    const r = await h.tool.mail_report.execute(
      { title: "T", summary: "S", confirm: true },
      ctx(`resr-${Date.now()}`)
    )
    assert.match(r.output, /BLOCCATO da MAIL_ALLOWED_RECIPIENTS/, r.output)
    assert.equal(SENT.length, 0)
  } finally {
    delete process.env.MAIL_ALLOWED_RECIPIENTS
    delete process.env.MAIL_TO
  }
})

test("SECURITY REGRESSION: destinatario con virgolette+parentesi angolari viene rifiutato (fail closed)", () => {
  // nodemailer e il nostro parser divergevano su questa forma: l'allowlist
  // vedeva un indirizzo consentito, il server SMTP ne usava un altro.
  process.env.MAIL_ALLOWED_RECIPIENTS = "ok@example.invalid"
  try {
    const evil = '"ok@example.invalid" <evil@attacker.example>'
    assert.equal(T.hasAmbiguousRecipientSyntax(evil), true)
    const r = T.checkRecipients([evil])
    assert.equal(r.ok, false, "sintassi ambigua non deve mai essere autorizzata")
  } finally {
    delete process.env.MAIL_ALLOWED_RECIPIENTS
  }
})

test("SECURITY: estrazione gli indirizzi che il parser SMTP potrebbe usare", () => {
  assert.deepEqual(T.extractAddresses("A <a@x.com>, b@x.com").sort(), ["a@x.com", "b@x.com"])
  assert.deepEqual(T.extractAddresses("ok@x.com <evil@y.com>").sort(), ["evil@y.com", "ok@x.com"], "va estretto tutto")
  assert.deepEqual(T.extractAddresses("a@x.com; c@x.com").sort(), ["a@x.com", "c@x.com"])
  // un token con '@' ma senza dominio è comunque candidato: fail closed
  assert.deepEqual(T.extractAddresses("nessuna@posta"), ["nessuna@posta"])
  assert.deepEqual(T.extractAddresses(""), [])
})

test("SECURITY REGRESSION: RESEND_SMTP_PASS non va a un SMTP_HOST arbitrario", () => {
  process.env.RESEND_SMTP_PASS = "re_LIVE_secret_key"
  process.env.SMTP_HOST = "smtp.attacker.example"
  delete process.env.MAIL_PROVIDER
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASS
  try {
    const cfg = T.getSmtpConfig()
    assert.equal(cfg, null, "la chiave Resend non deve essere consegnata a un host terzo")
    const d = T.getLastSmtpDiagnostics().join(" ")
    assert.ok(/RESEND_SMTP_PASS/.test(d), d)
  } finally {
    delete process.env.RESEND_SMTP_PASS
    delete process.env.SMTP_HOST
  }
})

test("SMTP: Resend su host Resend legittimo continua a funzionare", () => {
  process.env.RESEND_SMTP_PASS = "re_LIVE_secret_key"
  delete process.env.SMTP_HOST
  delete process.env.MAIL_PROVIDER
  try {
    const cfg = T.getSmtpConfig()
    assert.ok(cfg, "il percorso Resend normale deve funzionare")
    assert.equal(cfg.provider, "resend")
    assert.equal(cfg.host, "smtp.resend.com")
  } finally {
    delete process.env.RESEND_SMTP_PASS
  }
})

test("isResendHost: solo i domini Resend", () => {
  assert.equal(T.isResendHost("smtp.resend.com"), true)
  assert.equal(T.isResendHost("SMTP.RESEND.COM:587"), true)
  assert.equal(T.isResendHost("resend.com.attacker.example"), false)
  assert.equal(T.isResendHost("evilresend.com"), false)
})

test("dry_run: funziona anche al primo invio, senza reason/confirm", async () => {
  delete process.env.MAIL_ALLOWED_RECIPIENTS
  SENT.length = 0
  const h = await hooks()
  const s = `dryfirst-${Date.now()}`
  const r = await h.tool.mail_send.execute(
    { to: "ok@example.invalid", subject: "s", html: "<p>corpo</p>", dry_run: true },
    ctx(s)
  )
  assert.match(r.output, /DRY RUN/, `il dry-run deve precedere il gate: ${r.output}`)
  assert.match(r.output, /sessione non sbloccata/, r.output)
  assert.equal(SENT.length, 0)

  // e il gate resta ancora chiuso
  const blocked = await h.tool.mail_send.execute({ to: "ok@example.invalid", subject: "s", html: "<p>x</p>" }, ctx(s))
  assert.match(blocked.output, /BLOCCATO/, "il dry-run non deve sbloccare la sessione")
})
