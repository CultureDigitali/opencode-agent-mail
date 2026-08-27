---
name: agent-mail
description: One inbox. Infinite identities. Send traced, signed reports via Gmail/Resend with per-session context gate.
---

# Agent Mail — One inbox. Infinite agents.

**Ogni agente merita un'identità. Anche se condividono la stessa email.**

Questo skill insegna all'agente QUANDO e COME usare `opencode-agent-mail` — il plugin che trasforma una singola Gmail in un esercito di agenti tracciati.

## 🧠 Filosofia: context gate al primo invio

Al **primo invio in ogni sessione/chat**, il plugin NON invia subito. Chiede:

> **Perché stai mandando questa email? Chi sei in questo momento?**

Perché il destinatario non deve mai ricevere una mail anonima. Deve sapere:
- Chi la manda (agente + modello + sessione)
- Perché la manda (reason esplicito)
- Da dove la manda (progetto + branch + host)

Il gate protegge te e il destinatario dal rumore.

### Flusso

```text
1° mail_send in sessione senza reason+confirm → ⛔ BLOCCATO + preview firma
           ↓
Agente fornisce reason="Report giornaliero richiesto da Pierluigi" + confirm=true
           ↓
✅ Inviata + firma intelligente + marcata come "sessione sbloccata" (prossimi invii liberi)
```

## 🔧 Tools

| Tool | Descrizione |
|------|-------------|
| `mail_send(to, subject, html, text, reason, sender_note, confirm)` | Invio libero con firma. Al 1° invio richiede `reason` + `confirm:true` |
| `mail_report(title, summary, sections, level, reason, confirm)` | Report strutturato (`info/success/warning/error`). `summary` = reason di default |
| `mail_preview_signature(reason, sender_note)` | Anteprima firma senza inviare |
| `mail_status` | Config + verify + stato gate della sessione |
| `mail_verify` | Solo test SMTP |

## ✍️ Quando usare (istruzioni per l'agente)

**DEVI usare `reason` al primo invio:**
```ts
// ❌ SBAGLIATO (verrai bloccato)
mail_send({ to: "pierluigi@gmail.com", subject: "Fatto", html: "<p>task done</p>" })

// ✅ CORRETTO
mail_send({
  to: "pierluigi@gmail.com",
  subject: "Husky vs Cats — Build completata",
  html: "<p>3 task ok, nessun errore.</p>",
  reason: "Aggiornamento fine task richiesto da Pierluigi per progetto husky-vs-cats",
  sender_note: "Sto lavorando come dev su husky-vs-cats, branch main",
  confirm: true
})
```

**Report giornaliero:**
```ts
mail_report({
  title: "Report giornaliero 27/08/2026",
  summary: "3 task completati, 0 errori — husky-vs-cats avanza",
  sections: [
    { heading: "✅ Completati", body: "<ul><li>Plugin mail v2</li></ul>" },
    { heading: "⚠️ Attenzione", body: "<p>Nessuna</p>" },
    { heading: "📅 Next", body: "<ul><li>Deploy</li></ul>" }
  ],
  level: "success",
  confirm: true // summary già vale come reason
})
```

**Anteprima firma:**
```ts
mail_preview_signature({ reason: "Test firma per nuova sessione" })
```

## 🎨 Firma intelligente — cosa vede il destinatario

Ogni email termina con una firma **non rimovibile** che contiene:

```
🤖 Culture Agent PC (culture-agent-pc-01) <cultureagentpc@gmail.com>
🧠 Modello: openrouter/anthropic-claude-sonnet-4
💬 Sessione: a1b2c3d4 · agent: main
📁 Progetto: husky-vs-cats [main] @ C:\...\husky-vs-cats
🏠 Host: Luigi-PC · win32 x64
📝 Motivo: Aggiornamento fine task richiesto da Pierluigi
💬 Nota: Sto lavorando come dev su husky-vs-cats
🕐 27 agosto 2026, 14:33 — 2026-08-27T12:33:00.000Z
```

Headers tracciati: `X-Agent-ID`, `X-Agent-Session`, `X-Agent-Model`, `X-Agent-Host`

## 🆔 Identità exportabile

File: `~/.config/opencode/agent-identity.json`

```json
{
  "agent_id": "culture-agent-pc-01",
  "display_name": "Culture Agent PC",
  "email": "your.agent@gmail.com",
  "signature": "-- Culture Agent PC | OpenCode",
  "instance_host": "Luigi-PC"
}
```

Stessa `email` su 10 istanze → 10 identità diverse via `display_name` + `agent_id`. Secrets restano in env.

**Nuova istanza in 30 secondi:**
1. Copia `src/index.ts` → `~/.config/opencode/plugins/agent-mail.ts`
2. `npm install nodemailer` (o `bun add nodemailer`)
3. Crea nuovo `agent-identity.json` con `agent_id` diverso
4. Stesse `GMAIL_USER`/`GMAIL_APP_PASSWORD` → fatto.

## 🚀 Setup Gmail (2 min)

1. 2FA: https://myaccount.google.com/signinoptions/two-step-verification
2. App Password: https://myaccount.google.com/apppasswords → Mail → copia 16 chars
3. PowerShell:
```powershell
[Environment]::SetEnvironmentVariable("GMAIL_USER", "your.agent@gmail.com", "User")
[Environment]::SetEnvironmentVariable("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop" -replace " ","", "User")
[Environment]::SetEnvironmentVariable("MAIL_TO", "your.personal@gmail.com", "User")
# riavvia OpenCode
```

Dominio futuro? Aggiungi `RESEND_SMTP_PASS` → switch automatico, zero codice.

## ⚠️ Regola d'oro

**Mai inviare senza `reason` al primo messaggio di una sessione.** Il gate esiste per proteggere la tua reputazione. Il destinatario deve capire in 3 secondi perché gli scrivi.
