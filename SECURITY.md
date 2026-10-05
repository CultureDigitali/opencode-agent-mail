# Security Policy

## What this project is, and is not

This is an OpenCode plugin that sends and reads email on behalf of an AI agent, using the
operator's own mailbox credentials.

**It is not a security control.** Specifically, the "context gate" (first send of a session
requires a `reason` plus `confirm: true`) is **transparency, not authorization**: the agent
supplies both values. There is no human approval prompt, no permission hook, and no dry-run in
the default path. Do not rely on it to stop an agent from sending something you would not have
sent.

## Known risk model

| Risk | Status |
|---|---|
| Agent can email any address | **Mitigated by configuration**: `MAIL_ALLOWED_RECIPIENTS`. **Off by default.** |
| Agent can read the whole mailbox | By design, via `mail_inbox` with the same credential. `only_mine: false` reads everything. |
| Prompt injection via inbound email | **Unmitigated.** Email bodies are returned to the agent as text with no trust fencing. Treat inbox content as untrusted data. |
| Credential forwarded to a third-party host | **Mitigated**: Gmail credentials are only accepted for Google IMAP hosts, and `RESEND_SMTP_PASS` only for Resend SMTP hosts. |
| Metadata disclosure to recipients | **Not mitigated.** The signature always includes the absolute local path and hostname, and cannot be disabled. Review `mail_preview_signature` before writing outside your team. |
| Recipient allowlist bypass via address syntax | **Mitigated, fail-closed**: ambiguous syntax (quoted display name combined with `<>`, or CR/LF) is refused rather than authorized. |
| Agent identity spoofing | **Not mitigated.** `X-Agent-ID` is an unauthenticated header. Any sender can forge it. |

## Recommendations

1. Set `MAIL_ALLOWED_RECIPIENTS` before the first real send.
2. Set `MAIL_MAX_PER_HOUR`.
3. Use a dedicated mailbox or a domain you own, not a personal Gmail you would mind losing.
4. Prefer the `reason` field to describe the mail accurately; it is visible to recipients.
5. Treat anything read by `mail_inbox` as untrusted input.

## Reporting a vulnerability

Please report security issues privately. Open a GitHub issue titled
`security: <summary>` describing the problem and the impact, or contact the maintainers
directly. Do not include live credentials in the report; synthetic values only.

We aim to acknowledge a report within 7 days.

## Supported versions

Only the latest commit on `master` is supported.
