# 📬 opencode-agent-mail

### One inbox, many agent identities. Every email says who sent it and why.

> Give each agent its own display name and traceable headers, while sharing a single Gmail.
> **Read [What this does NOT protect you from](#what-this-does-not-protect-you-from) before you
> connect a real mailbox.** This plugin sends and reads mail *as you*, using your credentials.

⚠️ **Before you install this, read the [risk section](#-risks-read-this-first).** An AI agent that
can send email as you, and can read your inbox, is a significant capability — not a small
convenience.

---

## 🚨 Risks: read this first

**This is not a security product.** It is a convenience layer that makes an agent's outbound mail
self-describing. Please understand what that means before you point it at a real account.

- **The Context Gate is transparency, not authorization.** The first send of a session must carry
  a `reason`, and the agent must pass `confirm: true`. **The agent supplies both values.** There is
  no dialog, no prompt, no permission hook. An agent that wants to send simply sets `confirm: true`.
  The gate makes the *recipient's* life easier; it does not stop you from being surprised.
- **An App Password is not "just send".** It grants full IMAP **and** SMTP access to the mailbox.
  With `mail_inbox`, an agent holding that credential can read your 2FA codes, password resets and
  bank alerts — and those messages land in a model provider's context.
- **Prompt injection is a real risk here.** `mail_inbox` puts text written by strangers into the
  agent's context. Combined with `mail_send`, a malicious email can attempt to instruct an agent to
  forward data elsewhere. There is no allowlist and no dry-run in the path by default.
- **Every recipient sees your metadata.** The signature contains the agent name, the model, the
  project name, the git branch, the **absolute local filesystem path**, the hostname, and the OS.
  On Windows that reveals your OS username, which is often your email local-part.
- **Sending from a consumer Gmail is tolerated by Google, not granted by Google.** Volume limits
  are enforcement thresholds, not an allowance. Accounts used for automated mail can be suspended.
  A domain you own (Resend, SES, Mailgun) is the responsible path for anything non-trivial.

### Do this before anything else

```env
# 1. Restrict who may receive mail. OFF by default; turn it on.
MAIL_ALLOWED_RECIPIENTS=you@yourdomain.com

# 2. Cap runaway agents.
MAIL_MAX_PER_HOUR=10

# 3. Use mail_send(dry_run: true) to see exactly what would be sent.
```

Without an allowlist, an agent can email **anyone** from your address. This is the single most
important setting in the project.

---

## What this does NOT protect you from

| You might assume | Reality |
|---|---|
| "The gate protects my reputation" | It does not. The agent sets `confirm: true` itself. |
| "It's a multi-tenant identity platform" | It is a `From:` display name plus four custom `X-` headers and an HTML footer. No tenants, no isolation, no server. |
| "The identity is verified" | Nothing verifies it. Any sender can put any `X-Agent-ID` in a header. |
| "It's private to me" | One mailbox. `mail_inbox(only_mine: false)` reads the whole mailbox, and the `X-Agent-ID` filter is forgeable. |
| "Nobody can remove the signature" | True, and that is a downside: you cannot disable it. See [Privacy](#privacy-of-the-signature). |

---

### Honest scope

You run several OpenCode instances — a laptop, a server, a teammate's PC — and want each agent to
be recognisable in the mail it sends.

**A useful approach:**
- **One Gmail** → **distinct identities** via `From:` display name and `X-Agent-*` headers
- `From: "Culture Agent PC" <box@gmail.com>` → `X-Agent-ID: agent-pc-01`
- Same inbox, filterable, with the reason for each send visible to the recipient

**What it is:** ~1,700 lines of Nodemailer glue plus an IMAP reader. **What it is not:** a platform,
a tenant system, or anything that authenticates an agent.

---

## ✨ Why you might want it

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
- **ONE Gmail** → **distinct identities**
- `From: "Culture Agent PC" <box@gmail.com>` → `X-Agent-ID: agent-pc-01`
- `From: "Agent Server Prod" <box@gmail.com>` → `X-Agent-ID: agent-server-02`
- Same inbox. Distinct sender names. Filterable.

---

## ✨ What it actually does

| Without it | With it |
|-----------|---------|
| `noreply@domain.com` — who is this? | `Culture Agent PC (agent-pc-01) · husky-vs-cats [main]` — the recipient can tell |
| Email with no context | First send in a session must carry a `reason`, which is shown in the signature |
| Plain footer | Signature auto-injects Agent + Model + Session + Project + Branch + Host + Timestamp + Reason |
| Domain required | Free Gmail SMTP now; switch provider with one env var |
| Secrets in repos | Identity in a git-safe JSON file, secrets in env |

### The context gate — transparency, not a lock

The first email of every session must include a `reason`. Both `reason` and `confirm: true` come
from **the agent**, so this is a prompt the agent fills in, not a permission you hold.

```ts
// first send without a reason: blocked, and told what to add
mail_send({ to: "you@example.com", subject: "Done", html: "<p>done</p>" })
// → ⛔ BLOCCATO: mancano reason non vuoto e confirm=true.

// with a reason: sent, and the reason is visible to the recipient
mail_send({
  to: "you@example.com",
  subject: "Build done",
  html: "<p>3 tasks OK</p>",
  reason: "End-of-task update for husky-vs-cats",
  confirm: true,
})
// → Email inviata ✔ From: "..." <...> → To: you@example.com | ...
```

**What it buys you:** the recipient always knows who sent the mail and why.
**What it does not buy you:** protection from an agent that decides to send.

Preview first, send later:

```ts
mail_send({ to: "new@example.com", subject: "Hi", html: "<p>…</p>", dry_run: true })
// → full preview: From, To, Cc, Bcc, subject, allowlist verdict, body, signature.
//   Nothing is sent and the session stays locked.
```

After the first confirmed send, later sends in the same session do not re-prompt.

### The signature — and its privacy cost

Every email ends with a signature containing the agent, model, session, project, git branch,
**your absolute local path**, and hostname.

```
┌─────────────────────────────────────────────────┐
│ 🤖 Culture Agent PC · agent-pc-01               │
│    box@gmail.com via OpenCode Agent Mail        │
├─────────────────────────────────────────────────┤
│ 🧠 Model    anthropic/claude-sonnet-4
│ 💬 Session  a1b2c3d4 · agent: main              │
│ 📁 Project  husky-vs-cats [main]                │
│ 🏠 Host     Your-PC · win32 x64                  │
│ 📝 Reason   Daily report requested by owner      │
├─────────────────────────────────────────────────┤
│ -- Your Agent | OpenCode                         │
│ Sent via OpenCode Agent Mail                    │
│ ID: agent-pc-01 · 2026-08-27T12:33Z              │
└─────────────────────────────────────────────────┘
```

#### Privacy of the signature

The signature **cannot be disabled** (there is no opt-out flag), and the absolute local path and
hostname go to **every** recipient. If you write to people outside your team, review
`mail_preview_signature` first. Do not use a consumer Gmail you would mind losing.

Filtering headers: `X-Agent-ID`, `X-Agent-Session`, `X-Agent-Model`, `X-Agent-Host`

> Gmail does not support searching custom headers from the normal search box. Use a filter with
> the **"Has the header"** condition (Filter mail → Advanced → `X-Agent-ID` contains `agent-pc-01`),
> or filter on the `From` display name, which *is* searchable.
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

Install the runtime dependencies where OpenCode resolves plugins. **`mail_inbox` needs `imapflow`;
without it, only sending works.**

```bash
cd ~/.config/opencode
npm install nodemailer imapflow
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
# → identity + SMTP config + gate state, no network I/O

mail_send to="your.personal@gmail.com" subject="It works" html="<p>Hello</p>" dry_run=true
# → full preview of the message, nothing sent

mail_send to="your.personal@gmail.com" subject="It works" html="<p>Hello</p>" reason="First send test" confirm=true
# → Email inviata ✔ ... and you receive it
```

**Done.** Restart OpenCode to load the plugin, then try the `dry_run` preview before a real send.

---

## 🔄 Add it to more machines

```bash
# New machine
git clone https://github.com/CultureDigitali/opencode-agent-mail.git
cd opencode-agent-mail && npm ci && npm run build

mkdir -p ~/.config/opencode/plugins ~/.config/opencode/skills
cp dist/index.js ~/.config/opencode/plugins/agent-mail.ts
cp -r skills/agent-mail ~/.config/opencode/skills/
cd ~/.config/opencode && npm install nodemailer imapflow

# New identity — same mailbox, different sender name.
# Give each machine its own agent_id so replies stay attributable.
cat > ~/.config/opencode/agent-identity.json <<'JSON'
{
  "agent_id": "agent-server-02",
  "display_name": "Agent Server Prod",
  "email": "box@gmail.com"
}
JSON

# Same secrets, same inbox
export GMAIL_USER=box@gmail.com
export GMAIL_APP_PASSWORD=abcdefghijklmnop
```

Filter in Gmail: create a filter with **"Has the header"** → `X-Agent-ID` contains `agent-server-02`

---

## 🔀 Free today, pro tomorrow — zero migration

| Stage | Config | Cost |
|-------|--------|------|
| **Now** | Gmail SMTP (`smtp.gmail.com:587`) | 0€ — but Google *tolerates*, not *grants*, this. Suspension is the failure mode. |
| **Later** | `MAIL_PROVIDER=resend` + `RESEND_SMTP_PASS` | Your own domain: better deliverability and reputation isolation |

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
  to: "you@example.com",             // default: MAIL_TO
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

> **Security:** the Gmail password fallback is accepted **only** for Google IMAP hosts. Setting
> `IMAP_HOST` to anything else with Gmail credentials is refused, so a `.env` from a cloned project
> cannot ship your App Password to a third party. Non-Google hosts need their own
> `IMAP_USER`/`IMAP_PASS`. `imapflow` must be installed.

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
| **`MAIL_ALLOWED_RECIPIENTS`** | **Allowlist of permitted recipients, enforced on to/cc/bcc. `OFF` by default — set it first.** | none (all allowed) |
| `MAIL_TO` | Default recipient when `to` is omitted | identity email |
| `IMAP_USER` / `IMAP_PASS` | IMAP credentials for `mail_inbox`. Google hosts only accept Gmail credentials | falls back to `GMAIL_USER` / `GMAIL_APP_PASSWORD` |
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
├── agent-identity.json           ← your identity (git-safe, but still yours)
├── agent-mail-sessions.json      ← per-session gate state
├── agent-mail-ratelimit.json     ← hourly counters (only if MAIL_MAX_PER_HOUR > 0)
├── agent-mail-sent-ids.json      ← Message-IDs we sent, to recognise replies
└── plugins/agent-mail.ts         ← the plugin
```

The plugin is a **single file** (`src/index.ts`, ~1,700 lines). The responsibilities below are
logical modules inside that one file, not separate files:

| Responsibility | Where | What it does |
|---|---|---|
| Identity | `loadIdentity()` | env-over-file precedence, per-field validation |
| Provider selection | `getSmtpConfig()` / `getImapConfig()` | explicit `MAIL_PROVIDER`, credential/host guards |
| Signature | `buildSmartSignature()` | agent, model, session, project, branch, host, reason |
| Session store | `loadStore` / `saveStore` / `hasSentBefore` / `markSent` | atomic writes, per-identity keys |
| Gate | `evaluateGate()` | shared by `mail_send` and `mail_report` |
| Recipients | `checkRecipients()` | `MAIL_ALLOWED_RECIPIENTS` allowlist |

Signature pulls:
- **Identity** → `agent-identity.json`
- **Model** → `chat.params` / `chat.message` hooks (`providerID` + model `id`)
- **Session** → `ToolContext.sessionID` + `agent` name
- **Project** → `worktree`/`directory` + `.git/HEAD` branch (also handles `.git` files for linked worktrees)
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

MIT © 2026 Culture Digitali.

---

### In short

An agent sends a report. Instead of `noreply@`, the recipient sees *"Culture Agent PC
(agent-pc-01), running claude-sonnet-4 on husky-vs-cats [main], and I'm writing because you asked
for a daily report"* — plus a reason the agent had to supply. One mailbox, several distinguishable
agents.

That is the whole idea, and it is a small idea. It is worth using if you want agent mail to be
self-describing. It is not worth installing on a mailbox you would mind losing, and the
[risks section](#-risks-read-this-first) is not optional reading.
