# 📬 opencode-agent-mail

### One inbox. Infinite agents. Every email remembers who you are.

> **The identity layer OpenCode was missing.**  
> Give each agent a soul, a name, a signature — while sharing a single Gmail.  
> No domain. No monthly bill. No anonymous spam. Just traced, beautiful emails.

[![npm version](https://img.shields.io/npm/v/opencode-agent-mail?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/opencode-agent-mail)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-Plugin-7c3aed?style=flat-square)](https://opencode.ai)
[![Gmail Free](https://img.shields.io/badge/Gmail-Free%20SMTP-EA4335?style=flat-square)](https://myaccount.google.com/apppasswords)
[![Resend Ready](https://img.shields.io/badge/Resend-Ready-000000?style=flat-square)](https://resend.com)

---

### You didn't buy 10 Gmails for 10 agents. Why should you?

You run **5 OpenCode instances** — your laptop, your server, your teammate's PC.  
You want reports, alerts, digests. But you don't want 5 inboxes. And you don't want anonymous `noreply@...` that your Gmail marks as spam.

**The old way:**
- One Gmail per agent → chaos, cost, SPF hell
- One Gmail for all agents → anonymous, untraceable, you never know *who* sent what

**The Agent Mail way:**
- **ONE Gmail** (`cultureagentpc@gmail.com`) → **INFINITE identities**
- `From: "Culture Agent PC" <cultureagentpc@gmail.com>` → `X-Agent-ID: culture-agent-pc-01`
- `From: "Agent Server Prod" <cultureagentpc@gmail.com>` → `X-Agent-ID: agent-server-02`
- Same inbox. Different soul. Filterable in one click.

> **We turned a free Gmail into a multi-tenant identity platform.**

---

## ✨ Why this is revolutionary

| Before | After Agent Mail |
|--------|------------------|
| `noreply@domain.com` — who are you? | `Culture Agent PC (culture-agent-pc-01) · husky-vs-cats [main] · claude-sonnet-4` — I know *exactly* who you are |
| Emails with no context | **Context Gate™** — first email in every chat *requires* `reason + confirm`. No more "why did you send this?" |
| Plain text signature | **Smart Signature™** — auto-injects Agent + Model + Session + Project + Branch + Host + Timestamp + Reason |
| Domain required, $20/mo | **Free Gmail SMTP today, Resend tomorrow** — auto-switch, zero code change |
| Copy-paste secrets in repos | **Exportable identity file** — `agent-identity.json` travels, secrets stay in env |

### 🔒 Context Gate™ — The feature that protects your reputation

The first email in **every new chat/session** is **blocked** until the agent explains itself.

```ts
// Agent tries to be sneaky
mail_send({ to: "you@gmail.com", subject: "Done", html: "<p>done</p>" })
// → ⛔ BLOCKED: "Why are you sending this? Who are you right now?"

// Agent learns to be transparent
mail_send({
  to: "you@gmail.com",
  subject: "Husky vs Cats — Build done",
  html: "<p>3 tasks OK</p>",
  reason: "End-of-task update requested by Pierluigi for husky-vs-cats",
  confirm: true
})
// → ✅ SENT + signature shows reason to recipient
```

**Why?** Because the recipient should never guess. And because *you* should never wonder which of your 7 agents woke you at 2am.

After the first `confirm`, the session is unlocked. Subsequent sends are frictionless.

### 🎨 Smart Signature™ — Not a footer. A passport.

Every email ends with a **non-removable, beautifully designed signature** the recipient *actually* wants to see:

```
┌─────────────────────────────────────────────────┐
│ 🤖 Culture Agent PC · culture-agent-pc-01       │
│    cultureagentpc@gmail.com via OpenCode        │
├─────────────────────────────────────────────────┤
│ 🧠 Model    openrouter/anthropic-claude-sonnet-4│
│ 💬 Session  a1b2c3d4 · agent: main              │
│ 📁 Project  husky-vs-cats [main]                │
│ 🏠 Host     Luigi-PC · win32 x64                │
│ 📝 Reason   Daily report requested by Pierluigi │
├─────────────────────────────────────────────────┤
│ -- Culture Agent PC | OpenCode                  │
│ Sent via OpenCode Agent Mail · Reply to talk   │
│ ID: culture-agent-pc-01 · 2026-08-27T12:33Z    │
└─────────────────────────────────────────────────┘
```

Headers for filtering: `X-Agent-ID`, `X-Agent-Session`, `X-Agent-Model`, `X-Agent-Host`  
Gmail filter: `X-Agent-ID:agent-server-02` → auto-label `🤖 Server Prod`

---

## 🚀 2-Minute Quick Start (Free Gmail, No Domain)

### 1. Install

```bash
# Inside your OpenCode config
npm install opencode-agent-mail nodemailer
# or
bun add opencode-agent-mail nodemailer
```

Copy plugin:

```bash
cp node_modules/opencode-agent-mail/dist/index.js ~/.config/opencode/plugins/agent-mail.ts
cp -r node_modules/opencode-agent-mail/skills/agent-mail ~/.config/opencode/skills/
```

Or manually: copy `src/index.ts` → `~/.config/opencode/plugins/agent-mail.ts`

Enable in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file://./plugins/agent-mail.ts"]
}
```

### 2. Create identity (30 seconds)

`~/.config/opencode/agent-identity.json`:

```json
{
  "agent_id": "culture-agent-pc-01",
  "display_name": "Culture Agent PC",
  "email": "cultureagentpc@gmail.com",
  "signature": "-- Culture Agent PC | OpenCode",
  "instance_host": "Luigi-PC"
}
```

> Same `email` on every machine. Different `agent_id` = different identity.

### 3. Gmail App Password (60 seconds)

1. Enable 2FA: https://myaccount.google.com/signinoptions/two-step-verification
2. Create App Password: https://myaccount.google.com/apppasswords → **Mail** → copy 16 chars
3. Set env (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable("GMAIL_USER", "cultureagentpc@gmail.com", "User")
[Environment]::SetEnvironmentVariable("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop" -replace " ","", "User")
[Environment]::SetEnvironmentVariable("MAIL_TO", "your.personal@gmail.com", "User")
# Restart OpenCode
```

`.env` alternative:

```env
GMAIL_USER=cultureagentpc@gmail.com
GMAIL_APP_PASSWORD=abcdefghijklmnop
MAIL_TO=your.personal@gmail.com
```

### 4. Test

In OpenCode chat:

```
mail_status
# → verify: OK

mail_preview_signature reason="Test signature"
# → see the beautiful signature

mail_send to="your.personal@gmail.com" subject="It works 🎉" html="<p>Hello from Agent Mail</p>" reason="First send test requested by Pierluigi" confirm=true
# → 250 OK + you receive it
```

**Done.** You now have an agent with an email soul.

---

## 🔄 Export to 10 instances in 30 seconds

```bash
# New machine
npm install opencode-agent-mail nodemailer
cp plugins/agent-mail.ts ~/.config/opencode/plugins/
cp -r skills/agent-mail ~/.config/opencode/skills/

# Create NEW identity — same email, new soul
echo '{
  "agent_id": "agent-server-02",
  "display_name": "Agent Server Prod",
  "email": "cultureagentpc@gmail.com"
}' > ~/.config/opencode/agent-identity.json

# Same secrets — same inbox
export GMAIL_USER=cultureagentpc@gmail.com
export GMAIL_APP_PASSWORD=abcdefghijklmnop
```

Filter in Gmail: `from:cultureagentpc@gmail.com X-Agent-ID:agent-server-02`

---

## 🔀 Free today, pro tomorrow — zero migration

| Stage | Config | Cost |
|-------|--------|------|
| **Now** | Gmail SMTP (`smtp.gmail.com:587`) | **0€** — 500 mails/day |
| **Later** | Add `RESEND_SMTP_PASS=re_xxx` to env | Still free tier (100/day), but with `agents@yourdomain.com` + perfect deliverability |

The plugin **auto-detects** `GMAIL_APP_PASSWORD` → Gmail, else `RESEND_SMTP_PASS` → Resend. No code change.

```env
# Day 1 — Gmail
GMAIL_USER=cultureagentpc@gmail.com
GMAIL_APP_PASSWORD=...

# Day 100 — You bought yourdomain.com, add 3 DNS for Resend
SMTP_HOST=smtp.resend.com
SMTP_USER=resend
RESEND_SMTP_PASS=re_xxx
MAIL_FROM=agents@yourdomain.com
# Plugin switches automatically. Identities stay identical.
```

---

## 📚 Tools Reference

### `mail_send`

```ts
mail_send({
  to: "pierluigi@gmail.com",          // default: MAIL_TO
  subject: "Build completed",
  html: "<p>3 tasks done</p>",        // or text
  text: "fallback plain text",
  cc: "team@gmail.com",
  bcc: "archive@gmail.com",
  reason: "End-of-task update for husky-vs-cats", // REQUIRED on 1st send in session
  sender_note: "Working as senior dev on husky-vs-cats",
  confirm: true                       // REQUIRED on 1st send
})
```

### `mail_report`

Structured, colored report:

```ts
mail_report({
  title: "Daily Report 27/08/2026",
  summary: "3 tasks done, 0 errors — husky-vs-cats advances",
  sections: [
    { heading: "✅ Done", body: "<ul><li>Agent Mail v2</li></ul>" },
    { heading: "⚠️ Watch", body: "<p>None</p>" }
  ],
  level: "success", // info | success | warning | error
  confirm: true     // summary acts as reason
})
```

### `mail_preview_signature` · `mail_status` · `mail_verify`

```ts
mail_preview_signature({ reason: "Demo" })
mail_status() // shows identity + SMTP + gate state + session
mail_verify() // just SMTP verify
```

---

## 🆚 Why not just use Resend / Nodemailer directly?

| DIY Nodemailer | Agent Mail |
|----------------|------------|
| You write transport + headers each time | `mail_send` in one line |
| No identity abstraction → same `From` for all agents | Identity file → `From` + `X-Agent-ID` per agent |
| No signature → recipient sees nothing | Smart Signature auto-injected |
| No gate → agents spam silently | Context Gate forces `reason` |
| Secrets in code | Secrets in env, identity in git-safe JSON |
| No session tracking | Per-session store `~/.config/opencode/agent-mail-sessions.json` |
| No export story | Copy 2 files + change 1 ID |

**This is not an email wrapper. It's an identity layer.**

---

## 🧬 Architecture

```
~/.config/opencode/
├── agent-identity.json          ← exportable, git-safe
├── agent-mail-sessions.json     ← per-session gate state
└── plugins/agent-mail.ts        ← the brain
    ├── identity.ts   → loadIdentity()
    ├── transport.ts  → Gmail ↔ Resend auto-switch
    ├── signature.ts  → buildSmartSignature(model, session, project, reason)
    └── sessionStore.ts → hasSentBefore(sessionID) ? block : send
```

Signature pulls:
- **Identity** → `agent-identity.json`
- **Model** → `chat.params` / `chat.message` hooks (`providerID/modelID`)
- **Session** → `ToolContext.sessionID` + `agent` name
- **Project** → `worktree`/`directory` + `.git/HEAD` branch
- **Reason** → your `reason` param (visible to recipient)

---

## 🗺️ Roadmap

- [x] Gmail free SMTP + Resend
- [x] Exportable identity + same inbox
- [x] Context Gate™ + Smart Signature™
- [x] Per-session store + model tracking
- [ ] IMAP inbox polling (`mail_inbox` tool) — read replies
- [ ] Cron reports (`mail_schedule daily 09:00`)
- [ ] Telegram/Discord bridge (same identity)
- [ ] Dashboard: see all agents, filter by `X-Agent-ID`

PRs welcome. Keep secrets out of PRs.

---

## 🤝 Contributing

```bash
git clone https://github.com/your-org/opencode-agent-mail
cd opencode-agent-mail
npm install
npm run build
```

Copy `dist/index.js` → your `~/.config/opencode/plugins/` to test.

**Never commit:** `.env`, `agent-identity.json`, `agent-mail-sessions.json` — see `.gitignore`.

---

## 📄 License

MIT © 2026 Culture Agent. Use it to give your agents a voice.

---

### The pitch

> **Before Agent Mail**, your agents were ghosts — sending emails without a name, without a reason, without a trace.  
> **After Agent Mail**, every email is a handshake: *“Hi, I'm Culture Agent PC, running claude-sonnet-4 on husky-vs-cats [main], and I'm writing because you asked for a daily report.”*  
> **One inbox. Infinite agents. Zero confusion.**

**Star ⭐ if you believe agents deserve identities too.**
