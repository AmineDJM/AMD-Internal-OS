# Audit 27/10/2026 — Infra, déploiement, CI, observabilité, fiabilité

> Périmètre : `render.yaml`, scripts `package.json`, `next.config.mjs`, ordre lint → build → migrate,
> variables d'environnement, stockage, sauvegardes, journalisation, erreurs avalées, sondes de santé,
> mémoire et temps de build, CI, dépendances, reproductibilité.
> Base : `claude/hopeful-goodall-phd0nb` @ `456c8f6`. Branche : `audit/infra-ci-observabilite`.
> Tout chiffre ci-dessous a été **mesuré** dans ce conteneur (4 vCPU, 15 Go, Node 22.22, Postgres 16
> local) sauf mention « [à vérifier] ». La KB `docs/knowledge-base/10-infra-build-deploy-testing.md`
> est juste sur l'essentiel ; ce rapport ne la répète pas, il la complète et la corrige.

## 1. Synthèse

**Note du périmètre : 4,5 / 10.** L'outillage de build est remarquablement documenté (chaque réglage
mémoire porte sa mesure), les tests-cliquets sont une vraie force. Mais **rien ne garde la porte** :
aucune CI, une sonde de santé qui ne regarde pas la base, un planificateur dont une étape en échec
coupait toutes les suivantes, plus de mille erreurs avalées sans trace, et une pile de dépendances
(Next 14, next-auth bêta, xlsx) qui n'est plus corrigée.

Les trois risques majeurs :
1. **Perte de données sans filet** (INFRA-06) — aucune sauvegarde ni procédure de restauration dans le
   dépôt ; le Blueprint déclare un Postgres *free* (expire ~30 j, sans sauvegarde) qui stocke aussi des
   fichiers jusqu'à 100 Mo.
2. **Dépendances vulnérables non corrigeables sans montée de version** (INFRA-03) — `npm audit` :
   23 avis dont 3 critiques et 16 hauts ; la branche 14 de Next ne reçoit plus de correctifs.
3. **Pannes silencieuses** (INFRA-02, INFRA-07) — 1 068 `.catch(() => valeur)` muets hors tests :
   une base qui échoue se lit « rien à faire » dans l'écran du DG, et personne n'est prévenu.

## 2. Constats

| ID | Sév. | Catégorie | Titre | Statut |
|---|---|---|---|---|
| INFRA-01 | HAUTE | maintenabilité / fiabilité | Aucune CI : rien ne vérifie un commit avant Render | **CORRIGÉ** `29108f0` |
| INFRA-02 | HAUTE | fiabilité | Planificateur : 7 étapes sans `catch` coupent tout le passage ; 24 `catch` muets | **CORRIGÉ** `edd1128` |
| INFRA-03 | HAUTE | sécurité | Next 14.2.35, next-auth 5.0.0-beta.22, xlsx 0.18.5 : avis critiques/hauts | PROPOSÉ (atténué par INFRA-04) |
| INFRA-04 | HAUTE | sécurité | Optimiseur d'images `/_next/image` public, failles non corrigées sur Next 14 | **CORRIGÉ** `0f9cdfe` |
| INFRA-05 | MOYENNE | fiabilité | `healthCheckPath: /login` : page statique, ne voit pas la base | **CORRIGÉ** `a49ce19` (route) — branchement Render PROPOSÉ |
| INFRA-06 | HAUTE (CRITIQUE si la prod est en *free*) | intégrité des données | Aucune sauvegarde / restauration ; Postgres *free* dans le Blueprint ; fichiers en base | PROPOSÉ |
| INFRA-07 | HAUTE | observabilité / correction | 1 068 erreurs avalées (`.catch(() => [] / null / 0 / undefined / {})`) | PROPOSÉ |
| INFRA-08 | MOYENNE | outillage | `npm run typecheck` (porte de CLAUDE.md) meurt en OOM | **CORRIGÉ** `1990fbe` |
| INFRA-09 | MOYENNE | reproductibilité | `npm install` (pas `npm ci`) au build ; pas de version de Node déclarée | PARTIEL (`.nvmrc` `29108f0`) — `npm ci` PROPOSÉ |
| INFRA-10 | MOYENNE | maintenabilité / sécurité | 177 variables d'env lues, 124 documentées nulle part, aucune validation au démarrage | PROPOSÉ |
| INFRA-11 | MOYENNE | observabilité | Journal non structuré (534 `console.*`), pas de `global-error.tsx`, pas de remontée d'erreurs | PROPOSÉ |
| INFRA-12 | HAUTE | sécurité | `middleware.ts` (racine) n'est **pas compilé** : la garde d'authentification en périphérie n'existe pas en production | PROPOSÉ (vérifié par build) |

---

### INFRA-01 — Aucune CI · HAUTE · **CORRIGÉ `29108f0`**

- **Preuve** : `ls .github` → absent ; aucun `.gitlab-ci.yml`/`.circleci`. La seule porte est la
  séquence manuelle de `CLAUDE.md` et le build Render (`render.yaml:52`).
- **Scénario** : un développeur pousse un commit dont un `eslint-disable` nomme une règle inconnue
  (cas réel §118.155) ou dont un composant client tire `fs` via dix imports (cas réels `market/data.ts`,
  `messaging.ts`). Render échoue — **après** avoir appliqué les migrations dans l'ordre actuel — et le
  journal de build n'est lu par personne : la prod sert l'ancien code sur la base migrée.
- **Correctif** : `.github/workflows/ci.yml`, trois jobs parallèles (mémoire isolée, comme
  `build:render`) :
  - `verifier` — Postgres 16 de service, `prisma migrate deploy` sur base **vide** (les 465 migrations
    rejouées, ce qu'aucun poste ne fait), `db:bootstrap`, `npm run actions:contrat` + `git diff
    --exit-code`, `npm run typecheck`, `tsc -p tsconfig.build.json`, `next lint` ;
  - `tests` — **4 tranches** (`--shard=i/4`, la suite complète prend 12 min 30 sur 4 cœurs, ~2× sur
    un runner privé à 2 vCPU), chacune avec son Postgres, `rg` installé
    (`reachability.test.ts`), et une preuve `SELECT 1` **avant** `npm test` (sinon ~400 fichiers
    `dbOk ? describe : describe.skip` se sautent en silence) ;
  - `build` — `npm run build:render` à froid, **sans** cache `.next` (CLAUDE.md : un cache chaud
    masque « Can't resolve 'fs' »).
  - `.nvmrc` = 22 = `NODE_VERSION` de `render.yaml` ; `ADAM_SORTIE_INTERDITE=1`, aucune clé de
    fournisseur.
- **Garde** : `src/lib/infra/ci-workflow.test.ts` (échoue sans le fichier, vérifie chaque porte, la
  preuve de base avant `npm test`, l'absence de cache `.next`, l'égalité Node CI = Node Render).
- **À savoir dès le premier run** : la CI sera **rouge** sur les deux cliquets déjà en dépassement
  (`boundary.test.ts` 430 > 425, `domains.test.ts` 71 > 68) — c'est voulu : ce sont de vraies
  régressions que seule la discipline locale « ignorait ». Ne pas les masquer, les payer ou relever
  le plafond par un diff justifié.
- **Effort** : S.

### INFRA-02 — Le planificateur : une étape qui lève coupait toutes les suivantes · HAUTE · **CORRIGÉ `edd1128`**

- **Preuve** (`456c8f6`) : `src/lib/scheduled.ts:101-121` — `await sendDueMeetingReminders();`,
  `await sendDueReminders();`, `await sendDuePayrollNotifications();`, `await runDueRegulatoryJobs();`,
  `await runAnppWatchIfDue();`, `await pollAiBatches();`, `await runIntelligencePulse();` sans `.catch`,
  dans un unique `try { … } catch (err) { console.error("[scheduled] run failed", err) }` (`:279`).
  Et 24 étapes en `.catch(() => 0)` / `.catch(() => undefined)` : échec **sans un mot**.
- **Scénario** : une migration ajoutant une colonne lue par `sendDueReminders` n'est pas appliquée
  (commande du tableau de bord Render divergente, §118.208). Prisma lève `P2022` **à chaque passage**.
  Toutes les étapes suivantes — missions durables, surveillances, file du site web, balayage Gmail
  d'Adam, alertes de stock, rappels de caisse… — ne tournent plus **jamais**, avec pour seule trace un
  « run failed » anonyme par minute.
- **Correctif** : `src/lib/scheduler/etape.ts` — `etape(nom, travail)` exécute isolé, ne lève jamais,
  journalise sous le nom de l'étape, **déduplique** une même erreur (réécrite 1×/h, un message
  différent toujours écrit) et signale le rétablissement. Les 52 appels de `runScheduledJobs()` passent
  par elle.
- **Garde** : `src/lib/scheduler/etape.test.ts` — unité (isolement, continuation, déduplication) +
  garde de source : chaque `await` du corps est `await etape("…", …)` et aucun `.catch(() =>` muet n'y
  subsiste (plancher : ≥ 40 étapes trouvées). Échouait sur `456c8f6`, passe après. Les 5 tests
  « point d'appel dans le battement » (`recrutement`, `adam-commissioning`, `stock-registre`,
  `hot-alerts`, `mentions`) suivent la nouvelle forme.
- **Effort** : S.

### INFRA-03 — Dépendances vulnérables, sans correctif dans la branche utilisée · HAUTE · PROPOSÉ

- **Preuve** : `npm audit --omit=dev` (27/10) → **23 avis : 3 critiques, 16 hauts, 3 modérés, 1 bas**.
  - `next@14.2.35` (`package.json`) : ~25 avis dont GHSA-2464-fhr4-w9xw et GHSA-2xp9-vwfh-vxw4
    (RCE dans l'optimiseur d'images, SVG/AVIF), GHSA-m99w-x7hq-7vfj / GHSA-p3m5-59mp-jv5r (DoS par
    Server Actions), GHSA-89xv-2m56-2m9x (SSRF Server Actions) — **corrigés uniquement en 15.5.x**.
  - `next-auth@5.0.0-beta.22` : GHSA-8fpg-xm3f-6cx3 (critique : un objet `auth` peuplé d'une erreur
    passe un contrôle d'existence), GHSA-7rqj-j65f-68wh (critique : normalisation d'e-mail),
    GHSA-xmf8-cvqr-rfgj (haut : `getToken()` lève sur un Bearer malformé) — **corrigés en
    5.0.0-beta.32**. Atténuation constatée : `src/lib/session.ts:113` teste `session?.user` (pas
    `session`), ce qui neutralise GHSA-8fpg pour `requireUser`.
  - `xlsx@0.18.5` : prototype pollution (GHSA-4r6h-8v6p-xvw6) + ReDoS (GHSA-5pgg-2g8v-p4x9), **jamais
    corrigés sur npm** (SheetJS ne publie plus que sur `cdn.sheetjs.com`). Or 10 chemins appellent
    `XLSX.read` sur un **fichier téléversé** : `stock-pch-actions.ts:130`, `kpi-actions.ts:411`,
    `ventes-pch/service.ts:33`, `consommation/service.ts:17`, `segmentation/feuilles.ts:12`,
    `medical/directory-workbook.ts:31`, `knowledge/parsers/sheet.ts:163`,
    `regulatory/intelligence/extract/heavy-parse.ts:111`, `budget-marketing/integration-serveur.ts:50`,
    et côté navigateur `office-viewers.tsx:77`.
- **Scénario** : un délégué importe un classeur forgé dans « Ventes PCH » → ReDoS : le processus Node
  unique (plan *free*, une instance) se fige, l'ERP entier ne répond plus pour tout le monde.
- **Correctif** (par étapes, chacune une PR) :
  1. `xlsx` → `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` (API identique ; vérifier
     que l'hôte est joignable depuis Render) — S.
  2. `next-auth` → `5.0.0-beta.32` (même ligne bêta) + passer les tests `auth`/`session` — S/M.
  3. Next 14 → 15.5.x (React 19, `cookies()`/`headers()` asynchrones, cache `fetch` inversé) — **L** ;
     préparer avec le codemod `@next/codemod upgrade`, la CI d'INFRA-01 servant de filet. En attendant :
     INFRA-04 ferme la surface la plus exposée.
  4. Ajouter un job `npm audit --omit=dev --audit-level=critical` **informatif** dans la CI, à rendre
     bloquant une fois l'étape 3 faite.
- **Effort** : L (global).

### INFRA-04 — `/_next/image` public sur une version non corrigée · HAUTE · **CORRIGÉ `0f9cdfe`**

- **Preuve** : `next.config.mjs` n'avait pas de bloc `images` → optimiseur actif ; il est public (le
  matcher de `middleware.ts` l'exclut explicitement) et décode les images par `sharp`. Une seule
  image l'utilise : `assistant-workspace.tsx:203` (fond décoratif **flouté à 10 px**).
- **Scénario** : n'importe qui sur Internet appelle `/_next/image?url=/images/…&w=3840&q=100` en
  boucle (GHSA-h64f-5h5j-jqjh, DoS) ou exploite les avis RCE SVG/AVIF à leur publication complète.
- **Correctif** : `images: { unoptimized: true }` — vérifié dans
  `node_modules/next/dist/server/next-server.js:167` : le point d'entrée répond **404**. L'image est
  recompressée une fois (990 Ko → 125 Ko, mozjpeg q60) pour ne rien perdre côté poids.
- **Garde** : `src/lib/infra/next-config.test.ts`. **Effort** : S.

### INFRA-05 — La sonde de santé ne regarde pas la base · MOYENNE · **CORRIGÉ `a49ce19`** (route)

- **Preuve** : `render.yaml:25` `healthCheckPath: /login` ; `/login` est statique (KB 10 §4.10).
- **Scénario** : la `DATABASE_URL` est tournée, ou la base *free* expire : Render voit 200, bascule le
  trafic et ne redémarre rien ; chaque page de l'ERP rend une erreur pendant que la sonde est verte.
- **Correctif** : `src/app/api/health/route.ts` — `SELECT 1` borné à 3 s ; 200 `{ok:true}` ou 503
  `{ok:false, base:"injoignable"}`, **sans** détail d'erreur (testé : l'IP de l'erreur ne fuit pas),
  `Cache-Control: no-store`. Ouverte dans `authorized()` (`src/auth.config.ts`) et déclarée dans la
  liste des routes sans session de `vue-exacte-etanche.test.ts`.
- **Reste à faire (opérateur)** : `healthCheckPath: /api/health` dans `render.yaml` **et** dans
  *Settings → Health Check Path* du tableau de bord (§118.208 : le tableau de bord prime). Non modifié
  ici pour ne pas créer de conflit avec `refonte/p0-outillage`, qui réécrit les lignes voisines.
- **Évolution proposée** : que la sonde compare aussi `SELECT count(*) FROM _prisma_migrations WHERE
  finished_at IS NOT NULL` au nombre de dossiers de `prisma/migrations/` (le dépôt complet est présent
  au runtime, `outputFileTracing: false`) et rende 503 s'il manque des migrations : un tableau de bord
  qui aurait perdu l'étape `migrate deploy` ferait **échouer le déploiement** au lieu de servir du code
  sur un schéma en retard. **Effort** : S.

### INFRA-06 — Aucune sauvegarde, aucune restauration éprouvée · HAUTE (CRITIQUE si prod en *free*) · PROPOSÉ

- **Preuve** : `render.yaml:17` `plan: free` pour `amd-postgres` ; `docs/readme/24-deploiement-render.md:19`
  rappelle l'expiration à ~30 jours. Aucun `pg_dump`, script ou procédure de restauration dans
  `scripts/`, `docs/readme/` ou `docs/claude-md/` (recherche « pg_dump », « backup », « sauvegarde »).
  14 colonnes `Bytes` dans `prisma/schema.prisma` et `MAX_DB_UPLOAD_MB=100` (`render.yaml`) : des
  fichiers jusqu'à 100 Mo vivent **dans** Postgres quand S3 n'est pas configuré.
- **Scénario** : la base gratuite arrive à expiration (ou une migration manuelle détruit une table) :
  factures, BC, paie, dossiers réglementaires sont perdus ; rien dans le dépôt ne dit comment restaurer.
- **Correctif** :
  1. [à vérifier dans le tableau de bord] plan de `amd-postgres` ; passer à un plan payant avec
     sauvegardes quotidiennes / PITR et **corriger `render.yaml`** pour que ré-appliquer le Blueprint ne
     recrée pas une base gratuite.
  2. Sauvegarde **hors Render** : un job planifié (GitHub Actions `schedule:` nocturne, secret
     `PROD_DATABASE_URL` en lecture seule) `pg_dump -Fc` → bucket S3/R2 avec rétention 30 j +
     versionnement du bucket ; même chose pour le bucket des fichiers (réplication ou `rclone sync`).
  3. **Exercice de restauration** mensuel : `pg_restore` dans une base jetable + `npm run adam:doctor`,
     consigné dans `docs/readme/26-base-de-donnees-migrations.md`.
  4. Imposer S3 en production (refuser `MAX_DB_UPLOAD_MB > 10` quand `NODE_ENV=production`) : des
     sauvegardes de base de plusieurs Go ralentissent tout le reste.
- **Effort** : M.

### INFRA-07 — 1 068 erreurs avalées sans trace · HAUTE · PROPOSÉ

- **Preuve** : hors tests, `src/` contient `.catch(() => undefined)` ×430, `.catch(() => null)` ×304,
  `.catch(() => [])` ×175, `.catch(() => {})` ×80, `.catch(() => 0)` ×60, `.catch(() => false)` ×19.
  Foyers : `platform/in-process/missions` 123, `lib/regulatory/intelligence` 56,
  `actions/ad-pro-item-actions.ts` 38, `assistant.ts` 28, `queries/ad-pro-centre.ts` 27.
  Exemple tracé : `src/lib/queries/ad-pro-centre.ts:67-105` — `demandesAuCentreAdPro()` lit en
  parallèle les instances de workflow, les promos, les visas, les BC demandés, chacun en
  `.catch(() => [])`.
- **Scénario** : la requête des visas échoue (colonne manquante, délai de pool) → le **centre de
  validation du DG** affiche « rien à viser » ; les demandes restent bloquées, aucun journal ne le dit,
  et l'écran *ment* au lieu d'afficher « indisponible ».
- **Correctif** :
  1. Un helper unique `src/lib/observabilite/repli.ts` :
     ```ts
     export function repli<T>(contexte: string, valeur: T) {
       return (e: unknown): T => { journal.erreur(contexte, e); return valeur; };
     }
     // usage : prisma.adProGateVisa.findMany(…).catch(repli("centre-adpro.visas", []))
     ```
     Le comportement (repli) reste, la trace apparaît.
  2. Une règle ESLint `no-restricted-syntax` sur `CallExpression[callee.property.name='catch'] >
     ArrowFunctionExpression[params.length=0]` (un `catch` qui ignore son erreur), en **cliquet** :
     test qui compte les occurrences et ne laisse que descendre (plafond 1 068 aujourd'hui).
  3. Pour les **écrans de décision** (centre DG, boîtes de validation), remplacer le repli silencieux
     par un état « source indisponible » visible — un vide qui ment est pire qu'une erreur.
- **Effort** : M (helper + cliquet), L (résorption).

### INFRA-08 — `npm run typecheck` meurt en OOM · MOYENNE · **CORRIGÉ `1990fbe`**

- **Preuve** : mesuré (Node 22.22, 15 Go) : `npm run typecheck` → « Ineffective mark-compacts near
  heap limit … Aborted » après 18 s. `package.json:14` était `tsc --noEmit` sans plafond, alors que
  `build:render` en pose un (5120 Mo) pour le typecheck de production.
- **Scénario** : un contributeur suit CLAUDE.md (« `npm run typecheck && npm run build && npm test` »),
  la première commande plante ; il saute la porte ou pose `NODE_OPTIONS` au hasard.
- **Correctif** : `NODE_OPTIONS=--max-old-space-size=6144 tsc --noEmit` ; mesuré vert en 4 min 18.
  Garde dans `ci-workflow.test.ts`. **Effort** : S.

### INFRA-09 — Build non reproductible · MOYENNE · PARTIEL

- **Preuve** : `render.yaml:52` commence par `npm install` (peut réécrire `package-lock.json` et
  résoudre autrement que le poste) ; `.npmrc` `legacy-peer-deps=true` ; pas de champ `engines`, pas de
  `.nvmrc` avant ce lot (Render : `NODE_VERSION=22` ; `docs/readme/22` : « Node ≥ 18 »).
- **Correctif** : `.nvmrc` ajouté (`29108f0`). **Proposé** : `npm ci` dans la commande de build —
  à intégrer **dans la ligne réécrite par `refonte/p0-outillage`** (voir §2 bis) pour ne pas dupliquer —,
  `"engines": { "node": "22.x" }` dans `package.json`, et `docs/readme/22` aligné. **Effort** : S.

### INFRA-10 — Variables d'environnement : inventaire éclaté, aucune validation · MOYENNE · PROPOSÉ

- **Preuve** : 177 noms distincts lus via `process.env.X` dans `src/` ; `.env.example` en déclare 21,
  `docs/readme/23-variables-d-environnement.md` en cite 66 ; **124** ne figurent dans aucun des deux.
  Aucune validation centralisée : chaque module lit et interprète sa variable (souvent
  `=== "off"` / `=== "1"`), une faute de frappe dans le tableau de bord passe inaperçue.
- **Scénario** : un opérateur pose `MISSION_SWEEP=off` au lieu de `MISSIONS_SWEEP=off` pour couper un
  balayage qui s'emballe : rien ne se passe, rien ne le dit.
- **Correctif** : `src/lib/env/schema.ts` (zod, déjà en dépendance) : un objet par domaine
  (`base`, `auth`, `stockage`, `ia`, `debrayages`), lu une fois, typé, avec un `npm run env:check` et
  un test-cliquet « toute lecture `process.env.X` de `src/` passe par ce module ou est listée » ;
  `.env.example` **généré** depuis le schéma. **Effort** : M.

### INFRA-11 — Observabilité : journal plat, pas de capteur d'erreurs · MOYENNE · PROPOSÉ

- **Preuve** : 534 `console.(error|warn|log|info)` hors tests, sans niveau configurable ni identifiant
  de requête ; pas de `src/app/global-error.tsx` (seul `src/app/(app)/error.tsx`) ; aucune dépendance
  Sentry/OpenTelemetry/pino (`package.json`).
- **Scénario** : une erreur dans le layout racine (hors `(app)`) affiche la page d'erreur par défaut de
  Next en anglais, sans `digest` à transmettre au support ; côté serveur, l'erreur se perd dans le
  flux de logs de Render (rétention courte sur le plan gratuit).
- **Correctif** : `src/lib/observabilite/journal.ts` (JSON une ligne : `niveau`, `contexte`,
  `requete`, `message`, `pile`) ; `global-error.tsx` en français ; `instrumentation.ts` avec
  `onRequestError` (Next 15) pour remonter vers un capteur (Sentry auto-hébergé ou SaaS). **Effort** : M.

### INFRA-12 — Le middleware d'authentification n'est pas compilé · HAUTE · PROPOSÉ

- **Preuve (mesurée, plus [U])** : build propre `npm run build:render` du 27/10 →
  `.next/server/middleware-manifest.json` = `{"middleware": {}, "functions": {}, "sortedMiddleware": []}`
  et aucune ligne `ƒ Middleware` dans la sortie du build. `middleware.ts` est à la **racine** alors que
  l'application vit dans `src/app` ; Next 14.2.35 ne le cherche que dans `src/` (KB 10 §8.7).
  Fumée sur `next start` : `/dashboard` anonyme → 307 `/login` — c'est `requireUser()` du layout
  `(app)` qui protège, pas le middleware.
- **Scénario** : une route **hors `(app)`** ou une route `/api/*` qui oublie son propre contrôle est
  servie à un anonyme : la liste blanche soigneusement tenue dans `authorized()` (`src/auth.config.ts`)
  ne s'exécute jamais. Le garde `vue-exacte-etanche.test.ts` (« chaque route lit `@/lib/session` »)
  est aujourd'hui la seule barrière, et il ne vérifie pas que la session est **exigée**.
- **Correctif** (à mener avec l'audit sécurité, pas en solo) : déplacer `middleware.ts` vers
  `src/middleware.ts` **après** avoir rejoué l'E2E et l'auto-testeur (`npm run autotest:live`) : il
  activera des redirections sur des routes aujourd'hui servies (clés d'API, webhooks, jetons publics)
  si la liste blanche est incomplète. Ajouter à la CI (job `build`) une vérification
  `node -e "process.exit(Object.keys(require('./.next/server/middleware-manifest.json').middleware).length ? 0 : 1)"`
  pour que le middleware ne puisse plus disparaître sans bruit. **Effort** : M.

---

## 2 bis. Évaluation de `refonte/p0-outillage` (ordre lint → build → migrate)

Lu : `render.yaml` et `docs/architecture/refonte-p0-outillage.md` §2 de `origin/refonte/p0-outillage`
(`ed58f3e`). Nouvelle commande :
`npm install && npx prisma generate && npm run build:render && npx prisma migrate deploy && npm run db:bootstrap`.

- **Juste** : tout ce qui peut échouer sans écrire en base (lint, tsc, compilation) passe **avant**
  `migrate deploy` ; la mesure « `next build` n'ouvre aucune connexion » rend l'ordre sûr ; le
  `bootstrap` suit les migrations ; le risque du tableau de bord (§118.208) est explicitement signalé.
  `preDeployCommand` est écarté pour une bonne raison (plan gratuit). **Je l'approuve sans réserve
  sur l'ordre.**
- **Ce qui reste** (à ajouter à cette ligne, pas en double) :
  1. `npm ci` au lieu de `npm install` (INFRA-09).
  2. La commande du tableau de bord reste invérifiable depuis le dépôt : la sonde « migrations
     appliquées » d'INFRA-05 transforme cet oubli en déploiement **refusé**.
  3. Dès le passage à un plan payant : `migrate deploy` + `db:bootstrap` en `preDeployCommand` (exécuté
     une fois, hors du conteneur de build et de son plafond de 8 Go).
  4. Le contrôle de dérive (`src/lib/derive-schema/`) est un test Vitest : avec la CI d'INFRA-01 il
     devient enfin bloquant **avant** Render. J'ai vérifié qu'un `migrate diff --exit-code` brut ne
     peut pas servir de porte aujourd'hui (558 lignes de dérive sur base vierge) — c'est bien le cliquet
     à exceptions de cette branche qu'il faut, la CI ne le duplique pas.

## 3. Restructuration proposée

### 3.1 Cible

```
.github/workflows/
  ci.yml                 # FAIT — porte de chaque push/PR
  sauvegarde.yml         # pg_dump nocturne → R2, rétention 30 j (INFRA-06)
  audit-deps.yml         # npm audit hebdo + rapport (INFRA-03)
render.yaml              # npm ci · build:render · migrate · bootstrap ; healthCheckPath /api/health
src/lib/env/
  schema.ts              # zod : une section par domaine, défauts, débrayages typés (INFRA-10)
  index.ts               # export const env = lireEnv(process.env) — seul lecteur de process.env
src/lib/observabilite/
  journal.ts             # journal.erreur(contexte, e, champs) → JSON une ligne
  repli.ts               # .catch(repli("contexte", valeur)) — remplace les catch muets (INFRA-07)
src/lib/scheduler/
  etape.ts               # FAIT — une étape nommée, isolée, journalisée
  battement.ts           # (étape suivante) la liste des étapes en DONNÉES : [{ nom, fn, critique }]
src/app/api/health/route.ts   # FAIT — + contrôle « migrations appliquées »
src/app/global-error.tsx
```

### 3.2 Chemin de migration (petites étapes sûres, chacune verte en CI)

1. **Brancher la CI** (ce lot) et payer/justifier les deux cliquets rouges.
2. `render.yaml` + tableau de bord : `healthCheckPath: /api/health`, `npm ci` (ligne de refonte P0).
3. Sauvegarde nocturne + premier exercice de restauration documenté.
4. `xlsx` depuis le CDN SheetJS ; `next-auth` beta.32.
5. `journal.ts` + `repli.ts` ; cliquet sur les `catch` muets (plafond 1 068, ne descend que) ; traiter
   d'abord les écrans de décision (centre DG, validations).
6. `env/schema.ts` : migrer domaine par domaine, cliquet sur les lectures directes.
7. Montée Next 15.5 (codemod), retrait de `images.unoptimized` si l'optimiseur est voulu.
8. `battement.ts` : la liste des étapes devient une table (`{ nom, fn, cadence, critique }`) ; un écran
   admin lit l'état de la dernière exécution de chaque étape (succès, durée, dernier échec) — le
   planificateur devient observable sans lire les logs.

### 3.3 Ce qu'on gagne

Un commit cassé est arrêté avant la prod ; une panne de base fait échouer la sonde au lieu de servir
des pages vides ; une étape en échec est nommée et n'emporte plus les autres ; une erreur avalée laisse
une trace ; une variable mal saisie se signale au démarrage ; la base est restaurable.

## 4. Bonnes pratiques à graver

| Règle | Mécanisme |
|---|---|
| Rien n'arrive sur la branche déployée sans CI verte | `ci.yml` + protection de branche GitHub (*Require status checks*) — à activer par le propriétaire |
| La CI garde les portes de CLAUDE.md | `src/lib/infra/ci-workflow.test.ts` (FAIT) |
| Toute étape périodique passe par `etape()` | garde de source `src/lib/scheduler/etape.test.ts` (FAIT) |
| Pas d'optimiseur d'images tant que Next 14 | `src/lib/infra/next-config.test.ts` (FAIT) |
| Les scripts de porte fixent leur tas | `ci-workflow.test.ts` (FAIT) |
| Un `catch` ne jette pas l'erreur sans la dire | ESLint `no-restricted-syntax` + cliquet de comptage (PROPOSÉ) |
| `process.env` se lit dans un seul module | cliquet de source (PROPOSÉ) |
| La sonde de santé dit base + migrations | test de la route (FAIT pour la base) |
| Avis `critical` de `npm audit` = CI rouge | job `audit-deps` (PROPOSÉ, bloquant après Next 15) |
| Toute nouvelle route publique est nommée | `vue-exacte-etanche.test.ts` (existant — a bien attrapé `/api/health`) |

## 5. À vérifier

- **Plan réel de `amd-postgres`** et existence de sauvegardes côté Render (tableau de bord) — décide
  si INFRA-06 est CRITIQUE.
- **Commande de build et *Health Check Path* réellement saisies dans le tableau de bord** (§118.208).
- **Mémoire d'exécution** : le plan *free* donne 512 Mo à `next start`, qui charge le planificateur
  (~45 modules), `sharp`, `mupdf`, `tesseract.js` ; aucun plafond `--max-old-space-size` au runtime.
  Pas de mesure faite ici du RSS en charge.
- **`sorties-declarees.test.ts`** a échoué une fois dans la suite complète (« fiches non exercées :
  list_my_tasks ; gmail_search … expected 2 ≤ 1 ») et passe seul : sensibilité à la charge ou à
  l'ordre, hors périmètre, à confier au domaine Adam.

## 6. Mesures de ce lot (27/10, conteneur 4 vCPU / 15 Go, Node 22.22, Postgres 16 local)

| Mesure | Valeur |
|---|---|
| `npm ci` | ~6 min (avertissements de dépréciation : `eslint@8`, `glob@10.3`, `recharts@2`) |
| `prisma migrate deploy` sur base vide | 465 migrations, < 30 s (avec `generate`) |
| `npm run typecheck` (tas par défaut, `456c8f6`) | **OOM après 18 s** |
| `npm run typecheck` (tas 6144, `1990fbe`) | vert, 4 min 18 |
| `npm test` complet | 1 270 fichiers, 14 745 tests, **12 min 32** ; 4 échecs : `boundary` 430 > 425 et `domains` 71 > 68 (préexistants), `vue-exacte-etanche` (corrigé dans `a49ce19`, la suite avait démarré avant), `sorties-declarees` (passe seul — §5) |
| `rm -rf .next && npm run build:render` | vert, **623 s** (lint + tsc build + `next build`), 257 pages |
| `.next/server/middleware-manifest.json` | **vide** (INFRA-12) |
| Fumée `next start` | `/api/health` 200 `{"ok":true,"base":"ok"}` · `/_next/image?…` **404** · `/dashboard` anonyme 307 → `/login` |
| `npm audit --omit=dev` | 23 avis : 3 critiques, 16 hauts, 3 modérés, 1 bas |
| `prisma migrate diff` base migrée ↔ `schema.prisma` | 558 lignes (dérive connue, tenue par refonte P0) |

## 7. Correctifs commités

| Commit | Constat | Résumé |
|---|---|---|
| `edd1128` | INFRA-02 | `etape()` : chaque étape du planificateur isolée, nommée, journalisée (dédupliquée) ; garde de source |
| `0f9cdfe` | INFRA-04 | `images.unoptimized` : `/_next/image` répond 404 ; fond recompressé 990 → 125 Ko |
| `a49ce19` | INFRA-05 | `/api/health` : `SELECT 1` borné, 200/503 sans fuite ; déclarée route sans session |
| `29108f0`, `f5a9d66` | INFRA-01 | `.github/workflows/ci.yml` (verifier · tests ×4 · build) + `.nvmrc` + garde ; commentaire de durée mesurée |
| `1990fbe` | INFRA-08 | `npm run typecheck` avec plafond de tas |
