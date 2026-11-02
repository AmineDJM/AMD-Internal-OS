# Module `recettes` — la mémoire procédurale : « comment on fait chez nous » (J10, décision 0028)

Une recette est TIRÉE des circuits réels (dossiers clos et acceptés, au-delà d'un seuil d'occurrences réglable), PROPOSÉE,
puis validée — ou corrigée, rejetée, retirée — par le **responsable du processus** que la Direction désigne. L'Assistant IA
ne lit que la version validée (`recette_pour`). Décision : [`docs/assistant/decisions/0028-recettes.md`](../../../docs/assistant/decisions/0028-recettes.md).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : processus et circuits, contenu, extraction, états, plan tiré d'une recette et ses écarts, correspondance |
| `api.ts` | **Porte serveur** : `proposerLesRecettes(SiDu)`, `lireEcranRecettes`, gestes du responsable, `designerResponsable`, `recettePour` |
| `actions.ts` | clé `recettes-actions` : relire les circuits, valider, corriger, rejeter, retirer, désigner |
| `domaine/` | règles pures (+ tests en millisecondes) |
| `infra/` | `sources.ts` (circuits lus où ils sont écrits), `extraction.ts` (propositions idempotentes), `recettes.ts` (écran, gestes, usage) |
| `ecrans/` | l'écran `/recettes` |

- **Tables** : `RecetteResponsable`, `Recette`, `RecetteVersion`, `RecetteUsage` (migration `20270211090000_recettes`).
- **Lit** (Prisma, sans dette) : `WorkflowInstance`/`WorkflowStepEvent`/`WorkflowStep`, `ValidationRequest`/`ValidationStep`,
  `RecruitmentRequest`/`RecruitmentApproval`, `PieceLien`/`Piece`, `Mission` (travaux J2 réussis), `MissionPlanPattern` (VALIDATED).
- **Consommateurs** : l'Assistant IA (`assistant-ia/infra/recettes.ts` : outil `recette_pour`), la tâche `recettes.extraction`.
- **Bancs** : `recettes.test.ts` (base réelle, corpus semé, faux modèle) — ≥ 10 recettes justes, ≥ 70 % de plans acceptés sans retouche,
  aucune recette servie avant validation, aucune recette hors droits.
