# Assistant — contexte complet de la phase de cadrage

> Document de reprise : permet de continuer le chantier sans l'historique de la conversation.
> État au 22/10/2026. **Aucun code d'agent n'est encore écrit.** Cette phase = environnement + décisions de conception.

---

## 1. Objectif

Construire **uniquement l'Assistant IA** (pas Adam) de l'ERP *AMD Internal OS* (Adventum Pharma), avec :

1. une **couche de contexte** ;
2. une **couche de rôle**, configurable depuis les **paramètres** de la plateforme ;
3. **Mastra** (ou équivalent) comme cadre d'agent, **MiMo** comme LLM ;
4. les discussions de conception **journalisées** ;
5. développement **en local** sur une copie des données Render.

Le comportement attendu est celui décrit par les documents existants (section 6).

## 2. Ce que le code contient déjà (mesuré)

| Élément | Constat |
|---|---|
| Assistant actuel | `src/lib/assistant.ts` = **7 309 lignes**, + `src/lib/assistant/` (~47 000 lignes au total avec `ai.ts`) |
| Boucle agent | Claude, streaming SSE, outils de lecture exécutés, outils d'écriture **jamais seuls** → carte de confirmation |
| Rôle (existant) | outils filtrés selon `user.role` (`assistantToolsFor`), mode exécutif `executiveBriefing` / `buildChiefOfStaffContext` |
| Contexte (existant) | dossiers `context/`, `memory-*.ts` ; tables `AssistantThread`, `AssistantMessage`, `AssistantMemoryItem`, `AssistantHotState`, `AssistantEpisode`, `AssistantMemory`, `AssistantProvenance`… |
| Fournisseurs LLM | `src/lib/ai.ts` : registre `bindingFor(role)` Anthropic / OpenAI (`ADAM_MODEL_PROVIDER`). **Aucun Mastra ni SDK d'agent.** Dans `ai.ts`, « rôle » = rôle de **modèle** (qualité/bulk), pas rôle utilisateur |
| Réglages IA | modèle `AiSetting` (ligne `id="global"`) : **interrupteurs booléens uniquement** (`assistantEnabled`, `masterEnabled`…). Aucun prompt ni réglage par rôle |
| Voix | Whisper, `POST /api/assistant/transcribe` |
| Outils Adam | `src/lib/assistant/adam-tools.ts` (1 088 lignes) dans le même dossier |

## 3. Compatibilité Mastra (vérifiée sur npm)

- `@mastra/core` 1.79.0 : **Node ≥ 22.13.0**, peer `zod ^3.25.0 || ^4.0.0`.
- SDK « ai » de Vercel 7.x : Node ≥ 22, zod ≥ 3.25.76 — **pas d'alternative sérieuse qui évite la montée de version**.
- Projet : Node **20.17.0** local, `NODE_VERSION=20` dans `render.yaml`, **zod 3.23.8**, Next 14.2.35, React 18.3.1.
- Compatibilité Mastra ↔ Next 14.2 : **non testée**.

## 4. État de l'environnement local

| Élément | État |
|---|---|
| Branches git | `claude/hopeful-goodall-phd0nb` (d'origine) ; **`checkpoint`** poussée sur GitHub (même commit `5f80e5cd`) ; **`dy`** créée en local, **sans commit, non poussée** |
| Réseau git | SSH (port 22) bloqué → **push en HTTPS** : `git push https://github.com/AmineDJM/Regulatory-Affairs.git <branche>` |
| PostgreSQL | **18.6** installé via winget, service `postgresql-x64-18`, port 5432, superuser `postgres` / `postgres` (local seulement) |
| Base de dev | **`amd_dev`** = copie de la base Render `amd-postgres-k3uc` (5,5 Go, 437 tables, 20 utilisateurs, 461 migrations) |
| Écart connu | 6 politiques RLS d'Adam manquantes (rôles `adam_reader` / `adam_writer` absents en local) — sans effet sur l'assistant |
| `.env` | créé, **ignoré par git** : `DATABASE_URL` (amd_dev), `AUTH_SECRET`, `NEXTAUTH_URL`. Pas de SMTP / S3 / OnlyOffice. **Pas de `ANTHROPIC_API_KEY`** |
| App | `npm run dev` → http://localhost:3000 ; `/login` 200 ; `/assistant` redirige vers `/login` hors session. Premier chargement de page lent (30–40 s, compilation à la demande) |
| `npm install` | fait (avertissements d'audit à examiner plus tard) |

**Attention** : `npm test` écrit en base. Ne jamais le pointer sur `amd_dev` → utiliser `TEST_DATABASE_URL` vers une base `amd_test` à créer.

## 5. Risques identifiés

1. **Données réelles en local** (RH, finance, praticiens) : machine et base à ne pas partager.
2. **Effets de bord** : la copie peut contenir des identifiants de boîtes mail / jetons Google / abonnements push — non encore neutralisés (décision Q15).
3. **Fuite vers MiMo** : service externe, hébergement et contrat de données inconnus (décision Q14).
4. **Token d'API Render** collé dans la conversation : donne accès à ~15 bases, dont plusieurs sans rapport avec le projet. **À régénérer.** Seule `amd-postgres-k3uc` a été touchée. Le token n'est écrit dans aucun fichier.
5. **Montée Node/zod** : peut casser la suite ; `render.yaml` ne change le déploiement qu'à la fusion de `dy`.

## 6. Documents de référence (spécification de l'assistant)

Aucune spec unique : le « doit faire » est réparti.

- `docs/readme/15-intelligence-artificielle-claude-whisper.md` — fonctionnalités, outils, garde-fous, export Excel, liste blanche des réglages, dictée.
- `docs/CHIEF_OF_STAFF_ARCHITECTURE.md` (973 l.) — mode exécutif, **même moteur** que `lib/assistant.ts`, activé par le rôle côté serveur ; capacités, sécurité, limites connues.
- `docs/api/AGENT_API_GUIDE.md` — guide d'un agent qui ne connaît pas l'ERP.
- Hors périmètre (Adam) : `ADAM_PLATFORM_BOUNDARY.md`, `INFORMATION_FABRIC.md`, `ADAM_VOICE_CONTEXT_REPORT.md`, `ADAM_COMMISSIONING.md`.
- Règles de projet : `CLAUDE.md` (frontière client/serveur, `client-bundle-guard.test.ts`, vérification avant commit).

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

## 8. En suspens

- **MiMo** : URL de l'API, nom exact du modèle, clé — seul l'utilisateur les a. L'hypothèse « API compatible OpenAI » est supposée, non vérifiée, de même que la fiabilité sur les appels d'outils.
- **Accord explicite de démarrer** le jalon 1 (dernière question posée).
- **Régénération du token Render.**
- Préparatifs annoncés, non faits : base `amd_test`, base `amd_dev_anon`, neutralisation des identifiants. Le dossier `docs/assistant/decisions/` n'existe pas encore (la commande qui devait le créer a échoué).

## 9. Commandes utiles

```bash
# App locale
npm run dev                       # http://localhost:3000
# Base locale
PGPASSWORD=postgres "/c/Program Files/PostgreSQL/18/bin/psql.exe" -h localhost -U postgres -d amd_dev
# Vérification avant commit (CLAUDE.md)
npm run typecheck && rm -rf .next && npm run build && npm test && npx next lint
# Un test
npx vitest run src/lib/rbac.test.ts -t "libellé"
# Push (SSH bloqué)
git push https://github.com/AmineDJM/Regulatory-Affairs.git dy
# Graphify avant toute modification structurelle
npm run graphify:query -- "assistantToolsFor"
```
