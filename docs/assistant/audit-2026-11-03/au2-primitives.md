# AU2 — La liberté par primitives : ce qu'Adam sait faire, comment, et ce qu'il faudrait (audit, 03/11/2026)

> Axe AU2 de l'audit d'Adam demandé par la Direction le 03/11/2026. **Audit, pas un lot** : aucune refonte, un seul test
> (`src/modules/assistant-ia/au2-constats.test.ts`, il prouve le constat C1). Preuves brutes : [`au2-preuves/`](au2-preuves/).
> Base de banc LOCALE (`amd_bench`, semis du banc d'audit Q1 + 4 produits et un Word semés pour l'axe), `ADAM_SORTIE_INTERDITE=1`,
> aucune variable Google / SMTP / WhatsApp : rien n'est parti chez personne, aucune carte n'a été confirmée.
> Vrai modèle (`gpt-6.1-terra`, rôle standard ; `gpt-6-luna` pour le rapide). **Dépense totale : 0,34 $** (budget 3 $).

## 0. En une page

**Question de la Direction** : Adam fait-il ce que la personne demande, ou ce que le code a prévu ?

**Réponse mesurée : ce que le code a prévu.** Sur quatre demandes réelles rejouées par le chemin du produit, **aucune n'est
servie telle que demandée** (0/4) ; la même demande servie par une maquette de **trois primitives génériques**, hors dépôt, au
même modèle, est servie **5/5 (missions comprises), 7 fois moins cher, sans aucune question**, et le modèle s'y **corrige
seul** en lisant ce qu'il a réellement produit.

| Demande de la Direction | Produit aujourd'hui (0,31 $) | Maquette 3 primitives (0,034 $) |
|---|---|---|
| « mail, juste le planning en tableau aux couleurs, le reste en texte simple » | carte **texte brut**, le tableau devenu des puces ; Adam dit « le mail avec le planning **en tableau** » ; relancé, il ne peut que s'excuser (aucun moyen de voir ni de changer le rendu) | 1 tableau aux couleurs (#087084), 3 paragraphes sans aucun style, pas de bandeau — **vérifié par l'observation** |
| « copie l'annuaire des pharmacies d'Oran en Excel, ajoute une colonne statut, range-le dans ton Drive » | fichier dans « Exports » (pas d'espace d'Adam), cellules en JSON (`["Ouest — Oran"]`), **ligne « Total » qui additionne les numéros de téléphone (248 167 966)**, colonne statut **non écrite** (proposée dans l'Atelier, à accepter puis enregistrer à la main) | 8 pharmacies, colonne « statut », aucun total inventé, rangé dans `Adam/Brouillons` |
| « convertis ce Word en PDF et remplace la date » | date remplacée **à l'écran seulement** ; « acceptez puis enregistrez ; je pourrai ensuite convertir » — rien n'est fait | v2 du Word (v1 gardée), PDF produit. Premier appel raté (aucun remplacement) → **l'observation le montre → second appel juste** |
| « nos produits commercialisés en infectiologie » | catalogue **réglementaire** (posaconazole, pré-soumission) ; « aucun produit confirmé comme commercialisé » — **faux** : Amoxil et Azitrom sont commercialisés en infectiologie | Amoxil 1 g, Azitrom 500 mg — étape calculée par la règle de l'ERP (`etapeCycle`) |
| « donne nos 3 missions » (cas P1) | titres et « 0/2 », **non cliquables** (`mes_missions` ne rend pas de lien) | lien `/missions/<id>` rendu par la vue, cliquable |

**Cause unique, architecturale** : chaque capacité est un **outil sur mesure à contrat figé** (≈ 240 outils propres + 1 019
capacités offerts au Super Admin, 597 000 caractères de définitions), et **aucun outil ne rend au modèle ce que la personne
verra réellement**. Le modèle ne peut donc ni exprimer une forme non prévue, ni constater son erreur. Les correctifs successifs
ajoutent un outil ou une consigne de plus (77 `consigne:` dans les sorties d'outils) : c'est exactement le « rallonger le code
pour rien » que la Direction refuse.

**Cible** : six primitives (lire · agir · produire · fichier · espace d'Adam · observer), toutes sous la session réelle de la
personne, plus une boucle **plan → exécution → observation du résultat réel → correction** tenue par le moteur. On **supprime**
les gabarits figés, les ~14 outils d'export, la couche d'outils de l'Atelier, la plupart des lectures « un outil par écran » et
les opérations `preparer_*` qui ne font qu'envelopper une action ; le Super Admin et l'employé gardent **le même moteur**, seuls
les droits diffèrent. Estimation : **−6 à −8 k lignes** dans le module (−15 %), **+2,3 k** de primitives, **240 → ~40 outils propres**.

## 1. Méthode et mesures

- **Inventaire statique** — Graphify n'a pas été rafraîchi (axe d'audit ; l'inventaire est mesuré au code). Comptes faits par
  script (`compter-outils`, résultat ci-dessous) en construisant le catalogue réel `outilsV1(user, …, { capacites: true })`
  pour trois personas du banc, et filtrés par `allowed(user)`.
- **Rejeu produit** — `au2-preuves/rejeu-produit.ts.txt` : `deposerEcrit` (l'action de l'écran) puis le fil en arrière-plan,
  relu en base comme l'écran (même voie que `scripts/bench/audit-assistant/jouer.ts`). Persona Super Admin « Amine » du banc.
  Résultat brut : `au2-preuves/rejeu-produit.json`.
- **Maquette** — `au2-preuves/maquette-primitives.ts.txt` (221 lignes, **hors dépôt**, non branchée) : trois outils (`lire`,
  `produire`, `fichier`), le même modèle par l'API Responses, la même base. Lecture réelle (Prisma), Excel réel (exceljs), Word
  réel (jszip), PDF réel (LibreOffice). Résultat brut : `au2-preuves/maquette-primitives.json`, mail : `maquette-mail.html`.
  **Limites honnêtes** : la maquette tourne en vue globale (Super Admin), sans S1, sans K10, sans le profil ni la mémoire du
  tour ; son coût par demande n'est donc pas directement comparable — l'écart d'outils (3 contre ~15 actifs) et de réussite, si.

**Mesures**

| | Super Admin | Délégué médical | Assistante de direction |
|---|---:|---:|---:|
| Outils construits pour un tour de conversation | 1 261 | 742 | 636 |
| … offerts (`allowed`) | **1 259** | 725 | 609 |
| … dont capacités J6 (une par action serveur) | 1 019 | 623 | 524 |
| … dont outils propres (lectures, `preparer_*`, Atelier, exports, Adam…) | **240** | 102 | 85 |
| … dont `preparer_*` | 18 | 16 | 11 |
| Caractères de définitions (description + schéma) | **597 310** | 298 641 | 248 726 |

| Poids du code (lignes hors tests) | |
|---|---:|
| Module `src/modules/assistant-ia` | 44 281 (domaine 10 083 · infra 25 918 · écrans 9 904) ; tests 17 182 |
| dont `infra/operations/` (36 opérations du registre `OPERATIONS_IA`) | 6 904 + 430 (`domaine/operations`) |
| dont mails (gabarit, boîtes, rédaction) | 455 (+ `operations/envoi-gmail.ts` 201) |
| dont lectures « un outil par écran » (`lectures*.ts`, annuaire, juridique) | 1 052 + 459 + 429 |
| dont capacités (module + registre du socle) | 473 + 1 167 (+ `classement.genere.json`, 238 Ko) |
| Socle `src/platform/ia` | 19 437 |
| Ancien Adam (`src/lib/assistant*`) + pont `src/platform/in-process` | 66 303 + 18 539 |
| Contrat d'actions serveur (`lib/actions/contrat.genere.json`) | 1 320 actions |
| `consigne:` dans les sorties d'outils (module + socle) | 77 (212 mentions de « consigne » dans `infra/`) |

Rejeu produit : 33 appels du modèle standard, 6 603 jetons d'entrée en moyenne (2 682 en cache), 0,30 $ pour 6 tours.

## 2. Ce qu'Adam sait faire, et COMMENT

| Famille | Comment c'est fait | Où |
|---|---|---|
| **Lire** | un outil par écran ou par question (`search_products`, `my_overview`, `annuaire_terrain`, `lire_paie`, `registre_juridique`…), chacun avec ses champs, ses filtres et sa phrase de sortie ; **le SQL libre existe mais seulement en vue globale** (`requete_sql`, `infra/analyse/outils.ts:382`, `hasGlobalView`) | `infra/lectures*.ts`, `platform/ia/lectures/`, `infra/annuaire/`, `infra/juridique/outils.ts` |
| **Écrire** | (1) les **capacités J6** : une `PowerTool` par action serveur (1 019 pour le Super Admin), carte puis exécution par l'action elle-même — *c'est déjà une primitive* ; (2) **36 opérations `OPERATIONS_IA`** écrites à la main (`infra/operations/index.ts:46-74`) dont 18 `preparer_*` ; (3) 32 écritures de l'ancien Adam en cartes `adam_sa_op` | `infra/capacites.ts`, `infra/operations/`, `infra/adam/outils-adam.ts` |
| **Produire un document** | des **gabarits figés** : mail (`domaine/mails/gabarit.ts`), 14 exports d'écran + `exporter_donnees` (`infra/exports.ts`, `infra/analyse/exporter.ts`), `preparer_document` (modèle Word), et côté Super Admin `document_build` / `sheet_build` / `deck_build` de l'ancien Adam — **cinq chemins concurrents** | voir C1, C3, C6 |
| **Modifier / convertir** | l'**Atelier** : `ouvrir_dans_l_atelier` → `modifier_document` (gestes surlignés **à l'écran**, rien n'est écrit) → la personne accepte puis « Enregistrer » → `convertir_document` dans un tour suivant ; en parallèle `format_convertir` (ancien Adam) | `infra/atelier/outils.ts:109,133` |
| **Drive** | `drive_inventaire`, `drive_lot`, `gdrive_*` (Super Admin), `bilan_drive`, `assembler_pdf` ; les exports tombent dans « Exports » du Drive de la personne ; **aucun espace propre à Adam** | `platform/ia/exports.ts`, `infra/juridique/outils.ts` |
| **Missions** | `lancer_un_travail`, `mes_missions`, `piloter_mission`, `fusionner_missions` | `infra/missions/pilotage.ts` |
| **Choisir l'outil** | présélection lexicale (10 de socle + 6) + `trouver_outil` (J4) ; consignes par famille (`reglesPour`) ; règles de rédaction **dans le code** (`domaine/missions/pilotage.ts:190-197` : « en CONTENU STRUCTURÉ … tableau pour un planning ») | `domaine/selection-outils.ts`, `infra/contexte.ts` |
| **Se vérifier** | garde des chiffres non sourcés (K1), garde de vérité **par regex de verbes** (« envoyé », « enregistré » sans outil réussi, `domaine/missions/pilotage.ts:137-154`), composants retirés s'ils ne sont pas prouvés (R5) | `infra/fil/tour.ts:308-318` |

**Ce qui marche et qu'il faut garder tel quel** : la sécurité S1 (session réelle, Vue exacte fermée, périmètres par avenants,
filtre de confidentialité et repères), la réversibilité K10 (`journaliserGeste`, fenêtres d'annulation), l'exécution des
écritures **par l'action serveur elle-même** (capacités J6 — c'est la primitive (b), déjà là), la compréhension et la voix.

## 3. Les demandes, rejouées

### 3.1 « Fais-moi un mail avec juste le planning en tableau aux couleurs d'Adventum et le reste en texte simple »

- **Aujourd'hui** (`rejeu-produit.json`, MAIL) : `envoyer_mail` → carte « Envoyer par l'envoi de l'ERP », corps **texte**, le
  tableau devenu « • Lundi — Heure : 9 h — Activité : … ». Réponse : « le mail **avec le planning en tableau** attend votre
  confirmation ». La sortie de l'outil montrait pourtant le texte à puces (trace du tour) : le modèle ne l'a pas confronté à la
  demande. Relancé (« seul le tableau aux couleurs, c'est ce que tu as fait ? ») : `trouver_outil` seul, puis « je ne peux pas
  confirmer que l'aperçu respectait cette mise en forme » — **aucun outil ne lui permet de voir sa carte, ni d'en changer la forme**.
- **Pourquoi** : *feature trop rigide*. Le rendu est choisi par **la boîte**, jamais par la demande (`infra/mails/boites.ts:152-154` :
  Microsoft → `rendreMailHtml`, SMTP/ERP → `rendreMailTexte` ; Gmail d'Adam → toujours `rendreMailHtml`,
  `operations/envoi-gmail.ts:151`). Le contrat rempli par le modèle (`ContenuMail`, `domaine/mails/gabarit.ts:14-23`) n'a aucun
  mot pour la forme ; le gabarit HTML met **toujours** le bandeau (`gabarit.ts:103`) et la signature aux couleurs ; le gabarit
  texte aplatit **toujours** le tableau (`gabarit.ts:122`). Le cas de production (« simple, sans design » demandé quatre fois,
  carte au gabarit coloré) et ce rejeu (tableau coloré demandé, texte brut produit) sont **le même défaut vu des deux côtés**.
  Test : `au2-constats.test.ts` (3 cas).
- **Avec les primitives** : `produire({format: "mail", html})` — HTML libre, **assaini** (liste blanche de balises et de
  propriétés CSS en ligne), rendu, puis **observé** : `{tableaux: 1, elementsStyles: {table, tr, th, td}, paragraphesStyles: 0,
  couleurs: ["#087084", "#FFFFFF"]}` (`maquette-primitives.json`). L'envoi reste la capacité existante (carte, K10b).
- **Ce qu'on supprime** : `rendreMailHtml` / `rendreMailTexte` comme passages obligés (la charte devient une **feuille de
  styles nommée** que le modèle applique où il veut), `SCHEMA_CONTENU`, la branche de rendu de `boites.ts`, les règles de
  rédaction en dur de `pilotage.ts:192-193`. ≈ −350 lignes.

### 3.2 « Copie l'annuaire des pharmacies d'Oran en Excel, ajoute une colonne statut et range-le dans ton Drive »

- **Aujourd'hui** : `annuaire_terrain` → `exporter_donnees` → `ouvrir_dans_l_atelier` → `modifier_document` (4 outils, 8 appels,
  0,11 $). Le fichier (`Pharmacies d'Oran (2026-11-03 19h30).xlsx`, feuille « Analyse ») : colonnes `Secteurs`, `CouvertPar`, `Bu`
  en **JSON brut** ; une ligne **« Total » qui additionne la colonne Téléphone** (`SUM(E2:E9) = 248 167 966`) — la règle
  d'additivité (`platform/ia/analyse/bloc.ts:34,229`) juge une colonne au **format**, pas au **sens** ; la colonne « statut » n'est
  **pas écrite** (« proposée dans l'Atelier : acceptez-la puis cliquez sur Enregistrer ») ; rangé dans « Exports », il n'existe
  **aucun espace d'Adam**.
- **Pourquoi** : *features rigides et morcelées* (lecture d'un écran + export générique + éditeur humain) et *feature manquante*
  (l'espace d'Adam). Aucun outil ne relit le fichier produit : la somme des téléphones part sans que personne ne la voie.
- **Avec les primitives** : `lire({vue: "etablissements", filtres: type = pharmacie, wilaya = Oran})` → jeu de 8 lignes ;
  `produire({format: "xlsx", jeu, colonnesAjoutees: ["statut"]})` → observation `{colonnes: […, "statut"], lignes: 8, totaux: aucun}`,
  écrit dans `Adam/Brouillons`. 2 appels, 0,009 $.
- **Ce qu'on supprime** : `exporter_annuaire` et les 13 autres outils d'export (les **routes** d'écran restent pour les boutons),
  `exporter_donnees` (devient `produire(xlsx)` sur un jeu), la ligne « Total » automatique (un total se demande).

### 3.3 « Convertis ce Word en PDF et remplace la date »

- **Aujourd'hui** : `ouvrir_dans_l_atelier` → `modifier_document` ; « veuillez accepter la modification puis cliquer sur
  Enregistrer ; je pourrai ensuite convertir ». **Rien n'est fait** : la modification n'existe qu'à l'écran
  (`infra/atelier/outils.ts:133` : « Rien n'est enregistré »), la conversion attend un autre tour.
- **Pourquoi** : *feature trop rigide*. L'Atelier a été conçu pour qu'un humain relise ; il est devenu le **seul** chemin
  d'écriture d'un fichier pour l'assistant, alors qu'une écriture de fichier est **déjà réversible par nature** : le Drive garde
  les versions (`FileVersion`) — une nouvelle version s'annule en restaurant la précédente, exactement la promesse K10.
- **Avec les primitives** : `fichier({nomFichier, remplacements: [{avant: "14 octobre 2026", apres: "20 novembre 2026"}], versFormat: "pdf"})`
  → v2 (v1 gardée), PDF. **Le premier appel du modèle a oublié les remplacements ; l'observation a rendu le texte réel (« Date :
  14 octobre 2026 ») ; le modèle a rappelé l'outil, juste.** C'est la boucle demandée par la Direction (« qu'il se rende compte au
  bout de la première erreur »), obtenue **par l'architecture, sans consigne**.
- **Ce qu'on supprime** : la couche d'outils de l'Atelier pour l'assistant (`OUTILS_ATELIER`, ≈ 200 lignes — l'**écran** de
  l'Atelier reste pour l'humain), `format_convertir` en double, `ENREGISTRER_ATELIER` comme passage obligé.

### 3.4 « Nos produits commercialisés en infectiologie »

- **Aujourd'hui** : `search_products` (×2) → « deux dossiers en Infectiologie & Réanimation … pré-soumission » puis « aucun
  produit confirmé comme commercialisé » — **faux** (Amoxil 1 g et Azitrom 500 mg : `lifecycle = MARKETED`, segment
  « Infectiologie »).
- **Pourquoi** : *feature manquante*. `search_products` (`infra/lectures-erp.ts:119-135`) ne cherche que dans
  `RegulatoryProduct` (dci, marque, référence, `therapeuticClass`…) : ni `therapeuticSegments` (le champ où vit « Infectiologie »),
  ni `Product.lifecycle`, ni la règle `etapeCycle` (`src/lib/products/fiche-360.ts:27`) qui dit « commercialisé ». La seule lecture
  qui sait (`product_360`) est un outil de l'ancien Adam ; le SQL libre la contournerait mais est fermé hors vue globale.
- **Avec les primitives** : la vue `produits` déclare un champ **calculé par la règle de l'ERP** (`etape = etapeCycle(...)`) et
  `aires` ; `lire({vue: "produits", filtres: [etape = COMMERCIALISE, aires contient infectiologie]})` → les deux produits. 1 appel.
- **Sur la demande T2** (« lecture typée des produits ») : **une primitive générique la rend inutile** — une vue de 25 lignes
  (champs + portée + champ calculé) au lieu d'un outil de plus.

**Apport de la session T2 (mesuré par elle, rejeu ≈ 0,15 $ ; point 1 vérifié au code)** :
1. « Commercialisé » est déjà une **requête d'écran** sous les droits : `clauseCommercialises(user)`
   (`src/lib/queries/produits-360.ts:65-66` — un `Product` dont un dossier est `DECISION_OBTAINED`/`CLOSED`, sous
   `regulatoryLockWhere`). La vue `produits` de la cible doit **réutiliser cette clause** (et non recalculer) : c'est la
   preuve que les portées et les définitions métier existent déjà, prêtes à porter une primitive.
2. Le mot dit ≠ le mot écrit (« infectieux » / `therapeuticSegments = Infectiologie` / `therapeuticClass = Carbapénème`) :
   exposer au modèle le **schéma de la vue** et le laisser formuler le filtre, plutôt qu'un `contains` sur le mot de la personne.
3. La BU est un faux ami (la BU « Infectiologie / Hématologie » porte un anticoagulant) : l'aire se lit sur le dossier — la vue
   le décide une fois, pas chaque outil.
4. **Masquer un outil fait mentir** : sans le module Produits, la question tombe sur `search_everything` → « aucun produit »,
   muet sur la cause. Règle de la cible : une primitive reste **offerte** et **refuse en nommant le droit** (une vue hors portée
   rend « fermée : droit X », jamais un jeu vide).
5. Les entrées doivent être **naturelles et normalisées côté serveur** (mesuré par T2 : `gpt-6-luna` passe `month = « octobre
   2026 »` à `read_payroll`, qui refuse) — la robustesse ne doit pas dépendre de la force du modèle.

### 3.5 « Donne nos 3 missions » (pour mémoire — la cause du « worker absent » est l'objet de P1, non dupliquée)

`mes_missions` (`infra/missions/pilotage.ts:111-117`) rend `id, titre, etat, etapes, coutUsd` **sans lien** ; la vue `missions`
de la maquette porte `lien = /missions/<id>` et la réponse est cliquable sans consigne.

## 4. Les constats, du plus grave au moins grave

| # | Constat (prouvé) | Preuve | Gravité |
|---|---|---|---|
| **C1** | La **forme** d'un livrable n'est jamais celle demandée : elle est fixée par le canal (mail : la boîte) ; le contrat du modèle ne peut pas l'exprimer | `boites.ts:152-154`, `envoi-gmail.ts:151`, `gabarit.ts:14-23,103,122` ; rejeu MAIL ; `au2-constats.test.ts` | bloquant (cas de production 1) |
| **C2** | **Aucune observation du résultat réel** : aucun outil ne rend au modèle ce que la personne verra (rendu du mail, contenu du classeur, texte de la nouvelle version) ; le modèle affirme « en tableau » sur un texte à puces et ne peut pas se corriger | rejeu MAIL tours 1-2 ; rejeu ANNUAIRE (total des téléphones) ; contre-preuve : maquette WORD (correction seule) | bloquant (« il ne se rend même pas compte ») |
| **C3** | Les données existent mais **ne sont lisibles que si un outil a été écrit pour elles** ; le SQL générique est réservé à la vue globale faute de portée par personne | `lectures-erp.ts:119-135` ; `analyse/outils.ts:382` ; `fiche-360.ts:27` ; rejeu PRODUITS | bloquant (cas 3) |
| **C4** | **Écrire un fichier exige un humain** (Atelier : accepter puis enregistrer) alors que la version Drive est déjà l'annulation ; une demande en deux gestes (modifier + convertir) ne se termine pas | `atelier/outils.ts:109,133` ; rejeux WORD, ANNUAIRE | majeur |
| **C5** | **Pas d'espace d'Adam** : ses copies tombent dans « Exports » au milieu du Drive de la personne ; rien pour ranger, cacher un brouillon | `platform/ia/exports.ts` (`DOSSIER_EXPORTS`) ; rejeu ANNUAIRE | majeur (demande explicite de la Direction) |
| **C6** | **Catalogue énorme et redondant** : 1 259 outils pour le Super Admin (597 k caractères), cinq chemins pour produire un document, deux pour convertir, deux pour lire le Drive ; la sélection lexicale doit deviner parmi eux | mesures §1 ; liste `outils-sa` | majeur (lourdeur, choix erratiques) |
| **C7** | **La conduite est dans des consignes**, pas dans l'architecture : 77 `consigne:` en sortie d'outil, des règles de rédaction en dur (« tableau pour un planning »), une garde de vérité par **regex de verbes** qui ne sait rien de la forme | `domaine/missions/pilotage.ts:137-154,190-197` | majeur (« architecture, pas prompting ») |
| **C8** | Les exports génériques **inventent du sens** : total sur une colonne non additive (téléphones), tableaux sérialisés en JSON dans les cellules, feuille nommée « Analyse » | `bloc.ts:34,229` ; fichier du rejeu ANNUAIRE | moyen |
| **C9** | Les listes ne portent pas de **liens** (missions) : la réponse ne peut pas être cliquable | `pilotage.ts:111-117` | moyen |

## 5. Causes architecturales

1. **L'unité de capacité est l'outil sur mesure.** Chaque besoin nouveau = un outil (lecture, opération, export, gabarit) avec
   son schéma figé. Le modèle choisit parmi ce qui existe ; ce qui n'existe pas « n'a pas pu être confirmé ». C'est la définition
   même de l'ERP « qui fait ce qu'il a de disponible comme feature » que la Direction refuse.
2. **La boucle est ouverte.** Le moteur exécute un outil et rend au modèle un **compte rendu rédigé par l'outil** (souvent une
   consigne), jamais une **observation** du résultat. La vérification est un post-traitement par regex sur la réponse.
3. **La sécurité est soudée aux outils au lieu d'être sous eux.** Parce que S1 vit dans chaque outil (son `where`, sa famille,
   son `allowed`), ouvrir une lecture générique paraît dangereux — d'où `requete_sql` réservé à la vue globale. Or les
   **portées existent déjà comme fonctions** (`scopeRegulatory`, `legalReaderWhere`, la portée de l'annuaire, `ownerId` des
   missions) : elles peuvent porter une primitive.
4. **Les écritures « sûres » sont confondues avec les écritures humaines.** K10 (réversible) et « l'humain relit » sont deux
   choses ; l'Atelier impose la seconde là où la première suffit.
5. **Deux moteurs fusionnés par empilement.** A2 a branché ~140 outils de l'ancien Adam à côté des outils de l'Assistant IA ;
   les doublons (documents, conversions, Drive, SQL) se sont additionnés au lieu de se fondre.

## 6. Architecture cible

### 6.1 Six primitives (et rien d'autre de « métier » dans le catalogue de base)

| Primitive | Contrat | Ce qui la rend sûre (invariants du moteur, pas consignes) |
|---|---|---|
| **(a) `lire`** | `{vue, filtres[], champs[], tri, limite}` → un **jeu nommé** ; vues **déclarées** (champs, champs calculés par les règles de l'ERP, lien d'écran) ; agrégats par le pipeline K1 existant | chaque vue **exige** une `portee(user)` = la fonction `where` de son écran (type obligatoire : pas de vue sans portée, test de registre comme `registre.test.ts`) ; colonnes du coffre jamais déclarables ; sortie par `jetonnerSortie` ; bornes (lignes, durée) ; audit |
| **(b) `agir`** | `{capacite, entree}` → carte → exécution par l'action serveur — **c'est la capacité J6**, exposée en UN outil + recherche (`trouver_outil`) au lieu de 1 019 définitions | inchangé : portes, familles, R0-R4, simulation, retape CRITICAL, K10 |
| **(c) `produire`** | `{format: mail \| docx \| xlsx \| pdf \| texte, html \| jeu, styles?, nom}` — **mise en page libre** ; la charte = une feuille de styles nommée (`charte:adventum`) que le modèle applique à tout ou partie | assainissement par **liste blanche** (balises + propriétés CSS en ligne ; base : `src/lib/mail/sanitize.ts`, aujourd'hui sans `style`) ; rendu par les moteurs existants (exceljs, LibreOffice, pdfkit) ; **rend l'observation** |
| **(d) `fichier`** | `{source, remplacements \| gestes, versFormat}` — modifier, convertir, copier | **nouvelle version** Drive (l'ancienne reste) journalisée par `journaliserGeste` → annulation K10 = restaurer la version ; droits Drive de la personne (`resolveDriveAccess`) ; l'Atelier reste l'écran où l'humain relit **s'il le demande** |
| **(e) espace d'Adam** | un `DriveSpace` « Adam » **par personne** (`accessUserIds = [personne]`, modèle existant, aucune migration) : `Brouillons`, `Copies`, rangement libre | il appartient à la personne : Adam y a les droits de la personne, personne d'autre ; « cacher » = ne pas l'afficher dans « Mon Drive » |
| **(f) `observer`** | rendu par (c) et (d) à chaque appel, et lisible seul (« relis ta carte ») : structure réelle (tableaux, éléments stylés, couleurs, colonnes, lignes, totaux, texte) | calculé par le code, jamais par le modèle ; c'est aussi ce que la carte affiche (« l'aperçu est ce qui part ») |

L'annuaire « copier, exporter, éditer en Excel, ranger » (demande (f) de la Direction) = `lire` + `produire(xlsx)` + espace
d'Adam ; le réimporter dans l'annuaire = `agir` sur l'action existante `maj_annuaire` (carte, K10). Aucune feature nouvelle.

### 6.2 La boucle et les gardes, dans le moteur

```
demande → PLAN (le modèle) → EXÉCUTION (primitives, sous la session réelle) → OBSERVATION (code)
        → le modèle confronte l'observation à la demande → CORRECTION (nouvel appel) ou RÉPONSE
        → GARDE DE SORTIE : toute affirmation sur un livrable (« en tableau », « sans mise en forme », « 8 lignes »)
          est confrontée à la DERNIÈRE observation de ce livrable ; contredite → la réponse est corrigée, pas annotée.
```

La garde de vérité actuelle (regex de verbes) devient un cas particulier : « envoyé » se confronte à l'observation de l'envoi.

### 6.3 Super Admin et employé : un moteur, des accès

Les primitives sont les mêmes pour tous. Ce qui change : les **vues** et **capacités** que les portées ouvrent, et les **sources**
branchées (Gmail, WhatsApp, Agenda Google = des vues et des capacités de plus, ouvertes au seul Super Admin par leur portée).
Les ~140 outils de l'ancien Adam se répartissent : lectures → vues ; écritures → capacités ; documents / Drive / SQL → (c) (d) (a).

### 6.4 Ce qu'on SUPPRIME ou FUSIONNE (autant que ce qu'on ajoute)

| Supprimé / fusionné | Remplacé par | Lignes (est.) |
|---|---|---:|
| Gabarit mail figé, `SCHEMA_CONTENU`, branche de rendu de `boites.ts`, règles de rédaction en dur | `produire(mail)` + feuille de styles `charte:*` | −350 |
| 14 outils d'export + `exporter_donnees` (les routes d'écran restent) | `lire` + `produire(xlsx\|pdf)` | −450 |
| Couche d'outils de l'Atelier (`ouvrir/modifier/convertir`, `ENREGISTRER_ATELIER`) ; `format_convertir` | `fichier` (l'écran Atelier reste) | −350 |
| Lectures « un outil par écran » : `lectures-erp.ts`, une grande part de `lectures.ts`, `lectures-dossiers-mg.ts`, lectures d'annuaire et du registre juridique, `search_products`, `mes_missions` (lecture) | ~25 vues déclarées | −1 800 |
| `preparer_*` qui enveloppent une action 1:1 (relance, rendez-vous, réponse, message direct, dépôt de pièce, document modèle, traduction, formulaire PDF…) — on garde les **compositions métier** réelles (BC depuis devis, ranger au juridique, dossiers depuis Excel, Ad & Pro pré-rempli) | `agir` (capacité) + `produire` | −2 500 à −3 500 |
| 1 019 définitions de capacités par tour | un outil `agir` + `trouver_outil` | −(adaptateur, poids par tour) |
| 77 `consigne:` de sortie d'outil | observations structurées | −300 |
| Ancien Adam : `document_build`, `sheet_build`, `deck_build`, `gdrive_*`, `sql_query`/`requete_sql` en double… (masqués d'abord — 0055 : « ne supprime rien, quitte à tout masquer » — supprimés sur décision de la Direction) | (a) (c) (d) | −15 à −20 k (hors module) |
| **Ajouté** : registre de vues + exécuteur (≈ 1 000 avec 25 vues), `produire` (≈ 500 : assainisseur CSS, rendus, observation), `fichier` (≈ 250, sur `conversions-atelier.ts`), espace d'Adam (≈ 120), boucle d'observation + garde de sortie (≈ 400) | | **+2 300** |

**Avant → après (module)** : 44,3 k → ~36-38 k lignes ; outils propres offerts au Super Admin 240 → ~40 ; définitions par tour
597 k → < 60 k caractères. Hors module : jusqu'à −20 k lignes de l'ancien Adam quand la Direction lève « ne rien supprimer ».

## 7. Plan de migration — étapes réversibles, chacune mesurée par le banc

Chaque étape est **additive puis soustractive** : la primitive arrive derrière un interrupteur, le banc (Q1 + tâches T1-T3,
P1 bis) la compare à l'ancien chemin, l'ancien chemin est **masqué** puis retiré. Rien ne bascule sans banc vert.

| Étape | Contenu | Réversible par | Critère de passage |
|---|---|---|---|
| **M0** | Registre de vues (`lire`) en lecture seule, 5 vues (produits, établissements, missions, tâches, demandes), portée obligatoire, attaques S1 rejouées sur `lire` | interrupteur `ADAM_PRIMITIVES` | 93/93 attaques bloquées ; tâches PRODUITS / missions vertes |
| **M1** | `observer` + `produire(xlsx\|pdf)` + espace d'Adam (`DriveSpace` par personne) | interrupteur ; l'espace se supprime vide | ANNUAIRE vert ; aucun total inventé |
| **M2** | `fichier` (versions Drive, K10) | annulation = version précédente | WORD vert en un tour ; annulation rejouée au banc |
| **M3** | `produire(mail)` + assainisseur CSS + garde de sortie sur la forme ; `envoyer_mail` ne rend plus, il **envoie** ce que `produire` a rendu | interrupteur ; l'ancien gabarit reste une feuille de styles | MAIL vert (charte, simple, moitié-moitié) ; **retourner `au2-constats.test.ts`** |
| **M4** | `agir` en un outil (capacités) ; vues pour les lectures restantes ; masquer exports, outils Atelier, lectures doublons, `preparer_*` 1:1 | démasquer | recall du banc J6 ≥ 95 % ; coût/tour ≤ aujourd'hui |
| **M5** | Retrait du code masqué (module) ; puis, sur décision de la Direction, de l'ancien Adam en double | git | 2 semaines de banc nocturne sans régression |

## 8. Risques

| Risque | Parade (dans l'architecture) |
|---|---|
| Une vue mal déclarée lit au-delà des droits | portée obligatoire par type ; test de registre ; **espion Prisma** du banc Q1 rejoué sur `lire` ; colonnes du coffre non déclarables |
| HTML libre = surface d'injection (mail sortant, aperçu) | liste blanche balises + CSS, `url()` et `expression` refusés ; aperçu en `iframe sandbox` (déjà fait pour les mails entrants) |
| Plus de liberté = plus de dépenses (boucles de correction) | plafonds par tour / travail existants ; borne de 8 itérations par tour ; observation courte |
| Le modèle « se corrige » mal ou boucle | la garde de sortie confronte à l'observation ; au-delà de N essais, réponse honnête avec l'observation jointe |
| Perte de qualité métier des `preparer_*` riches (pré-remplissage Ad & Pro, BC) | on ne supprime que les enveloppes 1:1 ; les compositions métier restent des capacités nommées |
| Décision 0055 « ne rien supprimer » | M4 masque, M5 ne supprime qu'avec l'accord explicite de la Direction |
| Graphify et cartes de connaissance en retard | refresh après M1 et M4 (règle CLAUDE.md) |

## 9. Reproduire

```bash
# base de banc LOCALE
pg_ctlcluster 16 main start
DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_bench npx prisma migrate deploy
DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_bench BENCH_SEED_ALLOW=1 OPENAI_API_KEY= npm run audit:assistant -- --semer
# rejeu produit / maquette (copier les .ts.txt hors du dépôt en .ts ; Node ne passe par le proxy qu'avec NODE_USE_ENV_PROXY=1)
NODE_USE_ENV_PROXY=1 DATABASE_URL=…/amd_bench OPENAI_API_KEY=<factice> ADAM_SORTIE_INTERDITE=1 OUT=… CONV='[…]' npx tsx rejeu-produit.ts
NODE_USE_ENV_PROXY=1 DATABASE_URL=…/amd_bench OUT_DIR=… CONV='[…]' npx tsx maquette-primitives.ts
# le constat C1
npx vitest run src/modules/assistant-ia/au2-constats.test.ts
```

Note d'environnement relevée en passant : dans ce conteneur, le `fetch` de Node ne passe pas par le proxy sans
`NODE_USE_ENV_PROXY=1` — le premier passage du rejeu a échoué en « incident passager » (clé factice refusée), pas par défaut d'Adam.
