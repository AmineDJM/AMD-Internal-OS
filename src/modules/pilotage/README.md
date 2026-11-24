# Module `pilotage` — les signaux datés : ne plus perdre ce que les IA produisent (lot « mémoire », 24/11/2026)

La moitié des sorties d'IA n'étaient pas gardées (propositions affichées une fois, caches purgés chaque jour) et le
jugement humain qui suivait n'était jamais mesuré. Ce module est la **seule pièce** qui manquait (recensement des données
IA, §4.2) : une table de signaux datés et clés, que les mécanismes existants remplissent au lieu de jeter.

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : sources, clé d'unicité (`cleDeCible`, `identiteSignal`), traduction des calculs existants en lignes (Voix du terrain, Produits 360, finances), verdict d'une proposition et taux d'acceptation, dimensions dérivées (L3 visite, L9 vente PCH), plan de repointage du graphe d'influence (L4) |
| `api-ecriture.ts` | **Porte étroite des écrivains** : `ecrireSignaux`, `noterProposition`, `noterDecision` — jamais bloquants |
| `api.ts` | **Porte serveur** : tout `api-ecriture` + `lireSignaux` / `lireTauxAcceptation` (Super Admin seul), `instantaneQuotidienSiDu` (tâche `pilotage.instantane`), `repointerInfluence`, `controlerCles`, `dimensionsDesVisites`, `wilayasParDr` |
| `domaine/` | règles pures + tests |
| `infra/` | `ecriture.ts`, `lecture.ts`, `finances.ts` (instantané), `cles.ts` (influence, études de marché), `dimensions.ts` |

- **Table** : `SignalDate` (migration `20270247900000_signaux_dates`) — unique `(source, nature, cle, jour)` : un rejeu le même
  jour réécrit, le lendemain ajoute. Dimensions sans clé étrangère (un historique survit à ce qu'il observe).
- **Écrivains** : `lib/voix-terrain-luna.ts`, `lib/produit-360-luna.ts`, `lib/kpi-luna.ts` + `kpi-actions`, `lib/budget-campagne-luna.ts`
  + `budget-campagne-actions`, `lib/natures-depenses-ia.ts` + `general-means/expense-lines.ts`, `ad-pro` (postes, conseil de pièce),
  `rh` (attestation de travail), `lib/conseil-pieces-ia.ts`.
- **Lit** : `finances` (santé d'enveloppe, trésorerie) et les signaux des finances du pont (`platform/in-process/intelligence`).
- **Pourquoi une table neuve** : `FaitConfirme` décrit l'IDENTITÉ d'une fiche (sujets Personne/Organisation/Produit, attributs
  d'identité) ; `BusinessEvent` raconte des ACTIONS (qui a fait quoi), sans société ni valeur ; `IntelligenceSnapshot` est un
  instantané global à colonnes figées. On reprend leur vocabulaire (PROPOSE → décision, faits datés), pas leurs tables.
- **Contrôle des clés** : `scripts/controle-cles-orphelines.ts` (`--corriger` pour repointer ; rien n'est jamais effacé).
