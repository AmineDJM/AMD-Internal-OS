# 07 — Performance et exécution (audit du 27/10/2026)

Périmètre : rendu Next.js 14 (App Router), sondages de la coque, requêtes Prisma chaudes, taille des bundles,
tâches de fond (`src/lib/scheduled.ts`), travail CPU dans le processus web. Base : `claude/hopeful-goodall-phd0nb`
@ `456c8f6`. Branche : `audit/performance-runtime`.

Toutes les mesures ont été prises dans le conteneur d'audit (4 vCPU, Postgres 16 **local**, Node 22) ; les scripts
de mesure sont décrits dans chaque fiche pour être rejoués. Les volumes de production ne sont pas connus (voir
« À vérifier ») : les chiffres absolus sont donc des ordres de grandeur, les **rapports** avant/après sont fiables.

---

## 1. Synthèse

**Note du périmètre : 5,5 / 10.** L'architecture de rendu est saine (aucune page `"use client"`, les grosses
bibliothèques — `xlsx`, `jszip` — sont chargées à la demande, les listes ont des plafonds, les index du chemin
d'authentification sont en place, `pdf-parse` cède la main par page). Ce qui coûte, c'est **ce qui tourne en
permanence** : la coque et ses sondages, et les tâches de fond qui partagent le processus web.

Les trois risques majeurs :

1. **Les sondages de la coque coûtent ~170 requêtes SQL par minute et par onglet ouvert**, dont ~70 % pour
   ré-authentifier (session + résolution complète des droits, 10 requêtes) — et le sondage le plus fréquent
   rapatriait tout l'historique des conversations à cause d'un `take` imbriqué que Prisma n'applique pas en SQL.
   *Corrigé en partie (PERF-01, 02, 04 : −39 %) ; le reste est la session légère (PERF-06).*
2. **La coque charge tout le jeu d'icônes Lucide (~1 400 icônes, 120 kB gzip / 534 kB bruts) sur chaque page**
   via `src/components/ui/icon.tsx` : 38 % des 319 kB gzip de JS que paie la page la plus simple (PERF-05).
3. **Le travail de fond partage la boucle d'événements et le pool de 12 connexions des pages** : un import
   `xlsx` de 20 Mo fige **tout** l'ERP 2,2 s (64 Mo : 7,7 s) ; un balayage qui levait affamait les ~40 suivants
   (corrigé, PERF-03) ; aucun budget par étape. Cible : un processus « worker » séparé (PERF-07, PERF-09).

---

## 2. Constats

| ID | Sévérité | Catégorie | Constat | Effort | Statut |
|---|---|---|---|---|---|
| PERF-01 | HAUTE | performance | `take: 1` imbriqué : le sondage messagerie rapatrie tout l'historique des conversations | S | **CORRIGÉ** `c1ae1b9` |
| PERF-02 | HAUTE | performance | Le badge de la coque (toutes les pages, 12 s) calcule la liste complète du Messenger | S | **CORRIGÉ** `16cfa59` |
| PERF-03 | HAUTE | correction / disponibilité | 7 balayages du battement sans `.catch` : une exception saute les ~40 suivants | S | **CORRIGÉ** `e3cc4be` |
| PERF-04 | MOYENNE | performance | `/api/notifications/poll` sondé par deux composants de la coque (15 s + 20 s) | S | **CORRIGÉ** `db8f8a5` |
| PERF-05 | HAUTE | performance (bundle) | `ui/icon.tsx` importe tout Lucide → +120 kB gzip dans la coque de chaque page | M | PROPOSÉ |
| PERF-06 | HAUTE | performance | Chaque sondage ré-authentifie avec `getAccess` complet (10 requêtes) | M | PROPOSÉ |
| PERF-07 | MOYENNE | performance / disponibilité | `XLSX.read` synchrone dans le processus web : 2,2 s à 7,7 s de gel total | M | PROPOSÉ |
| PERF-08 | MOYENNE | performance | Même motif que PERF-01 en 33 autres endroits (Adam, routines, planifications, corpus…) | M | PROPOSÉ (+ cliquet) |
| PERF-09 | MOYENNE | exploitation | Planificateur dans le processus web : 48 étapes en série, sans budget ni mesure par étape | L | PROPOSÉ (mesure globale ajoutée dans `e3cc4be`) |
| PERF-10 | BASSE | performance | Coque `(app)/layout.tsx` : 6 allers-retours SQL séquentiels, fiche `User` lue 5 fois | S | PROPOSÉ |
| PERF-11 | BASSE | performance | `finances/paiements-a-faire` : 5 lectures indépendantes en cascade | S | PROPOSÉ |

Répartition : **0 CRITIQUE, 5 HAUTES, 4 MOYENNES, 2 BASSES** — 4 corrigés, 7 proposés.

### Budget des sondages de la coque (mesuré)

Compté avec un client Prisma journalisé substitué au singleton (même technique que les tests ajoutés), utilisateur
ordinaire, session sans `sid` (+1 requête avec `sid`) :

| Appel (par onglet) | Fréquence | Requêtes / appel avant | après correctifs | dont authentification |
|---|---|---|---|---|
| `GET /api/messaging/sync` (badge) | 5 / min | 17 | **11** (`?portee=badge`) | 10 |
| `GET /api/notifications/poll` | 7 / min → **4 / min** | 12 | 12 | 10 |
| `POST /api/replay` (rejeu de session) | ≤ 6 / min (si activité) | ~11 | ~11 | 10 |
| **Total hors rejeu** | | **169 req/min** | **103 req/min (−39 %)** | ~90 |
| Cible avec session légère (PERF-06) | | | **~31 req/min (−82 %)** | ~2 |

À 50 onglets ouverts : 8 450 → 5 150 requêtes/min aujourd'hui, ~1 550 avec PERF-06 — sur une base Render
« free » et un pool de 12 connexions partagé avec les pages et le battement.

### Taille des bundles (mesurée)

Build de production propre (`rm -rf .next && next build`), calcul du « First Load JS » gzip par page à partir de
`app-build-manifest.json` (layouts parents inclus) :

| Mesure | Valeur |
|---|---|
| Pages | 297 |
| JS de la coque (layout racine + `(app)/layout`) | **319 kB gzip** |
| Médiane par page | 328 kB gzip (la coque = 97 % de la médiane) |
| Page la plus lourde | 491 kB (`/admin/adoption`, recharts) |
| Chunk le plus lourd de la coque | `1068-*.js` : 534 kB bruts / 120 kB gzip, **1 419 modules, quasi tous des icônes Lucide** |

---

### PERF-01 — `take: 1` imbriqué : le sondage messagerie rapatriait tout l'historique — HAUTE — CORRIGÉ `c1ae1b9`

- **Catégorie** : performance (requête chaude, coût croissant à vie).
- **Preuve** : `src/lib/queries/messaging.ts:320-325` (base) —
  ```ts
  messages: { where: { deletedAt: null }, take: 1, orderBy: { createdAt: "desc" }, include: { sender: …, attachments: { select: { id: true }, take: 1 } } },
  ```
  sous `prisma.conversationMember.findMany(…)`. SQL réellement émis par Prisma 5.22 (journal de requêtes) :
  `SELECT … "Message"."body" … FROM "Message" WHERE ("deletedAt" IS NULL AND "conversationId" IN ($1…$40)) ORDER BY "createdAt" DESC OFFSET $41`
  — **aucun `LIMIT`** : le `take` par parent est appliqué en mémoire. Puis `SELECT … FROM "MessageAttachment" WHERE "messageId" IN (…)`
  avec **un paramètre par message rapatrié**.
- **Scénario réel** : tout utilisateur connecté → `MessagesIndicator` (coque, toutes les pages) appelle
  `/api/messaging/sync` toutes les 12 s → `getSync` → `getConversationSummaries` → l'historique complet de chacune
  de ses conversations (corps compris) traverse le réseau, est désérialisé, puis jeté. Le coût grandit avec
  l'ancienneté de la messagerie, sans borne.
- **Mesure** (40 conversations × 500 messages de 400 car., base locale) : avant **20 000 lignes, ~190 ms par appel**,
  SQL 31,9 ms / 1 336 tampons ; après **40 lignes**, SQL **0,5 ms / 120 tampons** (`EXPLAIN (ANALYZE, BUFFERS)` :
  `Index Scan Backward using "Message_conversationId_createdAt_idx"`, 1 ligne × 40 boucles).
- **Correctif** : `derniersMessages()` — une requête `unnest(ids) CROSS JOIN LATERAL (… ORDER BY "createdAt" DESC LIMIT 1)`
  sur l'index existant `(conversationId, createdAt)`, avec le nom de l'expéditeur et un `EXISTS` sur les pièces jointes.
- **Test** : `src/lib/queries/messaging-sync-perf.test.ts` — client Prisma journalisé à la place du singleton :
  aucune lecture de `Message` sans `LIMIT` (échoue avant, passe après) ; justesse de l'aperçu (message supprimé
  ignoré, expéditeur, pièce jointe, tri, non-lus).

### PERF-02 — Le badge de la coque calculait la liste complète du Messenger — HAUTE — CORRIGÉ `16cfa59`

- **Preuve** : `src/components/layout/messages-indicator.tsx:155,167` (base) sonde `/api/messaging/sync` toutes
  les 12 s, onglet en arrière-plan compris, et ne lit que `data.totalUnread`. `src/app/api/messaging/sync/route.ts:20`
  (base) renvoie `getSync()` : adhésions + conversations + membres + leurs fiches + aperçus + non-lus par conversation.
  Or `getTotalUnread()` (`queries/messaging.ts:295`, une requête `COUNT`) existait déjà et sert la coque au rendu.
- **Scénario** : chaque onglet ouvert sur n'importe quel écran → 5 calculs complets par minute, sérialisés en JSON,
  pour un nombre.
- **Correctif** : `?portee=badge` → `{ totalUnread: getTotalUnread(user.id) }` (même règle : hors sourdine) ;
  présence et battement inchangés ; l'indicateur demande cette portée. Le Messenger garde le flux complet.
- **Mesure** : 17 → 11 requêtes par appel (les 10 restantes = authentification, voir PERF-06).
- **Test** : `src/app/api/messaging/sync/badge.test.ts` (même total que la liste complète ; aucune lecture de
  `Conversation`/`Message`/`MessageAttachment` hors comptage ; l'indicateur demande la portée).

### PERF-03 — Un balayage qui lève affamait les ~40 suivants — HAUTE — CORRIGÉ `e3cc4be`

- **Catégorie** : correction / disponibilité des tâches de fond. Le registre des risques (R12) le mentionnait
  (« early steps lack `.catch` ») sans correctif ni mesure.
- **Preuve** : `src/lib/scheduled.ts:101-103,109,113,114,121` (base) — `await sendDueMeetingReminders();`,
  `await sendDueReminders();`, `await sendDuePayrollNotifications();`, `await runDueRegulatoryJobs();`,
  `await runAnppWatchIfDue();`, `await pollAiBatches();`, `await runIntelligencePulse();` sans `.catch`, dans un
  `try` unique dont le `catch` (`:279`) journalise « run failed » et s'arrête.
- **Scénario réel** : une exception dans le tout premier balayage (délai d'attente du pool — 12 connexions partagées
  avec les pages —, colonne manquante après un déploiement partiel, `notifyUser` qui lève dans le `Promise.all`
  des rappels de réunion) → missions durables, file du site public, alertes de stock, Gmail d'Adam, KPI… **ne
  tournent plus**, à chaque battement, tant que la cause dure. Une seule ligne de journal par minute.
- **Correctif** : chaque appel porte `.catch(journal("<étape>"))` ; un passage complet plus long que
  `SCHEDULER_SLOW_RUN_MS` (30 s par défaut) se signale (`[scheduled] passage lent : N ms`). La forme `await X()`
  des points d'appel est conservée (cinq cliquets existants l'épinglent).
- **Test** : `src/lib/scheduled-isolation.test.ts` — base remplacée par un client qui échoue à chaque appel en notant
  le modèle visé : avant, seul `meeting` est tenté ; après, `reminder`, `payrollEntry`, `employee`… le sont aussi.
  Plus un cliquet de forme : toute instruction `await` du corps du battement porte un `.catch(`.
- **Observation** (même banc) : base en panne, un passage complet dure ~23 s — certains balayages attendent ou
  réessaient plutôt que d'échouer vite ; c'est l'argument de PERF-09 (budget par étape).

### PERF-04 — `/api/notifications/poll` sondé deux fois par onglet — MOYENNE — CORRIGÉ `db8f8a5`

- **Preuve** : `src/components/layout/notification-popup.tsx:32,44` (15 s) et
  `src/components/layout/notification-chime.tsx:76,84` (20 s), montés côte à côte dans `src/app/(app)/layout.tsx:172,174`.
  Même route, même réponse (`{ unread, popups }`) ; le carillon n'en lit que `unread`.
- **Scénario** : 7 appels/min/onglet au lieu de 4, à 12 requêtes chacun (mesuré) → 36 requêtes/min/onglet inutiles.
- **Correctif** : le pop-up reste le seul sondeur et diffuse `amd:notifications-unread` ; le carillon écoute (même
  patron que le badge messagerie ↔ sidebar).
- **Test** : `src/components/layout/notifications-sondage-unique.test.ts` — cliquet général : aucune route d'API
  n'est sondée (`setInterval` + `fetch` GET) par deux composants de `components/layout`.

### PERF-05 — Tout le jeu d'icônes Lucide dans la coque de chaque page — HAUTE — PROPOSÉ

- **Catégorie** : performance (bundle client), surtout sur téléphone (force de vente terrain).
- **Preuve** : `src/components/ui/icon.tsx:2-3` — `import * as Lucide from "lucide-react"; import { icons } from "lucide-react";`
  puis `icons[name]` / `Lucide[name]` : l'accès dynamique par nom empêche tout tree-shaking. Importé par la coque :
  `sidebar.tsx:117,145,212`, `topbar.tsx:167-235`, `command-palette.tsx:143`, `mobile-tabbar.tsx:62-260`,
  `office-pins.tsx:62`. Mesure : chunk `1068-*.js` de la coque = 1 419 modules, 534 kB bruts / **120 kB gzip**.
- **Scénario** : un délégué médical ouvre l'ERP sur son téléphone en 4G → télécharge, analyse et compile ~530 kB de
  JS d'icônes dont la coque utilise une cinquantaine (~53 noms distincts dans `navigation.ts`, `labels.ts`, `nav-tabs.ts`).
- **Correctif concret** (les noms de la coque viennent tous du CODE — `NAVIGATION`, pôles, `labels.ts`,
  `office/apps.ts` — jamais de la base) :
  1. `src/components/ui/icones-coque.ts` : table statique `{ FileCheck2, Building2, … } satisfies Record<string, LucideIcon>`
     (imports nommés → tree-shaking).
  2. `IconeCoque({ name })` lit cette table ; sidebar/topbar/command-palette/mobile-tabbar/office-pins l'utilisent.
  3. Test-cliquet : pour chaque entrée de `NAVIGATION` (pôles, items, onglets), de `labels.ts` et de `OFFICE_APPS`,
     `name in ICONES_COQUE` — un nom oublié échoue en CI au lieu d'une icône vide en production (§118.149).
  4. `ui/icon.tsx` (noms venant de la base : `Conversation.icon`, onglets) reste pour les pages qui en ont besoin,
     chargé par `next/dynamic` ou rendu côté serveur (un Server Component qui passe l'élément déjà rendu).
- **Gain attendu** : −120 kB gzip sur 319 kB de coque (**−38 %**), sur les 297 pages.

### PERF-06 — Chaque sondage ré-authentifie avec la résolution complète des droits — HAUTE — PROPOSÉ

- **Preuve** : `src/lib/session.ts:260` `getCurrentUser()` → `build()` (`:113`) → `userSession.findUnique` (si `sid`)
  + `getAccess()` (`src/lib/rbac.ts:1372`) = `Promise.all` de 8 lectures (`userAccess`, `rowGrant`, `user`,
  `validationStep` avec jointure, `department.count`, `activeStandInsFor` → `leaveRequest` avec jointures,
  `getAppSettings`, `paymentCentreSeat.count`). `perRequest` (React `cache`) ne mémorise **rien** dans une route
  d'API : chaque appel paie tout. Mesuré : **10 requêtes** pour `getCurrentUser`, 12 pour `/api/notifications/poll`.
- **Scénario** : voir le budget ci-dessus — ~90 des 103 requêtes/min/onglet restantes servent à savoir « qui est-ce et
  a-t-il le droit de voir sa messagerie ». À 50 onglets : ~4 500 requêtes/min de pure authentification.
- **Correctif concret** : `src/lib/session-legere.ts` → `identiteDuSondage(): Promise<{ id; role; mustChangePassword; vue } | null>` :
  jeton décodé + `userSession` (révocation) + **la même règle de « Vue exacte »** (`vueHonoree`, en lecture) —
  sans `getAccess`. `MESSAGING:VIEW` se teste par `accesAttribue(role, secondaryRole, overrides)` limité au module
  (2 lectures), ou se met en cache mémoire 30 s par `(userId, versionDesDroits)`. Routes concernées :
  `api/messaging/sync`, `api/notifications/poll`, `api/replay`, `api/activity`.
  Cliquet : une route sondée par la coque n'appelle pas `getCurrentUser` (liste tenue par le test de PERF-04).
- **Pourquoi PROPOSÉ** : toucher à l'identité sous « Vue exacte » (§118.184) mérite une revue sécurité ; le gain
  (−70 % des requêtes de sondage) justifie de le faire en premier.

### PERF-07 — `XLSX.read` synchrone dans le processus web — MOYENNE — PROPOSÉ

- **Preuve** : appels serveur synchrones de `XLSX.read` : `src/lib/ventes-pch/service.ts:33` (import des ventes PCH,
  appelé deux fois : aperçu puis application), `src/lib/actions/stock-pch-actions.ts:130`, `src/lib/actions/kpi-actions.ts:411`,
  `src/lib/consommation/service.ts:17`, `src/lib/medical/directory-workbook.ts:31`, `src/lib/segmentation/feuilles.ts:12`,
  `src/lib/budget-marketing/integration-serveur.ts:50`, `src/lib/knowledge/parsers/sheet.ts:163` (balayage d'ingestion
  Drive, plafonné à 8 Mo par `MAX_INGEST_BYTES`), et `extract/heavy-parse.ts:111` en ligne sous le seuil
  `REG_WORKER_THRESHOLD_MB` = **100 Mo** (`:22`).
- **Mesure** (`xlsx` du dépôt, classeur de 5 colonnes, minuterie de 10 ms pour mesurer le gel) :
  100 000 lignes / 20,8 Mo → **2,2 s de boucle d'événements bloquée** ; 300 000 lignes / 64,3 Mo → **7,7 s**.
  À titre de comparaison `pdf-parse` (1 500 pages, 2,7 Mo) : 6,8 s de travail mais **15 ms** de blocage maximal.
- **Scénario** : l'équipe ventes importe le fichier mensuel d'une DR → pendant 2 à 8 s, plus aucune page, aucun
  sondage, aucune action ne répond pour **personne** (une seule instance Render), et le battement est suspendu.
- **Correctif** : réutiliser l'infrastructure existante de `heavy-parse.ts` (worker thread + repli) pour un
  `lireClasseurEnTache(buffer, options)` qui renvoie les lignes ; abaisser le seuil à ~2 Mo ; `sheetRows` dans
  `knowledge/parsers/sheet.ts` (seules `MAX_SHEET_ROWS` = 2 000 lignes servent, le classeur entier est analysé) ;
  ne lire le classeur qu'une fois entre aperçu et application (empreinte SHA déjà calculée → cache court).

### PERF-08 — Le motif de PERF-01 existe en 33 autres endroits — MOYENNE — PROPOSÉ

- **Preuve** : recensement automatique des `prisma.X.findMany({ … relation: { …, take: N } })` (take sur une
  relation 1-N sous une liste de parents) : **33 sites**. Ceux dont la relation grossit sans borne :
  `src/lib/agent/lectures.ts:36` (Adam « Conversations consultées » : `messages … take: 3` sur 200 conversations →
  tout l'historique, corps compris), `src/lib/agent/routines/service.ts:114` (`passages … take: 12` avec `contenu`),
  `src/lib/scheduler/manage.ts:200` (`runs … take: 5`), `src/app/(app)/regulatory/enregistrement/corpus/page.tsx:38`
  (`versions … take: 1`), `src/lib/drive-zip.ts:26` et `platform/in-process/fichiers/index.ts:70` (`versions`),
  `src/lib/missions/view/control.ts:149` (`steps`).
- **Correctif** : (a) au cas par cas, la requête `LATERAL … LIMIT N` de PERF-01 ; (b) **globalement**, activer la
  préversion `relationJoins` de Prisma 5 et `relationLoadStrategy: "join"` sur ces requêtes (le `take` devient un
  `LIMIT` dans une sous-requête latérale) — à valider par la suite de tests DB complète avant généralisation.
- **Cliquet proposé** : `src/lib/prisma-take-imbrique.test.ts` — le recenseur ci-dessus en test, plafond à 33 et
  décroissant (même mécanique que `boundary.test.ts`).

### PERF-09 — Le planificateur vit dans le processus web, sans budget par étape — MOYENNE — PROPOSÉ

- **Preuve** : `src/lib/scheduled.ts:78-92` (battement `setInterval` 60 s armé au premier import, en pratique par
  `/api/messaging/sync`), `:95-270` (48 étapes `await` en série, une seule mesure globale depuis `e3cc4be`), budget
  propre aux seuls jobs réglementaires (`REG_JOBS_BUDGET_MS` 120 s, `jobs/runner.ts:143`). Partage avec les pages :
  la boucle d'événements (PERF-07), le pool Prisma de 12 connexions (`src/lib/prisma.ts:144`), la mémoire.
  Plusieurs mécanismes supposent une instance unique (verrou `running` en mémoire, `passInFlight`).
- **Scénario** : un passage lent (ingestion Drive, embeddings, OCR, réconciliation du site) occupe le CPU de la seule
  instance pendant que les utilisateurs naviguent ; un second processus web (montée en charge) doublerait le
  battement sans verrou partagé (les « …SiDu » sont idempotents en base, mais pas tous les balayages : `[U]`).
- **Correctif** : voir §3 — registre de tâches déclaratif (nom, cadence, budget), verrou consultatif Postgres
  (`pg_try_advisory_lock`) par passage, processus `worker` séparé ; `SCHEDULER_DISABLED=1` existe déjà côté web.

### PERF-10 — La coque fait 6 allers-retours séquentiels et lit `User` 5 fois — BASSE — PROPOSÉ

- **Preuve** : `src/app/(app)/layout.tsx:44` `requireUser()` → `:49` `user.findUnique({ mustOnboard })` →
  `:59` `navigationFor(user)` → `:61` `Promise.all([...5])` → `:74` `myCompanyScope()` → `:76` `isTestUser()`
  (relit `User.testMode`) ; la ligne `User` est aussi lue par `getAccess` (`rbac.ts:1377`) et `getAdoptionBadge`
  (`adoption.ts:475`). La page appelle ensuite `requireModule()` → `requireUser()` → `build()` à nouveau
  (`userSession` relu : `build` n'est pas mémorisé par requête, seul `getAccess` l'est).
- **Correctif** : un seul `Promise.all` après `requireUser` (les lectures sont indépendantes ; `mustOnboard` redirige
  après coup), `isTestUser`/`mustOnboard`/`adoptionScore` lus dans **une** requête `User`, et `build` enveloppé dans
  `cache()` par (jeton, options). Gain : ~5 allers-retours par rendu (y compris le rendu qui suit chaque action
  serveur qui revalide).

### PERF-11 — `finances/paiements-a-faire` : 5 lectures indépendantes en cascade — BASSE — PROPOSÉ

- **Preuve** : `src/app/(app)/finances/paiements-a-faire/page.tsx:92,104,106,135,152` — `ordresAvecFacture`,
  `dossierHrefByOrder`, `marquesDesOrdres`, `modulesDesEntites`, `ordresBvAvecQuittance` ne dépendent que de
  `orders`, mais sont attendus l'un après l'autre.
- **Correctif** : un `Promise.all` unique après le chargement des ordres. Même revue à faire sur
  `marketing-cockpit/page.tsx` (9 `await` de premier niveau).

### Ce qui va bien (vérifié, à ne pas « optimiser »)

- **`revalidatePath`** : 1 291 appels, mais 307 pages `force-dynamic` et aucun `unstable_cache` : il n'y a pas de cache
  de données à purger. Le coût réel d'une action est **un** nouveau rendu (coque + page), quel que soit le nombre de
  chemins revalidés ; 6 seulement visent `("/", "layout")`. Pas de constat.
- **Composants serveur vs client** : 0 `page.tsx` en `"use client"` ; `xlsx`/`jszip` chargés par `import()` côté client ;
  `recharts` statique dans 4 composants seulement.
- **Index du chemin chaud** : `Notification(userId,isRead,createdAt)`, `ConversationMember(userId)`,
  `ValidationStep(validatorId,status)`, `UserAccess(userId)`, `RowGrant(userId,entityType)`,
  `LeaveRequest(standInId,standInStatus)`, `PaymentCentreSeat.userId @unique` : tous présents.
- **Listes** : les écrans principaux sont plafonnés (`PLAFOND_OUVERTES`, `take: 300`, `take: 500`).
- **`pdf-parse`** cède la main entre les pages (blocage maximal mesuré : 15 ms).

### À vérifier (non prouvé, hors constats)

- **Volumes de production** (messages par conversation, notifications, `ActivityLog`) : ils fixent le gain réel de
  PERF-01 et le coût de `admin/activity` (`activityLog.aggregate` sans filtre = parcours complet à chaque ouverture).
- **Nombre d'instances et plan Render** (veille du plan gratuit = battement suspendu) — question ouverte n° 3 de la
  base de connaissances.
- **`npm run typecheck`** sort en dépassement de tas avec le tas par défaut de Node dans ce conteneur (réussit avec
  `--max-old-space-size=6144`, 3 min 43 s). Le `next build` local fait de même au typecheck intégré (plafond 3 072 Mo
  de `next.config.mjs`) ; Render fait le typecheck à part. Probablement l'écart connu §118.208, à confirmer sur une
  machine de développeur.
- Taille réelle des fichiers d'import PCH/KPI (PERF-07) : les seuils proposés en dépendent.
- Les plafonds de liste (`PLAFOND_OUVERTES`…) sont-ils signalés à l'écran quand ils tronquent ? (UX, hors périmètre).

---

## 3. Restructuration proposée

### Cible

```
src/
  server/
    sondage/                       ← tout ce que la coque interroge en boucle
      identite.ts                  identiteDuSondage() : jeton + révocation + Vue exacte, SANS getAccess  (PERF-06)
      contrat.ts                   SONDAGES = [{ route, periodeMs, lecture }]  — la table unique des sondages
    taches/                        ← le travail de fond, déclaratif
      registre.ts                  TACHES: Tache[]  (nom, cadenceMs, budgetMs, run)
      executer.ts                  executerPassage(taches, { verrou, horloge })  — isolement + budget + mesure
      worker.ts                    point d'entrée du processus séparé (boucle + arrêt propre)
    lourd/
      classeur.ts                  lireClasseurEnTache(buffer, { sheetRows }) — worker thread         (PERF-07)
  components/ui/
    icones-coque.ts                table statique des icônes de la coque                             (PERF-05)
  lib/scheduled.ts                 devient un adaptateur : registre → executerPassage (compat. des cliquets)
```

Contrats :

```ts
// src/server/taches/registre.ts
export interface Tache {
  nom: string;                       // « rappels-reunion »
  cadenceMs: number;                 // la plus petite période utile ; « …SiDu » garde sa propre règle en base
  budgetMs: number;                  // au-delà : journal + passage à la suivante (AbortSignal transmis)
  run: (signal: AbortSignal) => Promise<unknown>;
}

// src/server/taches/executer.ts
export async function executerPassage(taches: readonly Tache[], deps: {
  verrou: () => Promise<(() => Promise<void>) | null>;   // pg_try_advisory_lock(hashtext('amd:planificateur'))
  journal?: (e: { nom: string; dureeMs: number; erreur?: unknown }) => void;
}): Promise<RapportDePassage>;
```

Le rapport de passage (`nom`, `dureeMs`, `ok`) s'écrit dans une table `SchedulerRun` (migration additive) : l'écran
d'administration montre enfin quelle tâche est lente ou en échec, au lieu de grep dans les journaux Render.

### Chemin de migration (petites étapes sûres)

1. **Fait** : isolement (`.catch`) + mesure globale (PERF-03) ; sondages dédoublonnés (PERF-02, PERF-04).
2. `icones-coque.ts` + cliquet de couverture des noms ; brancher les 5 composants de la coque (PERF-05). 1 jour.
3. `identiteDuSondage()` + bascule des 4 routes sondées, sous revue sécurité « Vue exacte » (PERF-06). 1–2 jours.
4. `executerPassage` + `Tache` ; `scheduled.ts` décrit ses 48 étapes en tableau **dans le même ordre** — les
   cliquets « point d'appel dans le battement » lisent le registre au lieu du texte. Verrou consultatif Postgres. 2 jours.
5. `lireClasseurEnTache` (réutilise `extract.worker.cjs`) ; bascule des 8 appelants `XLSX.read` (PERF-07). 1 jour.
6. **Processus séparé** : `npm run worker` (`tsx src/server/taches/worker.ts`, alias `@/` résolus par `tsconfig`) ;
   sur Render, un *Background Worker* (offre payante) **ou**, à coût nul, un *Cron Job* Render qui appelle
   `POST /api/interne/battement` (secret partagé) toutes les minutes. Côté web : `SCHEDULER_DISABLED=1`. 1–2 jours.
7. PERF-08 : `relationJoins` en préversion, essayé derrière la suite DB complète, puis plafond du cliquet abaissé.

### Plan chiffré

| Étape | Effort | Gain mesuré / attendu |
|---|---|---|
| PERF-01/02/04 (fait) | — | sondages : 169 → 103 req/min/onglet (−39 %) ; aperçu messagerie : 20 000 → 40 lignes |
| PERF-05 icônes de la coque | S–M (1 j) | −120 kB gzip sur **chaque** page (coque 319 → ~199 kB, −38 %) |
| PERF-06 session légère des sondages | M (1–2 j) | 103 → ~31 req/min/onglet (−70 % de plus) |
| PERF-07 classeurs en tâche | M (1 j) | 2,2–7,7 s de gel global → 0 (travail déporté) |
| PERF-09 registre + worker | L (3–4 j) | battement hors du processus web ; durée et échec par tâche visibles |
| PERF-10/11 cascades | S (½ j) | ~5 allers-retours SQL de moins par rendu de coque |
| PERF-08 `take` imbriqués | M (1–2 j) | lectures bornées sur 33 sites ; Adam « conversations » comme PERF-01 |

---

## 4. Bonnes pratiques à graver

1. **Un `take` sur une relation 1-N sous un `findMany` est un `LIMIT` en mémoire, pas en SQL** (Prisma 5 sans
   `relationJoins`). Pour « le dernier X de chaque Y » : `LATERAL … LIMIT N` (exemple : `derniersMessages`). Cliquet
   proposé : `prisma-take-imbrique.test.ts`, plafond décroissant.
2. **Toute route sondée par la coque a un seul sondeur et une portée minimale** : ce que l'écran lit, rien de plus.
   Cliquet en place : `notifications-sondage-unique.test.ts`. Ajouter la colonne « coût mesuré » au contrat des sondages.
3. **Un test de performance mesure le SQL émis, pas un chronomètre** : substituer au singleton un client Prisma
   journalisé (`vi.mock("@/lib/prisma", …)`, cf. `messaging-sync-perf.test.ts`) et affirmer sur les requêtes —
   déterministe, rapide, sans seuil de temps fragile.
4. **Chaque étape du battement est isolée** (`.catch` journalisé) — cliquet en place dans `scheduled-isolation.test.ts`
   — puis, à l'étape 4 du plan, **budgétée et mesurée** par le registre.
5. **Aucun calcul CPU synchrone de plus de ~50 ms dans le processus web** : `XLSX.read`, `mammoth`, rendu `mupdf`
   passent par le worker thread. Cliquet proposé : liste blanche des fichiers autorisés à importer `xlsx` côté serveur.
6. **Pas d'import « tout le module » d'une bibliothèque d'icônes ou d'UI** (`import * as X`, table indexée par nom)
   dans un composant client : règle ESLint `no-restricted-imports` sur `lucide-react` (`icons`, `*`), sauf
   `ui/icon.tsx` hors coque.
7. **Budget de bundle** : `npm run build:measure` existe pour la mémoire ; ajouter un script qui calcule le First Load
   JS de la coque depuis `app-build-manifest.json` (méthode de ce rapport) et échoue au-delà d'un plafond
   (aujourd'hui 319 kB gzip → viser 200 kB).
