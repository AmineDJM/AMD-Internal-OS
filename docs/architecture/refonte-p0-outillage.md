# Refonte des données — palier P0, outillage (lot W2)

> Cadre : [`refonte-donnees-et-monolithe-modulaire.md`](refonte-donnees-et-monolithe-modulaire.md) §4, ligne « P0 Fondations ».
> Mesures du 2026-10-27, base PostgreSQL 16 locale vide migrée par `prisma migrate deploy` (465 dossiers), Prisma 5.22.0.
> Ce lot ne contient **aucune migration** et ne déplace **aucun fichier** du schéma.

Trois livrables :

1. **Contrôle de dérive** schéma ↔ base migrée — `src/lib/derive-schema/` (implémenté).
2. **Ordre de déploiement Render** — `render.yaml` (implémenté).
3. **Étude** du découpage de `schema.prisma` avec `prismaSchemaFolder` (rapport seul, §3).

---

## 1. Contrôle de dérive schéma ↔ base

### 1.1 Le problème

Le typecheck compile contre `prisma/schema.prisma` ; la production tourne sur ce que les 465 migrations SQL écrites
à la main ont construit. Rien ne comparait les deux (KB 03 §6) : un champ ajouté au schéma sans sa migration compile,
passe le build, et casse à la première requête en production. Un simple `migrate diff --exit-code` ne peut pas servir
de garde : il échoue **déjà** aujourd'hui, sur 657 lignes d'écarts dont la plupart sont voulus.

### 1.2 Le mécanisme

| Fichier | Rôle |
|---|---|
| `src/lib/derive-schema/analyse.ts` | Module **pur** : découpe la sortie `migrate diff --script` en **écarts atomiques** à clé stable (`index:Nom:DROP`, `defaut:Table.col:DROP`, `fk:Nom:ADD`, `colonne:T.c:ADD`, `table:T:DROP`, `index:A->B:RENAME`…), puis `juger()` les compare aux exceptions. |
| `src/lib/derive-schema/exceptions.ts` | La liste des écarts **connus**, chacun avec sa raison, groupés par nature ; plus deux **règles** (familles tolérées sans énumération). |
| `src/lib/derive-schema/derive-schema.test.ts` | Tests purs de l'analyseur (toujours joués) + le contrôle réel contre la base (sauté sans base). |

Pourquoi des clés et pas le texte du diff : Prisma regroupe les clauses d'un même `ALTER TABLE` et ordonne les tables à
sa façon ; ajouter un modèle ailleurs déplacerait toutes les lignes. Une clé par clause est stable.

Le test réel :

1. **sauté proprement** si la base n'est pas joignable ou pas locale (`describe.skipIf`, même convention que les autres
   bancs ; `prisma.ts` refuse déjà toute base de tests distante à l'import) ;
2. vérifie d'abord que **toutes les migrations du dépôt sont appliquées** (`_prisma_migrations`) — sinon il mesurerait le
   retard de la base locale, pas la dérive — et nomme le remède (`npm run db:deploy`) ;
3. lance `node_modules/.bin/prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script`
   (≈ 2 s) ;
4. **échoue** sur tout écart qu'aucune exception ni règle ne couvre (« DÉRIVE NOUVELLE », avec la clé et la clause SQL),
   **et** sur toute exception qui ne correspond plus à rien (« EXCEPTION PÉRIMÉE » : la dette a été soldée, retirer la
   ligne). Le second sens empêche la liste de devenir un cimetière.

Garde-fous de l'analyseur : un écart que l'analyseur ne sait pas nommer est classé `autre` et **aucune règle ne peut le
couvrir** (testé avec une règle « tout accepter ») ; chaque exception doit porter une raison (> 20 caractères) et n'être
listée qu'une fois.

**Vérifié par sabotage** : ajout d'un champ `champSansMigration String?` à `SfeSettings` dans le schéma → le test échoue
avec `colonne:SfeSettings.champSansMigration:ADD` ; schéma restauré → vert.

**Concurrence sous `npm test`** : `legal/facture-reprise.test.ts` remonte, dans `public` et hors transaction, l'ancienne
table `Invoice` et son enum le temps de son `beforeAll`. Si le diff tombe dans cette fenêtre, il les voit. Une règle
`banc-facture-reprise` les tolère (une exception serait déclarée périmée à chaque passage normal). Les autres bancs qui
jouent du DDL le font dans une transaction annulée ou dans des tables `TEMP` : invisibles d'une autre connexion.

### 1.3 Les écarts actuels, mesurés et classés

`migrate diff` rend 657 lignes, soit **223 écarts atomiques**. Aucun n'est « nouveau » au moment du lot.

| # | Nature | Écarts | Classement | Ce qu'il faudrait pour le solder |
|---|---|---:|---|---|
| A | `updatedAt` : le SQL pose `DEFAULT CURRENT_TIMESTAMP`, Prisma gère `@updatedAt` côté client | 120 | **Voulu** — règle `updatedAt-defaut-sql` (toute nouvelle table suit la même convention) | Rien |
| B | Index GIN trigramme / plein texte (`*_trgm`, `*_tsv_idx`, `search_idx`) | 8 | **Voulu** — inexprimable en Prisma 5 | Rien |
| C | Colonnes `tsvector` (`RegulatoryExtraction.tsv`, `RegulatorySourceSection.search_vector`) | 2 | **Voulu** — type non supporté | Rien |
| D | Unicités **partielles** (`MissionStep_idempotencyKey_key`, `AssistantEpisode_span_key` … `WHERE … IS NOT NULL`) que le schéma déclare totales | 2 | **Voulu** — invariant présent, Prisma ne voit pas le `WHERE` | Rien |
| E | Index `AssistantEpisode` en tri `DESC` sur `endedAt`, nommés court en SQL | 4 | **Voulu** | Rien (ou `sort: Desc` + `map:` au schéma) |
| F | Tables historiques `SalesTeam`, `MailEntryLink` + `SalesRepProfile.teamId` (colonne, FK, index) | 7 | **Voulu** — aucune suppression destructive (KB 03 §6) | Un palier destructif (P6), avec accord |
| G | Index B-tree créés par migration, **absents du schéma** (`@@index` manquant) | 39 | **Dette** sans risque (l'index existe en base) | Déclarer `@@index` (sans migration) |
| H | Même index, nom court en SQL, nom Prisma par défaut au schéma (`RenameIndex`) | 8 | **Dette** | `map: "…"` au schéma (sans migration) |
| I | Même FK, même `ON DELETE`, mais le SQL omet `ON UPDATE CASCADE` (Mission*, `ExecutiveCommitment`, `OperationalTemplate`) | 18 (9 × DROP+ADD) | **Dette** sans effet : les `cuid` ne changent jamais | Migration d'alignement, ou laisser |
| J | FK posées en SQL sur des champs que le schéma garde **scalaires** (`BesoinAnnuelService` ×4, `InfluenceScore`, `PraticienRelation` ×2) | 7 | **Dette** : la base est plus stricte que le schéma | Déclarer les `@relation` (sans migration) |
| K | Défauts SQL `'{}'`/`''` sur des tableaux et un texte (`ApiClient.scopes`, `AuthorityHolder.roles/userIds`, `DriveTextIndex.textFold`, `WebhookEndpoint.events`, `WorkflowInstance.skippedSlugs`) | 6 | **Dette** sans effet : le client Prisma envoie toujours la valeur | `@default([])` au schéma |
| L | `SfeSettings.id` : `@default("global")` au schéma, absent en base | 1 | **Dette** sans effet : les deux écritures font un `upsert` à id explicite | Migration `SET DEFAULT`, ou retirer le `@default` |
| M | **`MissionInput.milestoneId`** : relation `onDelete: SetNull` au schéma, **aucune FK en base** (`20260908130000_missions_long_horizon`) | 1 | **Dette réelle** — le seul écart où la base est **plus faible** que le schéma : un jalon supprimé laisse un `milestoneId` orphelin | Migration idempotente `ADD CONSTRAINT … IF NOT EXISTS` (hors P0) |

Écart avec la KB 03 (§8, mesure du 2026-10-24 : « 123 AlterTable, 119 updatedAt ») : 124 `AlterTable` et 120 `updatedAt`
aujourd'hui — trois migrations de plus, même nature. La KB annonçait « 98 index SQL seuls » comme **borne haute** par
comparaison de noms ; le diff réel en voit 50 en `DropIndex` (B + E + F + G) et 8 renommés (H).

**À retenir pour P1** : G, H, J, K se soldent **dans le schéma seul**, sans migration (l'objet existe déjà en base) — un
bon premier exercice pour le découpage par module. M demande une migration. Chaque correction fera tomber le test en
« exception périmée » : c'est voulu, on retire la ligne dans le même commit.

### 1.4 Lancer

```bash
pg_ctlcluster 16 main start          # si arrêtée
npm run db:deploy                    # la base locale doit être à jour
npx vitest run src/lib/derive-schema # ou npm test (le contrôle en fait partie)
```

La base de tests est celle de `npm test` (`TEST_DATABASE_URL`, défaut `amd_internal_os` local). Le contrôle ne vise
jamais une base distante.

---

## 2. Ordre de déploiement Render

### 2.1 Avant

`render.yaml` — `buildCommand` :

```
npm install && npx prisma generate && npx prisma migrate deploy && npm run db:bootstrap && npm run build:render
```

avec `build:render` (`package.json:9`) = `next lint` → `tsc --noEmit -p tsconfig.build.json` → `next build`
(`TYPECHECK_SEPARE=1`), trois processus à tas plafonnés.

| Étape | Touche la base ? | Si elle échoue |
|---|---|---|
| 1. `npm install` | non | déploiement annulé, base intacte |
| 2. `prisma generate` | non | idem |
| 3. **`prisma migrate deploy`** | **oui — écrit** | migration en échec marquée dans `_prisma_migrations`, déploiement annulé |
| 4. `db:bootstrap` | oui (Super Admin) | déploiement annulé, **base déjà migrée** |
| 5. `next lint` | non | déploiement annulé, **base déjà migrée** |
| 6. `tsc` | non | déploiement annulé, **base déjà migrée** |
| 7. `next build` | non | déploiement annulé, **base déjà migrée** |
| 8. `next start` (nouvelle instance) | oui | — |

Le défaut : les étapes 5 à 7 — les plus fréquentes à échouer (une seule erreur de lint bloque tout déploiement,
§118.155 ; OOM du typecheck, §118.208) — viennent **après** l'écriture en base. Render garde alors l'ancienne instance en
service : l'**ancien code tourne sur le nouveau schéma**, pour une durée indéterminée (jusqu'au prochain déploiement
réussi). Les migrations étant additives c'est souvent sans effet visible, mais une migration de **données** qui change
une sémantique (requalification, reprise) est active avant le code qui la comprend (KB 03 §7).

### 2.2 Après

```
npm install && npx prisma generate && npm run build:render && npx prisma migrate deploy && npm run db:bootstrap
```

| Étape | Touche la base ? | Si elle échoue |
|---|---|---|
| 1. `npm install` | non | annulé, base intacte |
| 2. `prisma generate` | non | annulé, base intacte |
| 3. `next lint` | non | annulé, **base intacte** |
| 4. `tsc` | non | annulé, **base intacte** |
| 5. `next build` | **non** (mesuré, ci-dessous) | annulé, **base intacte** |
| 6. `prisma migrate deploy` | oui — écrit | annulé ; même situation qu'avant pour une migration en échec |
| 7. `db:bootstrap` | oui | annulé, base migrée (rare : idempotent, sans dépendance au code neuf) |
| 8. `next start` | oui | — |

Pourquoi tout le build passe devant, et pas seulement lint + typecheck :

- **`next build` n'a pas besoin de la base.** Mesuré : `rm -rf .next && DATABASE_URL=postgresql://amd:amd@127.0.0.1:5999/injoignable npm run build`
  → code 0 en 8 min 05, 257 pages générées, **aucune** trace de connexion ni d'erreur Prisma dans le journal. Seules
  `/login` et `/_not-found` sont statiques ; tout le reste est dynamique (`ƒ`), rendu à la requête.
- `prisma generate` reste **avant** le build : `tsc` et `next build` compilent contre le client généré à partir du
  **nouveau** schéma — ils n'ont besoin que du schéma, pas de la base.
- `db:bootstrap` lit et écrit `User` : il reste **après** les migrations, comme avant.
- Aucune variable, aucun plafond mémoire, aucun script `package.json` n'est modifié : `build:render` est appelé tel quel,
  seul son rang change. Le pic mémoire n'augmente pas (les étapes restent séquentielles ; `migrate deploy` est un petit
  binaire qui s'exécute après la libération des tas du build — `.next` reste sur disque, 277 Mo, déjà compté
  aujourd'hui puisqu'il était écrit en dernier).

Ce que l'ordre **ne** règle **pas** (inchangé, hors périmètre) :

- entre la fin de `migrate deploy` et la bascule du trafic vers la nouvelle instance, l'ancien code sert encore la base
  migrée — fenêtre de quelques secondes à minutes (démarrage + `healthCheckPath: /login`), au lieu de « jusqu'au prochain
  déploiement réussi ». Les migrations doivent rester additives (doctrine actuelle) ;
- une migration en échec à l'étape 6 laisse la ligne en échec dans `_prisma_migrations` (à résoudre à la main, comme avant).

Garde-fou futur : si une page devenait statique **et** lisait la base au build, `next build` interrogerait une base pas
encore migrée avec le client neuf. L'échec serait **franc** (build rouge, base intacte, ancien code servi) — pas une
dérive silencieuse. Le remède serait `export const dynamic = "force-dynamic"` sur la page.

Alternative écartée : `preDeployCommand` de Render (s'exécute après le build, avant la bascule) serait l'endroit
canonique pour `migrate deploy`, mais il n'est, à notre connaissance, pas proposé sur les instances gratuites
(`plan: free`) — à vérifier avant d'y passer ; et ce serait un changement du déploiement au-delà de l'ordre.

### 2.3 ⚠️ La commande du tableau de bord

Selon §118.208 (`docs/claude-md/08-versionnement-graphify-p06.md`), la commande saisie dans le tableau de bord Render a
déjà **remplacé** celle de `render.yaml` (le journal montrait un `npx next build` nu). Ce lot ne peut pas voir ce que
porte le tableau de bord aujourd'hui (KB 10 §4.1, [U]). **Action opérateur** : ouvrir *Settings → Build Command* du
service `amd-internal-os` et y recopier à l'identique la ligne de `render.yaml`. Tant que ce n'est pas fait, le nouvel
ordre n'est garanti que pour un déploiement par Blueprint.

---

## 3. Étude — découper `schema.prisma` avec `prismaSchemaFolder`

### 3.1 Ce que Prisma 5.22 fait réellement — mesuré, pas lu

La documentation de la fonctionnalité a changé plusieurs fois entre 5.15 et 6.x ; les règles ci-dessous ont été
**mesurées** dans un bac à sable (copie de `prisma/`, schéma découpé par script en `main.prisma` — en-tête, `generator`,
`datasource` — + `enums.prisma` (206 enums) + deux fichiers de modèles (218 + 219), lien vers le `node_modules` du dépôt).

| Question | Résultat mesuré |
|---|---|
| Activation | `previewFeatures = ["prismaSchemaFolder"]` dans le `generator` ; **fonctionnalité en préversion** en 5.22. |
| Découverte du schéma sans `--schema` | Si `prisma/schema.prisma` n'existe plus, la CLI charge le **dossier** `prisma/schema/` (« Prisma schema loaded from prisma/schema »). `"prisma": {"schema": "prisma/schema"}` dans `package.json` donne le même résultat, explicitement. |
| Références croisées | Modèles, enums et relations répartis sur 4 fichiers : `prisma validate` → valide. |
| **Emplacement des migrations** | Résolu comme `dirname(chemin du schéma)/migrations`. Schéma = **dossier** `prisma/schema` ⇒ migrations dans **`prisma/migrations`** (inchangé ✅). Schéma = **fichier** `prisma/schema/main.prisma` ⇒ migrations cherchées dans `prisma/schema/migrations`. |
| ⚠️ Migrations mal placées | `prisma migrate deploy` affiche « No migration found », puis « No pending migrations to apply » et **sort en code 0**. Un déploiement mal configuré n'appliquerait rien **sans échouer**. |
| ⚠️ `--schema` pointé sur UN fichier du dossier | Seul ce fichier est chargé : `migrate diff --to-schema-datamodel prisma/schema/main.prisma` propose **440 `DROP TABLE`**. |
| `migrate diff` sur le dossier | `--to-schema-datamodel prisma/schema` → les **mêmes 657 lignes** qu'avec le fichier unique : le contrôle de dérive (§1) se porte en changeant un chemin. |
| `migrate deploy` sur base vide | Les 465 migrations s'appliquent depuis `prisma/migrations` (11,6 s). |
| `prisma generate` | Client généré normalement (22 s). |

**Conséquence directe** : garder le schéma en **dossier** `prisma/schema/` et les migrations **où elles sont**
(`prisma/migrations/`). Ne jamais passer `--schema` avec un fichier du dossier.

### 3.2 Ce qui lit `schema.prisma` ou `prisma/migrations` — inventaire

**Lisent `prisma/schema.prisma` (à adapter à la bascule — 9 points) :**

| Fichier:ligne | Nature | Impact |
|---|---|---|
| `src/app/api/v1/meta/entities/[entity]/route.ts:17` | **Production, à l'exécution** : l'API agent lit le schéma pour décrire une entité | **Casse en production** (ENOENT) si non adapté — le seul point critique |
| `scripts/erp-audit/run.ts:57` | Script d'audit | Casse le script |
| `src/lib/api/registry/entities.test.ts:16` | Test : registre API ↔ champs du schéma | Test rouge |
| `src/lib/actions/generique.test.ts:101` | Test | Test rouge |
| `src/lib/notifications/index-lectures.test.ts:29` | Test : index déclarés au schéma | Test rouge |
| `src/lib/ad-pro/tva-jamais-devinee.test.ts:62` | Test | Test rouge |
| `src/lib/marketing-cockpit.test.ts:48` | Test (via `lire`) | Test rouge |
| `src/lib/derive-schema/derive-schema.test.ts:127` | Contrôle de dérive (`--to-schema-datamodel`) | Passer à `prisma/schema` |
| `package.json:8,16-23` (`prisma generate`, `migrate deploy`…) et `render.yaml` (`npx prisma generate`, `migrate deploy`) | CLI sans `--schema` | Fonctionnent par découverte ; **poser `"prisma": {"schema": "prisma/schema"}`** pour ne pas dépendre de l'heuristique |

**Lisent `prisma/migrations/` (aucun changement si les migrations restent en place) :**

- Exécution : `src/lib/test-center/migration-cert.ts:28` (certification disque ↔ `_prisma_migrations`), `scripts/gen-selection-pf-migration.ts:19`.
- Contrôle de dérive : `src/lib/derive-schema/derive-schema.test.ts:112`.
- Tests qui lisent ou rejouent une migration nommée (23) :
  `references/registre.test.ts:217`, `queries/formations-visibles.test.ts:138`,
  `actions/prise-en-charge-professionnels-flow.test.ts:201`, `annuaires/archivage.test.ts:24`,
  `actions/audit-types-graphe.test.ts:53-55`, `legal/facture-reprise.test.ts:33`, `legal/facture-extraction.test.ts:26`,
  `finance/rattachement-adventum.test.ts:11`, `secretariat/decision-approbation.test.ts:140`,
  `finance/dossier-reprise.test.ts:30`, `bons-de-commande/brouillon.test.ts:62`, `ad-pro/tva-jamais-devinee.test.ts:67`,
  `ad-pro/sponsoring-direct-migration.test.ts:24`, `workflow/description-final.test.ts:28`,
  `workflow/issue-sponsoring.test.ts:63`, `workflow/parcours.test.ts:290,352`, `sfe/territoire-kam-migration.test.ts:21`,
  `promo/catalogue-supports.test.ts:27`, `budget/domaines.test.ts:69-71`, `notifications/index-lectures.test.ts:80`,
  `pieces-lues/migration-lecture-pieces.test.ts:26`, `budget-marketing/domaine.test.ts:53`,
  `platform/in-process/artifact/numerotation-depart.test.ts:207,262` (chemins relatifs à `src/lib/` sauf le dernier).

**Documentation qui nomme `schema.prisma`** (à mettre à jour au même commit, pas bloquant) : `CLAUDE.md`, `AGENTS.md`,
`docs/knowledge-base/03-*` (lignes `schema.prisma:N` — elles deviendront `prisma/schema/<module>.prisma:N`),
`docs/readme/26-*`, `audit/baseline/02-prisma.txt` (instantané, à laisser).

Graphify n'extrait que `src/` : non concerné.

### 3.3 Plan de bascule en une fois

Principe : **un seul commit** qui déplace, sans changer un caractère de modèle — vérifiable par la sortie de
`migrate diff` (identique) et par le client généré (identique).

**Avant la bascule (commits préparatoires, déployables seuls) :**

1. Introduire `src/lib/schema-prisma-source.ts` : `lireSchemaPrisma(): string` qui lit `prisma/schema.prisma` s'il existe,
   sinon concatène `prisma/schema/*.prisma` triés. Module serveur (il lit des fichiers — à ne **jamais** importer d'un
   composant client, `client-bundle-guard.test.ts` le vérifierait). Y faire passer les 7 lecteurs du tableau (route,
   script, 5 tests). Neutre tant que le fichier unique existe.
2. Poser `"prisma": {"schema": "prisma/schema.prisma"}` dans `package.json` (explicite le chemin actuel).

**Le commit de bascule :**

3. Script de découpe (jetable, non versionné ou dans `scripts/`) : chaque bloc `model`/`enum` + ses commentaires de tête
   rangé dans `prisma/schema/<module>.prisma` selon une table modèle → module alignée sur `src/platform/domains.ts`
   (les 437 modèles et 206 enums). `main.prisma` garde l'en-tête, `generator` (+ `previewFeatures`) et `datasource`.
   Les enums partagés (`EntityType`, `UserRole`…) vont dans `commun.prisma`.
4. `git rm prisma/schema.prisma` ; `package.json` → `"schema": "prisma/schema"` ; chemin du contrôle de dérive →
   `prisma/schema`.
5. Preuves avant de pousser :
   - `prisma validate` ; `prisma format` ne doit **rien** changer (sinon le découpage a abîmé un bloc) ;
   - comptes : 437 `model`, 206 `enum` sur l'ensemble des fichiers ;
   - `migrate diff --from-url <base migrée> --to-schema-datamodel prisma/schema --script` **identique octet pour octet**
     à celui d'avant (le contrôle de dérive le garantit déjà) ;
   - `migrate diff --from-schema-datamodel <ancien fichier> --to-schema-datamodel prisma/schema --script` → vide ;
   - `prisma migrate status` → « 465 migrations found » (et pas « No migration found ») ;
   - typecheck, `rm -rf .next && npm run build`, `npm test`, `next lint`.
6. Docs au même commit : `CLAUDE.md` (chemin), KB 03/10, README 26 (recette de migration : `--to-schema-datamodel prisma/schema`).

**Après** : le premier `migrate deploy` de Render doit afficher « 465 migrations found in prisma/migrations ». Si le
journal dit « No migration found », arrêter : la configuration du schéma n'est pas celle attendue (voir 3.4, R1).

### 3.4 Risques

| # | Risque | Gravité | Parade |
|---|---|---|---|
| R1 | **`migrate deploy` silencieux** : si le chemin du schéma devient un fichier (`--schema prisma/schema/main.prisma`, réglage du tableau de bord Render, script), les migrations sont cherchées dans `prisma/schema/migrations`, rien n'est appliqué, **code 0**. Les migrations suivantes ne partiraient jamais, sans alerte. | Haute | Schéma toujours désigné par le **dossier** ; contrôle de dérive (une migration non appliquée localement fait échouer le test « toutes les migrations appliquées ») ; vérifier « 465 migrations found » au premier déploiement ; ne pas déplacer `prisma/migrations`. |
| R2 | **Route d'API en production** (`meta/entities/[entity]/route.ts:17`) lit le fichier à l'exécution : ENOENT après la bascule si l'étape 1 a été oubliée. Ni le typecheck ni le build ne le voient. | Haute | Étape 1 **avant** la bascule ; `entities.test.ts` passe par le même lecteur. |
| R3 | `--schema` pointé sur un seul fichier → schéma partiel (440 `DROP TABLE` proposés par `migrate diff`). Un `db push` ou `migrate dev` dans cet état serait destructeur. | Haute (si commande manuelle) | Interdit dans `CLAUDE.md` ; `db:push`/`db:migrate` déjà proscrits (KB 03 §8). |
| R4 | **Préversion** : `prismaSchemaFolder` n'est stable qu'en Prisma 6, où la configuration des chemins passe par `prisma.config.ts` (non mesuré ici — à revérifier au moment de la montée). La montée de version devra reconfigurer explicitement le chemin des migrations. | Moyenne | Noter dans le plan de montée Prisma ; le contrôle de dérive et le « 465 migrations found » détectent l'erreur. |
| R5 | Découpage qui perd un commentaire de tête, un `///` de documentation ou un `@@map` en bordure de bloc. | Moyenne | Découpe par script sur les frontières de bloc ; `prisma format` sans diff ; `migrate diff` schéma→schéma vide ; client généré identique. |
| R6 | Conflits avec les branches parallèles qui modifient `schema.prisma` pendant la bascule (git ne suit pas un bloc déplacé vers un autre fichier). | Moyenne | Bascule **en une fois**, sur une fenêtre où les autres workers ont intégré ; rebaser les branches en rejouant leurs blocs dans le bon fichier module. |
| R7 | Références `schema.prisma:N` dans la KB et le README deviennent fausses. | Faible | Mise à jour au même commit. |
| R8 | Outils externes (extension VS Code Prisma ancienne, scripts locaux) qui supposent un fichier unique. | Faible | Vérifier l'outil concerné au moment de la bascule (non mesuré ici). |

**Avis** : faisable en une fois, sans toucher aux migrations, à condition de faire l'étape 1 d'abord (seul vrai point de
casse en production) et de toujours désigner le schéma par son **dossier**. Le risque R1 est le plus sournois : c'est
la seule configuration où une erreur de chemin ne fait **rien échouer**.
