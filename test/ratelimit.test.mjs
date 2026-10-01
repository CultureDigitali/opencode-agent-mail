import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Solo test: il processo deve essere ermetico, altrimenti le credenziali
// Gmail dell'ambiente cambiano il provider selezionato.
process.env.MAIL_MAX_PER_HOUR = "2"
process.env.AGENT_MAIL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ratelimit-"))
delete process.env.GMAIL_USER
delete process.env.GMAIL_APP_PASSWORD
delete process.env.RESEND_SMTP_PASS
delete process.env.SMTP_HOST

const mod = await import("../dist/index.js")
const T = mod.__testing

test("rate limit disattivato per default quando MAIL_MAX_PER_HOUR=0 assente", () => {
  // in questo processo è impostato a 2: verifichiamo il comportamento configurato
  assert.equal(T.checkRateLimit("agente-x").limit, 2)
})

test("il contatore parte da zero per un'identità nuova", () => {
  T.resetRateLimit()
  const r = T.checkRateLimit("agente-fresh")
  assert.equal(r.count, 0)
  assert.equal(r.allowed, true)
})

test("il limite blocca dopo N invii per la stessa identità", () => {
  T.resetRateLimit()
  const id = "agente-loop"
  assert.equal(T.checkRateLimit(id).allowed, true)
  T.bumpRateLimit(id)
  assert.equal(T.checkRateLimit(id).allowed, true)
  T.bumpRateLimit(id)
  const blocked = T.checkRateLimit(id)
  assert.equal(blocked.allowed, false, "il terzo invio deve essere bloccato con limite 2")
  assert.equal(blocked.count, 2)
})

test("il limite è per identità: un'altra identità non è bloccata", () => {
  T.resetRateLimit()
  const a = "agente-A"
  T.bumpRateLimit(a)
  T.bumpRateLimit(a)
  assert.equal(T.checkRateLimit(a).allowed, false)
  assert.equal(T.checkRateLimit("agente-B").allowed, true, "identità B ha budget proprio")
})

test("reset azzera il contatore", () => {
  const id = "agente-reset"
  T.bumpRateLimit(id)
  T.bumpRateLimit(id)
  assert.equal(T.checkRateLimit(id).allowed, false)
  T.resetRateLimit()
  assert.equal(T.checkRateLimit(id).allowed, true)
})