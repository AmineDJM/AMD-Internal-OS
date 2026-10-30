### RH — quatre écrans, et les questions du quotidien

Le module était **une page à sept sections** : on y trouvait tout, sauf vite. Désormais :

| Écran | Route | Ce qu'on y fait |
|---|---|---|
| **À traiter** | `/rh` | Ce qui attend une décision : demandes RH, congés, avances, contrats à échéance. |
| **Équipe** | `/rh/equipe` | L'annuaire **cherchable** + la répartition de l'effectif (camembert). |
| **Congés** | `/rh/conges` | L'état de l'équipe **maintenant** + l'historique des décisions. |
| **Départements** | `/rh/departements` | La structure (hiérarchie, responsables, rattachements). |

**Sur le fond** — `modules/rh/infra/requetes/hr-pulse.ts` (`getHrPulse`) répond à ce que le module ignorait :

- **qui est absent aujourd'hui** (nombre sur l'effectif, motif, date de retour) — LA question
  quotidienne d'un service RH ;
- **qui part dans les 14 jours** : anticiper au lieu de constater ;
- **les échéances qu'on oublie** : fin de **période d'essai** (la renouvelée prime) et fin de
  contrat sous 60 jours, côte à côte — laisser filer une fin d'essai a des conséquences
  juridiques ;
- **les soldes de congés** les plus élevés : ce qui risque d'être reporté ou perdu ;
- **la recherche** dans l'annuaire (nom, poste, département, e-mail, téléphone — un seul champ,
  filtrage local, réponse à la frappe).

Salaire et masse salariale restent réservés aux comptes qui **valident**, comme partout ailleurs.

### Mobile — l'écran respire

Sur 375 px, chaque carte mangeait ~32 px en marges, bordures et arrondis : l'application
paraissait « boxée » au lieu de native.

- Les cartes de **premier niveau** passent **bord à bord** sur téléphone (ni bordure latérale,
  ni arrondi sur les côtés) ; les cartes **imbriquées** gardent leur cadre — c'est lui qui montre
  l'imbrication. Porté par une seule classe `page-shell` sur le conteneur de page
  (`app/(app)/layout.tsx` + `globals.css`), donc aucun composant à retoucher un par un.
- Un tableau qui déborde défile **bord à bord** ; marges de page 16 → 12 px ; ombres allégées ;
  titres compacts ; `text-size-adjust: 100%` (iOS n'agrandit plus le texte en paysage).
- **Les tiroirs deviennent des feuilles** : sur téléphone, `<Sheet>` monte du bas, arrondi en
  haut, avec une poignée, et s'arrête à 95 % de la hauteur pour qu'on voie ce qu'il y a derrière.
  Sur ordinateur, rien ne change.

### Frontière client / serveur (règle de compilation)

Un composant `"use client"` est compilé **pour le navigateur**. S'il importe — même
indirectement — un module qui lit des fichiers (`fs`, `zlib`…), la compilation de production
échoue avec **« Module not found: Can't resolve 'fs' »**. Le typecheck ne le voit pas, et un
`npm run build` local peut le rater à cause du cache `.next`.

- Les **actions serveur** (`"use server"`) ne comptent pas : Next.js les remplace par un appel
  distant. Un composant client peut les appeler librement.
- Pattern appliqué dans le code : les fonctions **pures** vivent dans un module dédié sans
  dépendance lourde — `src/lib/market/text.ts` (normalisation) et `galenic.ts` (molécule,
  dosage, forme) — tandis que `molecule.ts`, qui **lit les données**, les réexporte pour les
  modules serveur. L'explorateur de produits importe donc `galenic`, jamais `molecule`.
- **`src/lib/client-bundle-guard.test.ts`** remonte les chaînes d'import de chaque composant
  client et fait échouer `npm test` en affichant le chemin fautif, module par module.

### Graphiques — une seule palette, vérifiée

Tous les graphiques de la plateforme partagent les mêmes primitives (`src/components/charts/` :
`Donut`, `Trend`, `Bars`, `Meter`) et la **même palette catégorielle**, définie une fois dans
`palette.ts`.

- L'**ordre des teintes n'est pas décoratif** : il a été vérifié par l'outil de validation —
  écart CVD ≥ 8 sur toutes les paires voisines, écart en vision normale ≥ 15, sur le fond
  **blanc réel** de nos cartes. Ne pas réordonner.
- Trois teintes passent sous 3:1 de contraste sur blanc → règle tenue partout : **jamais la
  couleur seule**. Chaque part est reprise dans une **légende chiffrée** (qui vaut vue
  tabulaire) et décrite dans son `<title>` (info-bulle native, accessible).
- Au-delà de **6 catégories**, `foldTail` replie la queue dans « Autres » — on n'invente
  jamais une 7ᵉ teinte, indistinguable d'une existante en vision daltonienne.
- **Un seul axe** par graphique (jamais deux échelles), écart de 2 px entre tranches, marques
  fines, grille discrète. Composants **serveur** : aucun JS envoyé au navigateur.

### Intelligence marché — la maille MOLÉCULE

On cherche **par la case que l'on remplit** : **molécule**, **nom de produit**, ou
**laboratoire** (les trois se cumulent). Remplir la molécule débloque en plus l'**analyse
concurrentielle** — c'est la seule maille qui a un sens pour comparer des acteurs entre eux.

Une molécule, au sens métier, est un **triplet molécule + dosage + forme** : l'amoxicilline
500 mg gélule et l'amoxicilline 1 g injectable ne s'affrontent pas sur le même marché.

**Ce que l'analyse répond** (`src/lib/market/molecule.ts` → `analyzeMolecule`) :
- le **poids du marché** (valeur DZD/USD, volume, nombre d'acteurs) ;
- le **marché adressable** : part **ville** et part **hôpital** en %, avec les acteurs de chaque côté ;
- les **parts de marché** de chaque laboratoire, le leader, la **concentration** (HHI : > 2500 = concentré) ;
- qui est **enregistré** à la nomenclature, et surtout s'il **fabrique en Algérie ou importe** ;
- les **dosages et formes réellement présents**, pour affiner la recherche.

**Le vrai travail : réconcilier trois sources qui n'écrivent rien pareil.**

| Normalisation | Ce qu'elle résout |
|---|---|
| `moleculeStem` / `moleculeMatches` | « AMOXICILLIN » (IQVIA, anglais) ≡ « AMOXICILLINE TRIHYDRATÉE EXPRIMÉE EN AMOXICILLINE » (nomenclature). Les **sels** et l'hydratation ne font pas une molécule différente. Une association demandée exige **tous** ses composants. |
| `canonicalForm` | Décode les présentations abrégées d'IQVIA (`PD.SAC`, `P/SUS`, `FL+SOLV`, `STYL PRE REM`…). Formes non reconnues : **32,6 % → 3,8 %** de la valeur du marché. Stylos et seringues préremplies = **injectables** (c'est ainsi qu'ils s'achètent) ; bandelettes et lecteurs = **dispositifs**, pas des médicaments. L'ordre des règles est la règle métier (`GELULE` avant `GEL`, `PERFUSION` avant `INJECTABLE`). |
| `extractDosage` / `dosageMatches` | « CP.PE 875MG/ 125 MG 10 » → `875MG/125MG`. Renvoie `null` plutôt que d'inventer. |
| `labKey` | « SAIDAL » ≡ « GROUPE SAIDAL » ≡ « EPE / SPA GROUPE SAIDAL » — sans quoi le même acteur apparaissait trois fois et son origine ne se rattachait à rien. |

Saisie **assistée** (`moleculeSuggestions`, `labSuggestions`) : on ne propose que ce qui existe
réellement dans les données, les plus gros marchés d'abord. Écran : `/business-development/marche/produits`.
Tests : `src/lib/market/molecule.test.ts` (20 tests, cas tirés des données réelles).

### PCH — un appel d'offres lu par l'IA devient un tableau Excel

Téléverser le document suffit : **lecture (le texte du fichier d'abord, l'OCR seulement quand il
manque) → extraction IA des produits → enrichissement automatique de chaque ligne** par
l'intelligence marché. Avant, il fallait cliquer « Enrichir »
ligne par ligne — sur un marché de quarante produits, personne ne le faisait.

- **Nature de l'unité demandée** (`unitLabel`) : un appel d'offres ne parle pas toujours de
  comprimés — flacon, ampoule, seringue, poche, sachet. C'est ce mot qui donne son sens à la
  quantité ; sans lui on compare des flacons à des comprimés.
- **Analyse de marché par ligne** (`enrichLineById` → `analyzeMolecule`) : taille du marché,
  nombre d'acteurs, partage **ville / hôpital** en %, principaux concurrents avec leur part,
  concentration, et **production locale ou importée**. L'origine est **pondérée par le poids
  des acteurs**, pas par leur nombre : un marché à 80 % importé reste importé même s'il compte
  dix petits fabricants locaux (`dominantOrigin`).
- **Enrichir tout** (`enrichAllTenderLines`) rejoue l'analyse sur l'ensemble des lignes.
- **Export Excel** (`/api/pch/export?id=…`, `src/lib/pch-tender-export.ts`) — deux feuilles :
  - *Produits demandés* : désignation, molécule, dosage, forme, **unité demandée**, quantité,
    conditionnement, **boîtes à fournir** (arrondi au **supérieur** — on ne livre pas une
    demi-boîte), prix de référence verrouillé sur les réceptions PCH, valeur du marché à ce
    prix, et notre position ;
  - *Analyse de marché* : taille, concurrents, ville/hôpital, concentration, principaux
    acteurs, production locale ou importée.
  Les colonnes sans donnée **restent vides** : pas de demi-vérité dans le fichier qui sert à
  chiffrer une offre. Tests : `src/lib/pch-tender-export.test.ts` (11 tests).

### Pièces jointes (pattern standard)

Téléversement **en lot** (plusieurs fichiers **ou un dossier entier**, tous types sauf exécutables,
**sans limite de nombre**, **en parallèle**) : composant `components/documents/document-upload.tsx` →
route en flux `POST /api/documents/upload` → `persistUploadedDocument` (`src/lib/documents.ts`), logique
partagée avec l'action serveur historique `uploadDocument` (compat).

```ts
const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
// persistUploadedDocument(userId, { entityType, entityId, category, confidentiality, stepKey, file, maxUploadMb })
//   → validateDocumentUpload(name, size, maxMb)  (bloque seulement les exécutables ; taille réglable)
//   → clé `${ENTITY}/${id}/${randomUUID()}__${name}` ; saveFile(key, buffer) en try/catch (métadonnées quand même)
//   → prisma.document.create({ name, category, entityType, entityId, stepKey, fileKey, mimeType, sizeBytes, version, confidentiality, uploadedById })
```
Téléchargement : `/api/documents/[id]?dl=1`. Le **Drive** utilise un stockage distinct (`putBlob`/`getBlob`/`releaseBlob`
— blobs chiffrés dédupliqués + `FileVersion`). La fiche de paie utilise `EmployeeDocument` (blob Drive + `period`).

### Budgets par département — trois natures, trois responsables

Écran `/budgets/departements`. Le modèle porte **une ligne par (département, année, NATURE)** :

| Nature | Ce que ça couvre | Qui la règle |
|---|---|---|
| `OPERATING` | **Moyens généraux** — fournitures, prestations, déplacements | **Le directeur du département** (responsable ou adjoint dans l'organigramme) + l'administrateur |
| `HR` | **Masse salariale** — employés, charges, recrutement | **Les ressources humaines** (`RH:UPDATE`), exclusivement |
| `ACTIVITY` | **Budget métier** — Ad & Pro au marketing, paiement des BV au Regulatory… | **Le directeur du département** + l'administrateur (listes d'accès **séparées** de celles des moyens généraux) |
| `TRAINING` | **Budget formation** — montée en compétence de l'équipe | Les RH, doté par l'administration |

**Personne ne s'accorde son propre budget.** Une **dotation** (montant initial) ou une **rallonge**
se DEMANDE (`DepartmentBudgetRequest`) et l'administration tranche — c'est ce qui rend vérifiable
« budget fixé par les RH, validé par l'administration » au lieu d'en faire un usage. Une dotation
initiale est une rallonge partant de zéro : même geste, même circuit. Un montant accordé
**s'ajoute** au budget en cours (le remplacer effacerait silencieusement la dotation précédente).

**La consommation est réelle**, pas déduite : chaque dépense s'impute via
`DepartmentBudgetExpense`, avec sa **facture ou son bon de paiement** en pièce **obligatoire** —
sans pièce, une ligne de dépense n'est qu'une affirmation. La masse salariale fait exception : elle
se lit sur la **paie**, jamais saisie.

Le Super Admin règle les deux. **La séparation n'est pas cosmétique** : un directeur administratif n'a pas à
connaître la masse salariale pour accorder un budget de déplacement, et les RH n'ont pas à arbitrer les achats.
Comme les deux responsables **n'écrivent jamais la même ligne**, l'un ne peut pas écraser l'autre — la contrainte
`@@unique([departmentId, year, kind])` le rend structurellement impossible, avant même le contrôle applicatif, qui
vérifie le droit **par nature** (`canSetDepartmentBudget`).

- **Les deux colonnes sont CÔTE À CÔTE**, et une case non modifiable est **affichée en lecture** (cadenas) plutôt
  que masquée : c'est la seule façon de voir ce que coûte réellement un département. Ce qui est réservé, c'est
  l'écriture, pas la lecture. Qui règle quoi est **écrit à l'écran**, pas seulement appliqué en silence.
- **La masse salariale RÉELLE est calculée depuis la paie** de l'exercice (**coût employeur** de chaque ligne, repli brut + primes − retenues sur les mois d'avant ce champ — `modules/finances/domaine/payroll-cost.ts`),
  jamais saisie — un montant ressaisi dirait ce qu'on espère, pas ce qui se passe.
- **Le fonctionnement n'a volontairement PAS de colonne de consommation** : aucune dépense n'est aujourd'hui
  imputée à un département, et un chiffre inventé ressemblerait à une mesure sans en être une. La page le dit.
- `budgetHealth` distingue **« pas de budget réglé »** (`UNSET`) de **« rien consommé »** — une absence de décision
  n'est pas une bonne nouvelle. Seuils : ≥ 80 % `AT_RISK`, ≥ 100 % `OVER_BUDGET`.
- Le tableau nomme les départements par leur **chemin complet** (« Commercial › Ville »), sans quoi deux
  sous-départements homonymes de deux pôles se confondraient. Il reste dans la **portée d'entité** en cours.
**QUI Y A ACCÈS — réglé par le Super Admin, et par lui seul.** Le socle par rôle vaut *partout* ; il manquait de
quoi dire « le responsable du Commercial règle le fonctionnement DE SON département », ni plus ni ailleurs.

- **Trois portées distinctes**, parce que ce ne sont pas les mêmes personnes : **consultation**, **édition du
  fonctionnement**, **édition des employés**. On peut consulter sans rien régler.
- **Une règle par département + une règle GÉNÉRALE** (`departmentId = null`) valable pour tous. Les deux se
  **cumulent** (union, jamais intersection : intersecter ferait d'une règle de département une *restriction* de la
  règle générale). Unicité de la règle générale garantie par un **index partiel** — en SQL deux `NULL` ne s'égalent
  pas, un `@unique` ordinaire laisserait créer dix règles générales contradictoires.
- **Les autorisations s'AJOUTENT, elles ne retranchent jamais.** Poser la première ne doit pas retirer aux RH le
  budget des employés par effet de bord, et un droit qui disparaît sans qu'on l'ait demandé se diagnostique très
  mal. Pour restreindre, c'est le **droit de module** qu'on revoit. L'écran le dit, plutôt que de le laisser
  découvrir.
- **La porte de l'écran** n'est plus `requireModule("BUDGETS")` mais « droit de module **OU** une autorisation
  quelconque » : sinon une personne autorisée sur un département mais sans le module serait refoulée à l'entrée, et
  son autorisation ne servirait à rien. Les lignes qu'on n'a pas le droit de voir sont **filtrées côté serveur** —
  le montant ne transite même pas jusqu'au navigateur.
- Le droit est **revérifié à l'écriture**, sur CE département : les règles affichées à l'ouverture ont pu changer.
- La liste des rôles proposés est **dérivée de `ROLE_LABELS`**, jamais recopiée — une liste écrite à la main finit
  par proposer un rôle qui n'existe plus, et une case cochée sur un rôle fantôme n'autorise personne sans que rien
  ne le signale.
- **Fichiers** : `src/lib/department-budget.ts` (+ `.test.ts`, 28 tests), `src/lib/queries/department-budget.ts`,
  `src/lib/actions/department-budget-actions.ts`, `src/app/(app)/budgets/departements/` (`page.tsx`,
  `department-budget-table.tsx`, `access-sheet.tsx`). Modèles `DepartmentBudget`, `DepartmentBudgetAccess`.

### Budgets des pôles — Marketing, Regulatory, Operations & Sales (08/10)

**LA DÉCISION** : « un module copie de Budget, mais Budget Marketing : Ad & Pro + toutes les enveloppes que la Direction
Marketing aura développées » ; puis « un Budget Regulatory » (« Regulatory gère le budget de ses BV de 25 % et 75 % ») et
« un Budget Operations & Sales » (« la masse salariale de sa force de vente et ses dépenses hors Ad & Pro »).

- **UNE SEULE SOURCE** (`lib/budget/domaines.ts`, pur, zéro import — lu par `rbac.ts`, les requêtes et les écrans
  clients) : une enveloppe de pôle est une `BudgetEnvelope` ordinaire marquée **`domaine`** ∈ MARKETING · REGULATORY ·
  OPERATIONS (GENERAL sinon). **Budgets** (`/budgets`) lit tout et additionne — une enveloppe de pôle s'y **lit sans se
  régler** et dit où elle se gère ; chaque module de pôle ne lit que la sienne (`portee` des requêtes
  `lib/queries/budget.ts`). Mêmes écrans, mêmes requêtes (`budgets/vues-budget.tsx`, quatre portées) : rien n'est
  recopié, rien ne diverge. `lib/budget-marketing/domaine.ts` réexporte pour le Marketing (catégories Ad & Pro d'office).
- **Modules** `BUDGET_MARKETING` (`/budget-marketing` : Vue d'ensemble · Dépenses · **Demandes Ad & Pro** — chaque poste
  accordé : accordé, engagé, réglé · Réglages), `BUDGET_REGULATORY` (`/budget-regulatory` : + **BV par dossier**),
  `BUDGET_OPERATIONS` (`/budget-operations` : + **Masse salariale**) — pôles Marketing, Regulatory, Operations & Sales.
- **Droits** (`rbac.ts`) : `canViewEnvelope` / `canManageEnvelope` acceptent en plus le geste Voir / Modifier du module
  de budget **du pôle de l'enveloppe** (`peutBudgetDuPole`, `poleDe`) — le pôle n'est pas listé enveloppe par
  enveloppe, et le droit d'un pôle ne touche **jamais** l'enveloppe d'un autre ; **gouverner** (créer, régler montant /
  période, retirer) = `canGovernPoleEnvelope` (Super Admin, ou Créer / Modifier / Supprimer sur le module du pôle ; une
  enveloppe générale reste au Super Admin) ; les **listes d'accès** restent au Super Admin seul. Actions
  `lib/actions/budget-pole-actions.ts` (`createPoleEnvelope`, `updatePoleEnvelope`, `deletePoleEnvelope`, + gestes
  propres ci-dessous, `budgets/gestes-pole.tsx`). Défauts : Marketing → Direction Marketing (`PRODUCT_MANAGER`) ;
  Regulatory → Head of Regulatory (assistante réglementaire en lecture) ; Operations → directeur des opérations ;
  Direction et DG gèrent les trois ; Finances lisent les trois.
- **BV 25 % / 75 %** (`lib/budget-regulatory/bv.ts`, pur + tests ; requêtes `queries/budget-regulatory.ts`) : les deux
  bons de versement des **frais d'enregistrement ANPP** d'un dossier — BV 25 % aux étapes `bv25_req`/`bv25_pay`
  (préparation, avant la présoumission), BV 75 % aux étapes `bv75_req`/`bv75_pay` (constitution administrative,
  **avant le dépôt**). Chaque demande émet un ordre de dépense (`requestBV`, bénéficiaire ANPP, libellé « BV 25 % — REF
  DCI ») dont le règlement écrit la dépense. Catégories d'office `BV_25` / `BV_75` (`BudgetCategoryLine.cle`,
  « Compléter les catégories ») ; prévision du 75 % à partir du 25 % ; un libellé qui ne dit pas sa part est rangé à
  part, jamais deviné ; **saisir un BV payé hors circuit** (`saisirBvManuel`, `BudgetExpenseLine.regulatoryProductId`)
  et **ranger un BV** demandé ou payé dans l'enveloppe (`imputerBv`). Ce ne sont PAS les bons de versement de
  l'Information médicale.
- **Budget Regulatory simplifié (10/2026, maquette validée — remplace la vue « allégée » du 09/10)** : **3 chiffres**
  (Budget, Consommé, Restant = Budget − Consommé − Engagé), **une barre** Consommé | Engagé (hachuré) | Libre avec sa
  légende, **deux cartes** BV 25 % (payés / demandés / au total) et BV 75 % (payés / demandés / à venir), en nombre et en
  montant, et le tableau **« Dossiers (n) »**, replié, dont chaque ligne ouvre `/regulatory/<id>` (si la personne voit
  les dossiers). Règle-clé : **un BV 25 % engage tout le dossier** (frais = BV 25 % × 4) — dès qu'il est demandé ou payé,
  les 75 % restants (3 × BV 25 %) sont engagés jusqu'au paiement du BV 75 % ; un BV demandé non réglé est engagé.
  Consommé = consommé de l'enveloppe ; Engagé = max(engagé de l'enveloppe, BV demandés) + BV 75 % attendus. Règle pure
  `syntheseSimple` dans `lib/budget-regulatory/synthese.ts` (+ tests), écran `budgets/vue-regulatory.tsx`. La courbe,
  les barres par catégorie et les « Prochains BV » ont quitté l'écran (leurs règles pures restent). Même allègement
  pour **Moyens généraux** (voir sa section).
- **Masse salariale** (`lib/budget-operations/force-de-vente.ts`, pur + tests ; `queries/budget-operations.ts`) : la
  force de vente = profil KAM actif → sa BU ; sinon superviseur d'une BU ; sinon département sous le sous-département
  d'une BU ; sinon sous la Direction commerciale → « hors BU » ; **depuis le 09/10**, un salarié de la **Direction des
  opérations** (ou au rôle directeur des opérations) entre aussi, sous « Direction des opérations » ; personne d'autre. Budget de l'année (catégorie
  `MASSE_SALARIALE_FDV`, sous-catégories par BU — `businessUnitId`) face à la paie réelle (coût de
  `modules/finances/domaine/payroll-cost.ts`), BU par BU, mois par mois — **des totaux** : le détail par personne seulement pour qui voit
  les salaires (`voitLesSalaires`), une équipe d'une personne regroupée (`EFFECTIF_MINIMUM` = 2). Catégories d'office
  hors Ad & Pro : véhicules & carburant, déplacements terrain, téléphonie, logistique, formations commerciales.
- **Migrations** : `20270116090000_budget_marketing` (colonne `domaine` ; marque MARKETING les enveloppes qui ne
  couvrent que la famille Ad & Pro ; `businessUnitId` / `productId` facultatifs) et
  `20270117100000_budget_regulatory_operations` (`cle`, `businessUnitId` des catégories, `regulatoryProductId` ;
  marque REGULATORY les enveloppes générales qui ne couvrent que Regulatory ; rien n'est deviné pour les Operations).
  Idempotentes : le marquage n'a lieu qu'à la création de la colonne.

### Campagne budgétaire — Budgets 2027 (09/10)

**LA DÉCISION** (maquette validée) : chaque pôle prépare sa proposition, la soumet (v1), les valideurs l'examinent ligne
par ligne ; « à revoir » la renvoie au pôle qui resoumet (v2…) ; on arbitre, on valide, et **les enveloppes de l'année
se créent d'elles-mêmes**. Module `BUDGET_CAMPAIGN` (`/budget-campagne`, pôle Administration).

- **Une page, trois vues** (`app/(app)/budget-campagne/`) : la **Direction** (`vue-direction.tsx` — frise, tuiles,
  propositions par pôle, panneau d'examen `?examen=`), le **pôle** (`vue-pole.tsx` — ses lignes, le pré-remplissage, la
  soumission), les **réglages** (`?vue=reglages` : dates, cadrage, valideurs, seuil, rectificatif). `?campagne=`,
  `?pole=` : les liens des notifications (`lib/chemins/budget-campagne.ts`).
- **Les règles** (module PUR `lib/budget-campagne/regles.ts`, + `regles.test.ts`, `vues.test.ts`) : campagne
  Cadrage → Préparation par pôle → Revue et allers-retours → Arbitrage → Budgets ouverts (`TRANSITIONS_CAMPAGNE`,
  `verifierCloture`) ; proposition en préparation · à examiner · à revoir · acceptée (avec ajustements) · refusée ;
  décision par ligne ; une **justification** est exigée au-delà de ±5 % d'écart au réalisé (`SEUIL_JUSTIFICATION_DEFAUT`,
  réglable) et pour toute ligne nouvelle non nulle ; `diffVersions` dit exactement ce qui a changé d'une version à
  l'autre (Luna peut proposer une justification, `proposerJustificationLuna`, `lib/budget-campagne-luna.ts`).
- **Décisions de la Direction (défauts réglables)** : le **cadrage global du DG est PRIVÉ** — les pôles ne le voient
  jamais (filtré côté serveur, `vueCampagnePour`) ; on valide **à deux, DG ET Super Admin** (comité, règle « tous »,
  `issueDesVotes`, `valideursEnAttente`) ; **pas de révision après validation**, sauf si le Super Admin l'autorise,
  proposition par proposition (`autoriserRevisionProposition`, `rouvrirRectificatif`).
- **Jamais une page blanche** (`prefill.ts`) : chaque ligne part du réalisé de l'année projeté sur 12 mois ; lignes
  automatiques : masse salariale depuis la Paie (**en total seulement**, groupe < 3 salariés non chiffré pour qui ne voit
  pas les salaires), recrutements prévus, BV 25 % / 75 % des dossiers attendus, Ad & Pro par BU (tendance 6 mois).
- **Validé = ouvert** (`enveloppes.ts`, `ouvrirEnveloppeDeLaProposition`) : idempotent (une proposition porte au plus
  une enveloppe, chaque ligne retient sa catégorie) — rejoué, rien ne double ; un rectificatif met à jour les
  allocations, audité catégorie par catégorie.
- **Droits** (`rbac.ts`) : Direction et DG pilotent (Gérer), Finances lisent, Super Admin tout ; le **responsable d'un
  département** prépare SON pôle par l'organigramme (accès implicite Voir, portée bornée) ; valider = le comité nommé
  dans la campagne, pas le droit seul. Actions `lib/actions/budget-campagne-actions.ts`. Tables `BudgetCampaign`,
  `BudgetProposal`, `BudgetProposalVersion`, `BudgetProposalLine`, `BudgetProposalComment`, `BudgetProposalVote`
  (migration `20270118100000_campagne_budgetaire`).

### Organigramme, seule source — et son contrôle de cohérence (09/10)

Sociétés → départements (responsable, adjoint) → personnes (poste, N+1) se modifient **à UN endroit**. Le département
d'une personne se règle sur sa **fiche salarié** (`Employee.departmentId`) ; le libellé texte (`Employee.department`) et
le département du compte (`User.departmentId`) en **dérivent** et ne se saisissent plus : chaque geste qui change un
rattachement passe par `lib/org/source-unique.ts` (`alignerSurLaFiche`, `alignerLibellesDuDepartement` — appelés par
`modules/rh/actions.ts`, `department-actions.ts`, `org-coherence-actions.ts`). La migration `20270118100000_campagne_budgetaire`
rattrape l'existant (une fiche sans département reprend celui du compte ; libellés et comptes alignés).
**Contrôle de cohérence** (Super Admin, panneau sur `/organigramme`, `coherence-panel.tsx`) — règle pure
`lib/org/coherence.ts` (+ `coherence.test.ts`), lecture `coherence-donnees.ts` : comptes divergents, libellés périmés,
BU sans département, départements sans responsable, superviseurs de BU hors de la ligne hiérarchique de leurs KAM (le
responsable du département, sinon l'adjoint, est proposé), salariés sans département — chacun corrigé d'un clic
(`lib/actions/org-coherence-actions.ts` : `alignerCompteSurFiche`, `alignerToutSurOrganigramme`,
`rattacherBuAuDepartement`, `designerResponsableDepartement`, `appliquerSuperviseurPropose` ; Super Admin seul).

### Intelligence terrain — graphe d'influence et ROI Ad & Pro (Super Admin seul, 09/10)

Console d'administration, `/admin/intelligence-terrain` (carte depuis `/admin`), **visible uniquement par le Super
Admin** : la page renvoie tout autre rôle — Direction, DG, même avec tous les modules — **avant** de lire la moindre
donnée, et les deux actions refusent de même (`lib/influence/acces.test.ts`). Deux onglets (`?onglet=influence|roi`).

- **Influence** (« powered by Luna ») : par service hospitalier, un **graphe** (`graphe-service.tsx`) des praticiens et
  de leurs liens — **structurels** sans modèle (hiérarchie du service, pharmacie, co-orateurs ;
  `lib/influence/relations.ts`) et **proposés par Luna** depuis les rapports des délégués (suit l'avis de, élève de,
  co-orateur, comité, décide pour ; `lib/influence/extraction.ts` : la citation doit être un extrait **mot pour mot**,
  sinon la mention est jetée). Luna ne crée rien : chaque lien lu est **PROPOSÉ**, le Super Admin le confirme ou le
  rejette, preuve citée sous les yeux (`deciderLienInfluence`). **Score d'influence 0–100 explicable**
  (`lib/influence/score.ts`, chaque point a sa raison écrite) : dirige le service +30 (sinon Pr / MCA +15), orateur
  +10 par intervention (≤ 20), cité par d'autres (lien confirmé = 1, proposé = confiance × 0,5 ; 6 points par poids,
  ≤ 25), volume de l'établissement (boîtes distribuées par les DR, ≤ 15), taille du réseau (≤ 10) ; une donnée absente
  ne rapporte ni ne retire rien. « Ordre d'entrée » proposé : le décideur, puis l'influenceur des prescripteurs, puis
  la pharmacie. **Analyse** `lib/influence-luna.ts` : liens structurels recalculés, rapports **nouveaux** depuis le
  filigrane lus par lots (portes : interrupteur général → bascule `influence` (suit les rapports terrain) → clé → appel
  borné 25 s → relecture stricte → `logAiUsage` ; un échec n'avance pas le filigrane), noms rapprochés de l'annuaire,
  scores mis en cache — **une fois par jour** (`scheduled.ts`, `analyserInfluenceSiDu`) et relançable
  (`relancerAnalyseInfluence`). Tables `PraticienRelation`, `InfluenceScore`, `AnalyseWatermark` (migration
  `20270118120000_intelligence_terrain`).
- **ROI Ad & Pro** (`lib/roi-adpro/mesure.ts`, pur + tests ; lecture `lib/queries/roi-adpro.ts`) : avant / après
  l'action (fenêtre 3, 6 ou 12 mois) comparé à des médecins **semblables non touchés** (même spécialité, zone, lettre,
  statut) — différence des différences, avec une **fourchette** (bootstrap déterministe), jamais présentée comme
  certaine ; sous le seuil (moins de 3 médecins touchés mesurables ou moins de 10 comparables) : « pas assez de
  données ». Sources : médecins concernés des demandes (et invités / prises en charge des congrès), coûts des postes
  validés, affinité Q2/Q1, lettres figées des cycles, visites et messages (l'effort terrain, isolé), consommation des
  établissements (fichiers PCH des DR).

### Notifications — le lien mène à l'action exacte (09/10)

Une notification est écrite **une fois**, avec l'adresse du jour. **À la source** : les actions qui notifient pointent
désormais l'écran actuel et l'action précise (82 liens corrigés : `lib/chemins/*` — `ad-pro.ts`, `espace.ts`,
`finances.ts`, `rh.ts`, `validations.ts`…). **À l'affichage** (liste, cloche, pop-up `/api/notifications/poll`, boîte,
badges) : les notifications **déjà en base** passent par `reécriteLienNotification` (`lib/notifications/lien-actuel.ts`,
pur + tests), table de réécriture tirée de l'historique du dépôt (routes supprimées ou devenues pages d'escale :
`/missions` → `/mon-espace/missions`, `/retours-reclamations` → `/mon-espace`, stock promotionnel, Finances…) — un clic,
plus de 404 ni de double saut. Jamais appliquée à l'écriture.

### Ad & Pro — corriger une demande, joindre un fichier à un avis

**Corriger une demande** (bouton « Modifier » sur les sept fiches du pôle — sponsoring, deux prises en charge,
événement, matériel promotionnel, consulting, autre demande). Deux règles portent tout le reste :

1. **Ce qui a fondé une décision ne se réécrit pas.** Une fois la demande tranchée (`isAdProDecided`), le demandeur ne modifie
   plus : réécrire « 200 000 demandés » en « 400 000 » après un accord transformerait la décision en autre chose
   que ce qui a été décidé. Seule la **vue globale** garde la main — et l'audit note explicitement
   « **APRÈS DÉCISION** ». Avant décision : le demandeur, ou le droit `UPDATE` du module.
2. **Les champs de décision ne sont jamais modifiables ici** (montant accordé, statut, Direction Marketing, avis,
   motifs) : ils appartiennent au circuit. D'où une **LISTE BLANCHE** (`EDITABLE_FIELDS`) plutôt qu'une liste
   d'interdits — elle ne se trompe pas quand un champ nouveau apparaît dans le modèle. Le `select` de la requête
   **ET** le formulaire en sont dérivés : le formulaire ne peut pas afficher un champ que le serveur refuserait.

Le point d'entrée est **unique pour les sept natures** ; ce qui varie (table, module RBAC, chemin, colonne de
statut) tient dans la table `TARGETS`. L'audit consigne **ce qui CHANGE** (avant → après), pas l'état final :
relire « ville : Alger » n'apprend rien, « ville : Oran → Alger » dit ce qui s'est passé. Les comparaisons ignorent
les espaces de bordure et l'heure d'une date, sans quoi le journal se remplirait de non-modifications.

**Pièce jointe à un avis.** La Direction Marketing, le National Sales et la Direction peuvent joindre un document à leur
décision (devis comparatif, note, courrier), **à toutes les issues** — y compris un simple commentaire. **L'ordre
des opérations porte la garantie** : les fichiers sont **contrôlés avant** que le circuit n'avance (enregistrer
l'avis puis refuser la pièce laisserait la décision prise et sa justification perdue), l'**étape courante est lue
avant** l'avancement (sinon la pièce serait rattachée à l'étape suivante, c'est-à-dire à quelqu'un d'autre), et
l'écriture n'a lieu qu'une fois le moteur ayant **autorisé** l'action. Catégorie `SUPPORTING_DOC`, `stepKey` = slug
de l'étape. Le contrôle sans écriture est extrait dans `validateAttachments` (`src/lib/attach-files.ts`).

- **Fichiers** : `src/lib/ad-pro-edit.ts` (+ `.test.ts`, 14 tests), `src/lib/queries/ad-pro-edit.ts`,
  `src/lib/actions/ad-pro-edit-actions.ts`, `src/components/ad-pro/edit-request-button.tsx` ;
  `src/lib/actions/workflow-actions.ts` (`advanceWorkflow`), `src/components/workflow/workflow-panel.tsx`.

### Fiches de voyage chez l'assistante de direction (Direction, 14/10/2026)

« Après avoir rempli les fiches d'hôtellerie et de billetterie, on doit pouvoir les envoyer à l'assistante de direction en
un clic, chacune indépendamment ; si c'est déjà chez elle, ça l'indique ; on peut la relancer. » **Un seul circuit** pour
trois origines : voyageur d'un poste « billetterie » (`AdProVoyageur`), fiche d'un poste « hôtellerie » (`AdProHebergement`),
billet / hôtel d'une prise en charge de congrès (`CareCell` TICKET / HOTEL).

| Règle | Où | Pourquoi |
|---|---|---|
| **Une demande par fiche**, l'état seul | `DemandeReservation` (unique par fiche, contrainte `DemandeReservation_une_fiche`) | Les données du voyage restent sur la fiche (source unique) ; la demande garde l'état, qui l'a prise, les relances, l'**empreinte** de la fiche à l'envoi, les pièces du billet. |
| Machine d'états | `reservation-fiche/etat.ts` (`gestePossible`, `etatApres`, `refusGeste`) | ENVOYEE → PRISE → DEVIS_RECU → RESERVEE ; MANQUE_SIGNALE (« à compléter » chez le demandeur), MODIFIEE_APRES_ENVOI (« à renvoyer »), RETIREE. Un renvoi rend la fiche à celle qui l'avait prise. |
| Écritures **conditionnelles** | `reservation-fiche-actions.ts` (`updateMany` sur l'état lu, unicité en base) | Deux clics = un envoi ; deux assistantes = une prise (la seconde apprend qui). |
| Modifiée après l'envoi | `noterModificationFiche` (appelé par `modifierVoyageur`, `modifierHebergement`, `modifierPosteFiche`) + lecture de repli `etatLu` | Champs comparés à l'empreinte ; l'assistante voit ce qui a changé (`diffEmpreintes`) et ne dépose rien avant le renvoi. Une reprise d'envoi en bloc (empreinte nulle) n'est pas comparée. |
| Relance | `refusRelance` (24 h après le dernier envoi ou la dernière relance) | Prévient celle qui a pris la fiche, sinon toutes les assistantes actives (rôle principal ou secondaire). |
| Réservation après l'accord | `deposerBillet` (`REFUS_AVANT_ACCORD`) | L'envoi pour devis est permis avant l'accord du poste (ou de la personne) ; le dépôt du billet / de la confirmation non. Pièces multiples : `Document` de la fiche (`stepKey` = la fiche), ids dans `pieceIds` ; en prise en charge, la première devient aussi `issuedDocumentId` (livret). |
| Devis de l'agence | `joindreDevisAgence` → demande de pièce « devis » du poste + `submitDocumentRequest` ; prise en charge → `createCareQuote` | Le circuit devis EXISTANT, jamais un second : accepté par le demandeur, le devis rejoint le poste. |
| Le fil | sujet DOS du poste (`reservationDossierId`) ou de la prise en charge (`careReservationDossierId`), `noterAuFil` | Né au premier envoi, rouvert s'il était clos ; chaque geste y écrit sa ligne ; notifications ciblées. |
| Bureau du secrétariat | `/demandes?onglet=adpro` : `OngletsBureau`, `BureauAdPro` → `TableauAdPro` ; `queries/reservations-fiches.ts` (`bureauAdPro`, `compteurBureauAdPro`) | Tuiles (à prendre, en cours, relancées, BC de poste à établir, devis à retranscrire — ces deux lus dans leurs files existantes), filtre, file groupée par opération, panneau (gestes, pièces, fil). |
| Écran du demandeur | `components/reservation-fiche/envoi-fiche.tsx` (`EnvoiFiche`, `BandeauEnvois`) dans `voyageurs-bloc`, `hebergements-bloc`, `fiche-voyageur`, `care-panel` | Pastille + sous-état + gestes ; « Envoyer les fiches prêtes (n) » appelle la même logique fiche par fiche. |

Lecture : `passeport-acces.ts` ouvre aux membres du sujet les pièces de billet déposées sur une prise en charge
(`pieceIds`). Tests : `reservation-fiche/etat.test.ts` (pur), `reservation-fiche/reservation-fiche-flow.test.ts` (base locale).

### Assistant — recherche Regulatory complète et écriture sur les produits

- **`search_products` cherche là où les mots sont écrits** : DCI, nom commercial, référence, **classe
  thérapeutique** (« oncologie », « biosimilaire », « anticorps monoclonal »…), forme galénique, laboratoire
  partenaire, pays d'origine et entité. Sans la classe thérapeutique, ces recherches ne remontaient rien. La
  limite n'est plus figée (40 par défaut, **300** au plus) et la réponse dit le **total du portefeuille** et si
  elle est **tronquée** — omettre en silence serait pire que tronquer.
- **`set_products_company`** — seul outil d'écriture Regulatory : rattacher **un ou plusieurs** produits à une
  entité. Le lot est décrit par un **FILTRE**, jamais par une liste devinée, et ce filtre (`productBulkWhere`) est
  **partagé entre l'aperçu et l'exécution** — deux filtres écrits séparément finiraient par diverger, et on
  modifierait autre chose que ce qui a été montré. À l'exécution il est **intersecté avec les références
  affichées**, pour qu'un produit créé entre l'aperçu et le clic ne soit pas emporté. La confirmation **liste** les
  produits (25 puis « … et N autres ») plutôt qu'un compte. Droit vérifié : `REGULATORY:UPDATE` — écrire n'est pas
  lire — **revérifié à l'exécution**, jamais déduit de la proposition.
- **`MAX_TURNS = 16`** (contre 6) : lister tout le portefeuille consomme déjà plusieurs tours, et l'utilisateur
  recevait « je n'ai pas pu finaliser la demande » alors que l'assistant travaillait. Un tour ne coûte que s'il est
  utilisé — la boucle s'arrête dès que le modèle répond sans outil.

### Cloisonnement — entité, gamme, et ce que chacun voit

**Deux dimensions, pas une.** L'**entité** (société du groupe) dit *de qui* est un objet. La
**gamme** (`ProductRange`, propre à une entité) dit *de quoi* relève un produit. Elles se composent :
une gamme AFFINE l'entité, elle ne la remplace pas.

**Ce qui ouvre une entité** (`allowedCompanyIds`, pur, testé) : la société d'appartenance
(`Employee.companyId`), une autorisation nominative (`UserCompanyAccess`), **ou une gamme rattachée**
— une gamme ouvre son entité en lecture, sans quoi le rattachement n'ouvrirait rien. Le Super Admin
voit tout le groupe (`GROUP_WIDE_ROLES`) ; la Direction, non — ses accès inter-entités se saisissent.

**Ce qui restreint les produits** (`productRangeWhere`, pur, testé) : les gammes rattachées, **sauf**
celles dont l'entité est déjà ouverte en entier — on ne retire jamais un droit donné plus haut.
Composé côté serveur par `productRangeScope(userId)` dans `queries/regulatory-rows.ts` et
`queries/product-catalog.ts`.

**Le filtre d'entité des écrans** : `platformScope(userId)` — la portée du cookie **validée** contre les
droits, avec deux garde-fous (aucun filtre si le groupe n'a qu'une société ; aucun filtre pour qui ne relève
d'aucune entité, on n'aveugle personne par omission) —, composée en `AND` par `companyScopedWhere` (une LISTE,
lignes sans entité comprises) ou `ficheScopedWhere` (une FICHE ouverte par son lien : toutes les sociétés auxquelles
la personne a droit, §118.184). ⚠️ `currentCompanyWhere()` puis `currentCompanyWhereFor()` ont été **supprimés** : le
premier posait le cookie tel quel et, **sans cookie, ne filtrait rien** ; le second se laissait **étaler** dans un
`where` qui porte déjà un `OR`, et la portée métier disparaissait en silence.

**Le sélecteur** (`CompanySwitcher`) n'affiche un menu que si l'on a **plusieurs** entités ; sinon
il montre la sienne, sans choix. `setCompanyScope` **refuse** une entité hors droits et retombe sur
la portée légitime — jamais sur « toutes ».

**Écran** : `/admin/gammes` (Super Admin) — arbre entité › gammes › produits + rattachement des
personnes. Les produits sont ceux de Regulatory ; seuls ceux de l'entité de la gamme (ou sans
entité) sont éligibles. Supprimer une gamme **ne supprime aucun produit** (`SET NULL`).

---

### Refonte des données — les lieux et les coordonnées (vague 2, lot V2-D)

**Le principe** : le texte saisi (`wilaya`, `city`, `wilayaPivot`, `region`, `country`) reste la saisie ; la colonne
`wilayaCode` (FK → `Wilaya`, 69 wilayas de la loi n° 26-06) en est la **lecture**, posée par une seule règle,
`rattacherFiche` (`modules/lieux/domaine/rattachement.ts`) : la colonne wilaya prime ; la ville, puis la région, ne parlent que si
elle est vide ou illisible ; deux wilayas ou un numéro contredit → **nul et listé** ; un pays qui n'est pas l'Algérie →
pas de wilaya. Le code suit le texte : un texte devenu ambigu remet le code à nul. Cinq fiches :
`MedicalDoctor`, `MedicalInstitution`, `CompanyContact`, `Supplier`, `SalesSector`.

**Double écriture** : chaque écrivain de ces fiches appelle `reposerWilayaCode(modele, ids)` après son écriture — relit
la fiche entière (une cellule modifiée seule laisse les autres colonnes parler), pose le code, **n'échoue jamais**
l'action (erreur journalisée, la reprise rattrape). Interrupteur `AppSetting.lieuxDoubleEcriture` (allumé par défaut),
réglé sur l'écran de la refonte. Garde : `modules/lieux/double-ecriture-garde.test.ts` (un écrivain sans l'appel, ou une
exception qui nomme une colonne de lieu, fait échouer `npm test`).

**Reprises** (Administration › Refonte des données, `/admin/refonte-donnees`, **Super Admin seul**) — contrat commun
`modules/referentiels/domaine/reprises/types.ts` : aperçu à blanc, puis lots de 500 au curseur `"<Table>:<id>"`, chaque geste à
l'`AuditLog` (module « Refonte des données », champ = clé, curseur en `newValue` : l'écran reprend où l'on s'était
arrêté). Aucune ne tourne au déploiement.

| Clé | Lit | Écrit | Ne fait jamais |
|---|---|---|---|
| `lieux-wilaya` | les colonnes de lieu des cinq fiches | `wilayaCode` (sans toucher `updatedAt`) | modifier le texte ; deviner un cas ambigu |
| `adresses` | adresses des praticiens, collaborateurs (domicile), établissements, partenaires, fournisseurs, sociétés (siège) | `Adresse` (id `adr_<sha256>` de titulaire + adresse repliée) | créer une Personne / Organisation ; reprendre une adresse à l'étranger ; poser une commune |
| `points-de-contact` | téléphones, e-mails, sites de dix sources (dont `DirectoryEndpoint`) | `PointDeContact` (E.164 / minuscules / hôte ; id `pdc_<sha256>`) | reprendre une valeur illisible ; marquer un « principal » |

Les reprises R3 ne servent que les fiches **déjà rattachées** (`personneId`, `organisationId`, posés par V2-B / V2-C) ;
rejouées, elles n'insèrent que ce qui manque. **Lecture** : bandeau « Par wilaya » d'Annuaires › Établissements
(`groupBy wilayaCode`, la part sans code dite à côté). Communes : table vide, rien d'inventé. Détail :
`docs/architecture/refonte-v2-lieux.md`.

---

### Accusés, verrous & confidentialité — règles éparses à ne pas casser

- Événements (`Event`) n'a **pas** de champ `updatedById` → le moteur de workflow le retire avant `update`.
- `PERMISSIONS` (rbac.ts) est exhaustif par rôle — tout nouveau rôle casse le typecheck tant qu'il n'a pas son entrée.
- Références séquentielles : `buildRef`/`createWithRetry` (`src/lib/refs.ts`) — jamais `count()+1`.
- Suppression d'une demande RH par les RH : corbeille par demande (`deleteHrRequest`) — le bouton employé de la
  fiche est réservé à la **fiche complète** et l'annonce clairement.
- La **dernière activité** admin = max(`UserSession.lastSeenAt` groupé, `User.lastSeenAt` heartbeat, `lastLoginAt`).

### Coffre des données sensibles — double écriture, double lecture (refonte V2-E)


### Refonte des données — le dépôt nourrit les fiches (lot V2-A, 27/10/2026)

**Interrupteur** `AppSetting.enrichissementActif`, **fermé par défaut** ; ouvert / fermé par le Super Admin depuis
Administration › **Refonte des données** (`/admin/refonte-donnees`, audité). Fermé : rien n'est émis, rien n'est mis en
file, rien n'est traité.

- **Dépôt** — les trois goulots (`persistUploadedDocument` et `inscrireDocumentDirect` dans `lib/documents.ts`,
  `attachFiles`, `enregistrerFichierDrive`) appellent `lib/enrichissement/signalement.ts` APRÈS l'écriture acquise : fait
  `PIECE_DEPOSEE` au registre (inscrit au catalogue des faits) et une ligne `TacheEnrichissement` par (empreinte,
  rattachement), clé unique — redéposer le même fichier au même endroit ne crée rien. `saveFile` rend `{ blobId, sha256 }`.
  Pièce d'identité, RH, congés, paie : confidentielle pour le registre et la file (nom réduit à l'extension).
- **Passage** — `traiterLaFile({ max })` (`lib/enrichissement/traitement.ts`), au battement `runScheduledJobs` (10 tâches
  au plus) et au bouton « Traiter la file maintenant » ; prise atomique, reprise d'un verrou périmé, réessais espacés,
  `ECHEC` au 5ᵉ essai (bouton « Relancer les échecs »). Pièce trop lourde (> 15 Mo) ou sans lecteur : `IGNOREE`, dit.
- **Rien ne quitte le serveur** — texte lu en local (`cloud: false`, une fois par empreinte), classement par règles,
  extracteurs par règles, devis/factures par la lecture des pièces en mode confidentiel (aucun modèle approché).
- **Sujet** — la personne de la fiche où la pièce est déposée (voyageur ou fiche hôtellerie à l'étape `stepKey` d'un
  poste, salarié, candidat), contrôlée par l'empreinte des identifiants au coffre ; jamais un rattachement sur le nom seul.
  Une fiche porteuse sans Personne en reçoit une, faite de SA saisie. Une organisation se retrouve par NIF / NIS / RC / AI.
- **Décision** (`enrichissement/decision.ts`) — confirmé d'office (coordonnées lues sur une pièce qui en fait foi,
  confiance ≥ 0,9), à confirmer, conflit (jamais d'écrasement), ou **coffre** pour les numéros de pièce d'identité, NIN,
  RIB/IBAN, salaire (porte d'écriture seule `enrichissement/porte-coffre.ts`). Un passeport déposé sur un poste propose
  nom / prénoms / nationalité sur la Personne du voyageur et range le numéro au coffre.
- **« À confirmer »** (`/a-confirmer`) — les faits proposés et conflits des pièces que la personne a déposées (le Super
  Admin voit tout) : confirmer (écrit la fiche, l'ancienne valeur reste dans l'historique), rejeter, trancher.
- **Rattrapage** — reprise « Rattrapage des pièces existantes » (documents de module déjà en base), par lots, depuis le
  même écran (contrat commun des reprises : `modules/referentiels/infra/reprises/`).
- **Ce qui est copié** (`coffre/champs.ts`) : `Employee.iban` (IBAN ou RIB, validé par sa clé), `nationalId` (NIN), les
  quatre salaires ; `CompanyContact.rib` ; `CompanyLegalIdentity.rib`, `iban`. La colonne reste la vérité jusqu'à P5.
- **Écriture** (`coffre/ecriture.ts` → `copies.ts`), interrupteur `AppSetting.coffreEcriture` : après chaque écriture de la
  colonne, dans la transaction de l'écrivain s'il en a une ; sinon non bloquante (journal serveur, la reprise rattrape).
  Nouvelle valeur → nouvelle copie, l'ancienne datée `remplaceeLe` ; colonne vidée → copie datée ; mal formée → rien.
- **Lecture** (`coffre/acces.ts`, `lecture.ts`), interrupteur `coffreLecture` : politique (`politique.ts`) → **journal
  `AccesDonneeSensible` d'abord** (accord comme refus, geste en clair) → valeur (déchiffrée si la copie correspond à la
  colonne par empreinte) ou **masque**. Fermé : la colonne, sans journal, comme avant.
- **Écrire sans lire** : un champ montré masqué n'est pas envoyé (ou revient masqué) et garde sa valeur
  (`champsNonSaisis`) ; une saisie la remplace.
- **Pièces** (`controlerRibDePiece`, fabrique `platform/ia/artifact/factory.ts`) : tout RIB imprimé est reconnu
  au coffre par empreinte ; RIB d'une organisation → imprimé au nom de qui émet (journalisé) ; donnée d'une personne
  non ouverte → masque.
- **Gardes** : Super Admin seul pour la reprise et les interrupteurs ; jamais un modèle d'IA (politique, API v1, bac à
  sable SQL, filtre de confidentialité, frontière d'import `frontiere.test.ts`).

---

### Bibliothèque — toute pièce inscrite, lue une fois, retrouvée par son contenu (lot J1, 29/10/2026)

Décision : `docs/assistant/decisions/0014-bibliotheque.md`. Module `src/modules/bibliotheque/`, écran `/bibliotheque`.

- **Inscription** — tout point d'entrée qui écrit au coffre (`putBlob`, `saveFile`) appelle, APRÈS l'écriture métier,
  `inscrirePiece` (ou `inscrireDocument`, `inscrireDocumentEcrit`, `inscrireDocumentExistant`, `inscrireDocumentRh`,
  `inscrireFichierDrive`) de `@/modules/bibliotheque/api-inscription` ; les goulots `enregistrerFichierDrive`,
  `persistUploadedDocument`, `inscrireDocumentDirect`, `attachFiles`, `putDriveFile` le font pour leurs appelants. Registre
  `Piece` (une par empreinte, `piece_<sha256>`) + `PieceLien` (l'endroit, type ENTITE) + `BibliothequeFiche` (clés d'accès,
  métadonnées, file). Ne lève jamais. Cliquet `src/modules/bibliotheque/inscription-cliquet.test.ts` (exceptions nommées).
- **Clés d'accès** — `FAMILLE:id` : `DRIVE_NODE`, `DOCUMENT`, `MESSAGE_PIECE`, `SUJET_PIECE`, `REUNION_PIECE`,
  `REUNION_AUDIO`, `RH_DOCUMENT`, `TERRAIN_PIECE`, `TERRAIN_AUDIO`, `RETOUR_PIECE`, `KPI_PIECE`. Exclusives (une version
  remplace l'autre) : `DRIVE_NODE`, `DOCUMENT`, `REUNION_AUDIO`, `TERRAIN_AUDIO`, `KPI_PIECE`.
- **Lecture** (tâche `bibliotheque.ingestion`, sous bail, 10 fiches par passage) — lecteurs existants : `lireFichierUneFois`
  (texte, OCR LOCAL), `parsePptx`, transcription (celle de l'écran si elle existe ; sinon Whisper sous la bascule « voix »,
  jamais pour une pièce confidentielle). Classement local : identité / paie / RIB → `sensible`. Passages ~800 jetons
  (chevauchement), vecteurs 512 d par lots de 64 si pgvector est là et si la pièce n'est ni confidentielle ni sensible.
  Ignorée (dit) : archive, format inconnu, > 40 Mo (enregistrement > 25 Mo). Réessais 1 min → 6 h, ÉCHEC au 6ᵉ.
- **Rattrapage** (tâche `bibliotheque.rattrapage`) — 25 lignes par famille et par passage, par la même porte ; relecture
  par lots quand `VERSION_INGESTION` monte. Débrayage des deux tâches : `BIBLIOTHEQUE_INGESTION=off`.
- **Recherche** `chercherDocuments(user, requête, filtres, { pourModele })` — plein texte français replié (GIN), titre
  (trigrammes), sens (HNSW, si pgvector) fusionnés par RRF ; filtres format, période, source, objet, famille ; extraits
  surlignés. Une pièce n'est rendue qu'à qui peut ouvrir l'un de ses endroits — la règle de la route qui sert le fichier
  (`infra/acces.ts` → `resolveDriveAccess`, `entity-access/ouverture-pieces.ts`, `canAccessConversation`…). `pourModele` :
  ni confidentiel, ni sensible, extraits filtrés. `ouvrirDocuments(user, ids)` : le texte recousu, mêmes droits.
- **Super Admin** — `/bibliotheque` montre l'état de la file et le mode (hybride / plein texte) ; « Lire maintenant »
  (`bibliotheque-actions:lancerPassageBibliotheque`), relance d'une pièce (`relancerFicheBibliotheque`), audités.
- **Branchée dans l'Assistant IA** (lot J4, décision [0018](../assistant/decisions/0018-vitesse-memoire.md)) : outils
  `chercher_documents` / `ouvrir_documents` (`pourModele: true`) et `faits_confirmes` (`src/platform/ia/lectures/connaissance.ts`).
  Pas encore dans Adam ; le corpus réglementaire garde son index (pont : lot J2).

### Travaux longs de l'Assistant IA — le Mission Runtime pour tous (lot J2, 30/10/2026)

Décision [0016](../assistant/decisions/0016-travaux.md). Code : `src/lib/missions/travaux/` (moteur, ports),
`src/platform/ia/travaux/outil.ts` (outil du socle IA), `src/lib/agent/travaux.ts` (persona Assistant IA),
`src/lib/actions/assistant-ia-actions.ts` (gestes « travaux »), `src/components/assistant-beta/travaux-panel.tsx`.

- **Un travail = une `Mission` `kind = "TRAVAIL"`** conduite par le même `avancer` qu'Adam : `principalId` = n'importe quel
  collaborateur (accès au module `ASSISTANT_IA`), `persona` = `ASSISTANT_IA` (ou `ADAM`, port prêt), plusieurs par
  personne. Les balayages et écrans d'Adam filtrent `kind = "RUNTIME"` : ils ne voient pas les travaux.
- **Ouvrir** : le tour de l'Assistant IA porte l'outil `lancer_un_travail` et sa consigne (+ un indice quand la demande a la
  forme d'un travail long) ; le modèle propose un plan (`LECTURE`, `LOTS`, `ANALYSE` avec `pourChaque`, `GESTE`,
  `ATTENTE`, `LIVRABLE`, condition `si`), relu contre ce que la persona sait lire et faire **pour la personne** (familles de
  la console comprises). Rien ne tourne avant **« Approuver le plan »** (panneau « Travaux », bouton à côté des routines) :
  étapes, gestes autorisés (libellé, famille), plafond.
- **Conduire** (tâche `travaux.balayage`, sous bail) : vagues d'`avancer` ; avant chaque vague, **droits relus**
  (compte actif, module `ASSISTANT_IA` — sinon pause `DROITS`) et **plafonds** (travail : 20 $ par défaut ; mois de la
  personne : 50 $ ; jetons du jour) — atteint : pause `BUDGET_HOLD`, notifiée, réveil automatique quand le plafond le
  permet. Chaque étape écrit son résultat en finissant (point de reprise) ; une étape « en cours » d'un processus mort est
  reprise après 10 min ; rien d'autre n'est refait.
- **Gestes** : opérations de l'Assistant IA (`OPERATIONS_IA` hors routines) — permis seulement s'ils sont dans la liste
  approuvée ET ouverts par la console au moment d'agir ; reçu `TravailEcriture` réclamé avant, clos après : fait = jamais
  refait, interrompu = jamais rejoué (l'étape échoue et le dit). Trace `ACTION_TRACED` (demandé par… / exécuté par l'Assistant IA).
- **Carnet** : objectif, plan, notes, trouvailles, livrables — relu par chaque étape de modèle à la place de l'historique.
- **Attentes** : fait métier (`recordEvent` réveille aussitôt ; prédicat `champs` sur la charge utile ; échéance `jours`)
  ou minuterie ; « relance si pas de réponse sous 21 jours » = attente + geste `si: { issue: "TIMEOUT" }`.
- **Panneau** : liste (état, « attend « … » depuis 2 jours », étapes faites, coût / plafond), détail (étapes, livrable,
  trouvailles, journal), pause / reprendre / annuler ; notification à la fin et **point quotidien** pour un travail de
  plus d'un jour (lien `/assistant?travail=…`).
- **Console** `/admin/ai/acces` : plafonds par défaut (par travail, par mois) et par personne (`enregistrerPlafondsTravaux`, audité).
- **Worker** : sous `TACHES_DE_FOND=les-deux`, le web s'abstient de conduire les travaux dès que le worker bat. Image
  Docker `Dockerfile.worker` (LibreOffice, ffmpeg, Tesseract) — procédure : [Déploiement — Render](24-deploiement-render.md).

### Travaux, suite — délégation, attentes avancées, équipe, livrables au Drive (lot J8, 30/10/2026)

Décision [0023](../assistant/decisions/0023-delegation.md). Code : `src/lib/missions/travaux/` (`delegation.ts`, `jalons.ts`,
`reveil.ts`, `signaux.ts`), `src/modules/assistant-ia/infra/travaux-{pieces,livrables,equipe}.ts`,
`src/modules/assistant-ia/infra/operations/delegation.ts`, `src/modules/assistant-ia/actions-travaux.ts`, écrans
`ecrans/{demandes-recues,travaux-equipe}.tsx`.

- **Délégation** : étape `DEMANDE` (`a`, `question`, `pieces`, `partager`, `jours`) → nœud `WAIT_INPUT`. Dépôt **une fois**
  par étape (`TravailDemande`, clé `missionId, stepKey`), pièces partagées **en lecture** (`DriveShare`, audit), avis à la
  personne sollicitée (`/assistant?demande=…`). Elle ne voit que la question, les pièces attendues et partagées — jamais
  le carnet. Réponse (texte + pièces de **son** Drive, accordées en lecture au demandeur) ou refus motivé → l'étape se
  règle, la réponse entre au carnet, le travail reprend. Relance (mi-délai), escalade (échéance, au N+1 de l'organigramme),
  abandon (second délai → issue `TIMEOUT`). Faits `DEMANDE_DEPOSEE` / `DEMANDE_REPONDUE`. Côté sollicité : lecture
  `mes_demandes_recues` (contenu non fiable) et carte `preparer_reponse_demande` (fiches de la sélection, hors socle).
- **Attentes** : prédicat de charge utile sur les 34 types du catalogue ; jalons `relance` / `escalade { a: RESPONSABLE }` ;
  **réveil rapide** — tout ce qui règle une attente signale le travail (`Mission.reveilDemandeLe`), la boucle courte
  (`armerReveilsTravaux`, 10 s, worker et web) le conduit : p95 mesuré 10 s (critère 90 s).
- **Plusieurs travaux par personne** : priorité (`HAUTE` / `NORMALE` / `BASSE`), battement servi à tour de rôle par personne.
- **Équipe** : option console `/admin/ai/acces` « Travaux de l'équipe » (défaut **non**) — un N+1 voit résumé et étapes
  des travaux de son équipe, en lecture seule ; chaque consultation à l'audit (`Assistant IA — travaux`).
- **Livrables** : `format` `docx` | `pdf` | `xlsx` | `md` — Word / Excel de la fabrique, déposé au Drive personnel
  (dossier « Travaux »), inscrit à la Bibliothèque ; PDF par les conversions de l'Atelier. Dépôt sous reçu : jamais deux.
- **Robustesse mesurée** (`robustesse.test.ts`) : 3 semaines, 10 `SIGKILL` sur de vrais processus, aucun doublon ;
  web + worker simultanés : un seul exécute.

### L'Atelier de l'Assistant IA — documents affichés et modifiés en direct (lot J3, 30/10/2026)

Décision [0017](../assistant/decisions/0017-atelier.md). Code : `src/platform/ia/artifact/atelier/` (gestes, service,
conversions, structure — socle IA), `src/modules/assistant-ia/infra/atelier/outils.ts` (outils),
`src/modules/assistant-ia/actions-atelier.ts` (clé `assistant-ia-atelier-actions`), `src/app/api/assistant-ia/atelier/route.ts`,
`src/modules/assistant-ia/ecrans/atelier/` (écran).

- **Ouvrir** : « Ouvrir dans l'Atelier » (aperçu d'une pièce) ou l'outil `ouvrir_dans_l_atelier` ; un onglet = une
  `ArtifactSession` (`blockId` `atelier-…`) ; rendu fidèle par format (scènes du Live Office : Word, PowerPoint, grille Excel,
  pages PDF rastérisées). Droits = ceux du fichier (`canViewDrive`) ; sans `canEditDrive` : **lecture seule**, modification
  refusée avant d'être appliquée. Onglets multiples, « Côte à côte », poignée 25–75 %, plein écran ; téléphone : panneau plein écran.
- **Modifier** : l'outil `modifier_document` reçoit des **gestes** typés, traduits en commandes IR par format
  (`gestes.ts`) et appliqués **un par un sur le fichier d'origine** (styles, tableaux, mise en page conservés). L'écran relit
  `/api/assistant-ia/atelier` (0,6 s pendant un tour, 8 s sinon), relit la vue d'un onglet dont la révision a bougé,
  calcule ce qui a changé **par contenu** (`zonesModifiees`), y navigue et l'anime (surlignage, texte qui s'écrit, diapositive
  qui apparaît ; rien sous `prefers-reduced-motion`).
- **Revue** : une ligne par modification (`ArtifactOperation.revue`) — accepter, refuser (= annulée, rejeu exact), remettre à
  revoir ; tout accepter ; annuler / rétablir.
- **Enregistrer** : `FileVersion` n+1, jamais d'écrasement ; inscription Bibliothèque par le port. Document rattaché à un
  objet métier (pièce juridique, courrier, espace partagé — `documentSensible`) : **carte de confirmation**
  (`enregistrer_document`, famille Drive + Écritures). **Comparer** : avant / après côte à côte + différences constatées.
- **Convertir** : Word/PowerPoint/Excel → PDF, tableau Word → Excel, PDF → Word (texte seulement) ; voie WORKER (LibreOffice
  de l'image, tâche `atelier.conversions` sur le worker), EDITEUR (OnlyOffice), LOCAL, RENDU (`docxToPdf`), MAISON —
  **affichée** ; résultat = nouveau fichier du dossier « Atelier » ; la dernière version enregistrée.
- « Demander une modification » ouvre l'Atelier et pré-remplit la demande ; `preparer_document` ne sert plus qu'à créer.

### Assistant IA — vitesse et mémoire (lot J4, 30/10/2026)

Décision [0018](../assistant/decisions/0018-vitesse-memoire.md). Code : `src/modules/assistant-ia/domaine/{selection-outils,assembleur}.ts`,
`domaine/fil/resume.ts`, `infra/{selection,contexte,repondre,modele}.ts`, `infra/fil/{tour,service,resume}.ts` ; socle
`src/platform/ia/{modeles-roles.ts,lectures/connaissance.ts}`.

- **Outils d'un tour** : tous enregistrés, seuls les **actifs** partent au modèle à chaque étape — socle (10), présélection
  par la demande (6), et ceux qu'ajoute `trouver_outil(intention)`. Les fiches sont les outils offerts sous les droits
  (`allowed`, configuration du rôle) ; les familles de la console jugent à l'exécution. `trouver_outil` n'apparaît pas
  dans « sources consultées ».
- **Consigne** : préfixe stable (identité, règles, présentation, consignes générales, la personne), partie variable
  (indice de travail long, mémoire, résumé), heure en dernier ; règles d'une famille d'outils seulement si elle est offerte.
- **Conversation** : 4 échanges mot pour mot ; au-delà de 7, les plus anciens passent au **résumé roulant**
  (`AssistantIaFil.resume`), régénéré par le modèle rapide après la réponse ; « nouvelle conversation » l'efface.
- **Connaissance** : `chercher_documents` / `ouvrir_documents` (Bibliothèque, `pourModele: true`, famille « Drive &
  documents »), `faits_confirmes` (un fait n'est rendu qu'à qui peut ouvrir sa pièce ; jamais un fait sensible).
- **Modèle par geste** : rapide `gpt-6-luna` (résumé), standard `gpt-6.1-terra` effort `low`, raisonnement effort
  `medium` (analyse, comparaison, plusieurs pièces) — variables `ASSISTANT_IA_MODEL_RAPIDE`, `ASSISTANT_IA_EFFORT*`.


### Adventum IA — conversations multiples, privée, dossiers, app et site propre (décision 0027, 30/10/2026)

Fichiers : `src/modules/assistant-ia/{domaine/conversations.ts,domaine/dossiers.ts,infra/conversations/*,actions-conversations.ts}`,
`ecrans/{use-fil,use-pieces}.ts`, `ecrans/conversations/`, `ecrans/app/`, `src/app/ia/`, `src/platform/app-mode.ts`,
`src/auth.config.ts` (middleware), `public/adventum-ia/`, `public/ia-sw.js`, `render.yaml` (`adventum-ia`).

- **Conversation** = un `AssistantIaFil` (plusieurs par personne). Écrire : `envoyerAuFil(texte, pieces, conversation)` ou
  `/api/assistant-ia/vocal` (champ `conversation`) ; lire : `/api/assistant-ia/fil?c=`. Sans conversation : la courante
  (plus récente, ni archivée ni privée). Une conversation « nouvelle » n'existe qu'au premier envoi (`creerMaConversation`,
  privée choisie là). Titre : provisoire au dépôt, proposé par le modèle rapide après la 1re réponse, jamais sur un titre manuel.
- **Gardes** : porte `porte()` (module `ASSISTANT_IA`, session, pas d'écriture en Vue exacte) ; chaque `where` porte `userId`.
  Privée : `reglerPrive` refusé dès un tour (et en base : `tours: { none: {} }`) ; ni mémoire (`sansMemoire`), ni
  `proposer_memoire`, ni `chercher_conversations` ; purge 30 j (`assistant.conversations-privees`).
- **Dossier** (`AssistantIaDossier`) : consignes + documents ; documents ajoutés seulement s'ils sont ouvrables
  (`piecesCitees`), revérifiés à chaque tour (`sectionDossierDuTour`), nommés au modèle avec leur identifiant.
- **Mode app** (`APP_MODE=adventum-ia`) : `/`, `/mon-espace`, `/aujourdhui` → `/ia` ; `/assistant?c=` → `/ia?c=` ; pages
  permises : `/ia`, `/login`, `/change-password`, `/office-embed` ; API permises : assistant-ia, drive, documents, artifact,
  push, health, onlyoffice, rh/document, auth ; le reste → `ERP_URL` (page) ou 404 (API).
- **Appareils** : `listerMesAppareils` / `deconnecterMonAppareil` révoquent SES `UserSession` (honoré à la requête suivante).
### Assistant IA — le registre des capacités et l'appel générique (lot J6, 30/10/2026)

Décision [0020](../assistant/decisions/0020-capacites.md). Code : socle `src/platform/ia/capacites/` (registre PUR, classement,
portes, lexique, cliché `classement.genere.json`) ; module `src/modules/assistant-ia/infra/{capacites,lectures-erp}.ts`,
`domaine/capacites.ts` ; `npm run capacites:classement`.

- **Registre dérivé** de `lib/actions/contrat.genere.json` (1 206 actions), des outils de l'Assistant IA et des 16 commandes de
  l'Atelier : schéma JSON + zod, famille de la console, libellé français, risque **R0 → R4**, simulable (J7), annulation
  (`lib/annulation/reversibilite.ts`), contenu tiers, porte d'écran. Jamais appelable : `illisible`, refusée au chemin
  générique, hors de l'assistant (`portes.ts`), objet binaire. Le cliché relu fait échouer `registre.test.ts` pour toute
  action nouvelle non classée.
- **Appel** : offerte si la porte de l'écran est ouverte ; R0 exécutée pendant le tour sous la session de la personne ; R1/R2
  carte, R3/R4 carte renforcée (ressaisie) ; à la confirmation, arrêt d'urgence, porte et famille relus, puis l'ACTION ELLE-MÊME
  (`executerAction`). Pas dans les travaux (J2) : un geste de capacité repasse toujours par une carte.
- **Sélection** : les capacités sont des fiches de `trouver_outil` et de la présélection (J4) — rappel@5 96 % sur 300
  demandes, 3 837 jetons fixes au pire, jamais hors droits.
- **Adam n'est plus emprunté** (`RESIDUS` vide) : écritures → capacités ; `send_message` → opération propre ; lectures
  transverses → outils propres (`lectures-erp.ts`, `read_budget`, `read_hr_overview`, `finance_totals`).
- **Aucune régression de capacité** (0020 § 8, [inventaire](../assistant/decisions/0020-inventaire.md)) : les 123 gestes
  qu'Adam prêtait avant J6 ont chacun leur équivalent appelable, ouvert à chaque rôle d'avant (`npm run capacites:inventaire`,
  test `equivalents-avant-j6.test.ts`). Actions d'écran ajoutées : `modifierTache` (échéance, priorité, responsable),
  `corrigerMaDemande`, `modifierChampPersonnalise` ; fiche employé par la politique `interdictionDeLAssistantIa`
  (`GESTES_DE_FICHE` : jamais `userId`, R4, fiche relue et rejouée à la confirmation) ; portes nommées geste par geste
  (`PORTES_DU_GESTE` : « le propriétaire OU le droit du module ») ; un fichier facultatif n'empêche plus l'appel.


### Graphe de l'entreprise et faits datés (lot J9, 30/10/2026)

Décision [0021](../assistant/decisions/0021-graphe.md). Module `src/modules/graphe-entreprise/` ; outils au socle
`src/platform/ia/lectures/graphe.ts` ; fermeture bitemporelle `src/lib/enrichissement/confirmation.ts`.

- **Une vue, pas un registre** : nœuds = fiches canoniques (`Personne`, `Organisation`, `Product`, `RegulatoryProduct`,
  sponsoring / événement / demande « autre », congrès, `Piece`), arêtes datées lues dans `EntityLink`, `PieceLien`,
  `FaitConfirme` (`atteste`, jamais un fait sensible), `EntityMention` et les clés métier (affiliation, emploi, dossier,
  demandes, congrès). Une clé étrangère dit l'état actuel, et l'arête le dit.
- **Droits avant le parcours** : types fermés non lus (module RBAC, ou famille de la console fermée : Réglementaire →
  dossiers, Ad & Pro → demandes et congrès, Drive & documents → documents) ; chaque nœud jugé par la portée de son écran
  (`scopeRegulatory` + verrou, `scopeSponsoring`, `scopeCongress*`, `scopeAdProOther`, `piecesOuvrables`) AVANT d'être
  traversé ; pour un modèle, ni pièce confidentielle ni pièce du coffre. Profondeur ≤ 3, bornes dites (`tronque`).
- **Résolution** : arabe ↔ latin (translittération + squelette consonantique), particules (Ben, Abd El, Aït), fautes,
  sigles (ENPP), NIF/RC ; homonymes = question ; les candidats hors droits sont écartés avant le verdict.
- **Faits bitemporels** : validité (`valideDu`/`valideAu`) ≠ constat (`confirmeLe`/`fermeLe`) ; un fait remplacé est
  FERMÉ (`fermeLe`, `fermeParId`, `remplaceParId`), jamais écrasé. État à une date, et « ce qu'on savait » à une autre.
- **Outils de l'Assistant IA** : `explorer_relations`, `etat_a_une_date`, `d_ou_vient` — fiches de la sélection ; chaque
  chiffre porte sa `source` (vérifié au banc : `chiffresSansSource`).
### Terrain et voix (lot J13, 30/10/2026)

Décision [0025](../assistant/decisions/0025-terrain-voix.md). Code : `src/modules/assistant-ia/domaine/terrain/`,
`infra/terrain/captation.ts`, `infra/operations/terrain.ts`, `infra/voix/temps-reel.ts`, `ecrans/terrain/`,
`ecrans/voix-temps-reel.tsx` ; socle `src/platform/ia/voix/` ; page `/medical/terrain` ; routes `/api/assistant-ia/terrain`,
`/api/assistant-ia/voix/{session,delegation,journal}` ; table `AssistantIaTerrainCapture`.

- **Vocal → compte rendu** : file locale → dépôt idempotent (clé de capture) → Drive « Terrain — vocaux et photos » →
  `gpt-transcribe` (langue détectée, indice du panel et de la gamme ; mesuré meilleur des quatre moteurs) → structuration
  JSON relue → médecin résolu dans l'annuaire DU délégué (jamais deviné) → **cartes** : brouillon de compte rendu
  pré-rempli (`createFieldReport` + `updateFieldReport`), demande d'échantillons (`demanderMateriel`), tournée de demain
  (`planifierVisites`, sélection complète relue). **Rien n'est écrit sans clic** ; confirmation par `confirmerCarteTerrain`
  (porte : module Rapports terrain ; seulement les opérations `terrain_*` de ce compte).
- **Photos** : présentoir, ordonnance anonymisée (aucune donnée patient recopiée, filtrée en sortie), facture, carte de
  visite → faits proposés ; carte « rattacher au compte rendu » → `rattacherPhotoTerrain` (brouillon seulement).
- **Hors ligne** : IndexedDB, un élément ne sort de la file que sur l'accusé du serveur ; réessai 5 s → 5 min ; refus 4xx
  gardé à relire ; envoi au retour du réseau ; état visible ; `sw.js` sert l'écran Terrain hors ligne (et rien d'autre).
- **Voix temps réel de l'Assistant IA** (GPT-Live `gpt-live-1` seul, décision de Direction du 30/10 ; bouton à côté du
  micro de `/assistant`) : l'offre WebRTC est échangée par notre serveur (`/v1/live/sessions`, aucun secret au
  navigateur) ; GPT-Live converse et **délègue** ; la demande dite part dans **le même fil** que le texte, jouée par le
  même assistant (outils, droits, console, repères, cartes) ; le résultat revient à la voix sans valeur sensible ;
  **aucune confirmation à la voix** — une écriture est une carte, exécutée par son bouton. Modèle réglable par le Super
  Admin (Consommation IA) ou `ASSISTANT_IA_VOICE_MODEL`. Latence mesurée sur la ligne de temps de la session (cible p50
  ≤ 1,5 s, première mesure réelle à relever en production).

### Recettes — la mémoire procédurale (lot J10, 30/10/2026)

Décision [0028](../assistant/decisions/0028-recettes.md). Module `src/modules/recettes/` ; page `/recettes` ; outil
`src/modules/assistant-ia/infra/recettes.ts` ; tâche `recettes.extraction`.

- **Sources** (`infra/sources.ts`, 24 mois) : circuits Ad & Pro (`WorkflowStepEvent` + définition : rôles, `autoSkipMaxAmount`),
  validations par module (`ValidationStep`), recrutement (`RecruitmentApproval`), travaux J2 réussis (forme du plan), formes
  d'Adam `VALIDATED` ; pièces `PieceLien` → `Piece.nature` ; acteurs par RÔLE, jamais par nom.
- **Extraction** (`domaine/extraction.ts`) : rien sous le seuil (5 dossiers clos acceptés, plancher 3, réglable par processus) ;
  étapes par rang moyen, validateurs, pièces ≥ 50 %, seuil réglé ou observé (palier rond strictement entre les deux groupes,
  `seuilRond`), médiane et p90, pièges répétés sur ≥ 2 dossiers (chiffres masqués). Idempotente (signature de structure).
- **Vie** (`domaine/etats.ts`) : PROPOSEE → VALIDEE → REMPLACEE / RETIREE, ou REJETEE (motif). Seul le responsable désigné
  (`RecetteResponsable` : rôle ou personne, par processus ; désigné par Super Admin / Direction) tranche, et seulement un
  circuit dont il voit l'écran. Corriger = une version de plus.
- **Assistant** : `recette_pour(intention, plan?)` → `AUCUNE` | `AMBIGU` (question) | `RECETTE` (fiche, phrase « selon la
  recette … validée par … le … », plan J2 : ANALYSE → LIVRABLE → ATTENTE médiane → LIVRABLE, écarts). Version VALIDÉE
  seulement ; famille fermée → processus retirés. `RecetteUsage` ; acceptation lue au travail lancé (même plan approuvé).
- **Droits** : `voitLeCircuit` (module de l'écran du circuit ; formes d'Adam : Super Admin) — écran et assistant.

