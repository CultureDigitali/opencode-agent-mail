import { tool, type Plugin } from "@opencode-ai/plugin"
import nodemailer, { type Transporter } from "nodemailer"
import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── Types ─────────────────────────────────────────────────────────
type AgentIdentity = {
  agent_id: string
  display_name: string
  email: string
  signature?: string
  instance_host?: string
  created_at?: string
}

type ModelInfo = {
  providerID: string
  modelID: string
}

type SessionRecord = {
  sendCount: number
  firstSentAt?: string
  lastSentAt?: string
  lastTo?: string
}

/**
 * Controllo destinatari, applicato a TUTTI i campi di consegna (to, cc, bcc).
 *
 * MAIL_ALLOWED_RECIPIENTS è una allowlist esplicita: se impostata, ogni
 * destinatario fuori lista blocca l'invio. Serve perché, senza, un agente può
 * (anche indotto da contenuti letti via IMAP) scrivere a chiunque dal tuo
 * account. Disattivata di default per non rompere le installazioni esistenti,
 * ma è la prima cosa da attivare per un uso serio.
 */
function checkRecipients(fields: (string | undefined)[]): { ok: true } | { ok: false; blocked: string[]; allowed: string[] } {
  const raw = (process.env.MAIL_ALLOWED_RECIPIENTS || "").trim()
  if (!raw) return { ok: true }
  const allowed = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const blocked: string[] = []
  for (const field of fields) {
    if (!field) continue
    // sintassi ambigua: non sappiamo quale indirizzo userà davvero il server SMTP,
    // quindi non possiamo autorizzarla. Fail closed.
    if (hasAmbiguousRecipientSyntax(field)) {
      return {
        ok: false,
        blocked: [`sintassi destinatario non verificabile: ${JSON.stringify(String(field).slice(0, 120))}`],
        allowed,
      }
    }
    for (const addr of extractAddresses(field)) {
      if (!allowed.includes(addr)) blocked.push(addr)
    }
  }
  return blocked.length === 0 ? { ok: true } : { ok: false, blocked, allowed }
}

/**
 * Estrae TUTTI gli indirizzi presenti in un campo di destinatari.
 *
 * Deve essere più permissivo del parser SMTP: se qui non trova un indirizzo
 * che nodemailer troverà, l'allowlist può essere aggirata. Per questo non si
 * fidata del "primo <...>" ma estrae ogni token che sembra un indirizzo, e
 * tratta come sospette le virgolette (combinazione virgolette+parentesi
 * angolari usata per far divergere i due parser).
 */
function extractAddresses(field: string): string[] {
  const raw = String(field ?? "")
  const found = new Set<string>()
  // ogni sequenza che contiene un '@' viene considerata un indirizzo candidato
  for (const token of raw.split(/[,;]/)) {
    for (const match of token.matchAll(/[^\s<>"(),;:]+@[^\s<>"(),;:]+/g)) {
      found.add(match[0].trim().toLowerCase())
    }
  }
  return [...found]
}

/** True se il campo usa sintassi che fanno divergere i due parser. */
function hasAmbiguousRecipientSyntax(field: string): boolean {
  return /"[^"]*"[^,;]*</.test(String(field ?? "")) || /\r|\n/.test(String(field ?? ""))
}

// ── Paths ─────────────────────────────────────────────────────────
// AGENT_MAIL_STATE_DIR permette di isolare identità e store (test, portatile,
// ambienti multi-profilo) senza toccare la configazione globale.
const STATE_DIR = process.env.AGENT_MAIL_STATE_DIR || path.join(os.homedir(), ".config", "opencode")
const IDENTITY_PATH = path.join(STATE_DIR, "agent-identity.json")
// Nessun fallback "a caso" fuori da STATE_DIR: una copia di questo file dentro
// una directory di pacchetto o di progetto (clone git, npm link, altro
// processo con gli stessi permessi) potrebbe altrimenti fissare l'identità —
// cioè From, replyTo, X-Agent-ID e destinatario predefinito — di ogni agente.
// Se serve un profilo separato si usa AGENT_MAIL_STATE_DIR, che è esplicito.
const SESSION_STORE_PATH = path.join(STATE_DIR, "agent-mail-sessions.json")

// ── In-memory caches (per-process) ────────────────────────────────
const modelBySession = new Map<string, ModelInfo>()
const projectBySession = new Map<string, { directory: string; worktree: string }>()

// ── Identity ──────────────────────────────────────────────────────
type IdentityLoad = {
  identity: AgentIdentity
  meta: { fileUsed: string; fileValid: boolean; diagnostics: string[] }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

/**
 * Precedenza campo-per-campo: env > file > fallback.
 * Un file presente ma malformato non impedisce l'avvio: produce diagnostica
 * e si ripiega sui default, invece di far fallire l'invio più tardi e lontano.
 */
function loadIdentity(): IdentityLoad {
  const diagnostics: string[] = []
  let fileData: Record<string, unknown> | null = null
  let fileUsed = "(nessuno)"
  let fileValid = true

  for (const p of [IDENTITY_PATH]) {
    try {
      if (!fs.existsSync(p)) continue
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fileData = parsed as Record<string, unknown>
        fileUsed = p
        break
      }
      fileValid = false
      diagnostics.push(`Identity file ${p}: JSON non valido (atteso un oggetto), ignorato.`)
    } catch (e: any) {
      fileValid = false
      diagnostics.push(`Identity file ${p}: JSON malformato (${e.message}), ignorato.`)
    }
  }

  const pick = (envName: string, fileKey: string, fallback: string, validate?: (v: string) => boolean): string => {
    const env = process.env[envName]
    if (nonEmptyString(env)) {
      const v = env.trim()
      if (validate && !validate(v)) {
        diagnostics.push(`${envName}="${v}" non valido: ignorato.`)
      } else {
        return v
      }
    }
    const fileVal = fileData ? fileData[fileKey] : undefined
    if (fileVal !== undefined && !nonEmptyString(fileVal)) {
      diagnostics.push(`Identity file: campo "${fileKey}" assente o non stringa, uso fallback.`)
    }
    if (nonEmptyString(fileVal)) {
      const v = fileVal.trim()
      if (validate && !validate(v)) {
        diagnostics.push(`Identity file: campo "${fileKey}"="${v}" non valido, uso fallback.`)
        return fallback
      }
      return v
    }
    return fallback
  }

  const identity: AgentIdentity = {
    agent_id: pick("AGENT_ID", "agent_id", "opencode-main"),
    display_name: pick("AGENT_DISPLAY_NAME", "display_name", "OpenCode Agent"),
    email: pick("GMAIL_USER", "email", "your.agent@gmail.com", isValidEmail),
    signature: pick("AGENT_SIGNATURE", "signature", "-- OpenCode Agent"),
    instance_host: pick("AGENT_INSTANCE_HOST", "instance_host", os.hostname()),
  }

  return { identity, meta: { fileUsed, fileValid, diagnostics } }
}

// ── SMTP ──────────────────────────────────────────────────────────
type SmtpConfig = {
  provider: "gmail" | "resend" | "generic"
  host: string
  port: number
  secure: boolean
  requireTLS: boolean
  auth?: { user: string; pass: string }
  diagnostics: string[]
}

const SMTP_PORT_MIN = 1
const SMTP_PORT_MAX = 65535

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= SMTP_PORT_MIN && port <= SMTP_PORT_MAX
}

/**
 * Diagnostiche dell'ultima risoluzione SMTP, conservate anche quando la
 * configurazione è incompleta e getSmtpConfig() restituisce null, così
 * mail_status può spiegare il perché invece di limitarsi a "non configurato".
 */
let lastSmtpDiagnostics: string[] = []
/** Idem per IMAP: la diagnosi va mostrata anche quando la config e rifiutata. */
let lastImapDiagnostics: string[] = []

/**
 * Risoluzione esplicita del provider.
 * MAIL_PROVIDER vince; altrimenti si applica un ordine deterministico.
 * `SMTP_HOST` da solo produce sempre provider "generic", così `SMTP_SECURE`
 * non viene più ignorato quando è presente una password generica.
 * Nota: una password `SMTP_PASS` NON implica Resend: Resend si riconosce da
 * `RESEND_SMTP_PASS`, altrimenti ogni password SMTP generica verrebbe
 * scambiata per una chiave Resend.
 */
function getSmtpConfig(): SmtpConfig | null {
  const diagnostics: string[] = []

  const hasGmail = !!(process.env.GMAIL_APP_PASSWORD && process.env.GMAIL_USER)
  const hasResend = !!process.env.RESEND_SMTP_PASS
  const hasHost = !!process.env.SMTP_HOST

  const explicit = (process.env.MAIL_PROVIDER || "").trim().toLowerCase()
  if (explicit && !["gmail", "resend", "generic"].includes(explicit)) {
    diagnostics.push(`MAIL_PROVIDER ignorato (valore non valido: "${explicit}"). Attesi: gmail, resend, generic.`)
  }

  let provider: "gmail" | "resend" | "generic"
  if (["gmail", "resend", "generic"].includes(explicit)) {
    provider = explicit as "gmail" | "resend" | "generic"
  } else {
    // ordine di rilevamento: gmail ha la precedenza storica, così un
    // SMTP_HOST lasciato attorno non dirotta un'installazione Gmail funzionante
    const detected: string[] = []
    if (hasGmail) detected.push("gmail")
    if (hasResend) detected.push("resend")
    if (hasHost) detected.push("generic")
    if (detected.length === 0) {
      lastSmtpDiagnostics = [
        "Nessuna configurazione SMTP trovata: imposta GMAIL_USER + GMAIL_APP_PASSWORD, oppure RESEND_SMTP_PASS, oppure MAIL_PROVIDER=generic con SMTP_HOST.",
      ]
      return null
    }
    if (detected.length > 1) {
      diagnostics.push(
        `Provider multipli rilevati (${detected.join(", ")}): scelto "${detected[0]}". Imposta MAIL_PROVIDER per una scelta esplicita.`
      )
    }
    provider = detected[0] as "gmail" | "resend" | "generic"
  }

  if (provider === "gmail") {
    if (!hasGmail) {
      diagnostics.push("MAIL_PROVIDER=gmail richiede GMAIL_USER e GMAIL_APP_PASSWORD: configurazione incompleta.")
      lastSmtpDiagnostics = diagnostics
      return null
    }
    lastSmtpDiagnostics = diagnostics
    return {
      provider: "gmail",
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: process.env.GMAIL_USER!, pass: process.env.GMAIL_APP_PASSWORD! },
      diagnostics,
    }
  }

  if (provider === "resend") {
    if (!hasResend) {
      diagnostics.push("MAIL_PROVIDER=resend richiede RESEND_SMTP_PASS: configurazione incompleta.")
      lastSmtpDiagnostics = diagnostics
      return null
    }
    // Come per IMAP: la chiave Resend non può essere consegnata a un host
    // arbitrario. Senza questo, SMTP_HOST=attacker.example + RESEND_SMTP_PASS
    // invierebbe la chiave (e la reputazione del dominio) a un terzo.
    const resendHost = process.env.SMTP_HOST || "smtp.resend.com"
    if (!isResendHost(resendHost)) {
      diagnostics.push(
        `SMTP_HOST="${resendHost}" non e un server Resend, ma la credenziale e RESEND_SMTP_PASS: rifiutato per non consegnare la tua chiave a un host terzo. Togli SMTP_HOST o usa SMTP_USER/SMTP_PASS con MAIL_PROVIDER=generic.`
      )
      lastSmtpDiagnostics = diagnostics
      return null
    }
    lastSmtpDiagnostics = diagnostics
    return {
      provider: "resend",
      host: resendHost,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.SMTP_USER || "resend",
        pass: process.env.RESEND_SMTP_PASS || process.env.SMTP_PASS || "",
      },
      diagnostics,
    }
  }

  if (!hasHost) {
    diagnostics.push("MAIL_PROVIDER=generic richiede SMTP_HOST: configurazione incompleta.")
    lastSmtpDiagnostics = diagnostics
    return null
  }
  const port = Number(process.env.SMTP_PORT || 587)
  if (!isValidPort(port)) diagnostics.push(`SMTP_PORT non valido ("${process.env.SMTP_PORT}"): uso 587.`)
  const resolvedPort = isValidPort(port) ? port : 587
  const secure = process.env.SMTP_SECURE === "true" || resolvedPort === 465
  const rawPass = process.env.SMTP_PASS || process.env.RESEND_SMTP_PASS || ""
  const allowAnonymous = process.env.SMTP_ALLOW_ANONYMOUS === "true"
  if (!process.env.SMTP_USER && rawPass) {
    // non scartare silenziosamente una password fornita: è quasi sempre un errore di setup
    diagnostics.push(
      "SMTP_PASS presente senza SMTP_USER: la password verrebbe ignorata. Imposta SMTP_USER, oppure SMTP_ALLOW_ANONYMOUS=true per un relay anonimo intenzionale."
    )
    lastSmtpDiagnostics = diagnostics
    return null
  }
  const auth = process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: rawPass } : undefined
  if (!auth && !allowAnonymous) {
    diagnostics.push(
      "SMTP anonimo: imposta SMTP_ALLOW_ANONYMOUS=true per confermare che il relay senza autenticazione e intenzionale."
    )
    lastSmtpDiagnostics = diagnostics
    return null
  }
  if (!auth) diagnostics.push("SMTP anonimo attivo (SMTP_ALLOW_ANONYMOUS=true): nessuna autenticazione.")
  lastSmtpDiagnostics = diagnostics
  return {
    provider: "generic",
    host: process.env.SMTP_HOST!,
    port: resolvedPort,
    secure,
    requireTLS: !secure,
    auth,
    diagnostics,
  }
}

// Factory overridabile: i test possono iniettare un transport finto per
// verificare davvero il percorso di invio (gate, rate limit, redazione errori)
// senza aprire connessioni di rete.
type TransportFactory = () => Transporter | null
let transportFactory: TransportFactory = createTransporterImpl

function createTransporter(): Transporter | null {
  return transportFactory()
}

function createTransporterImpl(): Transporter | null {
  const cfg = getSmtpConfig()
  if (!cfg) return null
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: cfg.auth,
  })
}

// ── Session Store (per-chat gate) ─────────────────────────────────
function storeKey(sessionID: string, agentId: string): string {
  return `${agentId}::${sessionID}`
}

function sanitizeStore(raw: unknown): Record<string, SessionRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, SessionRecord> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const rec = v as Record<string, unknown>
    if (typeof rec.sendCount !== "number" || !Number.isFinite(rec.sendCount) || rec.sendCount < 0) continue
    out[k] = {
      sendCount: Math.floor(rec.sendCount),
      firstSentAt: typeof rec.firstSentAt === "string" ? rec.firstSentAt : undefined,
      lastSentAt: typeof rec.lastSentAt === "string" ? rec.lastSentAt : undefined,
      lastTo: typeof rec.lastTo === "string" ? rec.lastTo : undefined,
    }
  }
  return out
}

/** Scrittura atomica (tmp + rename): un'interruzione non lascia JSON troncato. */
function writeJsonAtomic(target: string, data: unknown): boolean {
  let tmp = ""
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
    fs.renameSync(tmp, target)
    return true
  } catch {
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
    return false
  }
}

function loadStore(): Record<string, SessionRecord> {
  try {
    if (fs.existsSync(SESSION_STORE_PATH)) return sanitizeStore(JSON.parse(fs.readFileSync(SESSION_STORE_PATH, "utf8")))
  } catch {}
  return {}
}

/** Ritorna true solo se lo stato è stato scritto su disco. */
function saveStore(store: Record<string, SessionRecord>): boolean {
  return writeJsonAtomic(SESSION_STORE_PATH, store)
}

/**
 * true se in questa sessione è già stato inviato qualcosa.
 * La chiave è `<agent_id>::<session_id>`. Per compatibilità con lo store
 * scritto dalle versioni 1.0.0 (chiave = session_id) si controlla anche il
 * record legacy: senza questo fallback ogni sessione già sbloccata verrebbe
 * bloccata di nuovo al primo invio dopo l'aggiornamento.
 */
function hasSentBefore(sessionID: string, agentId = "default"): boolean {
  const store = loadStore()
  if (store[storeKey(sessionID, agentId)]?.sendCount) return true
  return !!store[sessionID]?.sendCount
}

function markSent(sessionID: string, to: string, agentId = "default"): boolean {
  const store = loadStore()
  const key = storeKey(sessionID, agentId)
  const rec = store[key] || { sendCount: 0 }
  rec.sendCount += 1
  rec.lastSentAt = new Date().toISOString()
  rec.lastTo = to
  if (!rec.firstSentAt) rec.firstSentAt = rec.lastSentAt
  store[key] = rec
  return saveStore(store)
}

// ── IMAP (lettura risposte) ───────────────────────────────────────
type ImapConfig = {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  diagnostics: string[]
}

/**
 * Configurazione IMAP. Riutilizza le credenziali Gmail già presenti, così
 * non serve configurare nulla di nuovo se usi una password per app.
 *
 * SICUREZZA: le credenziali Gmail NON possono essere inviate a un host
 * arbitrario. Senza questo controllo, `IMAP_HOST=attacker.example` (o una
 * `.env` di un progetto clonato) farebbe recapitare la App Password di Gmail
 * a un server terzo via LOGIN. Il fallback delle credenziali Gmail è quindi
 * ammesso solo su host Google; per altri host serve una password dedicata.
 */
function getImapConfig(): ImapConfig | null {
  const diagnostics: string[] = []
  lastImapDiagnostics = diagnostics
  const explicitUser = process.env.IMAP_USER || ""
  const explicitPass = process.env.IMAP_PASS || ""
  const usingGmailCreds = !explicitUser || !explicitPass
  const user = explicitUser || process.env.GMAIL_USER || ""
  const pass = explicitPass || process.env.GMAIL_APP_PASSWORD || ""
  const host = process.env.IMAP_HOST || "imap.gmail.com"

  if (!user || !pass) {
    diagnostics.push(
      "IMAP non configurato: servono IMAP_USER + IMAP_PASS, oppure GMAIL_USER + GMAIL_APP_PASSWORD (la stessa password per app usata per l'invio)."
    )
    return null
  }

  if (usingGmailCreds && !isGoogleImapHost(host)) {
    diagnostics.push(
      `IMAP_HOST="${host}" non e un server Google, ma la password proviene da GMAIL_APP_PASSWORD:|rifiutato per non inviare la tua App Password a un host terzo.|Usa IMAP_USER + IMAP_PASS dedicati per questo host.`
    )
    return null
  }

  const rawPort = Number(process.env.IMAP_PORT || 993)
  if (!isValidPort(rawPort)) {
    diagnostics.push(`IMAP_PORT non valido ("${process.env.IMAP_PORT}"): uso 993.`)
  }
  const port = isValidPort(rawPort) ? rawPort : 993
  // 993 è la porta IMAP implicito standard: TLS a meno che non lo disattivi
  // esplicitamente. IMAP_SECURE=true vince sempre; =false disattiva anche su 993.
  const secure = process.env.IMAP_SECURE === "true" || (process.env.IMAP_SECURE !== "false" && port === 993)
  if (!secure && process.env.IMAP_ALLOW_INSECURE_TLS !== "true") {
    diagnostics.push(
      `IMAP su porta ${port} senza TLS: le credenziali viaggerebbero in chiaro. Imposta IMAP_SECURE=true o IMAP_ALLOW_INSECURE_TLS=true se e un relay fidato.`
    )
    return null
  }
  return {
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port,
    secure,
    user,
    pass,
    diagnostics,
  }
}

type InboxMessage = {
  uid: number | null
  from: string
  to: string
  subject: string
  date: string
  messageId: string
  inReplyTo: string
  agentId: string | null
  snippet: string
  text: string
}

function headerValue(raw: string, name: string): string {
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, "im")
  const m = raw.match(re)
  return m ? m[1].trim() : ""
}

/**
 * Parsing di un messaggio RFC822 in forma strutturata.
 * Funzione pura e senza I/O: è ciò che rende il parsing testabile.
 */
function parseInboxMessage(raw: string, uid: number | null): InboxMessage {
  // separa intestazioni da corpo
  const sep = raw.match(/\r?\n\r?\n/)
  const sepIndex = sep && typeof sep.index === "number" ? sep.index : -1
  const head = sepIndex >= 0 ? raw.slice(0, sepIndex) : raw
  const body = sepIndex >= 0 ? raw.slice(sepIndex + sep![0].length) : ""

  const text = htmlToText(body)
  const snippet = (text.split("\n").find((l: string) => l.trim().length > 0) || "").slice(0, 200)

  return {
    uid,
    from: headerValue(head, "From"),
    to: headerValue(head, "To"),
    subject: decodeMimeWords(headerValue(head, "Subject")),
    date: headerValue(head, "Date"),
    messageId: headerValue(head, "Message-ID"),
    inReplyTo: headerValue(head, "In-Reply-To"),
    agentId: (headerValue(head, "X-Agent-ID") || headerValue(head, "X-Agent-Id") || null) || null,
    snippet,
    text,
  }
}

/** Decodifica le parole encoded-word MIME (=?UTF-8?B?...?=). */
function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, payload: string) => {
    try {
      const buf = enc.toUpperCase() === "B" ? Buffer.from(payload, "base64") : Buffer.from(payload.replace(/_/g, " "), "binary")
      const text = buf.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1")
      return charset.toLowerCase().includes("utf") ? text : Buffer.from(text, "latin1").toString("utf8")
    } catch {
      return _m
    }
  })
}

/** True se il messaggio è stato inviato da questa identità (filtro multi-agente). */
function belongsToAgent(msg: InboxMessage, agentId: string): boolean {
  return !!msg.agentId && msg.agentId.trim() === agentId
}

/** True se il messaggio è stato spedito dalla casella dell'agente (echo di noi stessi). */
function isSelfSent(msg: InboxMessage, ownEmail: string): boolean {
  if (!ownEmail) return false
  const from = msg.from.toLowerCase()
  return from.includes(ownEmail.toLowerCase())
}

/** Messaggi che rispondono a qualcosa che questa identità ha inviato. */
function isReplyToUs(msg: InboxMessage, ourMessageIds: Set<string>): boolean {
  return !!msg.inReplyTo && ourMessageIds.has(msg.inReplyTo.trim())
}

// ── Registro dei Message-ID inviati ───────────────────────────────
// Necessario per riconoscere le risposte: i messaggi che spediamo vivono
// nella cartella Sent, non in INBOX, quindi `In-Reply-To` va confrontato con
// gli ID che abbiamo registrato all'invio.
const SENT_IDS_PATH = path.join(STATE_DIR, "agent-mail-sent-ids.json")
const SENT_IDS_MAX = 500

type SentIds = Record<string, string[]> // agent_id -> [messageId, ...]

function loadSentIds(): SentIds {
  try {
    if (!fs.existsSync(SENT_IDS_PATH)) return {}
    const raw = JSON.parse(fs.readFileSync(SENT_IDS_PATH, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const out: SentIds = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string")
    }
    return out
  } catch {
    return {}
  }
}

function recordSentId(agentId: string, messageId: string): void {
  if (!messageId) return
  try {
    const store = loadSentIds()
    const list = store[agentId] || []
    if (!list.includes(messageId)) list.push(messageId)
    store[agentId] = list.slice(-SENT_IDS_MAX)
    writeJsonAtomic(SENT_IDS_PATH, store)
  } catch {}
}

function sentIdsFor(agentId: string): Set<string> {
  return new Set(loadSentIds()[agentId] || [])
}

function ourIdsCount(agentId: string): number {
  return (loadSentIds()[agentId] || []).length
}

/** Tetto di messaggi scaricati per chiamata: `source:true` porta l'intero MIME. */
const MAX_SCAN = 200
// Un agente in loop non deve poter svuotare la quota Gmail del tuo account.
// Il contatore è PERSISTENTE su disco (per identità): sopravvive al reload
// del plugin e a più processi/istanze sulla stessa macchina.
// Con MAIL_MAX_PER_HOUR=0 resta disattivato e non scrive nulla.
const MAX_PER_HOUR = Number(process.env.MAIL_MAX_PER_HOUR || 0)
const RATE_STORE_PATH = path.join(STATE_DIR, "agent-mail-ratelimit.json")

type RateRecord = { hour: string; count: number }

function rateLimitEnabled(): number {
  return Number.isInteger(MAX_PER_HOUR) && MAX_PER_HOUR > 0 ? MAX_PER_HOUR : 0
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

function loadRateStore(): Record<string, RateRecord> {
  try {
    if (!fs.existsSync(RATE_STORE_PATH)) return {}
    const raw = JSON.parse(fs.readFileSync(RATE_STORE_PATH, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const out: Record<string, RateRecord> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue
      const rec = v as Record<string, unknown>
      if (typeof rec.hour === "string" && typeof rec.count === "number" && Number.isFinite(rec.count) && rec.count >= 0) {
        out[k] = { hour: rec.hour, count: Math.floor(rec.count) }
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Lock esclusivo cross-processo (file creato con O_EXCL).
 * Serve a rendere atomico il read-modify-write del rate limit: senza,
 * due processi che inviano insieme possono perdere un conteggio.
 * Se il lock è preso da un processo morto, scade dopo LOCK_STALE_MS.
 */
const LOCK_STALE_MS = 5000

function acquireLock(target: string): (() => void) | null {
  const lockPath = `${target}.lock`
  const deadline = Date.now() + 2000
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true })
      const fd = fs.openSync(lockPath, "wx")
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return () => {
        try {
          fs.unlinkSync(lockPath)
        } catch {}
      }
    } catch (e: any) {
      if (e?.code !== "EEXIST") return null
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath)
          continue
        }
      } catch {}
      if (Date.now() > deadline) return null
      // attesa breve: i processi concorrenti sono rari e brevi
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}

function checkRateLimit(agentId: string): { allowed: boolean; count: number; limit: number } {
  const limit = rateLimitEnabled()
  if (!limit) return { allowed: true, count: 0, limit: 0 }
  const hour = currentHour()
  const rec = loadRateStore()[agentId]
  const count = rec && rec.hour === hour ? rec.count : 0
  return { allowed: count < limit, count, limit }
}

function bumpRateLimit(agentId: string): void {
  const limit = rateLimitEnabled()
  if (!limit) return
  const hour = currentHour()
  const release = acquireLock(RATE_STORE_PATH)
  try {
    const store = loadRateStore()
    const rec = store[agentId]
    store[agentId] = { hour, count: rec && rec.hour === hour ? rec.count + 1 : 1 }
    writeJsonAtomic(RATE_STORE_PATH, store)
  } finally {
    release?.()
  }
}

// ── Project / Git helpers ─────────────────────────────────────────
type ImapClient = {
  connect(): Promise<unknown>
  getMailboxLock(folder: string): Promise<{ release(): void }>
  fetch(query: unknown, fetchSpec: unknown): AsyncIterable<any>
  messageFlagsAdd(uid: number, flags: string[], opts?: unknown): Promise<unknown>
  logout(): Promise<unknown>
}

type ImapClientFactory = (cfg: ImapConfig) => Promise<ImapClient>

/**
 * Factory IMAP iniettabile: in produzione usa imapflow (import pigro, la
 * libreria viene caricata solo quando serve), nei test un finto client.
 */
const realImapFactory: ImapClientFactory = async (cfg) => {
  const { ImapFlow } = await import("imapflow")
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  })
  return client as unknown as ImapClient
}

let imapFactory: ImapClientFactory = realImapFactory

function getProjectName(worktree: string, directory: string): string {
  try {
    const base = worktree || directory || process.cwd()
    return path.basename(base) || "unknown-project"
  } catch {
    return "unknown-project"
  }
}

/**
 * Risolve il percorso di HEAD per una directory di lavoro.
 * `.git` può essere una directory (repo normale) OPPURE un file
 * "gitdir: <path>" (linked worktree e submodule): nel secondo caso
 * HEAD vive nella directory gitdir, non in .git/HEAD.
 */
function resolveHeadPath(dir: string): string | null {
  const dotGit = path.join(dir, ".git")
  let st: fs.Stats
  try {
    st = fs.statSync(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) {
    const head = path.join(dotGit, "HEAD")
    return fs.existsSync(head) ? head : null
  }
  try {
    const raw = fs.readFileSync(dotGit, "utf8")
    const m = raw.match(/^gitdir:\s*(.+)$/m)
    if (!m) return null
    const target = m[1].trim()
    const gitDir = path.isAbsolute(target) ? target : path.resolve(dir, target)
    const head = path.join(gitDir, "HEAD")
    return fs.existsSync(head) ? head : null
  } catch {
    return null
  }
}

function readBranch(headPath: string): string {
  const content = fs.readFileSync(headPath, "utf8").trim()
  const m = content.match(/^ref:\s*refs\/heads\/(.+)$/)
  if (m) return m[1].trim()
  return `detached@${content.slice(0, 7)}`
}

function getGitInfo(worktree: string, directory: string): { branch: string | null; repo: string | null; dirty: boolean | null } {
  const start = worktree || directory
  if (!start) return { branch: null, repo: null, dirty: null }
  try {
    let cur = path.resolve(start)
    // risale fino alla radice: i repo monorepo possono essere molto annidati
    for (let depth = 0; depth <= 20; depth++) {
      const headPath = resolveHeadPath(cur)
      if (headPath) return { branch: readBranch(headPath), repo: path.basename(cur), dirty: null }
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  } catch {
    return { branch: null, repo: null, dirty: null }
  }
  return { branch: null, repo: null, dirty: null }
}

function shortSessionID(id: string): string {
  if (!id) return "unknown"
  return id.slice(0, 8)
}

// Impedisce header injection (CR/LF) ovunque un valore finisca in un header:
// Subject, From/display name e header X-*
function sanitizeHeaderValue(v: string): string {
  return String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
}

/** Indirizzo email accettato solo se non può iniettare header. */
function isValidEmail(v: string): boolean {
  const s = sanitizeHeaderValue(v)
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
}

/** Host IMAP appartenenti a Google: gli unici ammessi con le credenziali Gmail. */
function isGoogleImapHost(host: string): boolean {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "")
  return h === "imap.gmail.com" || h === "imap.googlemail.com" || h.endsWith(".googlemail.com") || h.endsWith(".gmail.com") || h === "gmail.com"
}

/** Host SMTP Resend: gli unici ammessi con RESEND_SMTP_PASS. */
function isResendHost(host: string): boolean {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "")
  return h === "smtp.resend.com" || h.endsWith(".resend.com")
}

// Non lascia mai trapelare la password SMTP dentro un errore del provider
function redactSecrets(message: string, secret?: string): string {
  let out = String(message ?? "")
  if (secret) out = out.split(secret).join("***")
  return out
}

function maskEmail(email: string): string {
  const at = email.indexOf("@")
  if (at <= 0) return "***"
  const local = email.slice(0, at)
  const domain = email.slice(at)
  return `${local.slice(0, 2)}${"*".repeat(Math.max(1, local.length - 2))}${domain}`
}

function indent(text: string, prefix = "    "): string {
  return String(text ?? "")
    .split("\n")
    .map((l) => (l.trim() ? prefix + l : l))
    .join("\n")
}

// ── Signature builder (rich + traceable) ──────────────────────────
function buildSmartSignature(opts: {
  identity: AgentIdentity
  sessionID: string
  agentName: string
  directory: string
  worktree: string
  model?: ModelInfo
  reason?: string
  senderNote?: string
}): { html: string; text: string } {
  const { identity, sessionID, agentName, directory, worktree, model, reason, senderNote } = opts
  const git = getGitInfo(worktree, directory)
  const projectName = getProjectName(worktree, directory)
  const now = new Date()
  const dateIt = now.toLocaleString("it-IT", { dateStyle: "full", timeStyle: "short" })
  const dateIso = now.toISOString()

  const modelLabel = model ? `${model.providerID}/${model.modelID}` : "unknown-model"
  const projectLabel = git.repo || projectName
const branchLabel = git.branch
    ? ` · branch: <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${escapeHtml(git.branch)}</code>`
    : ""
  const sessionLabel = `${shortSessionID(sessionID)} · agent: ${agentName || "default"}`

  const reasonBlock = reason
    ? `<tr><td style="padding:6px 10px;color:#475569;white-space:nowrap">📝 Motivo invio</td><td style="padding:6px 10px;color:#0f172a"><b>${escapeHtml(reason)}</b></td></tr>`
    : `<tr><td style="padding:6px 10px;color:#475569;white-space:nowrap">📝 Motivo</td><td style="padding:6px 10px;color:#64748b;font-style:italic">non specificato (invio successivo nella stessa sessione)</td></tr>`

  const senderNoteBlock = senderNote
    ? `<tr><td style="padding:6px 10px;color:#475569;white-space:nowrap">💬 Nota mittente</td><td style="padding:6px 10px;color:#334155">${escapeHtml(senderNote)}</td></tr>`
    : ""

  const html = `
<div style="margin-top:28px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px">
    <div style="width:36px;height:36px;border-radius:8px;background:#38bdf8;display:flex;align-items:center;justify-content:center;font-size:18px">🤖</div>
    <div>
      <div style="font-weight:700;font-size:13px;letter-spacing:0.2px">${escapeHtml(identity.display_name)} <span style="font-weight:400;opacity:0.8">· ${escapeHtml(identity.agent_id)}</span></div>
      <div style="font-size:11px;opacity:0.75">${escapeHtml(identity.email)} · via OpenCode Agent Mail</div>
    </div>
    <div style="margin-left:auto;text-align:right;font-size:10px;opacity:0.7">${dateIt}</div>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:12px;line-height:1.5">
    <tbody>
      <tr style="background:#f8fafc"><td style="padding:6px 10px;color:#475569;white-space:nowrap">🧠 Modello</td><td style="padding:6px 10px;color:#0f172a"><code style="background:#e2e8f0;padding:2px 6px;border-radius:4px">${escapeHtml(modelLabel)}</code></td></tr>
      <tr><td style="padding:6px 10px;color:#475569;white-space:nowrap">💬 Sessione</td><td style="padding:6px 10px;color:#0f172a"><code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${escapeHtml(sessionLabel)}</code> · id: ${escapeHtml(shortSessionID(sessionID))}</td></tr>
      <tr style="background:#f8fafc"><td style="padding:6px 10px;color:#475569;white-space:nowrap">📁 Progetto</td><td style="padding:6px 10px;color:#0f172a">${escapeHtml(projectLabel)}${branchLabel} · <span style="color:#64748b;font-size:11px">${escapeHtml(directory || worktree || "")}</span></td></tr>
      <tr><td style="padding:6px 10px;color:#475569;white-space:nowrap">🏠 Host</td><td style="padding:6px 10px;color:#0f172a">${escapeHtml(identity.instance_host || os.hostname())} · ${escapeHtml(os.platform())} ${escapeHtml(os.arch())}</td></tr>
      ${reasonBlock}
      ${senderNoteBlock}
    </tbody>
  </table>

  <div style="padding:10px 16px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;line-height:1.5">
    ${identity.signature ? `<div style="color:#334155;font-style:italic;margin-bottom:6px">${escapeHtml(identity.signature)}</div>` : ""}
    <div>✉️ Email inviata automaticamente da <b>OpenCode Agent Mail</b> — identità tracciata per audit. Rispondi pure a questa mail per parlare con l'agente.</div>
    <div style="margin-top:4px;font-size:10px;color:#94a3b8">ID: ${escapeHtml(identity.agent_id)} · Session: ${escapeHtml(sessionID)} · ${dateIso} · <span style="font-family:monospace">${escapeHtml(identity.email)}</span></div>
  </div>
</div>
`.trim()

  const text = [
    `--`,
    `${identity.display_name} (${identity.agent_id}) <${identity.email}>`,
    identity.signature || "",
    `Modello: ${modelLabel}`,
    `Sessione: ${sessionLabel} (${sessionID})`,
    `Progetto: ${projectLabel}${git.branch ? ` [${git.branch}]` : ""} @ ${directory || worktree}`,
    `Host: ${identity.instance_host || os.hostname()} | ${dateIso}`,
    reason ? `Motivo: ${reason}` : `Motivo: (non specificato)`,
    senderNote ? `Nota mittente: ${senderNote}` : ``,
    `Inviata via OpenCode Agent Mail`,
  ]
    .filter(Boolean)
    .join("\n")

  return { html, text }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Conversione HTML → testo per la parte text/plain del messaggio.
 * Serve sia per le email inviate (alternativa testuale: senza, i client
 * che non renderizzano HTML mostrano il markup grezzo) sia per leggere
 * le risposte in IMAP.
 */
function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function buildFrom(identity: AgentIdentity): string {
  const name = sanitizeHeaderValue(identity.display_name).replace(/"/g, "'")
  const email = sanitizeHeaderValue(identity.email).replace(/[<>\r\n]/g, "")
  return `"${name}" <${email}>`
}

function buildHeaders(identity: AgentIdentity, sessionID: string, model?: ModelInfo) {
  return {
    "X-Agent-ID": sanitizeHeaderValue(identity.agent_id),
    "X-Agent-Host": sanitizeHeaderValue(identity.instance_host || os.hostname()),
    "X-Agent-Session": sanitizeHeaderValue(sessionID),
    "X-Agent-Model": model ? sanitizeHeaderValue(`${model.providerID}/${model.modelID}`) : "unknown",
    "X-Mailer": `OpenCode-Agent-Mail/${sanitizeHeaderValue(identity.agent_id)}`,
  }
}

function buildGateMessage(opts: {
  identity: AgentIdentity
  sessionID: string
  agentName: string
  directory: string
  worktree: string
  model?: ModelInfo
  subject: string
  to: string
  htmlPreview?: string
  reasonProvided?: string
}): string {
  const { identity, sessionID, agentName, directory, worktree, model, subject, to, htmlPreview, reasonProvided } = opts
  const sig = buildSmartSignature({ identity, sessionID, agentName, directory, worktree, model, reason: reasonProvided || "(da specificare)" })
  const git = getGitInfo(worktree, directory)
  const projectName = getProjectName(worktree, directory)

  return [
    `⛔ PRIMO INVIO IN QUESTA SESSIONE — CONTESTO RICHIESTO`,
    ``,
    `Questa chat (${shortSessionID(sessionID)}) non ha mai inviato email prima. Per trasparenza verso il destinatario, devi fornire il CONTESTO.`,
    ``,
    `Cosa stavi per inviare:`,
    `  To: ${to}`,
    `  Subject: ${subject}`,
    `  Preview: ${(htmlPreview || "").slice(0, 200).replace(/<[^>]+>/g, " ").trim() || "(vuoto)"}...`,
    ``,
    `Chi sta mandando (auto-rilevato):`,
    `  Agente: ${identity.display_name} (${identity.agent_id}) <${identity.email}>`,
    `  Modello: ${model ? `${model.providerID}/${model.modelID}` : "unknown (verra tracciato al prossimo messaggio)"}`,
    `  Sessione: ${shortSessionID(sessionID)} (${sessionID}) · agent: ${agentName}`,
    `  Progetto: ${projectName}${git.branch ? ` [${git.branch}]` : ""} @ ${directory || worktree}`,
    `  Host: ${identity.instance_host || os.hostname()}`,
    ``,
    `Firma intelligente che verra aggiunta (anteprima):`,
    sig.text.split("\n").map((l) => `  ${l}`).join("\n"),
    ``,
    `AZIONE RICHIESTA:`,
    `  Re-invoca lo stesso tool aggiungendo:`,
    `    reason="perche stai mandando questa email (1-2 frasi chiare per il destinatario)"`,
    `    confirm=true`,
    `  Opzionale: sender_note="nota extra su chi sei in questo task"`,
    ``,
    `Esempio:`,
    `  mail_send(to="${to}", subject="${subject}", html="...", reason="Invio report giornaliero richiesto da Pierluigi per aggiornamento progetto ${projectName}", confirm=true)`,
    ``,
    `Per i prossimi invii nella stessa sessione non verrai piu bloccato. Usa mail_preview_signature per vedere la firma senza inviare.`,
  ].join("\n")
}

/**
 * Gate di contesto condiviso da mail_send e mail_report.
 * Restituisce null quando il send è ammesso, altrimenti il messaggio di blocco.
 * `reason` deve essere una stringa non vuota DOPO trim (whitespace-only = assente).
 */
function evaluateGate(opts: { isFirst: boolean; reason?: string; confirm?: boolean }): { allowed: true } | { allowed: false; missing: string[] } {
  if (!opts.isFirst) return { allowed: true }
  const missing: string[] = []
  if (!nonEmptyString(opts.reason)) missing.push("reason non vuoto")
  if (opts.confirm !== true) missing.push("confirm=true")
  return missing.length === 0 ? { allowed: true } : { allowed: false, missing }
}

// ── Plugin ────────────────────────────────────────────────────────
export const AgentMailPlugin: Plugin = async (input) => {
  // project info fallback from PluginInput
  const globalWorktree = input.worktree
  const globalDirectory = input.directory

  return {
    // Capture model per session
    "chat.params": async (p, _out) => {
      try {
        if (p.sessionID && p.model) {
          modelBySession.set(p.sessionID, { providerID: p.model.providerID ?? (p as any).providerID ?? "unknown", modelID: (p.model as any).id ?? (p.model as any).modelID ?? "unknown" })
          // also store project context if available
          if (p.sessionID && !projectBySession.has(p.sessionID)) {
            projectBySession.set(p.sessionID, { directory: globalDirectory, worktree: globalWorktree })
          }
        }
      } catch {}
    },
    "chat.message": async (p, _out) => {
      try {
        if (p.sessionID && p.model) {
          modelBySession.set(p.sessionID, { providerID: (p.model as any).providerID, modelID: (p.model as any).id ?? (p.model as any).modelID })
        }
      } catch {}
    },

    tool: {
      mail_send: tool({
        description:
          "Invia un'email con firma intelligente tracciata (agente, modello, sessione, progetto). Al PRIMO invio di ogni sessione richiede reason+confirm per fornire contesto al destinatario. Stessa casella per tutti gli agenti, identità distinta via From + X-Agent-ID.",
        args: {
          to: tool.schema.string().describe("Destinatario. Se omesso usa MAIL_TO o la mail dell'agente"),
          subject: tool.schema.string().describe("Oggetto email"),
          html: tool.schema.string().optional().describe("Corpo HTML"),
          text: tool.schema.string().optional().describe("Corpo plain text"),
          cc: tool.schema.string().optional().describe("CC"),
          bcc: tool.schema.string().optional().describe("BCC"),
          reason: tool.schema.string().optional().describe("OBBLIGATORIO al primo invio della sessione: perche stai mandando questa email? Sara visibile in firma"),
          sender_note: tool.schema.string().optional().describe("Nota opzionale su chi sei in questo task (es. 'Sto lavorando a husky-vs-cats come senior dev')"),
          confirm: tool.schema.boolean().optional().describe("Metti true per confermare invio dopo aver fornito reason al primo invio"),
          dry_run: tool.schema.boolean().optional().describe("true = mostra esattamente cosa verrebbe inviato, senza inviare nulla"),
        },
        async execute(args, ctx) {
          const { identity } = loadIdentity()
          const transporter = createTransporter()
          if (!transporter) {
            return { output: "SMTP non configurato. Imposta GMAIL_USER + GMAIL_APP_PASSWORD (o MAIL_PROVIDER con SMTP_HOST). Vedi mail_status." }
          }
          const sessionID = ctx.sessionID || "unknown-session"
          const to = args.to?.trim() || process.env.MAIL_TO || identity.email
          const from = buildFrom(identity)
          const model = modelBySession.get(sessionID)
          // il contesto del tool corrente ha la precedenza sulla cache di chat
          const cached = projectBySession.get(sessionID)
          const proj = { directory: ctx.directory || cached?.directory || globalDirectory, worktree: ctx.worktree || cached?.worktree || globalWorktree }

          // dry-run PRIMA del gate di contesto: serve proprio nel momento in cui
          // si valuta se inviare a qualcuno, e non deve richiedere confirm.
          // Non invia, non sblocca la sessione, non tocca lo stato.
          if (args.dry_run === true) {
            const previewSig = buildSmartSignature({
              identity,
              sessionID,
              agentName: ctx.agent,
              directory: proj.directory,
              worktree: proj.worktree,
              model,
              reason: args.reason,
              senderNote: args.sender_note,
            })
            const previewDenied = checkRecipients([to, args.cc, args.bcc])
            return {
              output: [
                `DRY RUN — nessuna email inviata, nessuno stato modificato, sessione non sbloccata.`,
                ``,
                `Da:        ${from}`,
                `A:         ${to}`,
                args.cc ? `Cc:        ${args.cc}` : null,
                args.bcc ? `Bcc:       ${args.bcc}` : null,
                `Oggetto:   ${sanitizeHeaderValue(args.subject)}`,
                `Allowlist: ${previewDenied.ok ? "OK" : "BLOCCATO: " + previewDenied.blocked.join(", ")}`,
                `Motivo:    ${args.reason || "(non specificato: al primo invio reale sara richiesto)"}`,
                ``,
                `Corpo (cosi' come lo riceverebbe il destinatario):`,
                indent(htmlToText(args.html || args.text || "")),
                ``,
                `Firma che verrebbe aggiunta (visibile al destinatario):`,
                indent(previewSig.text),
              ]
                .filter((l) => l !== null)
                .join("\n"),
            }
          }

          // RATE LIMIT: protegge la quota dell'account da un agente in loop
          const rate = checkRateLimit(identity.agent_id)
          if (!rate.allowed) {
            return {
              output: `⛔ Limite orario raggiunto: ${rate.count}/${rate.limit} email per "${identity.agent_id}" in questa ora. Nessuna email inviata. Attendi il prossimo ciclo o rivedi MAIL_MAX_PER_HOUR.`,
            }
          }

          // GATE: primo invio in questa sessione
          const isFirst = !hasSentBefore(sessionID, identity.agent_id)
          const gate = evaluateGate({ isFirst, reason: args.reason, confirm: args.confirm })
          if (!gate.allowed) {
            const gate2 = buildGateMessage({
              identity,
              sessionID,
              agentName: ctx.agent,
              directory: proj.directory,
              worktree: proj.worktree,
              model,
              subject: sanitizeHeaderValue(args.subject),
              to,
              htmlPreview: args.html || args.text,
              reasonProvided: args.reason,
            })
            return { output: `⛔ BLOCCATO: mancano ${gate.missing.join(" e ")}.\n\n${gate2}` }
          }

          const sig = buildSmartSignature({
            identity,
            sessionID,
            agentName: ctx.agent,
            directory: proj.directory,
            worktree: proj.worktree,
            model,
            reason: args.reason,
            senderNote: args.sender_note,
          })

          const htmlBody = args.html
            ? `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;max-width:640px">${args.html}${sig.html}</div>`
            : `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;max-width:640px"><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(args.text || "")}</pre>${sig.html}</div>`

          // Parte testuale sempre presente: senza, i client che non renderizzano HTML
// mostrerebbero il markup grezzo. Se l'agente ha passato solo html, lo
// deriviamo invece di omettere del tutto text.
const textBody = args.text ? `${args.text}\n\n${sig.text}` : `${htmlToText(args.html || "")}\n\n${sig.text}`
          const headers = buildHeaders(identity, sessionID, model)

          const denied = checkRecipients([to, args.cc, args.bcc])
          if (!denied.ok) {
            return {
              output: `⛔ BLOCCATO da MAIL_ALLOWED_RECIPIENTS: ${denied.blocked.join(", ")} non in lista. Consentiti: ${denied.allowed.join(", ")}.`,
            }
          }

          try {
            const info = await transporter.sendMail({
              from,
              to,
              cc: args.cc || undefined,
              bcc: args.bcc || undefined,
              replyTo: from,
              subject: sanitizeHeaderValue(args.subject),
              html: htmlBody,
              text: textBody,
              headers,
            })
            const persisted = markSent(sessionID, to, identity.agent_id)
            bumpRateLimit(identity.agent_id)
            // registra il Message-ID: serve a riconoscere le risposte in mail_inbox
            recordSentId(identity.agent_id, String(info?.messageId || ""))
            // keep project mapping
            projectBySession.set(sessionID, proj)
            const rejected = Array.isArray(info.rejected) ? info.rejected : []
            const partial = rejected.length > 0 ? ` | Destinatari rifiutati: ${rejected.join(", ")}` : ""
            const storeWarn = persisted ? "" : " | ATTENZIONE: stato sessione non salvato, il gate ripartira dal primo invio"
            return {
              output: `Email inviata ✔ From: ${from} → To: ${to} | Subject: "${args.subject}" | ID: ${info.messageId} | Agent: ${identity.agent_id} | Model: ${model ? `${model.providerID}/${model.modelID}` : "unknown"} | Session: ${shortSessionID(sessionID)} | Provider: ${getSmtpConfig()?.provider}${partial}${storeWarn}`,
            }
          } catch (err: any) {
            return { output: `Errore invio: ${redactSecrets(String(err?.message || err), getSmtpConfig()?.auth?.pass)}` }
          }
        },
      }),

      mail_report: tool({
        description:
          "Invia report strutturato con firma intelligente e gate contestuale al primo invio (richiede confirm).",
        args: {
          to: tool.schema.string().optional().describe("Destinatario"),
          title: tool.schema.string().describe("Titolo report"),
          summary: tool.schema.string().describe("Sommario 1-2 righe (usato anche come reason in firma)"),
          sections: tool.schema.array(tool.schema.object({ heading: tool.schema.string(), body: tool.schema.string() })).optional(),
          level: tool.schema.enum(["info", "warning", "error", "success"]).optional(),
          reason: tool.schema.string().optional().describe("Se diverso da summary: motivo specifico dell'invio"),
          sender_note: tool.schema.string().optional(),
          confirm: tool.schema.boolean().optional().describe("true per confermare al primo invio della sessione"),
        },
        async execute(args, ctx) {
          const { identity } = loadIdentity()
          const transporter = createTransporter()
          if (!transporter) return { output: "SMTP non configurato. Vedi mail_status." }

          const sessionID = ctx.sessionID || "unknown-session"
          const to = args.to?.trim() || process.env.MAIL_TO || identity.email
          const from = buildFrom(identity)
          const model = modelBySession.get(sessionID)
          // il contesto del tool corrente ha la precedenza sulla cache di chat
          const cached = projectBySession.get(sessionID)
          const proj = { directory: ctx.directory || cached?.directory || globalDirectory, worktree: ctx.worktree || cached?.worktree || globalWorktree }

          // RATE LIMIT (mail_report)
          const rate = checkRateLimit(identity.agent_id)
          if (!rate.allowed) {
            return {
              output: `⛔ Limite orario raggiunto: ${rate.count}/${rate.limit} email per "${identity.agent_id}" in questa ora. Report non inviato.`,
            }
          }

          const effectiveReason = args.reason || args.summary
          const isFirst = !hasSentBefore(sessionID, identity.agent_id)
          const gate = evaluateGate({ isFirst, reason: effectiveReason, confirm: args.confirm })
          if (!gate.allowed) {
            const gate2 = buildGateMessage({
              identity,
              sessionID,
              agentName: ctx.agent,
              directory: proj.directory,
              worktree: proj.worktree,
              model,
              subject: sanitizeHeaderValue(`[${identity.agent_id}] ${args.title}`),
              to,
              htmlPreview: args.summary,
              reasonProvided: effectiveReason,
            })
            return { output: `⛔ BLOCCATO: mancano ${gate.missing.join(" e ")}.\n\n${gate2}\n\nPer questo report, summary e gia un buon reason. Re-invoca con confirm=true per inviare.` }
          }

          const sig = buildSmartSignature({
            identity,
            sessionID,
            agentName: ctx.agent,
            directory: proj.directory,
            worktree: proj.worktree,
            model,
            reason: effectiveReason,
            senderNote: args.sender_note,
          })

          const colors: Record<string, string> = { info: "#2563eb", success: "#16a34a", warning: "#d97706", error: "#dc2626" }
          const color = colors[args.level || "info"]
          const sectionsHtml = (args.sections || []).map((s) => `<h3 style="margin:16px 0 8px;color:#111">${escapeHtml(s.heading)}</h3><div>${s.body}</div>`).join("")
          const body = `
            <div style="border-left:4px solid ${color};padding:12px 16px;background:#f8fafc;border-radius:8px;margin-bottom:16px">
              <h2 style="margin:0 0 4px;color:${color}">${escapeHtml(args.title)}</h2>
              <p style="margin:0;color:#475569">${escapeHtml(args.summary)}</p>
              <p style="margin:8px 0 0;font-size:12px;color:#94a3b8">Agente: <b>${escapeHtml(identity.display_name)}</b> (${escapeHtml(identity.agent_id)}) · ${new Date().toLocaleString("it-IT")}</p>
            </div>
            ${sectionsHtml}
          `
          const html = `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;max-width:640px">${body}${sig.html}</div>`

          const reportDenied = checkRecipients([to])
          if (!reportDenied.ok) {
            return {
              output: `⛔ BLOCCATO da MAIL_ALLOWED_RECIPIENTS: ${reportDenied.blocked.join(", ")} non in lista. Consentiti: ${reportDenied.allowed.join(", ")}.`,
            }
          }

          try {
            const info = await transporter.sendMail({
              from,
              to,
              replyTo: from,
              subject: sanitizeHeaderValue(`[${identity.agent_id}] ${args.title}`),
              html,
              headers: buildHeaders(identity, sessionID, model),
            })
            const persisted = markSent(sessionID, to, identity.agent_id)
            bumpRateLimit(identity.agent_id)
            recordSentId(identity.agent_id, String(info?.messageId || ""))
            projectBySession.set(sessionID, proj)
            const rejected = Array.isArray(info.rejected) ? info.rejected : []
            const partial = rejected.length > 0 ? ` | Destinatari rifiutati: ${rejected.join(", ")}` : ""
            const storeWarn = persisted ? "" : " | ATTENZIONE: stato sessione non salvato"
            return {
              output: `Report inviato ✔ To: ${to} | "${args.title}" | ${info.messageId} | Agent: ${identity.agent_id} | Model: ${model ? `${model.providerID}/${model.modelID}` : "unknown"}${partial}${storeWarn}`,
            }
          } catch (err: any) {
            return { output: `Errore report: ${redactSecrets(String(err?.message || err), getSmtpConfig()?.auth?.pass)}` }
          }
        },
      }),

      mail_preview_signature: tool({
        description: "Mostra anteprima della firma intelligente senza inviare nulla. Utile per verificare cosa vedra il destinatario.",
        args: {
          reason: tool.schema.string().optional().describe("Motivo fittizio da mostrare in firma"),
          sender_note: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const { identity } = loadIdentity()
          const sessionID = ctx.sessionID || "unknown-session"
          const model = modelBySession.get(sessionID)
          // il contesto del tool corrente ha la precedenza sulla cache di chat
          const cached = projectBySession.get(sessionID)
          const proj = { directory: ctx.directory || cached?.directory || globalDirectory, worktree: ctx.worktree || cached?.worktree || globalWorktree }
          const sig = buildSmartSignature({
            identity,
            sessionID,
            agentName: ctx.agent,
            directory: proj.directory,
            worktree: proj.worktree,
            model,
            reason: args.reason || "Anteprima firma - non e un invio reale",
            senderNote: args.sender_note,
          })
          return {
            output: [
              `Firma per ${identity.display_name} (${identity.agent_id})`,
              `Sessione: ${shortSessionID(sessionID)} | Modello: ${model ? `${model.providerID}/${model.modelID}` : "unknown (verra tracciato al prossimo prompt)"}`,
              `Progetto: ${getProjectName(proj.worktree, proj.directory)} | Branch: ${getGitInfo(proj.worktree, proj.directory).branch || "n/a"}`,
              ``,
              `--- HTML (renderizzato in email) ---`,
              sig.html,
              ``,
              `--- TEXT ---`,
              sig.text,
            ].join("\n"),
          }
        },
      }),

      mail_status: tool({
        description: "Mostra configurazione mail, identita e stato del gate. Non esegue I/O di rete: usa mail_verify per la verifica SMTP.",
        args: {
          verify: tool.schema.boolean().optional().describe("true per eseguire anche una verifica SMTP di rete"),
        },
        async execute(args, ctx) {
          const { identity, meta } = loadIdentity()
          const cfg = getSmtpConfig()
          const hasTransport = !!createTransporter()
          const sessionID = (ctx as any)?.sessionID || "n/a"
          const model = sessionID !== "n/a" ? modelBySession.get(sessionID) : undefined
          const store = loadStore()
          const scopedKey = storeKey(sessionID, identity.agent_id)
          const rec = store[scopedKey] || store[sessionID]
          // record presente ma solo con la chiave legacy (store 1.0.0)
          const legacyOnly = !store[scopedKey] && !!store[sessionID]?.sendCount
          const lines = [
            `Identita agente:`,
            `  agent_id: ${identity.agent_id}`,
            `  display_name: ${identity.display_name}`,
            `  email: ${identity.email}`,
            `  host: ${identity.instance_host || os.hostname()}`,
            `  signature: ${identity.signature || "(nessuna)"}`,
            `  file: ${meta.fileUsed}${meta.fileValid ? "" : " (JSON MALFORMATO: uso fallback)"}`,
            ...(meta.diagnostics.length ? [`  diagnostica: ${meta.diagnostics.join(" | ")}`] : []),
            ``,
            `Sessione corrente:`,
            `  session: ${sessionID} (${shortSessionID(sessionID)})`,
            `  agent: ${(ctx as any)?.agent || "n/a"}`,
            `  model: ${model ? `${model.providerID}/${model.modelID}` : "non ancora tracciato (verra capturato al prossimo messaggio)"}`,
            `  directory: ${(ctx as any)?.directory || globalDirectory}`,
            `  worktree: ${(ctx as any)?.worktree || globalWorktree}`,
            `  progetto: ${getProjectName((ctx as any)?.worktree || globalWorktree, (ctx as any)?.directory || globalDirectory)}`,
            `  branch: ${getGitInfo((ctx as any)?.worktree || globalWorktree, (ctx as any)?.directory || globalDirectory).branch || "n/a"}`,
            `  gate: ${rec ? `gia inviato ${rec.sendCount} mail in questa sessione (primo: ${rec.firstSentAt})${legacyOnly ? " [record legacy 1.0.0]" : ""}` : "PRIMO INVIO BLOCCATO - richiedera reason+confirm"}`,
            ``,
            `SMTP:`,
            `  provider: ${cfg?.provider || "(non configurato)"}`,
            `  host: ${cfg?.host || "-"}`,
            `  port: ${cfg?.port || "-"}`,
            `  secure: ${cfg?.secure ?? "-"}`,
            `  requireTLS: ${cfg?.requireTLS ?? "-"}`,
            `  user: ${cfg?.auth?.user ? maskEmail(cfg.auth.user) : "-"}`,
            `  pass: ${cfg?.auth?.pass ? "•••••••• (" + cfg.auth.pass.length + " chars)" : "(mancante)"}`,
            `  transporter: ${hasTransport ? "OK" : "NON CONFIGURATO"}`,
            ...(cfg?.diagnostics.length ? [`  diagnostica: ${cfg.diagnostics.join(" | ")}`] : []),
            ...(hasTransport ? [] : lastSmtpDiagnostics.length ? [`  diagnostica: ${lastSmtpDiagnostics.join(" | ")}`] : []),
            ``,
            `Store: ${SESSION_STORE_PATH} (${Object.keys(store).length} sessioni tracciate)`,
            ``,
            `Uso:`,
            `  mail_send(to, subject, html, reason, confirm=true) -> primo invio richiede reason+confirm`,
            `  mail_report(title, summary, confirm=true) -> usa summary come reason`,
            `  mail_preview_signature(reason="...") -> anteprima firma`,
          ]
          if (args.verify && hasTransport) {
            try {
              await createTransporter()!.verify()
              lines.push(`  verify: OK`)
            } catch (e: any) {
              lines.push(`  verify: ERRORE - ${redactSecrets(e.message, cfg?.auth?.pass)}`)
            }
          }
          return { output: lines.join("\n") }
        },
      }),

      mail_verify: tool({
        description: "Verifica connessione SMTP.",
        args: {},
        async execute() {
          const t = createTransporter()
          if (!t) return { output: "SMTP non configurato" }
          try {
            await t.verify()
            return { output: "SMTP verify OK - pronto per inviare" }
          } catch (e: any) {
            const cfg = getSmtpConfig()
            return { output: `SMTP verify FALLITO: ${redactSecrets(String(e?.message || e), cfg?.auth?.pass)}` }
          }
        },
      }),

      mail_inbox: tool({
        description:
          "Legge l'INBOX via IMAP e restituisce i messaggi ricevuti (per default: risposte indirizzate a questa identità). Usalo per ricevere feedback o risposte ai report inviati.",
        args: {
          limit: tool.schema.number().optional().describe("Quanti messaggi leggere (default 10, max 50)"),
          folder: tool.schema.string().optional().describe("Cartella IMAP (default INBOX)"),
          unread_only: tool.schema.boolean().optional().describe("Leggi solo i messaggi non letti (default true)"),
          only_mine: tool.schema.boolean().optional().describe("Restituisci solo i messaggi che rispondono a email inviate da questa identità (default true)"),
          include_body: tool.schema.boolean().optional().describe("Includi il testo completo del messaggio, non solo l'anteprima"),
          mark_seen: tool.schema.boolean().optional().describe("Segna come letti (default false)"),
        },
        async execute(args) {
          const { identity } = loadIdentity()
          const cfg = getImapConfig()
          if (!cfg) {
            return {
              output: [
                "IMAP non disponibile.",
                ...(lastImapDiagnostics.length ? lastImapDiagnostics : ["Serve IMAP_USER + IMAP_PASS, oppure GMAIL_USER + GMAIL_APP_PASSWORD (la stessa password per app usata per l'invio)."]),
              ].join("\n"),
            }
          }

          const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
          const folder = (args.folder || "INBOX").trim() || "INBOX"
          const unreadOnly = args.unread_only !== false
          const onlyMine = args.only_mine !== false
          const includeBody = args.include_body === true

          let client: ImapClient
          try {
            client = await imapFactory(cfg)
          } catch (e: any) {
            return { output: `Impossibile caricare il client IMAP: ${redactSecrets(String(e?.message || e), cfg.pass)}` }
          }

          const search: Record<string, unknown> = unreadOnly ? { seen: false } : {}
          const messages: InboxMessage[] = []
          let lock: { release(): void } | null = null
          let truncated = false

          try {
            await client.connect()
            lock = await client.getMailboxLock(folder)
            // hard cap: `source:true` scarica l'intero MIME, quindi senza un
            // tetto una casella grande esaurirebbe la memoria.
            for await (const msg of client.fetch(search, { source: true, uid: true })) {
              if (messages.length >= MAX_SCAN) {
                truncated = true
                break
              }
              if (!msg?.source) continue
              messages.push(parseInboxMessage(String(msg.source), msg.uid ?? null))
            }

            let filtered = messages
            if (onlyMine) {
              // Riconosce: (a) messaggi che portano il nostro X-Agent-ID,
              // (b) risposte a un Message-ID che questa identità ha inviato
              //     (registrato all'invio: i nostri messaggi stanno in Sent,
              //      quindi non sono tra quelli appena letti),
              // (c) esclude l'eco di noi stessi.
              const ourIds = sentIdsFor(identity.agent_id)
              filtered = messages.filter(
                (m) => !isSelfSent(m, identity.email) && (belongsToAgent(m, identity.agent_id) || isReplyToUs(m, ourIds))
              )
            }

            const selected = filtered.slice(-limit).reverse()

            // mark_seen DEVE avvenire con la connessione ancora viva e la
            // mailbox selezionata: dopo il logout la STORE fallirebbe.
            let markedCount = 0
            if (args.mark_seen === true && selected.length) {
              try {
                for (const m of selected) {
                  if (m.uid == null) continue
                  await client.messageFlagsAdd(m.uid, ["\\Seen"], { uid: true })
                  markedCount++
                }
              } catch (e: any) {
                return {
                  output: `Messaggi letti, ma il flag "letto" non e stato applicato a tutti: ${redactSecrets(String(e?.message || e), cfg.pass)}`,
                }
              }
            }

            const header = [
              `Inbox "${folder}" · identita ${identity.agent_id} · ${selected.length} messaggi (letti: ${messages.length}${truncated ? `, oltre ${MAX_SCAN} non analizzati` : ""}, dopo filtri: ${filtered.length})`,
              ``,
            ]
            if (selected.length === 0) {
              return {
                output: [
                  `Nessun messaggio corrispondente in "${folder}" per l'identita ${identity.agent_id}.`,
                  unreadOnly ? `Filtro: solo non letti.` : null,
                  onlyMine ? `Filtro: solo risposte a email inviate da questa identita (Message-ID registrati: ${ourIdsCount(identity.agent_id)}).` : null,
                  `Usa only_mine=false per vedere tutta la casella, oppure unread_only=false per includere i gia letti.`,
                ]
.filter(Boolean)
                .join("\n"),
              }
            }

            const lines = [...header]
            for (const m of selected) {
              lines.push(`--- uid ${m.uid ?? "?"} | ${m.date || "senza data"}`)
              lines.push(`  From: ${m.from}`)
              lines.push(`  To: ${m.to}`)
              lines.push(`  Subject: ${m.subject}`)
              if (m.agentId) lines.push(`  X-Agent-ID: ${m.agentId}`)
              if (m.inReplyTo) lines.push(`  In-Reply-To: ${m.inReplyTo}`)
              lines.push(includeBody ? `  Corpo:\n${indent(m.text)}` : `  Anteprima: ${m.snippet}`)
              lines.push(``)
            }
            if (markedCount > 0) lines.push(`Segnati come letti: ${markedCount}.`)
            else if (!args.mark_seen) lines.push(`I messaggi NON sono stati segnati come letti (imposta mark_seen=true se vuoi che lo faccia).`)
            return { output: lines.join("\n") }
          } catch (e: any) {
            return {
              output: `Errore IMAP su "${folder}": ${redactSecrets(String(e?.message || e), cfg.pass)}\nSuggerimento: per Gmail abilita IMAP in https://mail.google.com/mail/#settings (la password per app copre sia invio sia lettura).`,
            }
          } finally {
            try {
              lock?.release()
            } catch {}
            try {
              await client.logout()
            } catch {}
          }
        },
      }),

    },
  }
}

export default AgentMailPlugin

/**
 * Superficie interna per test automatici (nessuna rete, nessun invio).
 *
 * NON è un export separato del modulo. opencode scorre TUTTI gli export e, per
 * ognuno che non è una funzione plugin, solleva "Plugin export is not a
 * function" (logica `lk`/`dk` del loader di opencode 1.18.x). Un
 * `export const __testing = {...}` renderebbe quindi il plugin INCARCICABILE,
 * in silenzio: zero tool e nessun errore in UI. Bug realmente verificato.
 * Per questo è una PROPRIETÀ della funzione plugin: `AgentMailPlugin.__testing`.
 */
type Testing = {
  getSmtpConfig: typeof getSmtpConfig
  loadIdentity: typeof loadIdentity
  evaluateGate: typeof evaluateGate
  buildFrom: typeof buildFrom
  buildHeaders: typeof buildHeaders
  buildSmartSignature: typeof buildSmartSignature
  escapeHtml: typeof escapeHtml
  sanitizeHeaderValue: typeof sanitizeHeaderValue
  redactSecrets: typeof redactSecrets
  maskEmail: typeof maskEmail
  sanitizeStore: typeof sanitizeStore
  storeKey: typeof storeKey
  getGitInfo: typeof getGitInfo
  getProjectName: typeof getProjectName
  shortSessionID: typeof shortSessionID
  hasSentBefore: typeof hasSentBefore
  markSent: typeof markSent
  checkRateLimit: typeof checkRateLimit
  bumpRateLimit: typeof bumpRateLimit
  getImapConfig: typeof getImapConfig
  parseInboxMessage: typeof parseInboxMessage
  decodeMimeWords: typeof decodeMimeWords
  belongsToAgent: typeof belongsToAgent
  isReplyToUs: typeof isReplyToUs
  isSelfSent: typeof isSelfSent
  recordSentId: typeof recordSentId
  sentIdsFor: typeof sentIdsFor
  MAX_SCAN: number
  htmlToText: typeof htmlToText
  setImapFactory: (fn: ImapClientFactory) => void
  resetRateLimit: () => void
  setTransportFactory: (fn: TransportFactory) => void
  getLastSmtpDiagnostics: () => string[]
  checkRecipients: typeof checkRecipients
  extractAddresses: typeof extractAddresses
  isGoogleImapHost: typeof isGoogleImapHost
  isResendHost: typeof isResendHost
  hasAmbiguousRecipientSyntax: typeof hasAmbiguousRecipientSyntax
  getLastImapDiagnostics: () => string[]
  paths: { IDENTITY_PATH: string; SESSION_STORE_PATH: string; STATE_DIR: string }
}

const testing: Testing = {
  getSmtpConfig,
  loadIdentity,
  evaluateGate,
  buildFrom,
  buildHeaders,
  buildSmartSignature,
  escapeHtml,
  sanitizeHeaderValue,
  redactSecrets,
  maskEmail,
  sanitizeStore,
  storeKey,
  getGitInfo,
  getProjectName,
  shortSessionID,
  hasSentBefore,
  markSent,
  checkRateLimit,
  bumpRateLimit,
  getImapConfig,
  parseInboxMessage,
  decodeMimeWords,
  belongsToAgent,
  isReplyToUs,
  isSelfSent,
  recordSentId,
  sentIdsFor,
  MAX_SCAN,
  htmlToText,
  setImapFactory: (fn: ImapClientFactory) => {
    imapFactory = fn ?? realImapFactory
  },
  resetRateLimit: () => {
    try {
      if (fs.existsSync(RATE_STORE_PATH)) fs.unlinkSync(RATE_STORE_PATH)
    } catch {}
  },
  // solo test: sostituisce la factory del transport per verificare
  // il percorso di invio senza aprire connessioni
  setTransportFactory: (fn: TransportFactory) => {
    transportFactory = fn ?? createTransporterImpl
  },
  getLastSmtpDiagnostics: () => lastSmtpDiagnostics,
  checkRecipients,
  extractAddresses,
  isGoogleImapHost,
  isResendHost,
  hasAmbiguousRecipientSyntax,
  getLastImapDiagnostics: () => lastImapDiagnostics,
  paths: { IDENTITY_PATH, SESSION_STORE_PATH, STATE_DIR },
}

// Espono la superficie di test come PROPRIETÀ della funzione plugin, non come
// export: vedi il commento sopra e test/loader.compat.test.mjs.
Object.assign(AgentMailPlugin, { __testing: testing })

export type AgentMailPluginWithTesting = typeof AgentMailPlugin & { __testing: Testing }
