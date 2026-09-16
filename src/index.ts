import { tool, type Plugin } from "@opencode-ai/plugin"
import nodemailer from "nodemailer"
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

// ── Paths ─────────────────────────────────────────────────────────
const IDENTITY_PATH = path.join(os.homedir(), ".config", "opencode", "agent-identity.json")
const IDENTITY_FALLBACK = path.join(__dirname, "..", "agent-identity.json")
const SESSION_STORE_PATH = path.join(os.homedir(), ".config", "opencode", "agent-mail-sessions.json")

// ── In-memory caches (per-process) ────────────────────────────────
const modelBySession = new Map<string, ModelInfo>()
const projectBySession = new Map<string, { directory: string; worktree: string }>()

// ── Identity ──────────────────────────────────────────────────────
function loadIdentity(): AgentIdentity {
  const candidates = [IDENTITY_PATH, IDENTITY_FALLBACK]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"))
        if (raw.agent_id && raw.email) return raw as AgentIdentity
      }
    } catch {}
  }
  return {
    agent_id: process.env.AGENT_ID || "opencode-main",
    display_name: process.env.AGENT_DISPLAY_NAME || "OpenCode Agent",
    email: process.env.GMAIL_USER || process.env.MAIL_FROM || "your.agent@gmail.com",
    signature: process.env.AGENT_SIGNATURE || "-- OpenCode Agent",
    instance_host: os.hostname(),
  }
}

// ── SMTP ──────────────────────────────────────────────────────────
function getSmtpConfig() {
  if (process.env.GMAIL_APP_PASSWORD && process.env.GMAIL_USER) {
    return {
      provider: "gmail" as const,
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    }
  }
  if (process.env.RESEND_SMTP_PASS || process.env.SMTP_PASS) {
    return {
      provider: "resend" as const,
      host: process.env.SMTP_HOST || "smtp.resend.com",
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER || "resend",
        pass: process.env.RESEND_SMTP_PASS || process.env.SMTP_PASS || "",
      },
    }
  }
  if (process.env.SMTP_HOST) {
    return {
      provider: "generic" as const,
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER || "", pass: process.env.SMTP_PASS || "" },
    }
  }
  return null
}

function createTransporter() {
  const cfg = getSmtpConfig()
  if (!cfg) return null
  return nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth })
}

// ── Session Store (per-chat gate) ─────────────────────────────────
function loadStore(): Record<string, SessionRecord> {
  try {
    if (fs.existsSync(SESSION_STORE_PATH)) return JSON.parse(fs.readFileSync(SESSION_STORE_PATH, "utf8"))
  } catch {}
  return {}
}
function saveStore(store: Record<string, SessionRecord>) {
  try {
    fs.mkdirSync(path.dirname(SESSION_STORE_PATH), { recursive: true })
    fs.writeFileSync(SESSION_STORE_PATH, JSON.stringify(store, null, 2), "utf8")
  } catch {}
}
function hasSentBefore(sessionID: string): boolean {
  const store = loadStore()
  return !!store[sessionID]?.sendCount
}
function markSent(sessionID: string, to: string) {
  const store = loadStore()
  const rec = store[sessionID] || { sendCount: 0 }
  rec.sendCount += 1
  rec.lastSentAt = new Date().toISOString()
  rec.lastTo = to
  if (!rec.firstSentAt) rec.firstSentAt = rec.lastSentAt
  store[sessionID] = rec
  saveStore(store)
}

// ── Project / Git helpers ─────────────────────────────────────────
function getProjectName(worktree: string, directory: string): string {
  try {
    const base = worktree || directory || process.cwd()
    return path.basename(base) || "unknown-project"
  } catch {
    return "unknown-project"
  }
}

function getGitInfo(worktree: string, directory: string): { branch: string | null; repo: string | null; dirty: boolean | null } {
  const cwd = worktree || directory
  if (!cwd) return { branch: null, repo: null, dirty: null }
  try {
    const headPath = path.join(cwd, ".git", "HEAD")
    if (!fs.existsSync(headPath)) {
      // try parent traversal up to 3 levels
      let cur = cwd
      for (let i = 0; i < 3; i++) {
        cur = path.dirname(cur)
        if (fs.existsSync(path.join(cur, ".git", "HEAD"))) {
          const content = fs.readFileSync(path.join(cur, ".git", "HEAD"), "utf8").trim()
          const m = content.match(/ref: refs\/heads\/(.+)/)
          return { branch: m ? m[1] : content.slice(0, 7), repo: path.basename(cur), dirty: null }
        }
      }
      return { branch: null, repo: null, dirty: null }
    }
    const content = fs.readFileSync(headPath, "utf8").trim()
    const m = content.match(/ref: refs\/heads\/(.+)/)
    const branch = m ? m[1] : content.slice(0, 7)
    const repo = path.basename(cwd)
    return { branch, repo, dirty: null }
  } catch {
    return { branch: null, repo: null, dirty: null }
  }
}

function shortSessionID(id: string): string {
  if (!id) return "unknown"
  return id.slice(0, 8)
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
  const branchLabel = git.branch ? ` · branch: <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${git.branch}</code>` : ""
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

function buildFrom(identity: AgentIdentity): string {
  const name = identity.display_name.replace(/"/g, "'")
  return `"${name}" <${identity.email}>`
}

function buildHeaders(identity: AgentIdentity, sessionID: string, model?: ModelInfo) {
  return {
    "X-Agent-ID": identity.agent_id,
    "X-Agent-Host": identity.instance_host || os.hostname(),
    "X-Agent-Session": sessionID,
    "X-Agent-Model": model ? `${model.providerID}/${model.modelID}` : "unknown",
    "X-Mailer": `OpenCode-Agent-Mail/${identity.agent_id}`,
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
        },
        async execute(args, ctx) {
          const identity = loadIdentity()
          const transporter = createTransporter()
          if (!transporter) {
            return { output: "SMTP non configurato. Imposta GMAIL_USER + GMAIL_APP_PASSWORD. Vedi mail_status." }
          }
          const sessionID = ctx.sessionID || "unknown-session"
          const to = args.to?.trim() || process.env.MAIL_TO || identity.email
          const from = buildFrom(identity)
          const model = modelBySession.get(sessionID)
          const proj = projectBySession.get(sessionID) || { directory: ctx.directory || globalDirectory, worktree: ctx.worktree || globalWorktree }

          // GATE: primo invio in questa sessione
          const isFirst = !hasSentBefore(sessionID)
          if (isFirst && (!args.reason || args.confirm !== true)) {
            const gate = buildGateMessage({
              identity,
              sessionID,
              agentName: ctx.agent,
              directory: proj.directory,
              worktree: proj.worktree,
              model,
              subject: args.subject,
              to,
              htmlPreview: args.html || args.text,
              reasonProvided: args.reason,
            })
            return { output: gate }
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

          const textBody = args.text ? `${args.text}\n\n${sig.text}` : undefined
          const headers = buildHeaders(identity, sessionID, model)

          try {
            const info = await transporter.sendMail({
              from,
              to,
              cc: args.cc || undefined,
              bcc: args.bcc || undefined,
              replyTo: from,
              subject: args.subject,
              html: args.html || !args.text ? htmlBody : undefined,
              text: textBody,
              headers,
            })
            markSent(sessionID, to)
            // keep project mapping
            projectBySession.set(sessionID, proj)
            return {
              output: `Email inviata ✔ From: ${from} → To: ${to} | Subject: "${args.subject}" | ID: ${info.messageId} | Agent: ${identity.agent_id} | Model: ${model ? `${model.providerID}/${model.modelID}` : "unknown"} | Session: ${shortSessionID(sessionID)} | Provider: ${getSmtpConfig()?.provider}`,
            }
          } catch (err: any) {
            return { output: `Errore invio: ${err.message}` }
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
          const identity = loadIdentity()
          const transporter = createTransporter()
          if (!transporter) return { output: "SMTP non configurato. Vedi mail_status." }

          const sessionID = ctx.sessionID || "unknown-session"
          const to = args.to?.trim() || process.env.MAIL_TO || identity.email
          const from = buildFrom(identity)
          const model = modelBySession.get(sessionID)
          const proj = projectBySession.get(sessionID) || { directory: ctx.directory || globalDirectory, worktree: ctx.worktree || globalWorktree }

          const effectiveReason = args.reason || args.summary
          const isFirst = !hasSentBefore(sessionID)
          if (isFirst && args.confirm !== true) {
            const gate = buildGateMessage({
              identity,
              sessionID,
              agentName: ctx.agent,
              directory: proj.directory,
              worktree: proj.worktree,
              model,
              subject: `[${identity.agent_id}] ${args.title}`,
              to,
              htmlPreview: args.summary,
              reasonProvided: effectiveReason,
            })
            return { output: gate + `\n\nPer questo report, summary e gia un buon reason. Re-invoca con confirm=true per inviare.` }
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

          try {
            const info = await transporter.sendMail({
              from,
              to,
              replyTo: from,
              subject: `[${identity.agent_id}] ${args.title}`,
              html,
              headers: buildHeaders(identity, sessionID, model),
            })
            markSent(sessionID, to)
            projectBySession.set(sessionID, proj)
            return { output: `Report inviato ✔ To: ${to} | "${args.title}" | ${info.messageId} | Agent: ${identity.agent_id} | Model: ${model ? `${model.providerID}/${model.modelID}` : "unknown"}` }
          } catch (err: any) {
            return { output: `Errore report: ${err.message}` }
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
          const identity = loadIdentity()
          const sessionID = ctx.sessionID || "unknown-session"
          const model = modelBySession.get(sessionID)
          const proj = projectBySession.get(sessionID) || { directory: ctx.directory || globalDirectory, worktree: ctx.worktree || globalWorktree }
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
        description: "Mostra configurazione mail, identita, session gate e stato SMTP.",
        args: {},
        async execute(_args, ctx) {
          const identity = loadIdentity()
          const cfg = getSmtpConfig()
          const hasTransport = !!createTransporter()
          const sessionID = (ctx as any)?.sessionID || "n/a"
          const model = sessionID !== "n/a" ? modelBySession.get(sessionID) : undefined
          const store = loadStore()
          const rec = store[sessionID]
          const lines = [
            `Identita agente:`,
            `  agent_id: ${identity.agent_id}`,
            `  display_name: ${identity.display_name}`,
            `  email: ${identity.email}`,
            `  host: ${identity.instance_host || os.hostname()}`,
            `  signature: ${identity.signature || "(nessuna)"}`,
            `  file: ${fs.existsSync(IDENTITY_PATH) ? IDENTITY_PATH : "(fallback env)"}`,
            ``,
            `Sessione corrente:`,
            `  session: ${sessionID} (${shortSessionID(sessionID)})`,
            `  agent: ${(ctx as any)?.agent || "n/a"}`,
            `  model: ${model ? `${model.providerID}/${model.modelID}` : "non ancora tracciato (verra capturato al prossimo messaggio)"}`,
            `  directory: ${(ctx as any)?.directory || globalDirectory}`,
            `  worktree: ${(ctx as any)?.worktree || globalWorktree}`,
            `  progetto: ${getProjectName((ctx as any)?.worktree || globalWorktree, (ctx as any)?.directory || globalDirectory)}`,
            `  branch: ${getGitInfo((ctx as any)?.worktree || globalWorktree, (ctx as any)?.directory || globalDirectory).branch || "n/a"}`,
            `  gate: ${rec ? `gia inviato ${rec.sendCount} mail in questa sessione (primo: ${rec.firstSentAt})` : "PRIMO INVIO BLOCCATO - richiedera reason+confirm"}`,
            ``,
            `SMTP:`,
            `  provider: ${cfg?.provider || "(non configurato)"}`,
            `  host: ${cfg?.host || "-"}`,
            `  port: ${cfg?.port || "-"}`,
            `  user: ${cfg?.auth.user ? cfg.auth.user.replace(/(?<=.{2}).(?=.*@)/g, "*") : "-"}`,
            `  pass: ${cfg?.auth.pass ? "•••••••• (" + cfg.auth.pass.length + " chars)" : "(mancante)"}`,
            `  transporter: ${hasTransport ? "OK" : "NON CONFIGURATO"}`,
            ``,
            `Store: ${SESSION_STORE_PATH} (${Object.keys(store).length} sessioni tracciate)`,
            ``,
            `Uso:`,
            `  mail_send(to, subject, html, reason, confirm=true) -> primo invio richiede reason+confirm`,
            `  mail_report(title, summary, confirm=true) -> usa summary come reason`,
            `  mail_preview_signature(reason="...") -> anteprima firma`,
          ]
          if (hasTransport) {
            try {
              await createTransporter()!.verify()
              lines.push(`  verify: OK`)
            } catch (e: any) {
              lines.push(`  verify: ERRORE - ${e.message}`)
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
            return { output: `SMTP verify FALLITO: ${e.message}` }
          }
        },
      }),
    },
  }
}
