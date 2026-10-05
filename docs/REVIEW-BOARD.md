# Review board — opencode-agent-mail

Mandato: stabilire se il progetto è pronto per essere distribuito al grande pubblico.

Regole: default "non pronto" · ogni finding porta file:riga + evidenza + falsificazione ·
nessuna approvazione per cortesia · "perfetto" non è uno stato verificabile.

## Round 1 — 4 revisori indipendenti
**Esito: NOT READY.** 3 blocker, ~20 finding. I due più gravi:

1. **Il plugin non si caricava.** `export const __testing` faceva throw nel loader di
   opencode (`"Plugin export is not a function"`, logica `lk`/`dk`). Zero tool, errore
   silenzioso. **Regressione introdotta dal mio commit precedente**, non preesistente.
2. **Allowlist non applicata al destinatario risolto** (controllava `args.to`, inviava
   `to = args.to || MAIL_TO || identity.email`).
3. `RESEND_SMTP_PASS` consegnato a qualunque `SMTP_HOST`.
4. La documentazione affermava cose false: "multi-tenant identity platform",
   "the feature that protects your reputation", output in inglese mai prodotto,
   diagramma architetturale di 4 file inesistenti, istruzioni su directory inesistenti,
   `imapflow` mai menzionato, badge npm per un pacchetto non pubblicato.

## Round 2 — riesaminatura a cascata
Ogni revisore ha ricevuto i finding altrui. Esito: **3 fix confermati, 7 ancora aperti**,
più bypass nuovi dell'allowlist (parsing divergente da nodemailer).

## Stato alla fine del round 2
- 99 test, typecheck pulito, 0 vulnerabilità npm, CI verde.
- Test verificati **sensibili**: ripristinando i bypass, i test tornano rossi.
- **P1 ancora aperti**: `belongsToAgent` si fida di `X-Agent-ID` falsificabile ·
  prompt injection da `mail_inbox` non contenuta · `mail_report` `sections[].body` HTML
  grezzo senza `text/plain` · metadati PII in firma senza opt-out · `getGitInfo` sale 20
  livelli e può attribuire il branch di un repo padre non correlato · CI con action su tag
  mutabili e scan parziale.

## Verdetto
**Non approvato per distribuzione al grande pubblico.**

Il codice è sensibilmente migliore di quando si è partiti e la verifica è reale, ma restano
due condizioni che non sono risolvibili con la scrittura:

1. **Nessun prompt di approvazione umana.** `confirm: true` lo fornisce l'agente. Un
   allowlist e un dry-run sono strumenti forti, ma non sono un permesso.
2. **Nessun confine di fiducia sul contenuto letto.** `mail_inbox` mette testo di estranei
   nel contesto dell'agente; `mail_send` può scrivere a chiunque senza allowlist
   (di default disattivata).

Il revisore scettico ha riassunto:推广 e blast radius scalano insieme. Va bene per un
gruppo piccolo e consapevole; non per un rilascio virale indiscriminato. Prima servono
i P1 e una revisione di sicurezza indipendente.
