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
git clone https://github.com/CultureDigitali/opencode-agent-mail.git
cd opencode-agent-mail
npm ci
npm run build
```

Copy plugin (Linux/macOS):

```bash
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/skills
cp dist/index.js ~/.config/opencode/plugins/agent-mail.ts
cp -r skills/agent-mail ~/.config/opencode/skills/
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\opencode\plugins"
New-Item -ItemType Directory -Force "$HOME\.config\opencode\skills"
Copy-Item dist\index.js "$HOME\.config\opencode\plugins\agent-mail.ts"
Copy-Item -Recurse skills\agent-mail "$HOME\.config\opencode\skills\"
```

Install the runtime dependency where OpenCode resolves plugins:

```bash
cd ~/.config/opencode && npm install nodemailer
```

> Working from source: you can copy `src/index.ts` instead of `dist/index.js`, but you
> still need `nodemailer` installed and `@opencode-ai/plugin` available.

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
| **Later** | `MAIL_PROVIDER=resend` + `RESEND_SMTP_PASS` | Resend free tier (100/day), plus your own domain |

The plugin resolves the provider **explicitly and predictably**:

1. If `MAIL_PROVIDER` is set (`gmail`, `resend`, `generic`), that provider is used — and if its
   credentials are missing the plugin refuses to start rather than silently falling back.
2. Otherwise it auto-detects in this order: `GMAIL_USER`+`GMAIL_APP_PASSWORD` → gmail,
   `RESEND_SMTP_PASS`/`SMTP_PASS` → resend, `SMTP_HOST` → generic. If more than one provider is
   configured without `MAIL_PROVIDER`, `mail_status` reports a diagnostic telling you to choose
   explicitly.

> **Important:** setting only `RESEND_SMTP_PASS` does **not** switch a Gmail-configured install.
> Set `MAIL_PROVIDER=resend` as well.

```env
# Day 1 — Gmail
GMAIL_USER=cultureagentpc@gmail.com
GMAIL_APP_PASSWORD=...

# Day 100 — own domain, Resend
MAIL_PROVIDER=resend
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
RESEND_SMTP_PASS=re_xxx
MAIL_TO=you@example.com
# Identities stay identical.
```

### Generic SMTP (self-hosted, corporate relays)

```env
MAIL_PROVIDER=generic
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=utente
SMTP_PASS=password
```

`SMTP_SECURE=true` selects implicit TLS (typically port 465, which is detected automatically);
otherwise the plugin requires STARTTLS and will not send over a plaintext connection.
`SMTP_USER` is required whenever `SMTP_PASS` is set; for a deliberately unauthenticated relay
set `SMTP_ALLOW_ANONYMOUS=true`.

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

### `mail_inbox` — read replies (IMAP)

```ts
mail_inbox({ limit: 10 })                       // unread, replies addressed to this identity
mail_inbox({ only_mine: false })                // whole mailbox, not just this agent's
mail_inbox({ include_body: true, limit: 3 })    // full text instead of snippet
mail_inbox({ mark_seen: true })                 // opt-in: flags messages as \Seen
```

Credentials default to the ones you already use — `IMAP_USER`/`IMAP_PASS`, falling back to
`GMAIL_USER`/`GMAIL_APP_PASSWORD` — so a Gmail App Password covers both sending and reading.
Gmail requires IMAP to be enabled at https://mail.google.com/mail/#settings.

By default `mail_inbox` filters to messages that are replies to what this identity sent (matched
via `In-Reply-To`) or that carry its `X-Agent-ID`, which keeps a shared inbox usable with several
agents. It does **not** mark anything as read unless you pass `mark_seen: true`.

### `mail_preview_signature` · `mail_status` · `mail_verify`

```ts
mail_preview_signature({ reason: "Demo" })
mail_status()            // identity + SMTP + gate state, no network I/O
mail_status({ verify: true })  // opt in to an SMTP connection test
mail_verify()            // explicit SMTP verify only
```

---

## 🆚 Why not just use Resend / Nodemailer directly?

| DIY Nodemailer | Agent Mail |
|----------------|------------|
| You write transport + headers each time | `mail_send` in one line |
| No identity abstraction → same `From` for all agents | Identity file → `From` + `X-Agent-ID` per agent |
| No signature → recipient sees nothing | Smart Signature auto-injected |
| No gate → agents spam silently | Context Gate forces `reason`; `MAIL_MAX_PER_HOUR` caps runaway loops |
| Secrets in code | Secrets in env, identity in git-safe JSON |
| No session tracking | Per-session store, isolated per identity |
| No export story | Copy 2 files + change 1 ID |

**This is not an email wrapper. It's an identity layer.**

---

## 🔧 Environment reference

| Variable | Purpose | Default |
|---|---|---|
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Gmail credentials | — |
| `MAIL_TO` | Default recipient | identity email |
| `MAIL_PROVIDER` | Explicit provider: `gmail` \| `resend` \| `generic` | auto-detect |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_ALLOW_ANONYMOUS` | Generic SMTP | 587 + STARTTLS |
| `RESEND_SMTP_PASS` | Resend API key | — |
| `AGENT_ID` / `AGENT_DISPLAY_NAME` / `AGENT_SIGNATURE` / `AGENT_INSTANCE_HOST` | Identity overrides (take precedence over the JSON file, field by field) | see above |
| `AGENT_MAIL_STATE_DIR` | Where identity + session store live | `~/.config/opencode` |
| `MAIL_MAX_PER_HOUR` | Per-identity hourly send cap, persisted on disk (0 = off) | 0 (off) |
| `IMAP_USER` / `IMAP_PASS` | IMAP credentials for `mail_inbox` | falls back to `GMAIL_USER` / `GMAIL_APP_PASSWORD` |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_SECURE` | IMAP server | `imap.gmail.com:993`, secure |

> **The context gate is transparency, not authorization.** `confirm: true` is supplied by the
> agent, not by you. It forces every email to explain who sent it and why; it does not stop an
> agent from sending something you would not have sent. `MAIL_MAX_PER_HOUR` caps runaway loops and
> is persisted per identity, so it survives plugin reloads on that machine — but it still does not
> aggregate across machines. Treat it as a safety net, not a quota, and review new recipients.

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
- [x] IMAP inbox reading (`mail_inbox`)
- [x] Persistent per-identity hourly rate limit
- [ ] Cron reports (`mail_schedule daily 09:00`)
- [ ] Telegram/Discord bridge (same identity)
- [ ] Dashboard: see all agents, filter by `X-Agent-ID`

PRs welcome. Keep secrets out of PRs.

---

## 🤝 Contributing

```bash
git clone https://github.com/CultureDigitali/opencode-agent-mail
cd opencode-agent-mail
npm ci
npm run typecheck   # tsc --noEmit
npm test            # build + node:test suite, no network
npm run build
```

`npm test` runs a dependency-free `node:test` suite covering provider selection, identity
precedence/validation, the context gate, header sanitization, HTML escaping, session-store
atomicity and legacy migration, the persistent hourly rate limit, and IMAP parsing and filtering.
It performs **no network I/O and sends no email**. CI additionally loads the built plugin and
asserts the context gate blocks an unconfirmed first send, then that it sends once `reason` and
`confirm` are supplied.

**Never commit:** `.env`, `.env.*` (except `.env.example`), `agent-identity.json`,
`agent-mail-sessions.json` — see `.gitignore`.

---

## 📄 License

MIT © 2026 Culture Agent. Use it to give your agents a voice.

---

### The pitch

> **Before Agent Mail**, your agents were ghosts — sending emails without a name, without a reason, without a trace.  
> **After Agent Mail**, every email is a handshake: *“Hi, I'm Culture Agent PC, running claude-sonnet-4 on husky-vs-cats [main], and I'm writing because you asked for a daily report.”*  
> **One inbox. Infinite agents. Zero confusion.**

**Star ⭐ if you believe agents deserve identities too.**
