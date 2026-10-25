# 0006 — Correctif d'urgence et UI générative

> Date : 25/10/2026. Suite à la réanalyse des jalons 3 à 6 (commits `e9c969a3` → `41b2ef0e`).

## Constat

La production Render tournait sur `cd143d3e` : l'ancien assistant avait été remplacé sur `/assistant` par
une action serveur qui détectait les demandes par expression régulière, rejouait le faux modèle des
tests, envoyait un message au premier Super Admin quel que soit le destinataire demandé, et appelait
MiMo sans outils avec l'historique non filtré. Variable `mimo` posée sur Render.

## Décisions (grilling, tour 1)

| # | Décision |
|---|---|
| C1 | Supprimer `mimo` sur Render et redémarrer — **à faire par l'utilisateur** (action refusée par les permissions). |
| C2 | Correctif d'urgence d'abord, déployé ; refonte ensuite, sur `dy` seulement. |
| C3 | La branche de déploiement ne reçoit que le correctif d'urgence, puis rien sans demande explicite. |
| C4 | Production : fournisseur du registre `ai.ts`. MiMo uniquement en local sur `amd_dev_anon` jusqu'au jalon 7 (remplace Q3 « MiMo par défaut »). |
| C5 | Vraie boucle Mastra avec outils pour chaque message ; plus d'expression régulière ni de réponse rapide. Faux modèle réservé aux tests. |
| C6 | Garder l'interface `assistant-beta/`, retirer compteurs et textes inventés. |

## Décisions (grilling, tour 2 — prompt « Generative UI » fourni)

| # | Décision |
|---|---|
| C7 | Les blocs sont **fabriqués par le serveur** depuis les résultats d'outils (protocole `workspace/protocol.ts`). Le modèle écrit le texte et peut seulement **choisir** une présentation pour un résultat d'outil désigné, sans en recopier les valeurs. Le schéma JSON où le modèle remplit `content` est rejeté. |
| C8 | V1 : `text`, `table`, `list` (→ `table`/`people`), `card` (→ `record`/`dossier`), `alert` (→ `alerte`), `chart` (→ `viz`, si un outil rend des chiffres), plus la carte de confirmation. Hors V1 : `calculator`, `form`, `tabs`, `accordion`, `code`, `steps`. |
| C9 | Rendu par `WorkspaceBlocks` (`src/components/chief/workspace/blocks.tsx`) dans l'habillage beta. |
| C10 | Règles gardées du prompt, en français, dans `compileContext` : concision, texte simple pour une question simple, zéro invention, ne jamais prétendre avoir exécuté une action non faite, jamais de HTML/JSX/code exécutable. |

## Correctif d'urgence — contenu

- `/assistant` : ancien assistant restauré (`4c5a3b81`), réservé au Super Admin (`peutVoirAdam`).
- `/assistant/beta` : Super Admin seulement (page ET chaque action serveur).
- `beta/actions.ts` : expressions régulières, faux modèle, appel MiMo, compteurs et textes inventés retirés ; réponse « en cours de refonte ».
- `layout.tsx` : pop-up d'accueil retiré.
- Tests `integration.test.ts` / `role-config.test.ts` : erreurs de type corrigées (`label` manquant, `createdAt` inexistant, `updatedById` manquant). `HEAD` échouait déjà au typecheck complet ; Render ne vérifie pas les tests.

## Décisions (grilling, tours 3 et 4 — corrections de fond)

| # | Décision |
|---|---|
| Q11 | Objet de la page chargé seulement par l'outil de lecture que l'utilisateur pourrait appeler (droit + droits par ligne) ; `donneesObjet` venu du navigateur supprimé. |
| Q12 | Tout ce qui part au modèle passe le filtre de confidentialité (résultats d'outils compris) ; l'affichage suit les droits de l'utilisateur via les blocs. |
| Q13 | Destinataire désigné par son nom, résolu par l'annuaire ; ambiguïté → question, absence → le dire, jamais de défaut. Écriture via `envoyerMessageDirect`. |
| Q14 | Droit `allowed(user)` revérifié au moment de la confirmation. |
| Q15 | Nouvelle migration idempotente : `RESTRICT` au lieu de `CASCADE` sur l'audit ; configuration et audit dans une seule transaction. |
| Q16 | `tone` → consignes ; `enforcedModel` → registre, limité aux modèles configurés ; `confirmationLevel` gardé en base, non affiché en V1. |
| Q17 | Échec de compilation du contexte → refus « service indisponible » + journal. Tests du vrai chemin sur `amd_test`, sans Prisma simulé. |
| Q18 | Section « par rôle » dans `/admin/ai`, Super Admin ; audit (10 dernières) par rôle ; action classée « non exposée à l'assistant » dans `action-registry.ts`. |
| Q19 | `AiSetting.assistantBetaEnabled`, éteint par défaut, règle « lu / offert / rejoué » respectée ; Super Admin seul même allumé. |
| Q20 | Outils V1 : `directory_lookup`, `directory_list`, `regulatory_portfolio`, `regulatory_workload`, `regulatory_knowledge`, `list_my_tasks`, `search_products` (les deux derniers via `executeReadTool`). |
| Q21 | Ordre R1 → R7 ; un commit par étape sur `dy` ; branche de déploiement seulement pour R1, puis sur demande. |

## Révision (25/10/2026, décision de l'utilisateur)

- **C1 annulé** : `mimo` reste sur Render.
- **C4 remplacé** : **MiMo est le modèle par défaut, local et production**, branché dans Mastra via `@ai-sdk/openai-compatible`
  (point d'accès supposé `https://token-plan-ams.xiaomimimo.com/v1`, modèle `mimo-v2.6-flash`, à confirmer).
  Secours : fournisseur du registre `ai.ts` en cas d'échec ou d'appel d'outil invalide.
- Risque accepté par l'utilisateur : données réelles envoyées à un service externe au contrat de données inconnu.
  Garde-fou maintenu : filtre de confidentialité obligatoire sur tout ce qui part au modèle (Q12).
- `amd_dev_anon` abandonnée : l'évaluation MiMo (R7) se fait sur `amd_dev` (identifiants déjà neutralisés), filtre actif.
- Périmètre : uniquement l'Assistant IA.

## Révision de C7 (25/10/2026, prompt « Generative UI » réaffirmé par l'utilisateur)

- Le prompt fourni (`docs/assistant/prompt-systeme-ui-generative.md`) est adopté **tel quel** : le modèle renvoie
  `{ "message", "components" }` et choisit ses composants.
- Garde-fou serveur, tiré des règles du prompt lui-même (« Never fabricate data », « Only use components supported
  by the front end ») : un composant n'est rendu que si son type est pris en charge par l'interface, et ses chiffres /
  lignes doivent provenir des résultats d'outils du même tour ; sinon il est retiré et seul `message` s'affiche.
- La liste montrée au modèle = composants pris en charge (V1 : text, card, list, table, chart, alert).
- Le rendu réutilise `WorkspaceBlocks` (C9) via une correspondance composant → bloc.

## Coordination des agents

- Jalons 3 à 6 construits avec Gemini Flash (Antigravity CLI). Règles communes écrites dans `AGENTS.md` et `GEMINI.md`
  (contenu identique) : travail sur `dy`, jamais de push sur la branche de déploiement sans demande, un seul agent à la fois.

## Révision (25/10/2026) — MiMo seul

- **Aucun modèle de secours** : MiMo uniquement. En cas d'échec ou de dépassement du délai (45 s par tour,
  `MIMO_TIMEOUT_MS`), l'assistant affiche une erreur au lieu de basculer sur un autre fournisseur.
- Clé lue dans `MIMO_API_KEY`, ou `mimo` (nom de la variable déjà posée sur Render).
- **Déploiement** : R1 n'est pas déployé seul (il utilise l'ancien moteur, donc OpenAI). La production passe
  directement à **R1 + R4** (moteur Mastra sur MiMo, filtre de confidentialité actif).
