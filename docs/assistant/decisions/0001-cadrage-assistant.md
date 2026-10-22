# 0001 — Cadrage de l'Assistant IA (décisions Q1–Q17)

> Date : 22/10/2026. Source : séance de grilling. Contexte complet : [../CONTEXTE_PHASE_ASSISTANT.md](../CONTEXTE_PHASE_ASSISTANT.md)

## 7. Décisions prises (grilling, 3 tours)

| # | Décision |
|---|---|
| Q1 | Agent **entièrement neuf** dans `src/lib/agent/`, à côté de l'ancien, derrière un interrupteur dans `AiSetting`. |
| Q2 | Mastra **dans le processus Next.js**, ajouté à la liste des paquets Node-only de `client-bundle-guard.test.ts`. Mémoire = nos tables `Assistant*`, pas celle de Mastra. |
| Q3 | **MiMo par défaut** via le registre de `ai.ts`, avec **modèle de secours** (Claude/OpenAI). Défaut confirmé après mesure sur ~20 cas réels. |
| Q4, Q12 | Table **`AssistantRoleConfig`**, une ligne par rôle, réglée depuis l'onglet IA de `/admin` : (1) nom et ton, (2) consignes ≤ 2 000 car., (3) outils autorisés — **restriction seulement**, (4) niveau de confirmation — jamais sous le minimum codé pour une action critique, (5) modèle imposé (optionnel). Modifications **tracées** (qui, quand, ancienne valeur). **Le RBAC reste le plafond.** Valeur absente → comportement actuel. |
| Q5 | Moteur + **mode exécutif inclus**. Outils Adam **coupés derrière un drapeau**, pas supprimés. Adam hors périmètre. |
| Q6 | Journal : fichiers de décision dans `docs/assistant/decisions/` **+** skill `recall` en fin de session. |
| Q7 | Cerveau neuf, mais **chaque outil = adaptateur mince** autour de l'action métier existante (celle des écrans). Aucune écriture directe en base. Écritures → carte de confirmation. |
| Q8 | Tranche V1 : lecture annuaire, tâches, fiches Regulatory (produits, dossiers) ; écritures confirmées : **créer une tâche**, **envoyer un message interne**. |
| Q9 | `compileContext(user, thread, page)` déterministe : identité + résumé des droits, config du rôle, historique fenêtré + résumé, mémoire pertinente, page/objet en cours. Budget ≈ **8 000 tokens**, provenance conservée. **Pas de RAG vectoriel en V1** (documents via `document-discovery`). |
| Q10 | Nouvelle page **`/assistant/beta`** (même habillage, carte de confirmation existante), derrière interrupteur. Ancienne page intacte. |
| Q11 | **Mêmes tables** `AssistantThread` / `AssistantMessage`, migration **additive** seulement, colonne marquant le moteur (ancien/nouveau). Migration = SQL manuel idempotent dans `prisma/migrations/` + `db:deploy`. |
| Q13 | **Node 22 + zod 3.25** en **premier commit isolé**, suite complète vérifiée (`typecheck`, build propre `rm -rf .next`, `next lint`, `npm test`). Si ça casse → on s'arrête et on choisit une solution sans Mastra. |
| Q14 | **Jamais** de rémunération, pièce d'identité ni donnée bancaire envoyée à MiMo (filtre dans la couche de contexte). Tests MiMo sur une **copie pseudonymisée `amd_dev_anon`**. Données réelles seulement avec un fournisseur déjà utilisé en production. |
| Q15 | Identifiants mail, jetons Google, abonnements push **neutralisés dans `amd_dev`** avant tout test d'outil ; liste montrée à l'utilisateur. |
| Q16 | Tests en 3 niveaux : (1) Vitest avec **faux modèle** (déterministe) ; (2) ~20 scénarios réels, 2 comptes (Super Admin + droits limités), notés sur bon outil / refus RBAC / non-invention ; (3) même jeu sur MiMo et secours. Base **`amd_test`** séparée. |
| Q17 | Commits courts, **sans `Co-Authored-By`** (ni dans les commits ni dans les push), **pas de PR**, push de `dy` après chaque jalon, en HTTPS. |

### Jalons (un commit sur `dy` chacun)

1. Node 22 + zod 3.25, suite verte.
2. Squelette : Mastra, adaptateur de modèle avec faux modèle, un outil de lecture.
3. Couche de contexte.
4. Configuration par rôle + écran de réglages.
5. Les deux écritures avec confirmation.
6. Page `/assistant/beta`.
7. Scénarios d'évaluation.

Les jalons 1 à 5 se font **sans MiMo** (faux modèle).

