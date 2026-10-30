# 0017 — L'Atelier : afficher et modifier des documents EN DIRECT (lot J3, 30/10/2026)

**Demande de la Direction** : « on doit pouvoir afficher un ou plusieurs documents et surtout les modifier ; la
modification d'un PowerPoint, Word, PDF, une conversion… doit être en live, avec une interface, un côté magique »
— proposition validée <https://claude.ai/artifact/8TCDJTz6Nxow3qUtjb2hRS> (lot J3).

## Le constat (vérifié dans le code)

- Le **Live Office** (§104) existe : `src/lib/artifact/` (moteur à rejeu, IR de commandes, adaptateurs docx/pptx/xlsx/pdf,
  contrôle qualité), composé au socle `src/platform/ia/artifact/` (ports Drive sous `canViewDrive`/`canEditDrive`, magasin
  Prisma `ArtifactSession`/`ArtifactOperation`). Mais il ne s'affichait que dans l'espace d'**Adam** (Super Admin).
- L'**Assistant IA** n'avait qu'un aperçu latéral en lecture (`ApercuUniversel`) et « Demander une modification » faisait
  **recomposer** un Word par `preparer_document` : styles, tableaux, en-têtes perdus.
- Conversion : `src/lib/office-convert.ts` (OnlyOffice, inerte faute de configuration) ; le worker Docker (J2) embarque
  LibreOffice, sans rien pour l'utiliser.

## Ce qui a été fait : le Live Office, vu par onglets, pour chacun

**Un onglet = une `ArtifactSession`** dont le `blockId` commence par `atelier-`. Pas de moteur de plus : l'état reste un
rejeu (version Drive + journal), annuler reste exact, l'enregistrement reste une **nouvelle version** (§104.8).

| Où | Quoi |
|---|---|
| `src/lib/artifact/runtime/engine.ts` | `revoir(seq, ACCEPTER \| REFUSER \| A_REVOIR)` — refuser une modification qui n'est **pas** la dernière = la marquer annulée et **rejouer** (aucune commande inverse) ; l'opération garde ses **zones touchées** (`touches`) et sa **revue** |
| `src/lib/artifact/adapters/docx/…` | opération neuve `docx.inserer_tableau` (bordé, en-tête en gras, police du voisin, avant `w:sectPr`) |
| `prisma/migrations/20270209100000_atelier` | `ArtifactOperation.touches`, `.revue` ; table `AtelierConversion` (file + **voie**) — additive, idempotente |
| `src/platform/ia/artifact/atelier/gestes.ts` | **pur** : le vocabulaire des GESTES (`remplacer_texte`, `reecrire_paragraphe`, `inserer_paragraphe`, `supprimer_paragraphe`, `modifier_titre`, `mettre_en_forme`, `inserer_tableau`, `modifier_cellule`, `ajouter_diapo`, `supprimer_diapo`, `dupliquer_diapo`, `deplacer_diapo`, `texte_forme`, `supprimer_pages`, `pivoter_pages`, `filigrane`) → commandes IR **par format** (lit la vue quand il faut trouver où agir : un remplacement dans un PowerPoint vise chaque zone qui porte le texte) ; refus motivé hors format ; `zonesModifiees(avant, après)` — ce qui a changé, **par contenu** (une insertion ne surligne pas tout ce qui suit) |
| `…/atelier/service.ts` | droits relus (`voir` / `modifier`) ; ouvrir (réutilise une session ouverte, §36) ; **appliquer les gestes un par un** (un pas de 0,7 s : chaque commande = une révision que l'écran voit arriver) ; revue ; enregistrer ; comparer (version d'origine + état courant + différences constatées, §52) ; document **sensible** (pièce juridique, courrier, espace partagé) |
| `…/atelier/conversions.ts` + `src/lib/office/conversions-atelier.ts` | la composition (droits et dépôt par le port) au socle, les moteurs et la file en bibliothèque ERP ; Word/PowerPoint/Excel → PDF, tableau Word → Excel, PDF → Word (texte) ; **voies** : WORKER (LibreOffice de l'image, file prise par `atelier.conversions`), EDITEUR (OnlyOffice), LOCAL (LibreOffice du processus), RENDU (`docxToPdf`), MAISON (composition) — **la voie est rendue et affichée** ; le résultat est un **nouveau fichier** (dossier « Atelier »), relu avant dépôt, inscrit à la Bibliothèque par le port |
| `…/atelier/structure.ts` | **pur** : la structure dite au modèle (¶ rangs, titres, diapositives et zones, cellules) — bornée, encadrée comme contenu tiers |
| `src/modules/assistant-ia/infra/atelier/outils.ts` | outils `ouvrir_dans_l_atelier`, `modifier_document`, `convertir_document` (famille **Drive & documents**), consigne de l'Atelier ; hors routines et travaux (`ECRITURES_DU_MOTEUR`) |
| `…/infra/operations/atelier-enregistrer.ts` | opération `enregistrer_document` : la **carte de confirmation** (proposée par le modèle, ou rendue par le bouton sur un document sensible) |
| `src/modules/assistant-ia/actions-atelier.ts` | clé `assistant-ia-atelier-actions` : ouvrir, relire, revoir, tout accepter, annuler/rétablir, enregistrer, comparer, convertir, fermer |
| `src/app/api/assistant-ia/atelier/route.ts` | ce que l'écran relit : onglets (révision, modifié), conversions récentes |
| `src/modules/assistant-ia/ecrans/atelier/*` | l'Atelier : onglets, rendu fidèle par format (les scènes du Live Office, exportées de `platform/ia/ecrans/blocks/artifact.tsx`), revue, comparaison, conversions, effets |

### Le parcours

1. Une pièce jointe, renvoyée ou trouvée : **« Ouvrir dans l'Atelier »** (aperçu) — ou l'assistant appelle
   `ouvrir_dans_l_atelier` ; l'onglet apparaît à droite de la conversation (poignée redimensionnable 25–75 %, plein écran ;
   sur téléphone, panneau plein écran). Plusieurs documents : plusieurs onglets, **« Côte à côte »** pour deux.
2. Droits : identiques à l'ouverture du fichier (`canViewDrive`) ; un lecteur voit **« Lecture seule »** et la modification
   est **refusée avant d'être appliquée** (pas à l'enregistrement, quand il aurait vu des changements qu'il ne peut garder).
3. « Mets la période d'essai à 6 mois » : le modèle appelle `modifier_document` avec des gestes typés ; chaque commande
   s'applique **sur le fichier d'origine** et devient une révision. L'écran relit `/api/assistant-ia/atelier` toutes les
   0,6 s pendant le tour, voit la révision, relit la vue, calcule ce qui a changé, **y va** (diapositive, feuille, page) et
   l'anime : surlignage qui arrive, texte qui « s'écrit », diapositive qui apparaît — rien qui bouge sous
   `prefers-reduced-motion` (le surlignage seul).
4. **Revue** : une ligne par modification — Accepter ✓, Refuser ✗ (elle disparaît du document, rejeu exact), Remettre à
   revoir ; « Tout accepter ». Annuler / rétablir restent là.
5. **Enregistrer** = `FileVersion` n+1 (la précédente reste ouvrable), inscrite à la Bibliothèque par le port. Document
   rattaché à un objet métier → la **carte de confirmation** de l'Assistant IA (avertissement « Document sensible… »).
   **Comparer** : avant / après côte à côte, et les différences constatées.
6. **Convertir** : le menu de l'onglet ; l'écran dit « Converti par LibreOffice, sur le worker » (ou l'éditeur Office, le
   rendu intégré…) et propose le Drive. La dernière version **enregistrée** est convertie — dit si des modifications en cours
   n'y sont pas.
7. « Demander une modification » ouvre l'Atelier et pré-remplit « Modifie « X » directement dans l'Atelier… » ;
   `preparer_document` ne sert plus qu'à **créer** un document neuf (consigne et contexte le disent).

### Pourquoi la relecture plutôt qu'un SSE

Le fil de l'Assistant IA est déjà relu (route, 0,9 s pendant un tour) ; le tour tourne en arrière-plan, éventuellement dans
un autre processus. Le **journal des opérations est le flux** : il est en base, ordonné, idempotent — l'écran le relit,
n'importe quel processus l'écrit. Un SSE demanderait un bus entre processus pour dire la même chose.

## Mesures

- `src/platform/ia/artifact/atelier/gestes.test.ts` (vrais adaptateurs) : traduction par format — Word (remplacement qui garde
  `Heading1`, tableau inséré et relu, titre), PowerPoint (deux zones visées, diapositive ajoutée, surlignée, l'écran y va),
  Excel (formule, remplacement hors formules, tableau posé depuis B2) ; refus hors format ; insertion repérée par contenu ;
  **revue** : refuser la 1ʳᵉ de deux modifications la retire exactement, à revoir la rétablit, l'enregistrement crée la v2
  et la v1 est **identique octet pour octet**.
- `src/modules/assistant-ia/atelier.test.ts` (vraie base, par les outils) : un collaborateur **sans droit** ne peut ni ouvrir
  ni modifier (aucun onglet, aucune version) ; un **lecteur** ouvre en lecture seule, sa modification est refusée sans
  opération ; la **propriétaire** modifie en place puis enregistre → v2, v1 intacte, styles gardés, pièce à la Bibliothèque ;
  espace partagé → **carte** ; conversions : tableau → Excel (MAISON), Word → PDF (LibreOffice local ici, rendu sinon),
  refusées à un étranger.
- **E2E** `e2e/atelier.spec.ts` (Chromium, `next start`) : Word + PowerPoint en onglets, une modification diffusée apparaît
  surlignée, refusée puis acceptée, enregistrée → v2, diapositive ajoutée, côte à côte, comparer, téléphone —
  captures `e2e-screenshots/atelier-*.png`.
- **Banc live** `scripts/bench/atelier-live.ts` (`gpt-6.1-terra`, base de banc) : PowerPoint « remplace le titre et ajoute une
  diapositive de synthèse » → `ouvrir_dans_l_atelier` puis `modifier_document`, titre remplacé, diapositive « Synthèse du
  3e trimestre 2026 » (5 puces tirées du deck) ; Word « mets la période d'essai à 6 mois » → 1 modification, enregistrée en
  v2, `Heading1` et tableau conservés. **0,09 $**, 6 appels, 30 s. Le premier passage (0,13 $) a révélé deux défauts
  corrigés : (1) sur un deck générique, le modèle **demande** les points clés au lieu de les inventer — c'est juste, le banc
  sème désormais un vrai deck ; (2) la consigne des familles rangeait « un contrat » sous « Contrats & documents RH » (fermée
  par défaut) : le modèle refusait de toucher le contrat **de la personne**, dans **son** Drive. La consigne dit désormais
  qu'une pièce du **dossier RH d'autrui** relève de cette famille, un fichier joint ou du Drive de « Drive & documents » —
  les droits du fichier décident.

### Le socle n'a pas grossi

Le cliquet du socle IA (imports vers l'ERP, `boundary.test.ts`) ne se relève pas : l'Atelier y entre par les fichiers qui
connaissaient déjà le Drive et la base (droits et repère « sensible » au **port**, onglets au **magasin**, revue et vue d'une
version à **`office.ts`** / moteur), la traduction par `view-types.ts`, et un seul import neuf (`lib/office/conversions-atelier`).
Trois imports en double fusionnés au passage : le plafond **baisse**, 180 → 178.

### Un défaut trouvé en route : Tailwind ne lisait pas les modules

`tailwind.config.ts` ne scannait que `src/{app,components,pages}` : une classe employée seulement dans `src/modules/` ou
`src/platform/` n'était pas générée. Mesuré par l'E2E : `lg:basis-[var(--conversation)]` absente, l'Atelier recevait une largeur
nulle. Les deux dossiers sont désormais lus (aucun effet sur le bundle JS ; la coque reste sous 175 kB).

## Ce qui reste

- **PDF → Word** est un texte : la mise en page, les images et les tableaux ne suivent pas (dit à l'écran et au modèle).
  LibreOffice n'en fait pas mieux ; un convertisseur dédié serait un lot à part.
- Les conversions partent de la dernière version **enregistrée** ; convertir l'état non enregistré demanderait de sérialiser
  la session (les images à résoudre sous les droits) — volontairement pas fait.
- Une session déjà ouverte dans l'espace d'Adam rejoint les onglets (même document, §36) : son bloc d'Adam garde son
  contenu, mais son identifiant devient `atelier-…`.
- La voie WORKER attend le passage suivant du worker (une minute au plus) ; une demande en file plus de 15 min échoue en le
  disant.
