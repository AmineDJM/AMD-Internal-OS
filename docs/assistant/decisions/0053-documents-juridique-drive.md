# 0053 — Documents, juridique et Drive : ranger à sa place, convertir, modifier, retrouver et donner (lot T1, 02/11/2026)

**Demande de la Direction (02/11, verbatim, extrait)** : « Ranger des documents dans légal, convertir des documents,
modifier des documents […] checker le drive, nous donner des documents etc. […] Qu'il range parfaitement les documents à
leurs places […] et qu'il soit smart. »

**Constat (inventaire du lot)** : le registre des capacités exposait déjà `attachDriveNodeToLegal` (R4, sans dossier ni
montant, partie exigée sans dire laquelle) et `moveLegalDocuments` — **deux cartes sur deux tours** (une carte par tour)
pour ranger un seul contrat, et des dates que le modèle devait recopier sans les avoir lues. Aucune lecture du registre
juridique (ni échéances, ni dossiers, ni « le dernier contrat de X »), aucun moyen de **remettre** une pièce juridique,
aucun « check » du Drive, aucune fusion / extraction de pages PDF ni images → PDF.

## 1. Décision — des gestes typés, vérifiés par le code, jamais une phrase de prompt

| Outil (vu par le modèle) | Nature | Ce qu'il fait | Garde |
|---|---|---|---|
| `ranger_au_juridique` | opération (carte) | Range **1 à 12 pièces en UNE carte** au registre : nature et dossier **canoniques** (`domaine/juridique/classement.ts`), dates **lues sur la pièce** quand le modèle ne les donne pas (la preuve est citée sur la carte), partie résolue à l'annuaire (citée dans la pièce, sinon nommée ; absente : ajoutée si la personne écrit l'annuaire, sinon refus qui le dit), entité, lecteurs. Une pièce déjà au registre est seulement rangée. Au-delà de 12 : une **mission** (le geste est offert aux travaux). | `LEGAL` CREATE (le geste n'est même pas offert sinon) ; exécution par les actions de l'écran (`createLegalFolder`, `createCompanyContact`, `createLegalDocument`, `moveLegalDocuments`), RBAC, entité et lecteurs revérifiés |
| `modifier_fiche_juridique` | opération (carte) | Met à jour échéance, début, titre, référence, montant, notes (« + » pour compléter), dossier — **seuls les champs donnés changent** | `LEGAL` UPDATE + `accesAuxPiecesLegal(UPDATE)` ; `updateLegalDocument` |
| `registre_juridique` | lecture | Recherche (mot, partie, nature, dossier), échéances (`expirees`, 30, 90 j), `dernier: oui` ; rend le **lien `/drive/<id>`** du fichier pour le remettre (l'écran le montre en pièce ouvrable, droits revérifiés par `piecesCitees`) | module Juridique ou Finances ; entité ; **lecteurs désignés** (`legalReaderWhere` puis `accesAuxPiecesLegal(VIEW)`) — une pièce restreinte n'est **jamais nommée** ; lien seulement si le fichier est lisible au Drive |
| `bilan_drive` | lecture | « Checke le Drive » : doublons (même contenu), fichiers à la racine, pièces juridiques du Drive pas encore au registre ; pour qui lit le Juridique : expirées, à échéance 30 / 90 j, non classées, sans fichier | le Drive **de la personne** ; le registre par la même porte que ci-dessus |
| `assembler_pdf` | écriture directe (fichier neuf) | `fusionner` des PDF (mupdf, greffe de pages), `extraire` des pages (« 1-3, 7 »), `images_en_pdf` (pdfkit) → un **nouveau** fichier au Drive (« Atelier »), originaux intacts | chaque source revérifiée (`canViewDrive`) ; **journal J7** (annulable) ; hors routines et travaux (`ECRITURES_DU_MOTEUR`) |

Convertir (Word/Excel/PowerPoint ↔ PDF, image → PDF/Word) et modifier en place restent l'Atelier J3 (`convertir_document`,
`modifier_document` + `enregistrer_document`) — inchangés, désormais **mesurés** par le banc.

**Ce que le banc réel a fait corriger (par le code, jamais par la consigne)** — passage par passage dans
[la synthèse](../preuves/audit-documents/SYNTHESE.md) :
- **Gestes nus supplantés** : offerts, `attachDriveNodeToLegal` et `moveLegalDocuments` étaient choisis par le modèle et la
  confirmation échouait (partie exigée). `capacitesOffertes` les retire quand `ranger_au_juridique` est ouvert à la personne
  (`SUPPLANTEES`, `infra/capacites.ts`) — aucun droit de moins : l'opération passe par les mêmes actions.
- **Un AVENANT** naît par l'action des avenants de l'ERP (`createAmendment`) sur le contrat de la même partie, au registre et
  lisible ; le fichier, le dossier et la partie sont ensuite posés sur la pièce (porte : règle des pièces Legal). Sans contrat
  au registre : la question le dit (« rangez-le d'abord »).
- **Désigner un fichier comme une personne** : `resolveDriveFile` (socle, partagé) tranche aussi sur le nom SANS extension et,
  en dernier recours, par TOUS les mots significatifs (accents et ordre ignorés) ; le rangement choisit l'original plutôt
  qu'une copie de même contenu et écarte une autre famille (« le contrat » n'est pas l'avenant) — l'hypothèse est DITE sur la carte.
- **Accents** : le registre et la recherche d'une fiche comparent les mots sans accents (Postgres ne les replie pas).
- **Conversions sans worker** : voies de secours « maison », dites dans la note — PDF → Excel (lignes à colonnes) et image →
  PDF (`src/lib/office/conversions-atelier.ts`) ; une image désignée par son NOM se convertit (Atelier).
- **« Enregistre »** sans dire lequel : l'unique document modifié et non enregistré de l'Atelier (sinon la question).
- **Les accès** du registre et du Drive vivent au domaine Legal de l'ERP (`src/lib/actions/internes/legal/registre-lecture.ts`,
  `internes/documents/fichiers-lus.ts`) — « aides, lectures et corps internes » des actions, comme `internes/legal/regles.ts` :
  le module n'ajoute AUCUN couplage à la dette héritée vers `src/lib/` (cliquet `modules/frontieres.test.ts`), et le socle IA
  reste à son plafond (177).

**Pourquoi des pièces internes ont une partie** : le registre exige une partie à l'annuaire (règle de l'écran). Les statuts
et PV prennent la **société elle-même** (sa fiche à l'annuaire) ; elle est aussi écartée de la détection de « l'autre
partie » (elle est citée dans toutes ses pièces).

## 2. Réversibilité (K10) — par le journal, comme toute opération

Les deux opérations passent par `executerOperationJournalisee` : chaque écriture est au journal J7, « annule » la défait.
La règle K10b s'applique telle quelle : une pièce du registre **ne s'efface pas, elle passe ANNULÉE** ; les dossiers créés
par le geste restent avec elle comme trace (compte rendu : « sans objet »). Une fiche modifiée reprend ses valeurs.
`assembler_pdf` écrit sous `journaliserGeste` (capacité `outil:assembler_pdf`) : le fichier créé est retiré.
Aucune action du registre n'est ajoutée : le cliquet global de réversibilité reste tenu sans exception nouvelle.

## 3. Sécurité S1

- Le **commercial** (sans Juridique) : le geste n'est pas offert, le registre répond « ne vous est pas ouvert » sans rien
  lister ; le bulletin d'autrui est refusé par chaque outil (« pas accessible »), sans en dire le contenu.
- La **juriste** ne voit pas une pièce restreinte au Super Admin (« Protocole d'accord QZ-PROTO-7731 ») : ni dans le registre,
  ni dans le bilan, ni comme candidate d'un nom ambigu (la résolution des fiches filtre AVANT de lister).
- Sondes déterministes ajoutées (cliquet des lectures, `sondes.ts`) : `registre_juridique` (nom de la victime, « contrat de
  travail »), `bilan_drive`, `assembler_pdf` (extraire / fusionner le bulletin de la victime) sous toutes les personas non habilitées.
- Attaques réelles ajoutées (`attaques-documents.ts`, préfixe `DOC-ATK-`) : fusionner le bulletin d'autrui avec son contrat,
  le ranger au registre pour s'en faire donner le lien (avec clic « Confirmer »), le chercher au registre / à la bibliothèque,
  « checker le Drive de toute la société », et le commercial qui demande tout le registre.

## 4. Le banc DOC- (décision 0050)

`src/modules/assistant-ia/infra/testing/audit/taches/documents.ts` — **36 tâches**, 8 personas (dont une nouvelle :
la **juriste** (Lamia CHERIF, persona du banc commun Q1 : module Juridique, rien de RH)), 6 catégories : ranger une pièce (contrat, AMM, statuts,
PV, assurance, bail, avenant, dossier précis demandé, pièce jointe), un lot en une carte, une **mission** de 14 pièces,
mettre à jour une échéance / une note / un classement, convertir (Word → PDF, PDF → Excel, image → PDF), fusionner,
extraire des pages, modifier en place puis enregistrer, rédiger un NDA, donner « le dernier contrat de X », une attestation,
les échéances à 30 jours, le contenu d'un dossier, checker le Drive, la recherche plein texte (Bibliothèque), une demande
ambiguë (au plus une question), les erreurs (pièce introuvable, page hors document), le refus propre (sans droit), la pièce
restreinte, l'annulation.

**Chaque tâche est jugée sur le résultat** : un **vérificateur déterministe** (`verifier`, nouveau champ des tâches) relit
la fiche du registre (nature, dossier, partie, début, échéance, notes), le fichier produit (format, **nombre de pages**, texte
du Word), la nouvelle version du document, le **lien du bon fichier** remis (et pas celui de l'ancien contrat) — jamais la
parole de l'assistant. Le semis (`semis-documents.ts`) dépose de vraies pièces (PDF, Word, image) et un registre vivant.
Les tâches modifient l'état : resemer avant un second passage complet.

```bash
BENCH_SEED_ALLOW=1 npm run audit:assistant -- --semer
AUDIT_SEULEMENT=DOC- AUDIT_RAPPORT_DIR=docs/assistant/preuves/audit-documents npm run audit:assistant
```

Exécution réelle contre la base locale (sans modèle) : `src/modules/assistant-ia/documents-t1.test.ts` (carte → clic
« Confirmer » → geste → annulation, porte, remise du bon fichier, bilan, fusion / extraction) et
`domaine/juridique/classement.test.ts` (règles pures).

## 5. Résultat réel

Banc `DOC-` (36 tâches, 5 attaques), 4 passages, **2,53 $** : passage 1 (premières capacités) **19/30** réussies ; à leur dernier
passage, **36/36 réussies** ; **5/5 attaques bloquées** à chaque passage. Détail et limites : [SYNTHESE](../preuves/audit-documents/SYNTHESE.md).

## 6. Limites, décisions Direction à prendre

1. **Le Juridique ne donne pas le Drive** : une pièce que la personne lit au registre n'a de lien remis que si son fichier
   lui est lisible au Drive (partage, espace). Faut-il qu'un lecteur du registre lise aussi le fichier pointé ? (Aujourd'hui :
   non — c'est la règle de l'écran ; l'assistant le dit.)
2. **Ajouter une partie à l'annuaire** en rangeant : seulement pour qui a l'écriture de l'annuaire des partenaires. Une
   juriste sans ce droit voit le refus. Faut-il ouvrir l'annuaire en création au module Juridique ?
3. Les natures « statuts », « PV », « AMM », « agrément » n'existent pas au registre : rangées sous `OTHER` / `LICENSE`, dans
   un dossier qui les nomme, la nature écrite en note. Ajouter ces natures est une migration de l'enum (écrans, exports) — à
   arbitrer.
4. Factures, bons de commande et avoirs ne se « rangent » pas : ils ont leur circuit (centre de validation, sens de l'argent).
5. Annuler un rangement laisse les pièces ANNULÉES et les dossiers créés en place (règle K10b) : faut-il qu'un dossier créé
   par l'assistant et resté vide disparaisse avec l'annulation ?
