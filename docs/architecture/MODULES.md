# Les modules — carte, portes, règles, et comment migrer un module

> Référence d'architecture : [`docs/audit/2026-10-27/08-architecture-code.md`](../audit/2026-10-27/08-architecture-code.md)
> (§3) et [`refonte-donnees-et-monolithe-modulaire.md`](refonte-donnees-et-monolithe-modulaire.md) §5.
> Ce document est le **mode d'emploi** : un développeur qui arrive doit pouvoir migrer un module seul en le suivant.
> État au 28/10/2026 (lot V3-G, puis V4 : modules `rh` et `ad-pro`).

---

## 1. L'idée en trois phrases

1. **Un métier = un dossier** `src/modules/<module>/`. On sait où il vit, on sait ce qu'il possède.
2. **Un module ne s'ouvre que par ses portes** (`api.ts`, `partage.ts`, …). Tout le reste est privé et peut
   changer sans prévenir personne.
3. **Les règles sont tenues par des machines**, pas par la bonne volonté : ESLint dans l'éditeur (et au build
   Render), et `src/modules/frontieres.test.ts` dans `npm test`, imports relatifs compris.

---

## 2. La carte des modules

Source de vérité : [`src/modules/carte.ts`](../../src/modules/carte.ts) — qui a le droit de lire qui.

| Module | Couche | Portes | Lit | Lu par | État |
|---|---|---|---|---|---|
| `lieux` | socle métier | `api.ts`, `partage.ts` | — | `referentiels`, segmentation, actions des annuaires | **migré** (V3-G) |
| `coffre` | socle métier | `api.ts` (écriture), `api-lecture.ts` (déchiffre), `partage.ts`, `actions.ts` | — | `referentiels`, actions RH/Finances/Legal, enrichissement, pont d'Adam | **migré** (V3-G) |
| `referentiels` | socle métier | `api.ts`, `partage.ts`, `actions-{personnes,organisations,reprises}.ts` | `lieux`, `coffre` | ~20 fichiers d'actions, enrichissement, pages `/personnes`, `/organisations`, `/admin/refonte-donnees` | **migré** (V3-G) |
| `consommation` | métier | `api.ts`, `actions.ts` | — | segmentation, vue 360° | **pilote** (audit 08), actions rangées au lot V3-G |
| `ad-pro` | métier | `api.ts`, `partage.ts`, `actions-*.ts` (16 clés, dont `ad-pro-item-actions` en six morceaux), `ecrans/` | `referentiels` | pages `/sponsoring`, `/congress-*`, `/events`, `/ad-pro`, `/centre-ad-pro`, `/budget-marketing`, `/promo-material` ; Adam ; consulting, secrétariat, bons de commande | **migré** (V4) — dette : 253 imports vers `src/lib/` |
| `rh` | métier | `api.ts`, `partage.ts`, `actions{,-documents,-paie,-interim,-conges-discussion}.ts`, `ecrans/` | `coffre`, `referentiels` | pages `/rh`, `/mon-dossier`, `/mon-equipe`, `/mon-espace`, `components/hr/`, Adam (actions), centre de paiement (`solderVirementPaie`) | **migré** (V4) |

```
            ┌──────────────── socle métier (lu par tous, ne lit que le socle) ────────────────┐
            │                                                                                  │
            │     lieux ◄──────────── referentiels ────────────► coffre                        │
            │                                                                                  │
            └──────────────────────────────────────────────────────────────────────────────────┘
                     ▲                    ▲                          ▲
       src/lib/* (domaines historiques), src/lib/actions/*, src/app/*, platform/in-process/*
                     (ils consomment les portes ; aucun module ne les importe en retour,
                      sauf la « dette héritée » nommée dans frontieres.test.ts)
```

**Prochains candidats** (ordre du rapport 08, §3.5) : `produits` et `annuaires` (ils effacent la dette héritée de
`consommation`), puis `segmentation`, `kpi`, `qualite`, `stocks`… ; `promo` (le stock et le dossier de matériel promotionnel, reste du pôle Ad & Pro), `finances` après (`rh` et `ad-pro` migrés au lot V4) ; Adam en dernier.

---

## 3. L'anatomie d'un module

```
src/modules/<module>/
├── README.md        rôle, portes, tables possédées, consommateurs (≈ 15 lignes) — exigé par le test
├── api.ts           PORTE SERVEUR : commandes, requêtes, types publics. Réexporte `partage.ts`.
├── api-<facette>.ts (rare) une porte serveur SPÉCIALISÉE, quand une partie ne doit pas être atteinte par tous
├── partage.ts       PORTE PURE : ne réexporte que `domaine/`. Importable partout, navigateur compris.
├── actions.ts       actions serveur ("use server"), déclarées dans `src/lib/actions/parc.ts`
├── actions-<cas>.ts (si plusieurs fichiers d'actions) — chacun garde sa clé historique
├── domaine/         règles PURES + leurs tests (millisecondes) — ni Prisma, ni Next, ni Node, ni React
├── infra/           Prisma, fichiers, fournisseurs ; `requetes.ts` = les lectures des écrans
└── ecrans/          composants React du module, importés par les pages de `src/app/` seulement
```

Rien d'autre à la racine (le test refuse un `utils.ts` qui traîne) ; rien d'autre que `domaine/`, `infra/`, `ecrans/`
comme sous-dossiers. Des sous-dossiers **dans** `domaine/` ou `infra/` sont libres (`infra/personnes/`, `infra/reprises/`).

### Quelle porte importer ?

| Je suis… | J'importe | Exemple |
|---|---|---|
| un composant client (`"use client"`) | `@/modules/<m>/partage` (règles pures) et `@/modules/<m>/actions` | `cartes-reprises.tsx` → `@/modules/referentiels/partage` |
| une page, une action, un service serveur | `@/modules/<m>/api` | `hr-actions.ts` → `@/modules/coffre/api` |
| le `domaine/` d'un autre module | `@/modules/<m>/partage` **seulement** | `referentiels/domaine/coordonnees.ts` → `@/modules/lieux/partage` |
| une page de `src/app/` qui rend un écran du module | `@/modules/<m>/ecrans/<écran>` | `consommation/page.tsx` → `@/modules/consommation/ecrans/televerser` |
| un fichier du **même** module | un chemin relatif (`../domaine/x`) | `infra/requetes.ts` → `../domaine/revue` |

### Pourquoi une porte peut se dédoubler : l'exemple du coffre

Les actions serveur sont atteignables par l'assistant (Adam les appelle). Si le coffre n'avait qu'une porte qui
réexporte aussi le déchiffrement, une action qui l'importe pour **écrire** tirerait le déchiffrement dans le graphe
d'Adam — or un modèle d'IA ne lit jamais le coffre (décision de la Direction). D'où :

- `api.ts` : écrire (clés, chiffrement, `doubleEcrireCoffre`, contrôle d'accès). **Ne déchiffre jamais.**
- `api-lecture.ts` : tout `api.ts` **plus** le déchiffrement, le service, le journal. Écrans RH / Legal / admin.

`src/modules/coffre/frontiere.test.ts` remonte les imports depuis l'assistant et les agents et refuse tout chemin
vers ce qui déchiffre. Vérifié par mutation : ajouter `dechiffrer` à `api.ts` fait rougir deux tests.

---

## 4. Les règles, et ce qui les tient

| # | Règle | ESLint (`.eslintrc.json`) | Test |
|---|---|---|---|
| 1 | Hors d'un module : seulement ses portes (ou `ecrans/*` depuis `src/app/`) | `no-restricted-imports` : `@/modules/*/{domaine,infra}/**`, `ecrans` hors `src/app/` | `frontieres.test.ts` règle 1 |
| 2 | `domaine/` pur ; `partage.ts` ne réexporte que `domaine/` | override `src/modules/*/domaine/**` | règle 2 (un `import type` de `@prisma/client` est permis : il s'efface) |
| 3 | Module → module : déclaré dans `carte.ts`, sans cycle, sans permission morte ; un `domaine/` par `partage` | override `domaine/**` (`@/modules/*/api` interdit) | règle 3 |
| 4 | Le socle (`lib/prisma`, `session`, `rbac`, `components/ui`…) n'importe aucun module | — | règle 4 |
| 5 | Personne n'importe un **ancien chemin** | `@/lib/{coffre,lieux,referentiels}/**` signalés | règle 5 |
| — | Dette héritée module → `src/lib/` : liste EXACTE, ne peut que rétrécir | — | `DETTE_HERITEE` |
| — | Chaque action d'un module a une clé déclarée | — | `contrat.test.ts` « PARC DES ACTIONS » |

Pourquoi les deux : ESLint parle **pendant qu'on écrit** et bloque `build:render` (Render lint avant de construire) ;
le test voit ce qu'ESLint ne voit pas (imports relatifs qui sortent du module, graphe déclaré, dette exacte).

### Les cliquets autour (ils ne se relèvent jamais)

`src/platform/couverture.test.ts` — six plafonds mesurés, qui ne peuvent que baisser :

| Mesure | Avant V3-G | Après V3-G | Après V4 (`rh` puis `ad-pro`) |
|---|---|---|---|
| Fichiers de `src/lib/` dans aucune couche (jamais mesurés ailleurs) | 828 | 768 (fusion V3-C/D/E) | **722** (756 après `rh`, 754 après la décision 0011 de l'Assistant IA) |
| Pages / layouts qui importent `@/lib/prisma` | 129 | **126** | 126 |
| Routes qui importent `@/lib/prisma` | 53 | 53 | 53 |
| Imports `src/components/` (et `ecrans/` des modules) → `src/app/` (inversion) | 12 | 12 | 12 |
| Imports du kit d'interface (`components/ui`, `shared`) vers un métier | 6 | 6 | **2** |
| Tests (hors modules) qui lisent le source par un chemin `src/…` | 128 | 128 | **109** (125 après `rh`) |

Au lot V4, les écrans d'un module sont mesurés comme des composants (`couverture.ts`) : un écran déménagé ne
sort pas de la mesure. Les bancs qui parcourent les écrans (`saisie-montant`, `responsive-guard`, `cle-manquante`…)
parcourent aussi `src/modules/`.

Un chiffre qui baisse grâce à vous : **abaissez le plafond au chiffre mesuré** dans le même commit.

`src/platform/taille-fichiers.test.ts` (lot V4) : **1 000 lignes au plus** par fichier de production ; au-delà, on
découpe par responsabilité dans un dossier au nom du fichier, l'origine restant une porte qui réexporte. Le seul fichier
hérité (`payment-request-actions.ts`, paiements) est figé à sa taille ; la liste ne fait que rétrécir.

---

## 5. Les trois verrous levés (et comment ils marchent)

### 5.1 Une action a une clé, pas une adresse — `src/lib/actions/parc.ts`

La clé d'une action est `"<fichier>:<fonction>"` (`"coffre-actions:basculerCoffre"`) : registre de parité d'Adam,
contrat généré, aiguillage, traces d'audit. Elle était aussi un **chemin** (seul `src/lib/actions/` était lu).

Désormais : un fichier de `src/lib/actions/` garde sa clé implicite ; un fichier rangé dans un module se déclare
dans `ACTIONS_DES_MODULES` **avec sa clé historique**. Déménager une action ne change aucune clé — seul
`aiguillage.genere.ts` pointe le nouveau chemin (`@/modules/coffre/actions`). Preuve : après le déménagement de
`coffre-actions`, `consommation-actions` et des trois fichiers d'actions des référentiels, `contrat.genere.json` est
régénéré **identique** (1 184 actions).

Le scanner du contrat suit une porte (`api.ts` → `export { … } from "./infra/x"`, un niveau) : une action qui
appelle `doubleEcrireCoffre` par `@/modules/coffre/api` reste décrite comme écrivant `donneeSensible`.
⚠ Une porte n'exporte jamais deux fois le même nom (TypeScript le refuse) et évite les homonymes avec une action :
c'est pourquoi les écrivains `defaireFusion` des référentiels sont devenus `annulerFusionOrganisation` /
`annulerFusionPersonnes`.

### 5.2 Un fichier déménagé laisse une adresse de réexpédition — `tsconfig.json` + `src/platform/demenagements.ts`

D'autres sessions travaillent en parallèle. Une branche ouverte avant le déménagement importe encore
`@/lib/coffre/cle`. Deux remèdes classiques sont mauvais : un fichier relais à l'ancienne place empêche git de voir
le déplacement (la retouche de l'autre branche entre en conflit avec le relais au lieu de suivre le fichier) ; ne
rien laisser casse leur build.

D'où : une entrée **exacte** de `compilerOptions.paths` (`"@/lib/coffre/cle": ["./src/modules/coffre/infra/cle"]`).
TypeScript, Next.js et `tsx` la lisent nativement ; Vitest par `vitest.config.ts`, qui la dérive du même fichier.
**Aucun fichier relais** : git suit le déplacement, et la retouche parallèle atterrit dans le module.

Le code du dépôt, lui, parle la nouvelle langue dès le déménagement : la règle 5 (test + ESLint) refuse tout import
d'un ancien chemin et donne la porte à écrire à la place. **Quand retirer une adresse ?** Quand plus aucune branche
ouverte n'importe l'ancien chemin (en pratique : une à deux semaines après la fusion, à la revue de la branche
principale) — supprimer les lignes de `tsconfig.json` et les motifs correspondants de `.eslintrc.json`.

### 5.3 Un test de structure vise une règle, pas une adresse — `src/platform/source.ts`

- `lireSource("src/lib/coffre/cle.ts")` suit les déménagements ;
- `sourceDuSymbole("doubleEcrireCoffre")` lit le fichier qui **déclare** l'export (et refuse un nom ambigu).

Préférez **tester le comportement** (appeler la fonction). Pour une vraie règle de structure, ces deux portes, ou le
graphe d'imports (`platform/imports.ts` : `dependances()`, `cibleInterne()`).

---

## 6. Guide pas à pas — migrer un module

Durée : ½ à 3 jours selon la taille. **Un module à la fois**, jamais de renommage de masse (d'autres branches
vivent). Exemple suivi : le lot V3-G (`git log --oneline -- src/modules/coffre`).

### Étape 0 — Choisir et délimiter
1. Choisir un module **isolé** (peu d'importeurs, peu de dépendances) — `docs/architecture/MODULES.md` §2,
   rapport 08 §3.5. Nom : français, singulier, kebab-case (`bons-de-commande`, `rh`, `adpro`).
2. Lister son périmètre : `npm run graphify:query -- "<symbole central>"`, les fichiers `src/lib/<m>*`, ses
   actions (`src/lib/actions/<m>-*`), ses pages et écrans (`src/app/(app)/<m>/`).
3. Lister ses importeurs externes et ses dépendances :
   ```bash
   grep -rlE '@/lib/<m>(/|")' src scripts | grep -v '^src/lib/<m>/'
   grep -hoE 'from "[^"]+"' src/lib/<m> -r | sort | uniq -c | sort -rn
   ```

### Étape 1 — Classer chaque fichier
| Le fichier… | va dans |
|---|---|
| n'importe ni Prisma, ni Next, ni Node, ni React (règles, calculs, libellés, types) | `domaine/` |
| lit/écrit la base, des fichiers, un fournisseur, ou utilise `node:crypto` | `infra/` |
| est un composant React propre au module | `ecrans/` |
| est le fichier d'actions `"use server"` | `actions.ts` à la racine |
| est un test | à côté de son sujet ; un garde transversal (qui scanne tout `src/`) à la racine du module |

Un fichier pur qui importe un fichier d'infra n'est pas pur : il va en `infra/` (ou on sépare la partie pure).

### Étape 2 — Déménager (`git mv`, garder les noms : l'historique suit)
```bash
mkdir -p src/modules/<m>/{domaine,infra}
git mv src/lib/<m>/regle.ts src/modules/<m>/domaine/regle.ts
git mv src/lib/<m>/service.ts src/modules/<m>/infra/service.ts
```
Puis corriger les imports **internes** en relatif (`../domaine/regle`). Le lot V3-G l'a fait par un script qui lit
la table des déménagements et réécrit chaque import : pour un gros module, faites de même plutôt qu'à la main.

### Étape 3 — Écrire les portes
- `partage.ts` : réexporte **nommément** ce que les autres utilisent du `domaine/` (`export { a, b, type T } from "./domaine/x";`).
- `api.ts` : `export * from "./partage";` puis les commandes et requêtes de `infra/`, groupées et commentées
  (voir `src/modules/lieux/api.ts`, le plus court).
- N'exportez **que** ce que les importeurs externes utilisent (le compilateur les liste au typecheck). Un nom
  exporté est un contrat ; un nom non exporté est libre de changer.
- Un en-tête dit : le rôle, les tables possédées, qui ne doit pas importer quoi.

### Étape 4 — Réécrire les importeurs externes vers les portes
`@/lib/<m>/service` → `@/modules/<m>/api` ; un composant client → `@/modules/<m>/partage`. Fusionnez les imports
d'une même porte en une ligne.

### Étape 5 — Poser les adresses de réexpédition
Une ligne par fichier déménagé (hors tests) dans `tsconfig.json` → `compilerOptions.paths` :
```json
"@/lib/<m>/service": ["./src/modules/<m>/infra/service"],
```
Et le motif `@/lib/<m>`, `@/lib/<m>/*` dans le groupe « déménagé » de `.eslintrc.json`.

### Étape 6 — Ranger les actions
`git mv src/lib/actions/<m>-actions.ts src/modules/<m>/actions.ts`, puis dans `src/lib/actions/parc.ts` :
```ts
export const ACTIONS_DES_MODULES = { …, "<m>-actions": "src/modules/<m>/actions.ts" };
```
Dans `actions.ts`, importer le module par **`@/modules/<m>/api`** (le scanner du contrat suit les spécificateurs
`@/` et une porte, pas les relatifs). Puis `npm run actions:contrat` : `contrat.genere.json` doit rester
**identique** (`git diff --stat` ne montre que `aiguillage.genere.ts`). S'il change, une écriture n'est plus vue :
vérifier les imports de l'action. Une action **neuve** se classe en plus dans `src/lib/assistant/action-registry.ts`.

### Étape 7 — Sortir Prisma des pages
Une page du module garde les droits (`requireUser`/`requireModule`), appelle l'`api.ts`, rend. Les lectures vont
dans `infra/requetes.ts` ; une règle trouvée dans le JSX (un tri, un regroupement) va dans `domaine/` avec un test
(exemple : `referentiels/domaine/revue.ts`, l'ordre de revue des doublons, écrit deux fois avant). Abaisser le
plafond `pagesPrisma` de `couverture.test.ts`.

### Étape 8 — Déclarer
- `src/modules/carte.ts` : le module, et les modules qu'il lit.
- `src/modules/<m>/README.md` : rôle, portes, tables, consommateurs.
- `frontieres.test.ts` : lancer, puis copier dans `DETTE_HERITEE` **exactement** ce qu'il mesure (chaque entrée
  avec un commentaire : pourquoi, et quelle porte la remplacera).
- Mettre à jour les gardes qui citaient les anciens chemins (`grep -rn "src/lib/<m>" src`).

### Étape 9 — Vérifier
```bash
npm run typecheck
npx next lint
npm run test:architecture                 # frontières, carte, couverture, contrat, garde client — < 2 min
npm test                                  # la suite complète : 0 échec
rm -rf .next && npm run build:render      # des composants client ont changé d'imports
```
Puis : README fonctionnel (`docs/readme/13-carte-du-code-*`), knowledge base (chapitre du métier), cette page (§2),
et `npm run graphify:refresh` en fin de lot.

### Les pièges rencontrés (et leur parade)
| Piège | Parade |
|---|---|
| Un `sed` renomme aussi une action qui porte le même nom | Renommer l'écrivain de domaine, jamais l'action (sa clé est publique) |
| Une porte unique réexporte une partie sensible | Une seconde porte `api-<facette>.ts`, et un garde qui remonte les imports |
| `git mv` laisse des dossiers vides : le test « à moitié déménagé » rougit | `find src/lib/<m> -type d -empty -delete` |
| Un composant client importe `api.ts` → `fs`/`node:crypto` dans le navigateur | Il importe `partage.ts` ; `client-bundle-guard.test.ts` le rappelle |
| Un test lit l'ancien chemin d'un fichier | `lireSource()` (suit les adresses) ou, mieux, un test de comportement |
| Le contrat d'une action perd ses faits d'écriture | L'action importe `@/modules/<m>/api`, et `api.ts` réexporte directement depuis `./infra/x` |
| Un fichier d'actions de 4 000 lignes à découper | Une clé, plusieurs morceaux (`ACTIONS_DES_MODULES` accepte une liste) ; une action qui passe son formulaire à une autre reste dans le même morceau (le contrat suit la délégation locale) ; les aides privées communes vont dans `infra/…/commun.ts`, importées en RELATIF (invisibles au scanner, comme l'appel local d'avant) ; `actions:contrat` doit rester identique |
| Un découpage ajoute un spécificateur dans un fichier d'Adam (frontière à 422) | Regrouper dans un même morceau les actions qu'un fichier d'Adam importe ensemble |
| Un test lisait le fichier découpé | `sourceDeLaCle("<clé>")` (`parc.ts`) ou `lireSources(fichier, "dossier/")` (`platform/source.ts`) |
| Un composant du kit (`components/shared`) appelle une action du module | Le socle n'importe aucun module : le composant n'est pas du kit — il sort (les pièces liées vers `components/pieces/`) |

---

## 7. Adam, l'Assistant IA et leur socle — la frontière (lot J0, 29/10/2026)

Deux produits d'IA vivent dans le dépôt, et **aucun n'importe l'autre** (décision
[`docs/assistant/decisions/0013-jarvis-architecture.md`](../assistant/decisions/0013-jarvis-architecture.md)) :

```
   Adam (Super Admin, /chief-of-staff)                Assistant IA (chacun selon ses droits, /assistant)
   lib/assistant*, components/chief/,                 lib/agent/, app/(app)/assistant/,
   app/(app)/chief-of-staff/, app/api/assistant/,     components/assistant-beta/, app/api/assistant-ia/,
   platform/in-process/ (son pont),                   lib/actions/assistant-ia-*.ts
   lib/actions/assistant-actions.ts
                    │                                              │
                    └──────────────►  src/platform/ia/  ◄──────────┘
                                   LE SOCLE IA : n'importe ni l'un ni l'autre
              (forme d'un outil, 5 outils partagés, intentions, lectures, Drive, web,
               médias, fabrique de documents, enseignements, puits d'usage, blocs d'écran)
```

| Règle | ESLint | Test |
|---|---|---|
| L'Assistant IA n'importe pas Adam | `@typescript-eslint/no-restricted-imports` (une règle DISTINCTE de `no-restricted-imports` : un override qui la redéclarerait écraserait ses motifs) | `src/platform/ia/frontieres.test.ts` |
| Adam n'importe pas l'Assistant IA | idem | idem |
| Le socle n'importe ni l'un ni l'autre — zéro, sans exception | idem | idem |
| Ce qui reste est une liste EXACTE (`RESIDUS`), qui ne peut que rétrécir | — | idem |
| Le socle connaît l'ERP (comme le pont) : sa dette est comptée À PART | — | `boundary.test.ts` (`SOCLE_IA_CEILING`), `domains.ts` (couche « socle IA ») |

**Résidus nommés** (phase B, avec le déménagement de `lib/agent/` en module `src/modules/assistant-ia/`) : l'action
`confirmerIntentionAssistantIA` vit dans le fichier d'actions d'Adam (la déplacer change le contrat des actions), et le test
`lib/agent/limites.test.ts` qui vérifie ce chemin.

**Un test qui exerce le socle À TRAVERS Adam** (il importe `POWER_TOOLS`, `composeWorkspace`…) reste côté Adam, à côté de
l'ancien emplacement du code : le socle n'a pas de test qui connaisse Adam.
