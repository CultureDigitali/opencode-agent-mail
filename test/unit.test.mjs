import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Nessuna rete, nessun invio: solo funzioni pure e file in una dir temporanea.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-test-"))
process.env.AGENT_MAIL_STATE_DIR = STATE_DIR

const mod = await import("../dist/index.js")
const T = mod.AgentMailPlugin.__testing

const MAIL_ENV = [
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "MAIL_TO",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
  "RESEND_SMTP_PASS",
  "MAIL_PROVIDER",
  "SMTP_ALLOW_ANONYMOUS",
  "AGENT_ID",
  "AGENT_DISPLAY_NAME",
  "AGENT_SIGNATURE",
  "AGENT_INSTANCE_HOST",
]

function withEnv(vars, fn) {
  const saved = {}
  for (const k of MAIL_ENV) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return fn()
  } finally {
    for (const k of MAIL_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// ── SMTP selection (P1: SMTP_SECURE ignorato; P1: migrazione Resend) ──
test("gmail: selezionato quando solo Gmail è configurato", () => {
  withEnv({ GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "x".repeat(16) }, () => {
    const cfg = T.getSmtpConfig()
    assert.equal(cfg.provider, "gmail")
    assert.equal(cfg.host, "smtp.gmail.com")
    assert.equal(cfg.port, 587)
    assert.equal(cfg.secure, false)
    assert.equal(cfg.requireTLS, true)
  })
})

test("P1: SMTP generico con password rispetta SMTP_SECURE (prima andava nel ramo resend)", () => {
  withEnv({ SMTP_HOST: "mail.example.com", SMTP_USER: "u", SMTP_PASS: "p", SMTP_SECURE: "true" }, () => {
    const cfg = T.getSmtpConfig()
    assert.equal(cfg.provider, "generic", "una SMTP_PASS generica non deve essere trattata come chiave Resend")
    assert.equal(cfg.host, "mail.example.com")
    assert.equal(cfg.secure, true)
    assert.equal(cfg.requireTLS, false)
  })
})

test("SMTP_PORT 465 attiva implicit TLS anche senza SMTP_SECURE", () => {
  withEnv({ SMTP_HOST: "mail.example.com", SMTP_USER: "u", SMTP_PASS: "p", SMTP_PORT: "465" }, () => {
    const cfg = T.getSmtpConfig()
    assert.equal(cfg.secure, true)
  })
})

test("SMTP_PORT non numerico: diagnostica e fallback a 587", () => {
  withEnv({ SMTP_HOST: "mail.example.com", SMTP_USER: "u", SMTP_PASS: "p", SMTP_PORT: "not-a-port" }, () => {
    const cfg = T.getSmtpConfig()
    assert.equal(cfg.port, 587)
    assert.ok(cfg.diagnostics.join(" ").includes("SMTP_PORT"))
  })
})

test("F4: SMTP_PASS senza SMTP_USER non viene scartata in silenzio", () => {
  withEnv({ SMTP_HOST: "mail.example.com", SMTP_PASS: "sekrit123" }, () => {
    assert.equal(T.getSmtpConfig(), null, "config incompleta invece di relay anonimo che ignora la password")
    assert.ok(T.getLastSmtpDiagnostics().join(" ").includes("SMTP_PASS"))
  })
})

test("SMTP anonimo richiede opt-in esplicito", () => {
  withEnv({ SMTP_HOST: "localhost" }, () => {
    assert.equal(T.getSmtpConfig(), null)
    assert.ok(T.getLastSmtpDiagnostics().join(" ").includes("SMTP_ALLOW_ANONYMOUS"))
  })
  withEnv({ SMTP_HOST: "localhost", SMTP_ALLOW_ANONYMOUS: "true" }, () => {
    const cfg = T.getSmtpConfig()
    assert.equal(cfg.provider, "generic")
    assert.equal(cfg.auth, undefined)
  })
})

test("F4: gmail resta il default anche con SMTP_HOST leftovers (migrazione Resend)", () => {
  withEnv(
    {
      GMAIL_USER: "a@gmail.com",
      GMAIL_APP_PASSWORD: "y".repeat(16),
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "u",
      SMTP_PASS: "p",
    },
    () => {
      const cfg = T.getSmtpConfig()
      assert.equal(cfg.provider, "gmail", "non deve scivolare su generic e abbandonare Gmail")
      assert.ok(cfg.diagnostics.join(" ").includes("MAIL_PROVIDER"))
    }
  )
})

test("P1: MAIL_PROVIDER=resend vince anche con credenziali Gmail presenti", () => {
  withEnv(
    { GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "y".repeat(16), RESEND_SMTP_PASS: "re_abc", MAIL_PROVIDER: "resend", SMTP_HOST: "smtp.resend.com" },
    () => {
      const cfg = T.getSmtpConfig()
      assert.equal(cfg.provider, "resend")
      assert.equal(cfg.host, "smtp.resend.com")
      assert.equal(cfg.auth.pass, "re_abc")
    }
  )
})

test("MAIL_PROVIDER esplicito senza credenziali: configurazione incompleta, non fallback silenzioso", () => {
  withEnv({ GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "y".repeat(16), MAIL_PROVIDER: "resend" }, () => {
    assert.equal(T.getSmtpConfig(), null)
  })
})

test("MAIL_PROVIDER non valido: diagnosticato e ignorato", () => {
  withEnv({ GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "y".repeat(16), MAIL_PROVIDER: "sendgrid" }, () => {
    const cfg = T.getSmtpConfig()
    assert.equal(cfg.provider, "gmail")
    assert.ok(cfg.diagnostics.join(" ").includes("sendgrid"))
  })
})

test("nessuna configurazione SMTP: null senza eccezioni", () => {
  withEnv({}, () => {
    assert.equal(T.getSmtpConfig(), null)
  })
})

// ── Identity precedence + validation (P1) ──
test("P1: env ha precedenza sul file, campo per campo", () => {
  const idPath = path.join(STATE_DIR, "agent-identity.json")
  fs.writeFileSync(idPath, JSON.stringify({ agent_id: "from-file", display_name: "File Name", email: "file@x.com" }))
  withEnv({ AGENT_DISPLAY_NAME: "Env Name" }, () => {
    const { identity } = T.loadIdentity()
    assert.equal(identity.agent_id, "from-file")
    assert.equal(identity.display_name, "Env Name")
    assert.equal(identity.email, "file@x.com")
  })
})

test("P1: file senza display_name non produce identità rotta (prima crashava in buildFrom)", () => {
  const idPath = path.join(STATE_DIR, "agent-identity.json")
  fs.writeFileSync(idPath, JSON.stringify({ agent_id: "solo-id", email: "solo@x.com" }))
  withEnv({}, () => {
    const { identity } = T.loadIdentity()
    assert.equal(identity.display_name, "OpenCode Agent")
    const from = T.buildFrom(identity)
    assert.ok(from.includes("OpenCode Agent"))
    assert.ok(from.includes("<solo@x.com>"))
  })
})

test("JSON malformato: diagnostica esplicita e fallback, nessun crash", () => {
  const idPath = path.join(STATE_DIR, "agent-identity.json")
  fs.writeFileSync(idPath, "{ this is not json ")
  withEnv({}, () => {
    const { identity, meta } = T.loadIdentity()
    assert.equal(meta.fileValid, false)
    assert.ok(meta.diagnostics.length > 0)
    assert.ok(identity.agent_id.length > 0)
  })
})

test("email senza @ nel file: fallback placeholder, mai header rotto", () => {
  const idPath = path.join(STATE_DIR, "agent-identity.json")
  fs.writeFileSync(idPath, JSON.stringify({ agent_id: "a", display_name: "N", email: "non-una-email" }))
  withEnv({}, () => {
    const { identity } = T.loadIdentity()
    assert.ok(identity.email.includes("@"))
  })
})

test("campo file di tipo sbagliato: diagnostica + fallback", () => {
  const idPath = path.join(STATE_DIR, "agent-identity.json")
  fs.writeFileSync(idPath, JSON.stringify({ agent_id: 42, display_name: "N", email: "a@x.com" }))
  withEnv({}, () => {
    const { identity, meta } = T.loadIdentity()
    assert.equal(identity.agent_id, "opencode-main")
    assert.ok(meta.diagnostics.join(" ").includes("agent_id"))
  })
})

// ── Gate (P1: whitespace-only reason; mail_report senza reason) ──
test("gate: primo invio senza reason e senza confirm → bloccato", () => {
  const r = T.evaluateGate({ isFirst: true, reason: undefined, confirm: undefined })
  assert.equal(r.allowed, false)
  assert.deepEqual(r.missing, ["reason non vuoto", "confirm=true"])
})

test("P1: reason composto solo da spazi viene trattato come assente", () => {
  const r = T.evaluateGate({ isFirst: true, reason: "   \n\t ", confirm: true })
  assert.equal(r.allowed, false)
  assert.deepEqual(r.missing, ["reason non vuoto"])
})

test("gate: reason valido + confirm=true → ammesso", () => {
  assert.equal(T.evaluateGate({ isFirst: true, reason: "report richiesto", confirm: true }).allowed, true)
})

test("gate: invii successivi ammessi senza reason (sessione già sbloccata)", () => {
  assert.equal(T.evaluateGate({ isFirst: false, reason: undefined, confirm: undefined }).allowed, true)
})

test("gate: confirm truthy non-booleano non sblocca", () => {
  const r = T.evaluateGate({ isFirst: true, reason: "ok", confirm: "true" })
  assert.equal(r.allowed, false)
})

// ── Header injection & escaping (P2) ──
test("P2: CRLF nel subject/header viene sanitizzato", () => {
  const headers = T.buildHeaders(
    { agent_id: "evil\r\nBcc: attacker@x.com", display_name: "N", email: "a@x.com" },
    "sess\r\nX-Injected: 1",
    { providerID: "p", modelID: "m" }
  )
  for (const v of Object.values(headers)) {
    assert.ok(!/[\r\n]/.test(v), `header contiene CRLF: ${v}`)
  }
})

test("P2: nome branch con HTML non viene interpretato", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "xss-"))
  fs.mkdirSync(path.join(repo, ".git"))
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/<script>alert(1)</script>\n")
  const sig = T.buildSmartSignature({
    identity: { agent_id: "a", display_name: "N", email: "a@x.com" },
    sessionID: "s1",
    agentName: "main",
    directory: repo,
    worktree: repo,
  })
  // il branch deve comparire solo come testo escapato, mai come markup
  assert.ok(sig.html.includes("&lt;script&gt;"), "il branch deve essere HTML-escaped")
  assert.ok(!sig.html.includes("<script>alert"), "nessun markup eseguibile nel branch")
  // nel MIME text/plain il branch resta letterale: non si applica entity-encoding,
  // non essendoci un renderer HTML. (Bug segnalato da questo test iniziale: era
  // un'asserzione errata, non un difetto del plugin.)
  assert.ok(sig.text.includes("<script>alert"), "il text/plain deve riportare il branch letteralmente")
  assert.ok(!sig.text.includes("&lt;"), "nessuna entity HTML nel text/plain")
})

test("escapeHtml neutralizza i caratteri pericolosi", () => {
  assert.equal(T.escapeHtml(`<script>"x"&</script>`), "&lt;script&gt;&quot;x&quot;&amp;&lt;/script&gt;")
})

test("P2: errori SMTP non espongono la password", () => {
  const out = T.redactSecrets("535 auth failed for secretpass123", "secretpass123")
  assert.ok(!out.includes("secretpass123"))
  assert.ok(out.includes("***"))
})

test("maskEmail non rivela la parte locale completa", () => {
  const masked = T.maskEmail("pierluigi.strazzullo@gmail.com")
  assert.ok(!masked.includes("strazzullo"))
  assert.ok(masked.endsWith("@gmail.com"))
})

test("buildFrom quoting: nome con virgolette resta valido", () => {
  const from = T.buildFrom({ agent_id: "a", display_name: 'Ag "Core" Bot', email: "a@x.com" })
  assert.equal(from, `"Ag 'Core' Bot" <a@x.com>`)
})

// ── Store (P1/P2: atomico, validato, isolato per identità) ──
test("P2: sanitizeStore scarta JSON valido ma non-oggetto", () => {
  assert.deepEqual(T.sanitizeStore(null), {})
  assert.deepEqual(T.sanitizeStore([1, 2, 3]), {})
  assert.deepEqual(T.sanitizeStore("stringa"), {})
})

test("P2: sanitizeStore scarta record con sendCount non valido", () => {
  const out = T.sanitizeStore({ a: { sendCount: "tre" }, b: { sendCount: -1 }, c: { sendCount: 2 } })
  assert.deepEqual(Object.keys(out), ["c"])
  assert.equal(out.c.sendCount, 2)
})

test("P1: stato sessione isolato per identità", () => {
  const store = path.join(STATE_DIR, "agent-mail-sessions.json")
  fs.writeFileSync(store, JSON.stringify({}))
  assert.equal(T.hasSentBefore("sess-x", "agent-1"), false)
  assert.equal(T.markSent("sess-x", "to@x.com", "agent-1"), true)
  assert.equal(T.hasSentBefore("sess-x", "agent-1"), true)
  assert.equal(T.hasSentBefore("sess-x", "agent-2"), false, "identità diversa non eredita lo sblocco")
})

test("store: la chiave è composta da identità e sessione", () => {
  assert.equal(T.storeKey("s", "a"), "a::s")
})

test("store: file JSON corrotto non blocca il gate (treated as empty)", () => {
  const store = path.join(STATE_DIR, "agent-mail-sessions.json")
  fs.writeFileSync(store, "{{{ corrotto")
  assert.equal(T.hasSentBefore("sess-y", "agent-1"), false)
  assert.equal(T.markSent("sess-y", "to@x.com", "agent-1"), true)
})

test("store: il file scritto è JSON valido e non lascia file .tmp", () => {
  const store = path.join(STATE_DIR, "agent-mail-sessions.json")
  fs.writeFileSync(store, "{}")
  T.markSent("sess-z", "to@x.com", "agent-1")
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(store, "utf8")))
  const leftovers = fs.readdirSync(STATE_DIR).filter((f) => f.includes(".tmp"))
  assert.deepEqual(leftovers, [], `file temporanei rimasti: ${leftovers.join(", ")}`)
})

// ── Git / project ──
test("getGitInfo: branch letto da .git/HEAD", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"))
  fs.mkdirSync(path.join(repo, ".git"))
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
  const info = T.getGitInfo(repo, repo)
  assert.equal(info.branch, "main")
  assert.equal(info.repo, path.basename(repo))
})

test("getGitInfo: .git file (worktree collegato) gestito", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"))
  const realGitDir = path.join(root, "real-git")
  fs.mkdirSync(realGitDir)
  fs.writeFileSync(path.join(realGitDir, "HEAD"), "ref: refs/heads/feature/x\n")
  const work = path.join(root, "work")
  fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, ".git"), `gitdir: ${realGitDir}\n`)
  const info = T.getGitInfo(work, work)
  assert.equal(info.branch, "feature/x")
})

test("getGitInfo: directory non-git → branch null, nessun crash", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"))
  const info = T.getGitInfo(plain, plain)
  assert.equal(info.branch, null)
})

test("shortSessionID tronca e gestisce input vuoti", () => {
  assert.equal(T.shortSessionID("abcdefghijkl"), "abcdefgh")
  assert.equal(T.shortSessionID(""), "unknown")
})