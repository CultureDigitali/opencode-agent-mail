# Review board — opencode-agent-mail

Mandato: stabilire se il progetto è pronto per essere distribuito al grande pubblico.
Regole per tutti i revisori:

- **Iper-critici.** Il default è "non pronto". Si passa a "pronto" solo con evidenza.
- **Mai approvare per cortesia.** Un revisore che non trova nulla deve dirlo esplicitamente
  e indicare l'ipotesi adversaria più forte che ha controllato.
- **Ogni finding** porta: file:riga, severità, evidenza, percorso di falsificazione.
  Niente "potrebbe essere" senza riproduzione o riferimento preciso.
- **Nessuna promessa di convergenza.** "Perfetto" non è uno stato verificabile:
  lo è "nessun difetto materiale noto + rischio residuo documentato".
- Non modificare file. Solo analisi e verifica.

## Ruoli

| Ruolo | Mandato |
|---|---|
| security | Superficie d'attacco, segreti, header injection, disclosure di metadati, supply chain |
| correctness | Comportamento, edge case, race, test che non mordono, regressioni |
| dx-release | Installazione, packaging, documentazione, compatibilità, "pubblicabilità" |
| skeptic | Persona non tecnica che valuta se installerebbe questo software e a chi lo consiglerebbe |

## Round

- Round 1: quattro revisioni indipendenti in parallelo.
- Round 2+: ogni revisore riceve i finding altrui e deve **falsificarli o confermarli**.
  Un finding confermato diventa un bug da correggere; un finding falsificato viene
  archiviato con la prova della falsificazione.
- Uscita: due round consecutivi senza nuovi finding materiali **non risolti**.
