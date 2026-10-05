import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

// Ermetico: nessuna credenziale reale, nessuna connessione.
process.env.AGENT_MAIL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-imap-"))
delete process.env.GMAIL_USER
delete process.env.GMAIL_APP_PASSWORD
delete process.env.RESEND_SMTP_PASS
delete process.env.SMTP_HOST

const mod = await import("../dist/index.js")
const T = mod.AgentMailPlugin.__testing

// La parola encoded-word è costruita a runtime: evita di scrivere a mano
// il base64 (errore facile, e un test con dati sbagliati non prova nulla).
const SUBJECT_TEXT = "Rispondo tutto lo"
const B64_SUBJECT = Buffer.from(SUBJECT_TEXT, "utf8").toString("base64")

const RAW_SELF_ECHO = [
  "From: Culture Agent PC <cultureagentpc@gmail.com>",
  "To: pierluigi@example.com",
  "Subject: Echo di me stesso",
  "Date: Mon, 16 Sep 2026 12:00:00 +0200",
  "Message-ID: <sent-1@example.com>",
  "X-Agent-ID: culture-agent-pc-01",
  "",
  "Report gia inviato.",
].join("\r\n")

const RAW_REPLY = [
  "From: Pierluigi <pierluigi@example.com>",
  "To: cultureagentpc@gmail.com",
  `Subject: =?UTF-8?B?${B64_SUBJECT}?=`,
  "Date: Mon, 16 Sep 2026 10:00:00 +0200",
  "Message-ID: <reply-1@example.com>",
  "In-Reply-To: <orig-1@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Ottimo, il report e arrivato.",
  "Seconda riga.",
].join("\r\n")

const RAW_OTHER_AGENT = [
  "From: altro@example.com",
  "To: cultureagentpc@gmail.com",
  "Subject: altro agente",
  "Date: Mon, 16 Sep 2026 11:00:00 +0200",
  "Message-ID: <other-1@example.com>",
  "X-Agent-ID: agent-server-02",
  "",
  "Messaggio di un'altra identita.",
].join("\r\n")

test("parseInboxMessage: intestazioni e corpo separati correttamente", () => {
  const m = T.parseInboxMessage(RAW_REPLY, 42)
  assert.equal(m.uid, 42)
  assert.ok(m.from.includes("Pierluigi"))
  assert.equal(m.to, "cultureagentpc@gmail.com")
  assert.equal(m.messageId, "<reply-1@example.com>")
  assert.equal(m.inReplyTo, "<orig-1@example.com>")
  assert.ok(m.date.includes("2026"))
  assert.equal(m.agentId, null)
})

test("parseInboxMessage: decodifica le parole MIME encoded-word", () => {
  const m = T.parseInboxMessage(RAW_REPLY, 1)
  assert.equal(m.subject, SUBJECT_TEXT, "=?UTF-8?B?...?= deve diventare testo leggibile")
  assert.ok(!m.subject.includes("=?"))
})

test("parseInboxMessage: X-Agent-ID estratto per il filtro multi-agente", () => {
  const m = T.parseInboxMessage(RAW_OTHER_AGENT, 7)
  assert.equal(m.agentId, "agent-server-02")
  assert.equal(T.belongsToAgent(m, "agent-server-02"), true)
  assert.equal(T.belongsToAgent(m, "culture-agent-pc-01"), false)
})

test("htmlToText: il corpo HTML diventa leggibile (niente tag)", () => {
  const t = T.htmlToText("<p>Ciao <b>mondo</b></p><p>Seconda riga</p>")
  assert.ok(!t.includes("<"))
  assert.ok(t.includes("Ciao mondo"))
  assert.ok(t.includes("Seconda riga"))
})

test("htmlToText: gestisce entità e script/style", () => {
  const t = T.htmlToText('<style>a{}</style><script>x()</script><p>A &amp; B &lt;tag&gt;</p>')
  assert.ok(!t.includes("x()"), "il contenuto degli script non deve finire nel testo")
  assert.ok(t.includes("A & B"))
})

test("isReplyToUs: riconosce le risposte ai nostri messaggi", () => {
  const m = T.parseInboxMessage(RAW_REPLY, 1)
  assert.equal(T.isReplyToUs(m, new Set(["<orig-1@example.com>"])), true)
  assert.equal(T.isReplyToUs(m, new Set(["<altro@example.com>"])), false)
})

test("getImapConfig: assente senza credenziali, con diagnostica", () => {
  assert.equal(T.getImapConfig(), null)
})

test("IMAP: riusa le credenziali Gmail senza configurazione separata", () => {
  const saved = { u: process.env.GMAIL_USER, p: process.env.GMAIL_APP_PASSWORD }
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  try {
    const cfg = T.getImapConfig()
    assert.equal(cfg.host, "imap.gmail.com")
    assert.equal(cfg.port, 993)
    assert.equal(cfg.secure, true)
    assert.equal(cfg.user, "cultureagentpc@gmail.com")
  } finally {
    if (saved.u === undefined) delete process.env.GMAIL_USER
    else process.env.GMAIL_USER = saved.u
    if (saved.p === undefined) delete process.env.GMAIL_APP_PASSWORD
    else process.env.GMAIL_APP_PASSWORD = saved.p
  }
})

// ── percorso completo del tool con client IMAP finto ──
// Il finto ONORA il ciclo di vita reale di imapflow: dopo logout() la
// connessione è distrutta e messageFlagsAdd deve fallire. Senza questo il
// test non potrebbe rilevare un STORE eseguito dopo il logout.
const FETCHED = []
let flagsAdded = []
let connectShouldFail = false

T.setImapFactory(async (cfg) => {
  assert.ok(cfg.user, "la config IMAP deve arrivare alla factory")
  let closed = false
  return {
    async connect() {
      if (connectShouldFail) throw new Error("AUTHENTICATIONFAILED imap-password-should-not-leak")
    },
    async getMailboxLock(folder) {
      assert.equal(folder, "INBOX")
      return {
        release() {
          flagsAdded.push("__released__")
        },
      }
    },
    async *fetch(search) {
      assert.deepEqual(search, { seen: false }, "il filtro non letti deve arrivare al server")
      for (const src of FETCHED) yield { source: src, uid: 1 }
    },
    async messageFlagsAdd(uid, flags) {
      // imapflow reale: la STORE fallisce se la connessione e' chiusa
      if (closed) throw new Error("Connection closed")
      flagsAdded.push(`${uid}:${flags.join(",")}`)
    },
    async logout() {
      closed = true
      flagsAdded.push("__logout__")
    },
  }
})

async function hooks() {
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

test("mail_inbox: senza IMAP configurato dice cosa manca e non tocca la rete", async () => {
  const h = await hooks()
  const r = await h.tool.mail_inbox.execute({}, {})
  assert.ok(/IMAP non configurato/.test(r.output), r.output)
  assert.ok(/IMAP_USER|GMAIL_USER/.test(r.output), "deve indicare la chiave da impostare")
})

test("mail_inbox: filtra per identità e restituisce le risposte", async () => {
  const saved = { u: process.env.GMAIL_USER, p: process.env.GMAIL_APP_PASSWORD }
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.AGENT_ID = "culture-agent-pc-01"
  FETCHED.length = 0
  FETCHED.push(RAW_OTHER_AGENT, RAW_REPLY)
  try {
    const h = await hooks()
    const r = await h.tool.mail_inbox.execute({ only_mine: false }, {})
    assert.ok(r.output.includes(SUBJECT_TEXT), "il messaggio deve comparire")
    assert.ok(r.output.includes("altro agente"), "con only_mine=false deve comparire tutto")
  } finally {
    if (saved.u === undefined) delete process.env.GMAIL_USER
    else process.env.GMAIL_USER = saved.u
    if (saved.p === undefined) delete process.env.GMAIL_APP_PASSWORD
    else process.env.GMAIL_APP_PASSWORD = saved.p
    delete process.env.AGENT_ID
  }
})

test("mail_inbox: only_mine=true NON deve perdere una risposta umana (bug F2)", async () => {
  // Una risposta vera porta In-Reply-To verso un messaggio che NOI abbiamo
  // inviato: quel messaggio sta in Sent, quindi non è tra quelli appena letti.
  // Il filtro deve riconoscerlo tramite il registro dei Message-ID.
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.AGENT_ID = "culture-agent-pc-01"
  FETCHED.length = 0
  FETCHED.push(RAW_REPLY)
  try {
    const script = `
      process.env.AGENT_MAIL_STATE_DIR = ${JSON.stringify(process.env.AGENT_MAIL_STATE_DIR)};
      delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD; delete process.env.SMTP_HOST;
      const m = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
      m.AgentMailPlugin.__testing.recordSentId("culture-agent-pc-01", "<orig-1@example.com>");
      console.log("recorded");
    `
    const rec = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
    assert.equal(rec.status, 0, rec.stderr)

    const h = await hooks()
    const r = await h.tool.mail_inbox.execute({ only_mine: true }, {})
    assert.ok(
      r.output.includes(SUBJECT_TEXT),
      `una risposta umana reale deve superare il filtro only_mine: ${r.output}`
    )
  } finally {
    delete process.env.AGENT_ID
  }
})

test("mail_inbox: only_mine=true esclude altri agenti ed esclude l'eco di noi stessi", async () => {
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.AGENT_ID = "culture-agent-pc-01"
  FETCHED.length = 0
  FETCHED.push(RAW_OTHER_AGENT, RAW_SELF_ECHO)
  try {
    const h = await hooks()
    const r = await h.tool.mail_inbox.execute({ only_mine: true }, {})
    assert.ok(!r.output.includes("altro agente"), "messaggio di un altro agente deve essere escluso")
    assert.ok(!r.output.includes("Echo di me stesso"), "il nostro stesso invio non deve essere restituito")
    assert.ok(/Nessun messaggio corrispondente/.test(r.output), r.output)
  } finally {
    delete process.env.AGENT_ID
  }
})

test("F4: IMAP_PORT=993 esplicito deve restare sicuro (non inviare credenziali in chiaro)", () => {
  const saved = { u: process.env.GMAIL_USER, p: process.env.GMAIL_APP_PASSWORD, port: process.env.IMAP_PORT, sec: process.env.IMAP_SECURE }
  process.env.GMAIL_USER = "a@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.IMAP_PORT = "993"
  delete process.env.IMAP_SECURE
  try {
    const cfg = T.getImapConfig()
    assert.equal(cfg.secure, true, "IMAP_PORT=993 non deve disattivare TLS")
    assert.equal(cfg.port, 993)
  } finally {
    if (saved.port === undefined) delete process.env.IMAP_PORT
    else process.env.IMAP_PORT = saved.port
    if (saved.sec === undefined) delete process.env.IMAP_SECURE
    else process.env.IMAP_SECURE = saved.sec
    delete process.env.GMAIL_USER
    delete process.env.GMAIL_APP_PASSWORD
  }
})

test("F4: porta fuori range rifiutata, non silenziosamente accettata", () => {
  process.env.GMAIL_USER = "a@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.IMAP_PORT = "99999"
  try {
    const cfg = T.getImapConfig()
    assert.equal(cfg.port, 993, "porta non valida deve ricadere su 993")
  } finally {
    delete process.env.IMAP_PORT
    delete process.env.GMAIL_USER
    delete process.env.GMAIL_APP_PASSWORD
  }
})

test("F4: IMAP senza TLS su porta non standard viene rifiutato per default", () => {
  process.env.GMAIL_USER = "a@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.IMAP_PORT = "143"
  delete process.env.IMAP_SECURE
  delete process.env.IMAP_ALLOW_INSECURE_TLS
  try {
    assert.equal(T.getImapConfig(), null, "porta 143 senza TLS non deve essere usata")
  } finally {
    delete process.env.IMAP_PORT
    delete process.env.GMAIL_USER
    delete process.env.GMAIL_APP_PASSWORD
  }
})

test("F4: IMAP_ALLOW_INSECURE_TLS=true consente il relay in chiaro", () => {
  process.env.GMAIL_USER = "a@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.IMAP_PORT = "143"
  process.env.IMAP_ALLOW_INSECURE_TLS = "true"
  try {
    const cfg = T.getImapConfig()
    assert.equal(cfg.secure, false)
    assert.equal(cfg.port, 143)
  } finally {
    delete process.env.IMAP_PORT
    delete process.env.IMAP_ALLOW_INSECURE_TLS
    delete process.env.GMAIL_USER
    delete process.env.GMAIL_APP_PASSWORD
  }
})

test("F3: il fetch e limitato a MAX_SCAN messaggi (niente OOM su caselle grandi)", async () => {
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  process.env.AGENT_ID = "culture-agent-pc-01"
  // Ricetta una casella piu grande del tetto
  const big = []
  for (let i = 0; i < T.MAX_SCAN + 50; i++) {
    big.push(
      [
        `From: qualcuno${i}@example.com`,
        "To: cultureagentpc@gmail.com",
        `Subject: Messaggio numero ${i}`,
        `Message-ID: <bulk-${i}@example.com>`,
        "",
        "contenuto",
      ].join("\r\n")
    )
  }
  FETCHED.length = 0
  FETCHED.push(...big)
  try {
    const h = await hooks()
    const r = await h.tool.mail_inbox.execute({ only_mine: false, limit: 5 }, {})
    assert.ok(/oltre \d+ non analizzati/.test(r.output), `il troncamento deve essere dichiarato: ${r.output.slice(0, 300)}`)
  } finally {
    delete process.env.AGENT_ID
  }
})

test("isSelfSent riconosce l'eco della propria casella", () => {
  const m = T.parseInboxMessage(RAW_SELF_ECHO, 1)
  assert.equal(T.isSelfSent(m, "cultureagentpc@gmail.com"), true)
  assert.equal(T.isSelfSent(m, "altro@gmail.com"), false)
})

test("recordSentId persiste e sentIdsFor rilegge", () => {
  const script = `
    process.env.AGENT_MAIL_STATE_DIR = ${JSON.stringify(process.env.AGENT_MAIL_STATE_DIR)};
    delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD; delete process.env.SMTP_HOST;
    const m = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    m.AgentMailPlugin.__testing.recordSentId("ag-x", "<a@x>");
    m.AgentMailPlugin.__testing.recordSentId("ag-x", "<b@x>");
    m.AgentMailPlugin.__testing.recordSentId("ag-x", "<a@x>");
    console.log(JSON.stringify([...m.AgentMailPlugin.__testing.sentIdsFor("ag-x")]));
  `
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
  assert.equal(out.status, 0, out.stderr)
  const ids = JSON.parse(out.stdout.trim().split("\n").pop())
  assert.deepEqual(ids.sort(), ["<a@x>", "<b@x>"], "nessun duplicato, entrambi presenti")
})

test("mail_inbox: per default NON marca come letti", async () => {
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  FETCHED.length = 0
  FETCHED.push(RAW_REPLY)
  flagsAdded = []
  const h = await hooks()
  const r = await h.tool.mail_inbox.execute({ only_mine: false }, {})
  assert.ok(/NON sono stati segnati come letti/.test(r.output), r.output)
  assert.ok(!flagsAdded.some((f) => f.includes("\\Seen")), "nessun flag \Seen senza mark_seen")
  assert.ok(flagsAdded.includes("__released__"), "il lock deve essere rilasciato")
  assert.ok(flagsAdded.includes("__logout__"), "il client deve essere chiuso")
  delete process.env.AGENT_ID
})

test("mail_inbox: mark_seen=true applica il flag Seen", async () => {
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16)
  FETCHED.length = 0
  FETCHED.push(RAW_REPLY)
  flagsAdded = []
  const h = await hooks()
  const r = await h.tool.mail_inbox.execute({ only_mine: false, mark_seen: true }, {})
  assert.ok(flagsAdded.some((f) => f.includes("\\Seen")), `flag Seen non applicato: ${flagsAdded.join(",")}`)
  assert.ok(/Segnati come letti/.test(r.output), r.output)
  delete process.env.AGENT_ID
})

test("mail_inbox: errore di autenticazione redatto e con suggerimento", async () => {
  process.env.GMAIL_USER = "cultureagentpc@gmail.com"
  process.env.GMAIL_APP_PASSWORD = "imap-password-should-not-leak"
  connectShouldFail = true
  try {
    const h = await hooks()
    const r = await h.tool.mail_inbox.execute({}, {})
    connectShouldFail = false
    assert.ok(!r.output.includes("imap-password-should-not-leak"), "la password IMAP non deve comparire")
    assert.ok(/Errore IMAP/.test(r.output), r.output)
    assert.ok(/mail.google.com/.test(r.output), "deve suggerire di abilitare IMAP")
  } finally {
    connectShouldFail = false
    delete process.env.AGENT_ID
  }
})