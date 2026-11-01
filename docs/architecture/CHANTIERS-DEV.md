# Chantiers de développement — Adam supervise Claude Code, GitHub et Render

> Architecture et plan d'intégration (31/10/2026), demandés par la Direction : « je parle à Adventum IA, il organise et
> supervise Claude Code de manière autonome, résout les problèmes et me livre un résultat fonctionnel et vérifié » ;
> Render piloté de bout en bout ; Terra cerveau, MiMo exécutant, Sol raisonnement, Claude Code développeur ; coût le plus
> bas possible ; missions parallèles sans conflit. Vérifié dans la documentation officielle le 31/10/2026 (sources § 9).

## 1. Ce que les fournisseurs permettent RÉELLEMENT (rien d'inventé)

| Besoin | Mécanisme officiel | Ce qu'il fait | Ce qu'il ne fait PAS |
|---|---|---|---|
| Lancer une session Claude Code **sur le compte de la Direction** | **Routines API** — `POST https://api.anthropic.com/v1/claude_code/routines/{trig_…}/fire`, jeton par routine (`sk-ant-oat01-…`), corps `{ text }` ≤ 65 536 car. (expérimental) | crée une session cloud visible sur claude.ai/code, rend `claude_code_session_id` + URL ; facturée sur l'abonnement | lister, lire, relancer une session existante, notifier la fin ; pas de branche par appel (le texte la nomme) ; 30 lancements/h/routine, 100/h/compte, pas d'idempotence |
| Reprendre une session existante, lui parler | `claude -p "…" --cloud <session-id>` — **CLI connectée au compte claude.ai, sur la machine de la personne** | message de suivi en gardant le contexte | **interdit depuis un serveur** : les conditions d'Anthropic défendent de stocker ou d'intermédier les identifiants claude.ai d'un abonnement |
| Suivi dans le fil d'une PR | **GitHub Action `anthropics/claude-code-action`** déclenchée par un commentaire `@claude` (jeton d'abonnement `CLAUDE_CODE_OAUTH_TOKEN` en secret du dépôt — les secrets restent chez GitHub) | corrige sur la branche de la PR, pousse, répond dans la PR ; le fil de la PR porte le contexte | auteur du commentaire : un compte humain avec droit d'écriture (les bots sont refusés sauf `allowed_bots`) |
| Contrôle total (créer, parler, lire, webhook de fin) | **Managed Agents** (bêta, clé API Console, facturation API) | sessions, événements, SSE, webhooks `session.status_idled/terminated` | pas l'abonnement ; montage de dépôt GitHub non vérifié — **option, pas défaut** (coût) |
| Render | **API Render v1** (jeton Bearer) | déployer, suivre, annuler, **rollback** (`POST /services/{id}/rollback`), logs (liste + flux), variables (lire/écrire une à une), services (`autoDeploy`), **webhooks** et événements | **déclencher une synchro Blueprint** (seulement les lister) → synchro automatique au push, ou bouton du tableau de bord |
| MiMo 2.6 Pro | API OpenAI-compatible de Xiaomi ; clé déjà posée sur Render sous `mimo` ; l'ancien code appelait `token-plan-ams.xiaomimimo.com/v1/chat/completions` | exécutant bon marché (1 M de contexte) | URL et identifiant exacts **à sonder** depuis Render (`/v1/models`) avant tout branchement |

**Conséquence assumée** : la source de vérité d'un chantier n'est PAS la transcription d'une session (illisible par API sur
l'abonnement), c'est **GitHub** (branche, commits, PR, checks CI) et **Render** (déploiement, santé, logs). Claude Code
travaille ; Adam vérifie ce qui est vérifiable, de façon déterministe.

## 2. Les rôles (hiérarchie de la Direction) et le routage au moindre coût

| Rôle | Modèle | Quand | Coût indicatif |
|---|---|---|---|
| Cerveau, interface, décisions | **GPT-6.1 Terra** (`gpt-6.1-terra`, effort bas par défaut) | comprendre la demande, découper, choisir la session, juger un résultat NON déterministe | 1 $ / 0,05 $ (cache) / 5 $ le M |
| Exécutant des sous-missions | **MiMo 2.6 Pro** (clé `mimo`) | lire des logs, résumer un diff, extraire l'erreur d'un build, rédiger une consigne technique, analyses, recherches | ≈ 0,4–0,6 $ le M en entrée (relais publics) |
| Raisonnement avancé | **GPT-6.1 Sol** (`gpt-6.1-sol`) | seulement : deux échecs de même signature, conflit fonctionnel, arbitrage d'architecture | 2 $ / 0,10 $ / 10 $ le M |
| Développement logiciel | **Claude Code Cloud** (abonnement) | toute modification de code, tests, commits, PR ; il orchestre lui-même ses sous-agents | inclus dans l'abonnement (plafonds horaires) |

Routeur (pur, testé) : **déterministe d'abord** (statut CI, code HTTP, présence d'un commit, regex d'erreur) → MiMo si un
texte doit être lu ou écrit → Terra si une décision engage la suite → Sol si (et seulement si) la règle d'escalade le dit.
Chaque appel porte `missionId` (journal K8 `ModelCallLog`) → coût par chantier exact.

## 3. Le chantier = une mission du moteur EXISTANT

Pas de second moteur : un chantier est une `Mission` du moteur des travaux (bail, idempotence, reprise après coupure,
réveil rapide, tableau « Missions » K3 en temps réel, sous-missions `parentMissionId`). `kind = "CHANTIER"`, persona `ADAM`.
Nouveaux types d'étape (DSL du plan, compilés et refusés s'ils sortent du catalogue) :

| Étape | Fait | Preuve exigée (déterministe) |
|---|---|---|
| `DEV_LANCER` | lance Claude Code (Routines) avec une consigne précise (rédigée par MiMo, relue par Terra si risquée) : dépôt, branche RÉSERVÉE, périmètre de fichiers, critères d'acceptation, commandes de test | `claude_code_session_id` + URL rendus |
| `DEV_ATTENDRE` | attend un événement GitHub (push sur la branche, PR, `check_suite`) — webhook, sinon sondage à pas croissant | commit nouveau sur la branche réservée |
| `DEV_VERIFIER` | lit GitHub : commits, fichiers touchés DANS le périmètre réservé, PR mergeable, **checks verts sur le SHA de tête** | tous verts, sinon `DEV_CORRIGER` |
| `DEV_CORRIGER` | renvoie le problème à Claude Code : commentaire `@claude` sur la PR (fil = contexte) ou nouveau lancement « reprends la branche X, corrige Y » ; MiMo extrait l'erreur utile des logs CI | même preuve que `DEV_VERIFIER`, bornée (§ 5) |
| `RENDER_DEPLOYER` | déclenche/suit un déploiement (commit donné), sérialisé par service | statut `live` |
| `RENDER_VERIFIER` | santé : `healthCheckPath` 200, routes témoins, logs sans erreur nouvelle ; E2E lourd seulement si le risque le demande | sinon `RENDER_REPARER` ou `RENDER_ROLLBACK` |
| `RENDER_ROLLBACK` | `POST /rollback` vers le dernier déploiement sain + `autoDeploy` coupé jusqu'au correctif (dit) | statut `live` du déploiement visé |
| `RAPPORT` | rend compte (conversation, notification, WhatsApp à la demande) avec liens, SHA, coût réel | — |

**Aucune réussite n'est annoncée sans sa preuve** : la conclusion d'un chantier exige le juge existant (`conclure`) ET les
preuves déterministes ci-dessus.

## 4. Concurrence — réservations avant tout

Table `ChantierReservation` (ressource, clé, mission, expiration, bail) : réservation **atomique** (contrainte d'unicité)
avant de lancer, libérée à la fin, reprise par expiration.

- `BRANCHE:<dépôt>:<branche>` — une branche n'a qu'un chantier ; chaque chantier travaille sur SA branche (`claude/…`).
- `PERIMETRE:<dépôt>:<glob>` — les dossiers déclarés ; deux chantiers aux périmètres qui se recouvrent sont **sérialisés**
  (dépendance), jamais lancés ensemble.
- `MIGRATIONS:<dépôt>` — exclusif : une seule migration en vol par dépôt (nom au-dessus du max figé, ordre).
- `DEPLOIEMENT:<service>` — exclusif : un déploiement à la fois par service ; ERP avant app et worker (migrations).
- **Conflit fonctionnel ≠ conflit Git** : avant tout déploiement, la branche d'intégration (ou `main`) passe la chaîne
  complète (tests, build) sur le SHA EXACT déployé ; deux chantiers fusionnés → revérification ensemble.
- Claude Code garde son orchestration native : Adam lance UNE session principale par chantier ; c'est elle qui
  fan-out ses sous-agents. Adam ne lance plusieurs sessions que pour des chantiers indépendants, réservations faites.

## 5. Coûts et boucles

- Budget par chantier (dollars modèles + nombre de lancements Claude Code + déploiements), plafonds globaux par jour,
  réglables en console ; dépassement → pause `BUDGET_HOLD` (mécanisme existant) et question à la Direction.
- **Anti-boucle** : signature d'échec (étape, check, première ligne d'erreur normalisée). Même signature 2× → Sol une
  fois ; 3× → blocage réel, rapport. Tentatives max par étape (défaut 3), délai croissant.
- Contexte minimal : la consigne d'une session = objectif + périmètre + critères + mémoire technique ciblée (§ 6), jamais
  l'historique complet ; résultats d'outil résumés par MiMo avant d'aller à Terra ; cache de prompt Terra.
- Tableau « Missions » existant : coût réel du chantier (K8), tentatives, réservations, liens session/PR/déploiement.

## 6. Mémoire technique permanente

Table `MemoireTechnique` (clé typée : `depot`, `service`, `branche`, `decision`, `dependance`, `incident`), mise à jour
automatiquement par les événements (webhooks GitHub/Render, fin de chantier) et lue **par extraits** (clé exacte, ≤ 2 k
jetons) dans les consignes. Contenu : dépôts et branches par défaut, services Render (id, type, health, ordre de
déploiement), commandes de vérification du dépôt (lues dans `CLAUDE.md`/`package.json` une fois), incidents et
correctifs, décisions. Évite de réanalyser à chaque chantier.

## 7. Autonomie contrôlée

Autonome : créer une branche, lancer/relancer Claude Code, commenter une PR, relancer un check, déployer en **préproduction**.
Carte à valider (écrite ou ORALE) : fusionner sur `main`, déployer en **production**, rollback de production, toucher aux
variables d'environnement, supprimer (branche, service), migration destructive. Arrêt d'urgence global (interrupteur
missions existant) ; chaque geste au journal des effets (J7) et à l'audit.

## 8. Secrets et sécurité

`RENDER_API_KEY`, `GITHUB_TOKEN` (fine-grained, dépôts listés, contents/pull-requests/checks/actions) ou GitHub App,
`CLAUDE_ROUTINE_<ALIAS>_ID` / `_TOKEN` (une routine par dépôt, créée par la Direction sur claude.ai/code/routines),
`mimo` (déjà posé), secrets des webhooks (`GITHUB_WEBHOOK_SECRET`, Render signé). Jamais lus par un modèle, jamais
journalisés ; une valeur de variable Render n'est jamais lue, seulement son NOM. Super Admin seul.

## 9. Plan d'intégration (lots)

- **L1 — Socle des chantiers** : `kind CHANTIER`, étapes DEV_*/RENDER_* au DSL, réservations, anti-boucle, budgets,
  routeur Terra/MiMo/Sol (adaptateur MiMo OpenAI-compatible + sonde `/v1/models`), mémoire technique, tableau K3 enrichi.
  **Fait (01/11/2026, lot C1, décision [0041](../assistant/decisions/0041-chantiers-socle.md))** — code
  `src/lib/missions/chantiers/`, contrat `src/platform/dev/ports.ts`, branchement des adaptateurs par `brancherPortsDev`.
- **L2 — Connecteurs GitHub et Render** : ports + adaptateurs `fetch`, webhooks signés → `BusinessEvent` → réveil,
  sondage de secours, rollback, santé, logs résumés par MiMo.
- **L3 — Connecteur Claude Code** : port `AgentDeveloppeur` (lancer, relancer, suivre par GitHub) ; adaptateurs
  Routines (défaut, abonnement) et commentaire `@claude` (GitHub Action) ; Managed Agents en option API.
- **L4 — Conversation et voix** : outils de l'Assistant IA / Adam (« lance un chantier », « où en est… », « déploie »,
  « annule »), rapports, artefacts (Drive, WhatsApp K6), oral (K9).

Tests réels : nécessitent sur Render `RENDER_API_KEY`, `GITHUB_TOKEN`, une routine + son jeton ; un dépôt de test dédié
pour les allers-retours de correction automatique (jamais la production pour un banc).

Sources : code.claude.com/docs/en/routines · platform.claude.com/docs/en/api/claude-code/routines-fire ·
code.claude.com/docs/en/claude-code-on-the-web · code.claude.com/docs/en/legal-and-compliance ·
code.claude.com/docs/en/github-actions · platform.claude.com/docs/en/managed-agents/overview ·
api-docs.render.com/llms.txt · render.com/docs/rollbacks.
