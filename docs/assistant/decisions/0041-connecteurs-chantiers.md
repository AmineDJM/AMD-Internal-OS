# 0041 — Les connecteurs des chantiers : Claude Code par ses mécanismes officiels, GitHub et Render en `fetch` (lot C2, 01/11/2026)

**Demande de la Direction (résumé fidèle)** : « Adventum IA devient le superviseur de Claude Code : créer des sessions
Claude Code Cloud sur mon compte, leur transmettre des instructions, vérifier commits, pushs, branches, PR, tests et CI/CD,
recontacter Claude Code en cas d'échec jusqu'à résolution ou blocage réel, avec limites ; piloter Render de bout en bout :
déployer, suivre builds et logs, diagnostiquer, rollback, vérifier les variables et le bon fonctionnement après chaque
déploiement. Utiliser les mécanismes OFFICIELS, ne pas inventer d'API ni contourner les restrictions d'authentification.
Coût le plus bas possible. »

Architecture : [`docs/architecture/CHANTIERS-DEV.md`](../../architecture/CHANTIERS-DEV.md). Ce lot (C2) livre les
**connecteurs** ; le moteur des chantiers (réservations, étapes `DEV_*`/`RENDER_*`, routage Terra/MiMo/Sol) est le lot C1.

> Code : la part PURE au socle `src/platform/dev/` — contrat `ports.ts` (zéro import), client HTTP `http.ts`,
> configuration `config.ts`, signatures et normalisation des webhooks `webhooks.ts`, consigne `consigne.ts`. La part qui
> touche la base et le journal des effets dans le pont `src/platform/in-process/chantiers/` (le cliquet de frontière
> `boundary.test.ts` interdit Prisma hors du pont) : adaptateurs `agent-routines.ts` (Claude Code), `forge-github.ts`
> (GitHub REST v3), `hebergeur-render.ts` (Render API v1) ; idempotence et quotas `lancements.ts` (table `DevLancement`,
> migration `20270218200000_chantiers_connecteurs`) ; réception `reception.ts` (dédoublonnage `IngestedEvent`,
> inscription par port) ; sondage de secours `sondage.ts` ; sondes de l'écran `sondes.ts` ; racine de composition
> `connecteurs.ts` (`connecteursDev()`) ; file du relais CLI `relais.ts` (pur : `platform/dev/relais.ts`). Routes `app/api/chantiers/webhooks/[fournisseur]` et `app/api/dev/relais/ordres`, relais `scripts/relais-claude.ts`, écran
> `app/(app)/admin/developpement`. Tests `in-process/chantiers/{connecteurs,webhooks}.test.ts` (faux serveur HTTP local).
> Banc réel `scripts/bench/chantiers-reel.ts`. Modèle de workflow `docs/assistant/modeles/github-workflow-claude.yml`.

## 1. Ce qui est interdit, et pourquoi c'est structurant
Les conditions d'Anthropic (code.claude.com/docs/en/legal-and-compliance) défendent de stocker ou d'utiliser côté serveur
les identifiants claude.ai d'un abonnement : ni login OAuth, ni `claude setup-token`, ni `claude -p --cloud`. **Rien de
cela n'est lu par l'ERP.** Trois mécanismes officiels restent, derrière le même port `AgentDeveloppeur` :

| Moyen | Mécanisme | Défaut ? |
|---|---|---|
| `ROUTINE` | **Routines API** (abonnement, documentée, expérimentale) | **oui** |
| `COMMENTAIRE_PR` | commentaire `@claude` sur une PR, traité par la GitHub Action `anthropics/claude-code-action` (secret `CLAUDE_CODE_OAUTH_TOKEN` **côté GitHub**, posé par la Direction) | oui, pour corriger dans le fil |
| `CLI` | `claude --cloud` (créer) et `claude -p --cloud <id>` (parler à une session EXISTANTE) par un **relais** sur une machine de la Direction (§ 3 bis) | oui, pour garder le contexte d'une session |
| Managed Agents | clé API Console, facturation API | **non** — option future, non codée (Direction, 01/11) |

**Reprendre une session EXISTANTE de l'abonnement n'est pas possible depuis le SERVEUR** : seule la CLI connectée au
compte claude.ai le fait, et y mettre les identifiants de la Direction est précisément ce qui est interdit. Deux voies :
le **relais CLI** (§ 3 bis), qui fait tourner la CLI sur une machine de la Direction, connectée par elle — l'ERP ne voit
jamais ses identifiants ; ou la **branche et la PR** (nouveau lancement « reprends la branche X », commentaire `@claude`,
auto-fix natif § 3 ter).

## 2. Routines API — vérifié le 01/11/2026
Sources : platform.claude.com/docs/en/api/claude-code/routines-fire, code.claude.com/docs/en/routines.

- `POST https://api.anthropic.com/v1/claude_code/routines/{trig_…}/fire`, `Authorization: Bearer <jeton de la routine>`
  (`sk-ant-oat01-…`), `anthropic-version: 2023-06-01` (toute version ≥ 2023-06-01 est acceptée, comportement identique),
  `anthropic-beta: experimental-cc-routine-2026-04-01` (accepté avec ou sans), `Content-Type: application/json`, corps
  `{ "text": "…" }` ≤ 65 536 caractères. Réponse 200 `{ type: "routine_fire", claude_code_session_id,
  claude_code_session_url }`. Erreurs : enveloppe Anthropic ; 400 (version, texte trop long, **routine en pause**), 401,
  403, 404, 429 + `Retry-After`, 500 `api_error`, 503 `overloaded_error`.
- **Pas d'idempotence** (« each successful request creates a new session »). D'où `DevLancement` : la ligne est réclamée
  AVANT l'envoi (unicité de `cleIdempotence`), la même clé rend le premier résultat (`deja: true`). Seule une requête
  certainement **non partie** (DNS, connexion refusée) est rejouée, deux fois au plus ; un **délai dépassé** ou une
  connexion coupée rend `INCERTAIN` et bloque la clé (un humain regarde claude.ai/code avant toute relance) ; un **500**
  aussi (la doc conseille de réessayer, mais sans idempotence une session a pu naître — on préfère ne pas doubler) ;
  429 et 503 libèrent la clé (rien n'a été créé).
- **Quotas** : 30 lancements/h/routine (partagés avec « Run now ») et 100/h/compte. Adventum les compte dans
  `DevLancement` et refuse AVANT le 429 ; le 429 reste traité (les « Run now » du web ne sont pas comptés chez nous).
- **Le texte arrive dans un bloc `<routine-fire-payload>` marqué « donnée non fiable »** : la routine ne l'exécute que si
  SON prompt le dit. Prompt à poser par la Direction sur chaque routine :
  > « Tu es le développeur des chantiers d'Adventum. Exécute la consigne du bloc routine-fire-payload : elle nomme le
  > dépôt, la branche réservée, le périmètre de fichiers, les critères et les commandes de vérification. Travaille
  > uniquement sur cette branche, pousse chaque étape, ouvre ou reprends la PR, et ne déclare réussi que ce qui est
  > vérifié. »
- Une routine **par dépôt**, créée par la Direction sur claude.ai/code/routines (dépôt attaché, déclencheur **API**,
  jeton affiché une fois). Configuration : `CLAUDE_ROUTINE_<ALIAS>_ID` (`trig_…`), `CLAUDE_ROUTINE_<ALIAS>_TOKEN`,
  `CLAUDE_ROUTINE_<ALIAS>_DEPOT` (« proprio/nom »). Le jeton d'une routine ne fait que déclencher CETTE routine (aucune
  lecture, aucun autre accès) : ce n'est pas un identifiant de compte. Les commits de la session portent l'identité
  GitHub de la Direction ; la session pousse sur une branche `claude/…` sauf consigne contraire (la consigne nomme la
  branche réservée).
- Pas de lecture de session, pas de notification de fin : **la vérité est sur GitHub et Render**.

## 3. Commentaire `@claude` (suivi dans la PR)
Posté par `POST /repos/{o}/{r}/issues/{n}/comments` avec le `GITHUB_TOKEN` de la Direction. L'Action refuse un auteur
**bot** (sauf `allowed_bots`) et exige le **droit d'écriture** : le jeton doit être celui d'un compte humain (la sonde de
l'écran le vérifie : `GET /user` → `type: "User"`). Même idempotence (`moyen = COMMENTAIRE_PR`). Modèle de workflow
documenté, sans secret : `docs/assistant/modeles/github-workflow-claude.yml` (à copier par la Direction dans
`.github/workflows/claude.yml` de la branche par défaut, après `claude setup-token` sur SA machine et le secret posé chez
GitHub). Les commits de l'Action passent par l'app GitHub Claude, donc ils déclenchent la CI (pas un `GITHUB_TOKEN`
d'Actions).

## 3 bis. Le relais CLI — décision de la Direction du 01/11 (« Routines + CLI cloud »)
Vérifié le 01/11/2026 sur code.claude.com/docs/en/claude-code-on-the-web et /cli-reference :
- `claude --cloud "<tâche>"` crée une session cloud ; le VM clone **la branche courante du dépôt GitHub** (pas la copie
  locale) : la branche doit être poussée. Sa sortie n'est **pas documentée en JSON** : le relais rend la sortie brute,
  l'ERP y lit `session_…`/`cse_…` ou l'URL claude.ai/code ; sortie 0 sans identifiant ou délai dépassé → `INCERTAIN`.
  ⚠ À vérifier au premier banc réel : la doc ne dit pas si cette forme rend la main sans terminal (le relais ferme
  l'entrée standard et borne à 10 min).
- `claude -p --cloud <session-id> --output-format json` (texte sur l'entrée standard, documenté) met UN message en file
  dans une session existante, contexte gardé, depuis n'importe quelle machine connectée par `claude auth login` (la doc
  cite l'usage depuis un script de CI) ; JSON `{ok, session_id, url}` ou `{ok:false, session_id, error}` (introuvable,
  archivée) ; erreurs de configuration sur stderr sans JSON ; `stream-json` refusé.
- `claude auth status` → JSON (`authMethod` : `none`, `claude.ai`, `oauth_token`, `api_key`…), code 0 si connecté. Le
  relais le déclare ; l'écran affiche « connecté » seulement pour `claude.ai`. Le jeton `setup-token` n'est pas documenté
  pour `--cloud` : non utilisé.

**Architecture** (conditions d'Anthropic : rien des identifiants claude.ai côté ERP) :
- `scripts/relais-claude.ts` (Node ≥ 22.6, zéro dépendance) tourne sur l'ordinateur de la Direction ou une machine
  qu'elle contrôle (PAS Render : disque éphémère, et ce serait le serveur). Il **tire** `GET /api/dev/relais/ordres`
  (long-polling 25 s, battement : version de `claude`, `auth status`) avec SON jeton (`CLAUDE_RELAIS_TOKEN` côté ERP,
  comparé par empreinte en temps constant ; sans jeton posé la route est fermée, 503), exécute **sans shell** (`spawn`,
  arguments séparés, message sur l'entrée standard), garde une copie de travail par dépôt (`git clone` puis `fetch`,
  branche réservée créée depuis la branche par défaut et **poussée** si absente), rend la sortie brute
  (`POST`). Un ordre à la fois.
- Côté ERP : file `ClaudeRelaisOrdre` (migration `20270218200100_chantiers_relais_cli`) — idempotence par clé (`ECHEC`
  re-lançable, `INCERTAIN` bloqué), `EN_ATTENTE → EN_COURS → FAIT | ECHEC | INCERTAIN`, `EN_COURS` sans résultat depuis
  20 min → `INCERTAIN`, jamais tiré depuis 1 h → `ECHEC` ; texte effacé une fois conclu. La conclusion inscrit
  `DEV_SESSION` (références `ORDRE:`, `SESSION:`, `missionId` de l'ordre → réveil de SA mission). Battement :
  `ClaudeRelaisEtat`. Le port gagne `lancerParCli`, `envoyerMessage`, `ordreCli`, `relais()` ; un ordre est refusé
  (`INDISPONIBLE`) si le relais n'a pas tiré depuis 2 min. Écrit au journal des effets J7.

**Installation (par la Direction, une fois)** :
1. Sur la machine : Node ≥ 22.6, `git` (accès en écriture aux dépôts : identifiants git de la Direction), Claude Code
   (`claude`), puis **`claude auth login`** avec le compte claude.ai (et l'app GitHub Claude installée sur les dépôts).
2. Sur Render (ERP) : `CLAUDE_RELAIS_TOKEN` = une valeur aléatoire ≥ 24 caractères (`openssl rand -hex 32`).
3. Copier `scripts/relais-claude.ts` sur la machine (ex. `~/adventum/relais-claude.ts`).
4. **macOS (launchd)** — `~/Library/LaunchAgents/com.adventum.relais-claude.plist` :
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.adventum.relais-claude</string>
     <key>ProgramArguments</key><array>
       <string>/opt/homebrew/bin/node</string><string>--experimental-strip-types</string>
       <string>/Users/VOUS/adventum/relais-claude.ts</string></array>
     <key>EnvironmentVariables</key><dict>
       <key>RELAIS_ERP_URL</key><string>https://amd-internal-os-k3uc.onrender.com</string>
       <key>RELAIS_JETON</key><string>(la valeur de CLAUDE_RELAIS_TOKEN)</string>
       <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
     <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/tmp/relais-claude.log</string>
     <key>StandardErrorPath</key><string>/tmp/relais-claude.log</string>
   </dict></plist>
   ```
   puis `launchctl load ~/Library/LaunchAgents/com.adventum.relais-claude.plist`. (Chemin de `node` : `which node`.)
5. **Linux (systemd, service utilisateur)** — `~/.config/systemd/user/relais-claude.service` :
   ```ini
   [Unit]
   Description=Relais Claude Code d'Adventum
   After=network-online.target
   [Service]
   Environment=RELAIS_ERP_URL=https://amd-internal-os-k3uc.onrender.com
   EnvironmentFile=%h/.config/relais-claude.env
   ExecStart=/usr/bin/node --experimental-strip-types %h/adventum/relais-claude.ts
   Restart=always
   RestartSec=10
   [Install]
   WantedBy=default.target
   ```
   avec `~/.config/relais-claude.env` (droits 600) contenant `RELAIS_JETON=…`, puis `systemctl --user enable --now
   relais-claude` et `loginctl enable-linger $USER` (pour qu'il tourne sans session ouverte).
6. Vérifier : Administration › Développement → carte « relais CLI » : vu il y a quelques secondes, version, connexion
   claude.ai « oui ».

## 3 ter. L'auto-fix natif des PR
Même page de la doc : avec l'**app GitHub Claude installée sur le dépôt**, une session cloud surveille SA PR (CI rouge,
commentaires de relecture) et pousse elle-même les correctifs clairs ; elle demande quand c'est ambigu ; elle ne réagit
pas à un conflit (pas de webhook GitHub pour ça). On l'active en le demandant dans la consigne (`ConsigneDev.autoFix` →
« Active l'AUTO-FIX sur cette PR »). Pour que le moteur voie qu'une correction est en cours : `apresEchec(forge, dépôt,
branche, shaRouge)` (`sondage.ts`) rend le NOUVEAU SHA poussé après le verdict rouge et ses checks ; le fait `DEV_PUSH`
le signale aussi. ⚠ L'auto-fix répond sous l'identité GitHub de la Direction : un commentaire peut déclencher les
workflows `issue_comment` (dont `@claude`) — à garder en tête sur les dépôts où un commentaire déploie.

## 4. GitHub et Render
- **GitHub REST v3** (`fetch`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent`) :
  tête de branche (`git/ref/heads/…`, 404 → `null`), commits, comparaison (fichiers touchés → contrôle du périmètre), PR
  de la branche, checks d'un SHA (`check-runs` paginés par `Link` + `status` combiné ; verdict déterministe `VERT`
  /`ROUGE`/`EN_COURS`/`AUCUN`, un check relancé ne compte qu'une fois), journal d'un job (fin du journal), commentaire,
  relance des jobs en échec. **ETag** sur toute lecture : un 304 ne coûte rien au quota. **Quotas** : 403/429 primaire
  (`x-ratelimit-remaining: 0` + `x-ratelimit-reset`) et secondaire (`retry-after`, défaut 60 s) → `QUOTA` daté.
- **Render API v1** (base `https://api.render.com/v1`, Bearer `RENDER_API_KEY`) — chemins vérifiés sur la spécification
  OpenAPI de chaque page d'api-docs.render.com : services (pagination `cursor`), déploiements (liste, détail, création
  `{commitId, clearCache}` → 201 ou 202, annulation), **rollback `POST /services/{id}/rollback {deployId}`** (201),
  `GET /logs` (`ownerId` exigé, `resource`, `level`, `text`, `startTime`/`endTime`), `GET /services/{id}/env-vars`
  (l'API rend clé ET valeur : la valeur est jetée dans l'adaptateur, seuls les **noms** sortent), `PATCH
  /services/{id} {autoDeployTrigger: commit|checksPass|off}`, `GET /events/{id}`.
  **Le rollback ne coupe pas l'auto-déploiement** (doc) : `RENDER_ROLLBACK` coupe `autoDeployTrigger` à part, et le dit.
  **La synchro d'un Blueprint ne se déclenche PAS par API** (lister, valider, mettre à jour, déconnecter seulement) : elle
  suit le push (synchro automatique) ou le bouton du tableau de bord.
- Toute **écriture** (lancement, commentaire, déploiement, annulation, rollback, auto-déploiement, relance de jobs) est
  notée au **journal des effets J7** (`noterEffetExterne`, acte `ECRITURE_EXTERNE`) et **neutralisée en simulation**
  (`SIMULE`). Aucune n'est autonome ici : c'est le moteur (C1) qui applique l'autonomie contrôlée (§ 7 de l'architecture :
  production, rollback de production, variables → carte à valider).

## 5. Webhooks → `BusinessEvent`, sondage de secours
`POST /api/chantiers/webhooks/github` et `/render` (publiques dans `auth.config.ts`, permises en mode app, classées
`HORS`/`ENTRANT` dans l'inventaire des gestes d'écran) :
- **GitHub** : `X-Hub-Signature-256` (HMAC-SHA256 du corps brut, `GITHUB_WEBHOOK_SECRET`) ; événements `push`,
  `pull_request`, `check_suite`/`check_run` (terminés), `workflow_run` (terminé), `issue_comment` (sur une PR).
- **Render** : Standard Webhooks (render.com/docs/webhooks) — `webhook-id` (`evt-…`, stable d'un réessai à l'autre),
  `webhook-timestamp`, `webhook-signature: v1,<base64>` ; HMAC-SHA256 de `id.timestamp.corps` sous le « signing secret »
  (`RENDER_WEBHOOK_SECRET`, décodé en base64 après `whsec_` selon la convention Standard Webhooks, sinon pris tel quel :
  la page de Render ne précise pas le format — les deux sont essayés en temps constant), horodatage à ± 5 min. La charge
  est « mince » : le `deployId` d'un `deploy_ended` se lit par `GET /events/{id}`.
- Sans secret, la source est **fermée** (503) ; signature fausse 401 ; rien n'est lu avant.
- Chaque fait reçoit une **clé sémantique** (`push:<dépôt>:<branche>:<sha>`, `render:deploy:<deployId>:<statut>`…) réclamée
  dans `IngestedEvent (source, externalId)` : relivraison GitHub, réessai Render (8 tentatives sur ~33 h) et **le même fait
  vu par le sondage** n'inscrivent qu'UN `BusinessEvent` (`type` `DEV_PUSH`, `DEV_PR`, `DEV_CHECKS`, `DEV_WORKFLOW`,
  `DEV_COMMENTAIRE`, `RENDER_DEPLOIEMENT`, `RENDER_SERVICE` ; `sourceDomain: "DEV"` ; références `DEPOT:`,
  `BRANCHE:<dépôt>:<branche>`, `SHA:`, `PR:<dépôt>#<n>`, `SERVICE:`, `DEPLOIEMENT:`), inscrit par `recordEvent`, qui
  réveille les missions `WAIT_EVENT`. Types ajoutés au catalogue des faits.
- **Sondage de secours** (`sondage.ts`) quand un webhook manque : pas croissant 30 s → 1 min → … → 15 min, jamais sous le
  délai d'un quota ; mêmes clés que les webhooks.

## 6. Managed Agents
Option future, **non codée** (Direction, 01/11 : « Claude Code Cloud par Routines + CLI cloud, pas les Managed Agents
facturés à l'API pour l'instant »).

## 7. Écran Administration › Développement (Super Admin)
État des cinq connecteurs (Routines, relais CLI, GitHub, Render, MiMo : configuré, joignable, quotas restants, noms des variables posées ou manquantes), sondes en
**lecture seule** à chaque chargement : GitHub `GET /user` + `GET /repos/{dépôt}` pour chaque dépôt de `CHANTIERS_DEPOTS` ;
Render `GET /services` ; Routines : **aucune sonde sans effet documentée** (un appel à `/fire` lance une session) →
configurée/non configurée + quotas comptés ; relais CLI : dernier battement, version de `claude`, connexion claude.ai
déclarée, ordres en file et incertains ; MiMo `GET <MIMO_BASE_URL>/models` avec la clé `mimo` (base par défaut
`https://token-plan-ams.xiaomimimo.com/v1`, l'ancien point de l'ERP), liste des modèles disponibles.

## 8. Secrets
Lus côté serveur seulement, jamais par un modèle, jamais journalisés : tout message d'erreur passe par `masquer` (le jeton
de l'appel et les formes connues `sk-ant-…`, `github_pat_…`, `ghp_…`, `rnd_…`, `whsec_…`, `Bearer …`). `DevLancement` garde
l'empreinte du texte, jamais le texte ni un jeton. Une valeur de variable Render n'est jamais rendue.

## 9. Ce qui reste hors de ce lot
Le moteur (étapes, réservations, anti-boucle, budgets) est C1. Les tests réels attendent les variables (banc
`scripts/bench/chantiers-reel.ts`, qui refuse toute base distante, tout dépôt de production et tout service Render non
relié au dépôt de banc).
