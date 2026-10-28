# Audit 08 — Architecture, structure du code et maintenabilité

> 27/10/2026 · branche `audit/architecture-code` (base `claude/hopeful-goodall-phd0nb`, `456c8f6`) · périmètre :
> arborescence, domaines et cliquets, actions, fichiers géants, duplication, code mort, nommage, couplage, tests,
> outillage. **Ce rapport est la référence d'architecture** : il rend exécutable la proposition
> `docs/architecture/refonte-donnees-et-monolithe-modulaire.md` §5, et un premier module est migré pour servir d'étalon.
>
> Toutes les mesures sont rejouables : les commandes sont citées à côté des chiffres (annexe A).

---

## 1. Synthèse

**Note du périmètre : 5,5 / 10.** Le dépôt a une vraie culture d'architecture — carte des couches L0-L3, cliquets qui
ne se relèvent pas, garde de frontière client/serveur, peu de copier-coller (65 fenêtres de 15 lignes dupliquées sur
600 000 lignes). Mais cette culture repose sur des **tests à expressions régulières** qui ne voient qu'une partie du
code, et la structure physique (un dossier `src/lib/` de 130 sous-dossiers et 261 fichiers à plat, 190 actions dans un
seul dossier, 14 fichiers de plus de 1 500 lignes) ne dit pas où vit un métier. Un nouveau développeur ne peut pas
répondre seul à « où est le module Ad & Pro ? » : il est réparti sur `lib/ad-pro/`, `lib/ad-pro-items.ts`,
`lib/ad-pro-bc-devis.ts`, `lib/promo/`, `lib/promo-material/`, 19 fichiers `actions/ad-pro-*`, `components/ad-pro/`, etc.

**Les trois risques majeurs**
1. **Les cliquets d'architecture mesurent moins que ce qu'ils annoncent** (ARCH-01, ARCH-02) : aveugles aux imports
   relatifs (le socle `rbac.ts` importait 4 fichiers de domaines, dont un cycle d'exécution — **corrigé**), et la carte
   des domaines ne couvre que 57 % de `src/lib/` ; `src/app/` et `src/components/` ne sont pas mesurés du tout.
2. **La structure est verrouillée par l'outillage lui-même** (ARCH-03, ARCH-05) : le contrat des actions est indexé par
   *nom de fichier* dans `src/lib/actions/`, et 101 fichiers de tests lisent le code source par son chemin (290 lectures
   littérales). Déplacer un fichier casse des tests sans rien casser du produit : la migration modulaire coûte plus
   cher qu'elle ne devrait, et du code mort est « protégé » par ces tests.
3. **La boucle de retour est lente et fragile** (ARCH-09, ARCH-10) : `npm run typecheck` **plante en mémoire** avec le
   tas Node par défaut ; la suite complète prend 11 min 17 s, dont ≈ 70 % à *charger* des modules (un test de 0,36 s
   coûte 15 s de collecte) ; un test échoue seulement en suite complète parce que les tests partagent une base.

---

## 2. Constats

| ID | Sévérité | Catégorie | Titre | Effort | Statut |
|---|---|---|---|---|---|
| ARCH-01 | HAUTE | maintenabilité / correction des garde-fous | Les cliquets ignorent les imports relatifs ; le socle importait 4 domaines (cycle `rbac ⇄ hr/stand-in`) | S | **CORRIGÉ** `f4a70c7` |
| ARCH-02 | HAUTE | maintenabilité | La carte des domaines ne couvre que 57 % de `src/lib/` ; `app/` et `components/` hors mesure ; 128 pages parlent à Prisma | M | **PARTIEL** V3-G : 6 cliquets `platform/couverture.test.ts` |
| ARCH-03 | HAUTE | maintenabilité | 190 actions dans un dossier, contrat indexé par nom de fichier → on ne peut pas ranger une action dans son module | M | **CORRIGÉ** V3-G : `src/lib/actions/parc.ts` |
| ARCH-04 | MOYENNE | maintenabilité | 14 fichiers > 1 500 lignes, sans cliquet de taille (`assistant.ts` : 7 310 l., 94 imports) | L | PROPOSÉ |
| ARCH-05 | MOYENNE | maintenabilité / tests | 101 tests lisent le source par chemin (290 lectures) : tout déplacement casse, du code mort est « testé » | M | **PARTIEL** V3-G : adresses de réexpédition, `platform/source.ts`, cliquet (128) |
| ARCH-06 | MOYENNE | maintenabilité | 53 fichiers / 7 918 lignes injoignables depuis toute entrée ; garde d'atteignabilité limitée à 2 dossiers | S | PROPOSÉ |
| ARCH-07 | MOYENNE | outillage | ≥ 15 analyseurs d'imports réécrits à la main, couvertures divergentes (cause racine d'ARCH-01) | S | PARTIEL `f4a70c7` |
| ARCH-08 | BASSE | maintenabilité / lisibilité | Nommage : un métier, plusieurs dossiers et deux langues (`finance/`+`finances/`, `hr/`+route `/rh`, `promo*`/`ad-pro*`…) | M | PROPOSÉ |
| ARCH-09 | HAUTE | outillage | `npm run typecheck` (commande de CLAUDE.md) plante en mémoire ; ESLint sans aucune règle d'import | S | PARTIEL (règle modules) |
| ARCH-10 | MOYENNE | tests | Suite : 11 min 17 s dont ≈ 70 % de chargement ; un test dépend de l'état laissé par les autres | M | PROPOSÉ |

> **Suite — lot V3-G (28/10/2026, branche `v3/modules`).** La structure cible de §3 est exécutable et tenue :
> `lieux`, `coffre` et `referentiels` (socle métier) migrés complètement dans `src/modules/` avec leurs actions ;
> les actions du pilote `consommation` rangées ; carte des modules `src/modules/carte.ts` (règle 3 « arêtes ⊆ carte,
> sans cycle » en place) ; ARCH-03 levé (clé d'action déclarée, `parc.ts`) ; ARCH-05 désamorcé pour les
> déplacements (adresses de réexpédition dans `tsconfig.json`, aucun fichier relais) ; ARCH-02 mesuré sur `src/app/`
> et `src/components/` (`couverture.test.ts`). Mode d'emploi : [`docs/architecture/MODULES.md`](../../architecture/MODULES.md).

### ARCH-01 — Les cliquets ignorent les imports relatifs · HAUTE · **CORRIGÉ** (`f4a70c7`)

- **Preuve.** `src/platform/domains.ts` (avant correctif) : `if (!spec.startsWith("@/")) continue;` ;
  `src/platform/boundary-scan.ts:307-309` : seule la forme `@/` produisait une cible. Or `src/lib/rbac.ts:5-11` :
  ```ts
  import { activeStandInsFor } from "./hr/stand-in-resolve";
  import { pipelineAccessFor } from "./regulatory/pipeline-access";
  import { carrierAccess } from "./regulatory/assignment";
  import { DOMAINES, poleDe, type DomainePole } from "./budget/domaines";
  ```
  `rbac` est au **socle** (L0), qui « n'importe AUCUN domaine — vérifié durement, sans plafond » (`domains.ts`, en-tête).
  Mesuré en réécrivant les relatifs en `@/` sur une copie de l'arbre : **socle 0 → 4 fuites**, traversées et frontière
  inchangées. Et `hr/stand-in-resolve.ts:3` importe `rbac` : **cycle d'exécution** `rbac ⇄ hr/stand-in ⇄ stand-in-resolve`
  (le seul cycle statique de valeur du dépôt avec celui, interne, de `assistant.ts ⇄ assistant/capability-surface.ts`).
- **Scénario réel.** Un développeur ajoute à `rbac.ts` un `import { x } from "./finance/…"` : le test dit « socle 0 »,
  la revue fait confiance au test ; `userCan` (557 importeurs) tire désormais un domaine métier, et le prochain import de
  `rbac` par ce domaine crée un cycle dont l'ordre d'évaluation décide si `PERMISSIONS` vaut `undefined` au chargement.
- **Correctif appliqué.** `src/platform/imports.ts` (lecture unique : `import/export … from`, `import()`, `@/` **et**
  relatif) utilisé par les deux scanners ; les quatre règles lues par `rbac` déclarées au socle par **chemin exact**
  avec leur raison (elles n'importent que `rbac`/`prisma` ou rien, et sont désormais tenues par `scanSocle()`) ;
  test `src/platform/imports-relatifs.test.ts` qui rejoue les trois contournements sur un arbre jouet (3 rouges avant,
  verts après). Compteurs : traversées 71, frontière 430 (échecs préexistants, inchangés), socle 0.
- **Reste à faire (PROPOSÉ).** Ranger ces quatre fichiers sous `src/lib/rbac/` au découpage de `rbac.ts` et supprimer
  les exceptions ; casser le cycle `rbac ⇄ stand-in` en injectant `PERMISSIONS` dans `delegationsFor` (S).

### ARCH-02 — La carte des domaines est partielle · HAUTE · PROPOSÉ (pilote livré)

- **Preuve.** Classement de chaque fichier non-test de `src/lib/` par `domainOf()` + listes SOCLE/FAÇADES/PROVIDERS de
  `domains.ts` : **730 fichiers sur 1 709 (43 %) ne sont dans aucune couche**, donc jamais mesurés : `actions/` (190),
  `agent/` (45), `test-center/` (32), `pieces-lues/` (20), `segmentation/` (18), `budget-marketing/` (15),
  `bons-de-commande/` (14 hors `regle`/`prevalidation`), `secretariat/` (14), `kpi/` (11), `stocks/` (10)… et 261
  fichiers à plat dans `src/lib/` (dont `ad-pro-items.ts`, `ad-pro-bc-devis.ts`, `regulatory-workflow.ts` : le préfixe
  `src/lib/ad-pro/` ne les attrape pas). `scanDomains` ne parcourt que `src/lib` et `src/platform` : `src/app/`
  (≈ 1 050 fichiers) et `src/components/` (34 dossiers) ne sont pas mesurés. **128 pages sur 296** et **52 routes sur
  122** importent `@/lib/prisma` directement.
- **Scénario réel.** « Traversées inter-domaines : 71 » est lu comme l'état du couplage. Une action
  (`actions/ad-pro-item-actions.ts` : 71 imports, dont `workflow/engine`, `promo/*`, `bons-de-commande/*`, `queries/*`,
  `platform/in-process/artifact/factory`) relie six métiers sans compter pour un seul ; une page qui lit trois tables de
  trois métiers non plus. Le chiffre baisse pendant que le couplage réel monte.
- **Correctif proposé.** (1) Test-cliquet « **aucun fichier hors carte** » : chaque fichier de `src/lib/` appartient à
  exactement un domaine, au socle, à une façade ou à la liste `HORS_CARTE` figée (730 aujourd'hui, ne peut que baisser).
  (2) Étendre `scanDomains` à `src/modules/` et `src/app/` (un `page.tsx` hérite du domaine de son segment de route).
  (3) Cliquet « pages qui importent Prisma » (128 → 0, une page lit par `api.ts`). Le **module pilote** montre la cible :
  les trois pages de `/consommation` n'importent plus Prisma.

### ARCH-03 — 190 actions dans un dossier, contrat indexé par nom de fichier · HAUTE · PROPOSÉ

- **Preuve.** `ls src/lib/actions` : 309 fichiers (190 de production, 119 tests). La clé d'une action est
  `"<fichier>:<export>"` : `src/lib/assistant/action-registry.ts:1139` (`"consommation-actions:importerFichierConsommation"`),
  l'aiguillage généré `src/lib/actions/aiguillage.genere.ts:55` (`"consommation-actions": () => import("./consommation-actions")`),
  et le scanner `src/lib/actions/contrat-scan.ts:18` ne lit que ce dossier (`scripts/actions-contrat.ts:2,12`).
- **Scénario réel.** Ranger `consommation-actions.ts` dans `src/modules/consommation/actions.ts` (le geste naturel de la
  migration) : le contrat ne la voit plus, `contrat.test.ts` et `action-parity.test.ts` virent au rouge, et Adam perd
  l'action. Le pilote a dû la laisser en place. À l'échelle, **aucun module ne peut posséder ses actions** tant que
  ce point n'est pas réglé — c'est le premier verrou de la migration.
- **Déjà fait dans ce lot (`fee019c`).** Le scanner suit désormais `@/modules/…` et les réexportations d'une porte
  `api.ts` : sans cela, le pilote aurait rendu le contrat **faux** (`importerFichierConsommation` décrite comme
  n'écrivant que `auditLog`) sans qu'aucun test ne rougisse — `contrat-modules.test.ts` le tient.
- **Correctif proposé (M).** Clé d'action indépendante du chemin : `"<module>.<action>"` (ex. `consommation.importerFichier`),
  déclarée par le module dans `actions.ts` ; `contrat-scan` lit `src/lib/actions/*.ts` **et** `src/modules/*/actions.ts` ;
  une table d'alias `ancienne clé → nouvelle` garde la compatibilité de `action-registry.ts` et des traces d'audit
  (`AuditLog`) pendant la transition. Test : chaque action a une et une seule clé, chaque alias pointe une action vivante.

### ARCH-04 — Fichiers géants sans cliquet de taille · MOYENNE · PROPOSÉ

- **Preuve.** `find src -name '*.ts*' ! -name '*.test.*' | xargs wc -l | sort -rn` — 14 fichiers > 1 500 lignes :
  `lib/assistant.ts` 7 310 (94 imports, 14 exports, un bloc copié 2 fois : l. 4902 et 5517, 28 fenêtres identiques),
  `assistant/ops/catalog.ts` 5 399, `actions/ad-pro-item-actions.ts` 4 370 (47 actions exportées, 71 imports),
  `labels.ts` 2 284 (156 exports, 301 importeurs), `rbac.ts` 2 197, `assistant/action-registry.ts` 2 169,
  `components/ad-pro/items-panel.tsx` 2 148, `missions/runtime/engine.ts` 1 995, `workflow/engine.ts` 1 851,
  `platform/in-process/artifact/factory.ts` 1 846, `assistant/ops/impl-wave4b.ts` 1 597, `assistant/assistant-chat.tsx`
  1 555, `actions/care-actions.ts` 1 528, `payslip/docx-lecture.ts` 1 507.
- **Scénario réel.** Deux sessions qui touchent deux actions Ad & Pro différentes modifient le même fichier de 4 370
  lignes : conflits de fusion systématiques (le dépôt est travaillé en parallèle par plusieurs sessions) ; le typecheck
  incrémental et le HMR rechargent 71 dépendances pour une ligne changée.
- **Correctif proposé.** Cliquet `src/platform/taille-fichiers.test.ts` : plafond **par fichier** pour les 14 actuels
  (valeur mesurée, ne peut que baisser), 800 lignes pour tout autre fichier. Découpage par **cas d'usage** :
  `ad-pro-item-actions.ts` → `modules/adpro/actions/{poste,devis,bc,facture,stock}.ts` ; `labels.ts` → un fichier de
  libellés par module + `socle/navigation.ts` ; `rbac.ts` → `src/lib/rbac/{matrice,acces,delegations,annuaires}.ts`.

### ARCH-05 — Les tests lisent le source par chemin · MOYENNE · PROPOSÉ

- **Preuve.** `grep -lE 'readFileSync\(\s*["'\''`]src/|lire\(\s*["'\''`]src/' $(find src -name '*.test.ts*')` :
  **101 fichiers, 290 lectures littérales** d'un chemin `src/…`, qui assertent la présence d'un texte de code, ex.
  `src/lib/vue-exacte-etanche.test.ts:255` : `expect(lire("src/app/(app)/office/office-launcher.tsx")).toContain("lireStockagePersonnel(OFFICE_PINS_KEY, ident)")`
  — or `office-launcher.tsx` n'est importé par **aucun** fichier (ARCH-06). Idem
  `src/components/purchase/purchase-lines.test.ts:79` et `src/lib/secretariat/decision-approbation.test.ts:111` sur
  `components/purchase/purchase-section.tsx`, orphelin.
- **Scénario réel.** On supprime le code mort `office-launcher.tsx` : deux tests rouges, qui ne protègent aucun
  comportement. On déplace un fichier vers son module : N tests rouges sans régression. Le coût d'une migration est
  multiplié, et l'équipe apprend que « rouge » ne veut pas dire « cassé ».
- **Correctif proposé.** (1) Interdire les nouveaux tests de texte hors de `src/platform/` (cliquet sur le compte : 101).
  (2) Remplacer les assertions de texte par des tests de **comportement** (la fonction, pas sa source) ou, pour les
  vraies règles de structure, par une règle ESLint ou un test basé sur le graphe d'imports (`platform/imports.ts`).
  (3) Un test de texte qui pointe un fichier injoignable est supprimé avec le fichier.

### ARCH-06 — Code mort · MOYENNE · PROPOSÉ

- **Preuve.** Graphe d'imports complet (statiques, dynamiques, `require`, `vi.mock`, relatifs et `@/`) depuis toutes les
  entrées réelles (pages, layouts, routes, `middleware.ts`, `auth*.ts`, `scripts/`, `prisma/`) : **53 fichiers de
  production injoignables, 7 918 lignes** — 24 orphelins absolus (aucun importeur) et 29 importés **seulement par des
  tests**. Les plus gros : `app/(app)/courrier/mail-client.tsx` (617 l., orphelin), `lib/payslip/docx-blocks.ts` (477,
  tests seuls), `lib/assistant/voice/turn-metrics.ts` (409), `lib/cout/choix.ts` (298), `lib/ad-pro/payment-authority.ts`
  (291), `lib/scheduler/manage.ts` (268), `lib/models/workstreams.ts` (264), `lib/queries/medical.ts` (257, orphelin),
  `lib/market/produit-marche.ts` (179, orphelin), `app/(app)/regulatory/[id]/step-timeline.tsx`,
  `regulatory/enregistrement/analyse/[dossierId]/{cost,lifecycle,supplier}-panel.tsx`, `office/office-launcher.tsx`,
  `components/purchase/{purchase-section,purchase-request-form,my-purchase-requests}.tsx`, `components/charts/{projection,repartition}.tsx`.
  Liste complète : annexe B. La garde existante `src/platform/reachability.test.ts:28` ne couvre que
  `["src/lib/missions", "src/lib/artifact"]`.
- **Scénario réel.** Un développeur corrige un bogue d'affichage dans `courrier/mail-client.tsx` (617 lignes,
  vraisemblable) : rien ne change à l'écran, il cherche une heure. Un auditeur sécurité relit 7 900 lignes qui ne tournent pas.
- **Correctif proposé (S).** Supprimer les 24 orphelins après une passe de revue (une PR, les tests de texte associés
  avec) ; pour les 29 « tests seuls », brancher ou supprimer. Étendre `reachability.test.ts` à **tout** `src/` avec le
  graphe de `platform/imports.ts` et une liste d'exceptions motivées (bancs, fakes).

### ARCH-07 — Analyseurs d'imports multiples · MOYENNE · PARTIEL (`f4a70c7`)

- **Preuve.** Chaque garde réimplémente sa lecture d'imports par expression régulière : `platform/domains.ts`,
  `platform/boundary-scan.ts`, `lib/client-bundle-guard.test.ts:87` (le seul qui résolvait les relatifs),
  `lib/models/models.test.ts`, `lib/missions/horizon/architecture.test.ts`, `lib/site-web/liaison-portes.test.ts`,
  `lib/knowledge/knowledge.test.ts`, `platform/reachability.test.ts` (par `rg` sur l'alias seulement)… — au moins 15
  fichiers. Leurs couvertures divergent (relatifs, `export … from`, `require`, `import()`) : c'est exactement ce qui
  a produit ARCH-01.
- **Correctif.** Fait : `src/platform/imports.ts`, utilisé par `domains`, `boundary-scan` et `modules/frontieres.test.ts`.
  Proposé : y ajouter la résolution de fichier (extension, `index.ts`) et migrer les autres gardes ; un test interdit
  une nouvelle regex d'import hors de ce module.

### ARCH-08 — Nommage : un métier, plusieurs dossiers, deux langues · BASSE · PROPOSÉ

- **Preuve.** `finance/` et `finances/` coexistent (le commentaire de `domains.ts` l'appelle « dette historique ») ;
  budgets : `budget/`, `budget-marketing/`, `budget-campagne/`, `department-budget.ts` ; Ad & Pro : `ad-pro/`,
  `ad-pro-items.ts`, `ad-pro-bc-devis.ts`, `promo/`, `promo-material/`, `promo-automatismes.ts`, routes
  `/ad-pro`, `/centre-ad-pro`, `/promo-material`, `/stock-promotionnel` ; RH : code `hr/`, `recruitment/`, route `/rh`,
  `/recrutement`, action `recrutement-diffusion-actions.ts` à côté de `recruitment-actions.ts`. Fichiers d'actions :
  `*-actions.ts` en anglais, tests `*-flow.test.ts`, fonctions en français (`importerFichierConsommation`). 5 636 renvois
  `§118.x` dans le code pointent vers un document externe (`docs/claude-md/`).
- **Scénario réel.** « Où est la règle de clôture d'un sponsoring ? » : `ad-pro/cloture-sponsoring.ts`, mais le poste est
  dans `ad-pro-items.ts` (racine), l'écriture dans `actions/ad-pro-item-actions.ts`, le stock dans `promo/`. Chaque
  recherche coûte un `grep` et une lecture de 4 000 lignes.
- **Correctif proposé.** Règle unique, appliquée **au moment de la migration de chaque module** (jamais en renommage de
  masse) : dossiers de module = **nom métier français, singulier, kebab-case** (`adpro`, `finances`, `rh`, `regulatory`
  reste tel quel car c'est le nom de la fonction dans l'entreprise) ; un module = un dossier ; code (fonctions,
  variables) en français comme aujourd'hui ; termes techniques transverses en anglais toléré (`api.ts`, `infra/`).

### ARCH-09 — Outillage : typecheck qui plante, lint sans règle d'import · HAUTE · PARTIEL

- **Preuve.** `npm run typecheck` (= `tsc --noEmit`, la commande prescrite par `CLAUDE.md`) avec le tas par défaut de
  cette machine (`heap_size_limit` 2 198 Mo, 15 Go de RAM) : **`FATAL ERROR: Reached heap limit … Aborted`**. Avec
  `--max-old-space-size=6144` : **0 erreur en 271 s**. `build:render` le sait déjà (5 120 Mo, `package.json`),
  `typecheck` non. `.eslintrc.json` : `next/core-web-vitals` + trois règles désactivées ; aucune règle d'import,
  `eslint-plugin-import` est pourtant installé. Toute l'architecture repose sur `vitest`, dont la suite complète exige
  Postgres (sinon 397 suites passent en `describe.skip` — KB 01 R15).
- **Scénario réel.** Une session suit `CLAUDE.md`, lance `npm run typecheck`, obtient un *abort* sans diagnostic et
  pousse sans typecheck — le build Render, lui, le fait et échoue.
- **Correctif.** Fait : règle `no-restricted-imports` pour les modules (porte `api` obligatoire, `domaine/` pur),
  vérifiée par mutation. Proposé (S) : `"typecheck": "NODE_OPTIONS=--max-old-space-size=6144 tsc --noEmit"` ;
  `import/no-cycle` limité à `src/modules/**` (coût maîtrisé) ; script `npm run verifier` = typecheck + lint + tests
  d'architecture (`src/platform`, `src/modules`) en < 2 min, sans base.

### ARCH-10 — Suite de tests lente, état partagé · MOYENNE · PROPOSÉ

- **Preuve.** Suite complète (Postgres 16 local, 4 vCPU) : **677 s, 1 267 fichiers, 14 737 tests, 3 échecs**. Somme des
  durées *d'exécution* des fichiers : 795 s ; temps-travailleur disponible : 4 × 677 = 2 708 s → **≈ 70 % du temps passe
  à transformer et charger des modules**. Exemple isolé : `sorties-declarees.test.ts` = *collect 15,09 s, transform
  10,22 s, tests 0,36 s*. Les 3 échecs : `boundary.test.ts` et `domains.test.ts` (préexistants, connus) et
  `platform/in-process/missions/sorties-declarees.test.ts` — **vert seul, rouge en suite** (« gmail_search : le compte
  Google d'Adam n'est pas connecté ») : il dépend de lignes laissées en base par un autre fichier. 485 fichiers de tests
  importent Prisma et partagent **une** base ; 258 utilisent `vi.mock`.
- **Scénario réel.** Une session voit 1 rouge sur 14 737, le relance seul, il passe : elle conclut « flaky » et passe
  outre. Le jour où le rouge est vrai, il ressemble à celui-là (le dépôt le dit lui-même dans `vitest.config.ts`).
- **Correctif proposé.** (1) Les tests de `domaine/` n'importent rien de lourd → ils tournent en millisecondes : la
  migration modulaire **est** l'accélération (le pilote : 16 tests en 27 ms). (2) Projet Vitest séparé `unit`
  (sans base, `src/modules/*/domaine/**`, `src/platform/**`) et `integration` (base). (3) Une base (schéma) par
  travailleur Vitest (`DATABASE_URL` suffixé par `VITEST_POOL_ID`) pour supprimer l'état partagé. (4) Corriger
  `sorties-declarees.test.ts` pour poser lui-même l'état du compte Google qu'il suppose.

### À vérifier (soupçons non démontrés)

- Le cycle de 401 fichiers du graphe *dynamique* (`actions/aiguillage.genere.ts` charge paresseusement toutes les
  actions, qui atteignent `assistant.ts`, qui atteint l'aiguillage) : sans effet d'exécution observé (imports
  paresseux), mais il interdit tout découpage du bundle serveur par module. À mesurer au build.
- `google/oauth.ts` ↔ `mail/oauth.ts`, `drive/depot-direct.ts` ↔ `documents-depot-direct.ts`,
  `models/openai.ts` ↔ `models/openai-responses.ts` : 8 à 10 fenêtres de 15 lignes identiques chacun. Duplication
  probablement voulue (deux fournisseurs), à confirmer avant de factoriser.
- 20 % des lignes de production sont des commentaires (121 455 / 606 896) ; dans `rbac.ts` 52 %, `domains.ts` 59 %.
  C'est une force (le *pourquoi* est écrit) tant que le commentaire reste vrai ; aucun outil ne le vérifie.

---

## 3. Restructuration proposée — le monolithe modulaire, exécutable

### 3.1 Principes (repris de la proposition §5, précisés)

1. **Un module = un dossier** `src/modules/<module>/` qui possède ses tables, ses règles, ses écrans et ses actions.
2. **Une seule porte** : `api.ts` (serveur). Rien d'autre n'est importable du dehors, sauf `ecrans/*` depuis `src/app/`.
3. **Un domaine pur** : `domaine/` ne touche ni base, ni Next, ni Node, ni React. C'est là que vivent les règles, et
   c'est là que les tests sont rapides.
4. **Les dépendances entre modules forment un graphe orienté sans cycle, déclaré** (`src/modules/carte.ts`), vérifié
   par test. Communication par `api.ts` (synchrone) ou par événement (`BusinessEvent` → événements typés avec outbox).
5. **`src/app/` ne contient que des routes minces** : garde de droits, appel à `api.ts`, rendu d'un écran du module.
6. **Le socle** (`src/lib/{prisma,session,rbac,audit,utils,…}`, `components/ui`, `components/shared`) n'importe aucun
   module. Les référentiels (personnes, organisations, lieux, produits, pièces, coffre — proposition §3) sont des
   **modules du socle** : tout le monde les lit, eux ne lisent personne.

### 3.2 Arborescence cible

```
src/
├── app/                          # Next.js : routes MINCES seulement (page.tsx, route.ts, layout.tsx)
│   └── (app)/consommation/page.tsx   → requireModule() + api.ts + <EcranDuModule/>
├── modules/
│   ├── carte.ts                  # graphe déclaré : quel module a le droit de lire quel autre
│   ├── frontieres.test.ts        # tient les règles ci-dessous (zéro, sauf dette héritée nommée)
│   ├── consommation/             # ← PILOTE MIGRÉ (voir 3.4)
│   │   ├── README.md             # rôle, tables possédées, porte, consommateurs (10 lignes)
│   │   ├── api.ts                # porte serveur : commandes, requêtes, types publics
│   │   ├── actions.ts            # "use server" : FormData → commande (après ARCH-03)
│   │   ├── evenements.ts         # événements publiés (types) — quand le module en émet
│   │   ├── domaine/              # pur : règles + leurs tests (millisecondes)
│   │   ├── infra/                # Prisma, fichiers, fournisseurs ; requetes.ts pour les écrans
│   │   └── ecrans/               # composants React du module ("use client" ou serveur)
│   ├── produits/  annuaires/  personnes/  organisations/  pieces/   # référentiels (socle métier)
│   ├── adpro/  finances/  bons-de-commande/  rh/  regulatory/  legal/  drive/  courrier/ …
│   └── adam/                     # en dernier (proposition §5.7), au-dessus de tous
├── lib/                          # SOCLE uniquement à terme : prisma, session, rbac/, audit, utils, crypto, storage…
├── components/{ui,shared}/       # kit d'interface du socle
└── platform/                     # contrat Adam ↔ ERP, scanners d'architecture (imports.ts)
prisma/schema/<module>.prisma     # P0 de la proposition : un fichier de schéma par module (prismaSchemaFolder)
```

### 3.3 Règles d'import — comment elles sont tenues

| Règle | ESLint (éditeur, `next lint`, build Render) | Test (`npm test`, imports relatifs compris) |
|---|---|---|
| Hors d'un module : seulement `@/modules/<m>/api` (ou `ecrans/*` depuis `src/app/`) | `no-restricted-imports` `@/modules/*/{domaine,infra}/**` — **en place** | `frontieres.test.ts` règle 1 — **en place** |
| `domaine/` pur | override `src/modules/*/domaine/**` : `@/lib/prisma`, `xlsx`, `next/*`, `react`, `node:*`, `../infra/*` — **en place** | règle 2 — **en place** |
| Module → module seulement par `api` et selon `carte.ts` | idem règle 1 | règle 1 + (à ajouter) arêtes ⊆ `carte.ts`, sans cycle |
| Le socle n'importe aucun module | — | règle 4 — **en place** ; `scanSocle()` pour `src/lib` |
| Dette héritée module → ancien `src/lib/` | — | `DETTE_HERITEE` exacte, ne peut que rétrécir — **en place** |
| Taille, pages sans Prisma, fichiers hors carte | — | cliquets à ajouter (ARCH-02, ARCH-04) |

Configuration en place (`.eslintrc.json`) :

```json
"no-restricted-imports": ["error", { "patterns": [{
  "group": ["@/modules/*/domaine", "@/modules/*/domaine/*", "@/modules/*/infra", "@/modules/*/infra/*",
            "**/modules/*/domaine/*", "**/modules/*/infra/*"],
  "message": "Un module s'importe par sa porte : @/modules/<module>/api …" }] }],
"overrides": [{ "files": ["src/modules/*/domaine/**"], "rules": { "no-restricted-imports": ["error", {
  "paths": [{ "name": "@/lib/prisma" }, { "name": "xlsx" }],
  "patterns": [{ "group": ["next/*", "react", "node:*", "../infra/*", "../ecrans/*", "../api"] }, …] }] } }]
```

Pourquoi les deux : ESLint parle **dans l'éditeur** et bloque le build Render (`build:render` lint d'abord) ; le test
voit ce qu'ESLint ne voit pas (relatifs qui sortent du module, dette héritée exacte, appartenance au graphe déclaré).

`carte.ts` (à ajouter avec le 2ᵉ module) :

```ts
/** Qui peut lire qui. Un module absent de la liste des dépendances d'un autre lui est INTERDIT. */
export const CARTE = {
  produits: [],                       // référentiel : ne lit personne
  annuaires: [],
  consommation: ["produits", "annuaires"],
  segmentation: ["consommation", "produits", "annuaires"],
} as const satisfies Record<string, readonly string[]>;
```

### 3.4 Exemple complet : le module `consommation` (migré dans ce lot)

Choisi parce qu'il est **isolé** (4 importeurs externes : `segmentation/service.ts`, `queries/vue-360.ts`,
`actions/consommation-actions.ts`, trois pages) et **complet** (règles pures, base, fichiers Excel, écrans client,
actions, consommateurs).

| Avant | Après |
|---|---|
| `lib/consommation/{lecture,resolution,affinite}.ts` | `modules/consommation/domaine/{lecture,resolution,affinite}.ts` (+ `lireConfig`, pure, sortie de l'infra) |
| `lib/consommation/service.ts`, `affinite-service.ts` | `modules/consommation/infra/{imports,affinite}.ts` |
| Prisma dans les 3 pages (listes, comptes, regroupement « à revoir » de 25 lignes dans le JSX) | `infra/requetes.ts` (lectures) + `domaine/revue.ts` (`groupesARevoir`, **testé**, pur) |
| `app/(app)/consommation/{televerser,[id]/revue,affinite/config-form}.tsx` | `modules/consommation/ecrans/{televerser,revue,config-affinite}.tsx` |
| importeurs : `@/lib/consommation/service` … | `@/modules/consommation/api` |

La porte (`src/modules/consommation/api.ts`) :

```ts
// ── Commandes (écritures) ──
export { importerConsommation, confirmerCorrespondance, ignorerLigne, validerImport, annulerImport,
  type ResultatAnalyse } from "./infra/imports";
// ── Requêtes (lectures) ──
export { listerImports, lireImport, lignesDeLImport, groupesDeLImport, referentielsDeRevue,
  produitsEtConfigsAffinite, nomsEtablissements, STATUTS_LIGNE, type StatutLigne } from "./infra/requetes";
export { lignesDuMarche, affinitesEtablissements } from "./infra/affinite";
// ── Règles pures utiles aux autres modules ──
export { calculerAffinites, lireConfig, PERIODE_LABELS, type ConfigAffinite, type TypePeriode } from "./domaine/affinite";
export type { GroupeARevoir } from "./domaine/revue";
```

Une page devient (extrait de `app/(app)/consommation/page.tsx`) :

```ts
export default async function ConsommationPage() {
  const user = await requireModule("CONSUMPTION");          // 1. droits
  const imports = await listerImports();                    // 2. api du module
  return <…><TeleverserConsommation /> …{i.sures}…</…>;     // 3. écran du module
}
```

Ce qui reste volontairement hors du pilote (et pourquoi) : l'action serveur (ARCH-03) ; la lecture de
`MedicalInstitution`/`Product` dans `infra/requetes.ts` et les imports de `medical/directory-sheet` et
`products/identity` — **dette héritée nommée** dans `frontieres.test.ts`, qui disparaîtra quand `annuaires` et
`produits` auront leur `api.ts`. Le module n'est pas ajouté à `DOMAINS` : ses dépendances vers `src/lib/` sont
mesurées par sa propre liste exacte, sans fausser le compteur de traversées historique.

### 3.5 Plan de migration — module par module, chaque étape livrable seule

**Étape 0 — Lever les verrous (avant tout autre module ; ~1 semaine).**
1. ARCH-03 : clé d'action `<module>.<action>` + scan multi-racines + alias. *Sans cela, aucun module ne possède ses actions.*
2. ARCH-07 : tous les gardes lisent les imports par `platform/imports.ts`.
3. ARCH-05 : cliquet sur les tests de texte (101, décroissant) ; règle : un déplacement de fichier met à jour ou
   supprime le test de texte dans le même commit.
4. ARCH-09 : `typecheck` avec tas explicite ; `npm run verifier` (typecheck + lint + `src/platform` + `src/modules`).
5. Cliquets « fichiers hors carte » (730), « pages qui importent Prisma » (128), « taille » (14 plafonds).
6. P0 de la proposition : `prisma/schema/<module>.prisma` (sans changement de données).

**Recette d'une migration de module (½ à 3 jours selon la taille) — un commit par puce.**
1. Lister le périmètre : `npm run graphify:query -- "<symbole>"`, fichiers de `src/lib/<m>*`, actions, écrans, pages.
2. `git mv` des fichiers purs vers `domaine/`, des fichiers Prisma vers `infra/`, des composants vers `ecrans/`
   (garder les noms : l'historique suit).
3. Écrire `api.ts` en réexportant **seulement** ce que les importeurs externes utilisent (le compilateur les liste).
4. Remplacer les imports externes par `@/modules/<m>/api` ; sortir Prisma des pages vers `infra/requetes.ts`.
5. Déplacer `actions` vers `modules/<m>/actions.ts` (après étape 0) ; `npm run actions:contrat`.
6. Renseigner `DETTE_HERITEE` avec ce que `frontieres.test.ts` mesure, et `CARTE`.
7. Vérifier : `npm run typecheck`, `npx next lint`, `rm -rf .next && npm run build` (des composants client ont bougé),
   `npx vitest run src/modules src/platform src/lib/client-bundle-guard.test.ts <importeurs>`.
8. Mettre à jour la KB (chapitre du métier), le README fonctionnel et `graphify:refresh` en fin de lot.

**Ordre** (celui de la proposition §5.7, précisé par le couplage mesuré) :

| Vague | Modules | Pourquoi dans cet ordre |
|---|---|---|
| 1 — référentiels | `produits` (`products/`, `market/`), `annuaires` (`medical/`, `directory/`, `contacts/`, `annuaires/`), `personnes`, `organisations` | Tout le monde les lit ; ils effacent la dette héritée des suivants (le pilote dépend déjà de `produits` et `annuaires`) |
| 2 — petits métiers isolés | `segmentation`, `kpi`, `qualite`, `sfe`, `coaching`, `stocks`, `courrier` | 5 à 30 importeurs chacun : rodent la recette |
| 3 — pièces | `pieces` (`pieces-lues/`, `documents`, `lecture-pieces-ia`), `drive` | Socle du moteur d'enrichissement (proposition E) |
| 4 — gros métiers | `bons-de-commande`, `finances` (`finance/`+`finances/`+`payments/`+`budget*`), `adpro` (`ad-pro*`, `promo*`), `rh`, `regulatory`, `legal` | Couplés entre eux : le graphe `carte.ts` se dessine ici ; découpage des fichiers géants au passage |
| 5 — Adam | `assistant/`, `agent/`, `missions/`, `models/` | En dernier : il consomme tous les `api.ts` — la frontière Adam ↔ ERP devient « Adam n'importe que des `api.ts` » |

**Ce qu'on gagne, mesurable :** (1) « où est X ? » = un dossier ; (2) les tests de règles en millisecondes (pilote :
16 tests en 27 ms contre 15 s de collecte pour un test d'action) ; (3) des conflits de fusion localisés à un module ;
(4) des cliquets qui mesurent **tout** le code, pas 57 % ; (5) la possibilité, à terme, d'un worker séparé
(proposition §5.4) qui n'importe que les `api.ts` dont il a besoin.

---

## 4. Bonnes pratiques à graver

| Règle | Mécanisme | État |
|---|---|---|
| Un module s'importe par `api.ts` ; `domaine/` est pur | ESLint `no-restricted-imports` + `src/modules/frontieres.test.ts` | **en place** |
| Un garde d'architecture lit les imports par `src/platform/imports.ts`, relatifs compris | `imports-relatifs.test.ts` ; à ajouter : test interdisant une autre regex d'import | **partiel** |
| Aucun fichier de `src/lib/` hors carte (ni domaine, ni socle, ni façade) | cliquet `HORS_CARTE` (730 → 0) | à faire |
| Une page ou une route n'importe pas Prisma | cliquet (128 pages / 52 routes → 0) | à faire |
| Taille : ≤ 800 lignes par fichier ; les 14 géants ne grossissent pas | `taille-fichiers.test.ts` (plafond par fichier) | à faire |
| Aucun code injoignable | `reachability.test.ts` étendu à tout `src/` (graphe de `imports.ts`) | à faire |
| Pas de nouveau test qui lit le source par chemin hors `src/platform/` | cliquet sur le compte (101) | à faire |
| `npm run typecheck` passe sur une machine standard | tas explicite dans le script | à faire |
| Un test d'intégration pose lui-même l'état qu'il suppose ; une base par travailleur | revue + `VITEST_POOL_ID` | à faire |
| Nommage : un métier = un dossier de module, nom français kebab-case ; jamais de renommage de masse, seulement à la migration | convention (README de module) | proposé |
| Chaque module a un `README.md` de 10 lignes (rôle, tables, porte, consommateurs) | `frontieres.test.ts` peut l'exiger | proposé |

---

## 5. Vérifications de clôture

- `npx vitest run src/platform src/modules src/lib/client-bundle-guard.test.ts src/lib/segmentation src/lib/actions/contrat.test.ts src/lib/assistant/action-parity.test.ts src/lib/actions/use-server-exports.test.ts`
  → seuls `boundary.test.ts` (430 > 425) et `domains.test.ts` (71 > 68) échouent, **préexistants et inchangés**.
- `npx next lint` : ✔ aucune erreur (75 s). `tsc --noEmit` (tas 6 Go) : 0 erreur (271 s).
- `npm run actions:contrat` : `contrat.genere.json` régénéré **identique** (1 166 actions).
- `rm -rf .next && npm run build` (tas 6 Go) : ✓ compilé, 639 s ; `/consommation`, `/consommation/[id]`, `/consommation/affinite` générées.

---

## Annexe A — commandes de mesure

- Fichiers et lignes : `find src \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' | wc -l` (2 898) ; tests : 1 267.
- Hors carte : `domainOf()` + listes SOCLE/FAÇADES/PROVIDERS de `src/platform/domains.ts` sur chaque fichier de `src/lib`.
- Graphe, cycles (Tarjan), atteignabilité, fan-in : script Node sur `import/export from`, `import()`, `require`,
  `vi.mock`, résolution `@/` et relative, entrées = pages/layouts/routes/middleware/auth/scripts/prisma.
- Fan-in (importeurs de production) : `prisma` 931, `session` 662, `rbac` 557, `utils` 484, `ui/button` 355, `labels` 301, `audit` 240.
- Duplication : fenêtres de 15 lignes normalisées (hors commentaires, imports, accolades) hachées.
- Suite : `npm test -- --reporter=json` (677 s) ; collecte isolée : `npx vitest run <fichier>`.

## Annexe B — fichiers injoignables (lignes · nature · chemin)

```
617 orphelin    src/app/(app)/courrier/mail-client.tsx
477 tests-seuls src/lib/payslip/docx-blocks.ts
409 tests-seuls src/lib/assistant/voice/turn-metrics.ts
298 tests-seuls src/lib/cout/choix.ts
291 tests-seuls src/lib/ad-pro/payment-authority.ts
268 tests-seuls src/lib/scheduler/manage.ts
264 tests-seuls src/lib/models/workstreams.ts
257 orphelin    src/lib/queries/medical.ts
251 tests-seuls src/lib/assistant/context/working-set.ts
240 tests-seuls src/lib/pieces-lues/legal-custom.ts
215 tests-seuls src/lib/assistant/voice/delivery.ts
179 orphelin    src/lib/market/produit-marche.ts
178 tests-seuls src/lib/assistant/voice/uncertainty.ts
164 orphelin    src/app/(app)/regulatory/[id]/step-timeline.tsx
159 orphelin    src/app/(app)/regulatory/enregistrement/analyse/[dossierId]/cost-panel.tsx
158 orphelin    src/app/(app)/congress-international/congress-workflow.tsx
158 tests-seuls src/components/purchase/purchase-request-form.tsx
157 orphelin    src/app/(app)/office/office-launcher.tsx
154 tests-seuls src/lib/artifact/runtime/fakes.ts            (fake de test : légitime)
154 tests-seuls src/lib/assistant/context/bench.ts           (banc : légitime)
152 orphelin    src/lib/enrichissement/types.ts
139 orphelin    src/app/(app)/produits/[id]/prix-produit.tsx
137 tests-seuls src/lib/cout/plancher.ts
132 tests-seuls src/lib/regulatory/intelligence/supplier/actions.ts
115 tests-seuls src/lib/regulatory/intelligence/lifecycle/actions.ts
113 orphelin    src/app/(app)/events/[id]/registrations-manager.tsx
109 tests-seuls src/platform/in-process/cout/index.ts
107 orphelin    src/app/(app)/regulatory/enregistrement/analyse/[dossierId]/lifecycle-panel.tsx
100 orphelin    src/app/(app)/regulatory/enregistrement/analyse/[dossierId]/supplier-panel.tsx
 95 orphelin    src/components/charts/projection.tsx
 93 tests-seuls src/lib/assistant/context/holdout-corpus.ts  (corpus de test : légitime)
 91 tests-seuls src/components/purchase/my-purchase-requests.tsx
 85 orphelin    src/components/purchase/purchase-section.tsx
 78 tests-seuls src/lib/finance/attribution-produit.ts
 76 tests-seuls src/lib/ad-pro/authority-holders.ts
 71 tests-seuls src/lib/agent/testing/modele-factice.ts      (fake de test : légitime)
 65 orphelin    src/app/(app)/courrier/connect-mailbox.tsx
 65 tests-seuls src/lib/regulatory/intelligence/supplier/draft.ts
 58 orphelin    src/app/(app)/budgets/budgets-table.tsx
 58 orphelin    src/lib/queries/attribution-produit.ts
 53 tests-seuls src/lib/agent/agent.ts
 53 tests-seuls src/lib/regulatory/intelligence/lifecycle/impact.ts
 52 orphelin    src/components/meetings/jitsi-room.tsx
 50 orphelin    src/components/shared/validation-stepper.tsx
 38 tests-seuls src/lib/budget-marketing/integration-fixture.ts (fixture : légitime)
 33 orphelin    src/app/(app)/produits/[id]/repartition-bu.tsx
 28 orphelin    src/components/charts/repartition.tsx
 25 orphelin    src/lib/regulatory/intelligence/lifecycle/queries.ts
 24 tests-seuls src/lib/bons-de-commande/etat-bc-test-outils.ts (outil de test : légitime)
 24 tests-seuls src/lib/bons-de-commande/signature-test-outils.ts (outil de test : légitime)
 21 orphelin    src/lib/sandbox/index.ts
 15 orphelin    src/lib/regulatory/intelligence/supplier/queries.ts
```
(`src/platform/domains.ts`, importé par les seuls tests et scripts, est un outil d'architecture et n'est pas compté
comme mort.)
