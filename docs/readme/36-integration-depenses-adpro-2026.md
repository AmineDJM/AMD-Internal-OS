## Ad & Pro — intégration des dépenses réelles 2026 : 32 dépenses, 30 demandes, 33 558 715,94 DZD (Direction, 14/10/2026)

> « Plus de lignes de budget à part : la dépense vit dans la demande, et le budget se calcule depuis les demandes. Une
> seule source. » — maquette « adpro-integration » validée.

### Ce que fait l'intégration

Le fichier « Dépenses AP » (**Feuil1 fait foi** : en-têtes ligne 4 — A ACTION, B ACTION, C DETAIL ACTION, D Lieux,
E MOIS, F TOTAL BUDGET, G Depenses Reelles, I Commentaires ; données lignes 5 à 59) entre dans Ad & Pro **d'un bloc** :
chaque dépense rejoint SA demande, avec ses postes payés, ses pièces attendues et son imputation.

| Décision | Où elle vit |
|---|---|
| Seules les lignes « Depenses Reelles » > 0 ; consulting (L58, 3 000 000) **non intégré** (RH) | `LIGNES_ECARTEES` |
| 32 dépenses → **30 demandes** : symposium SAI (L22) et symposium Pr Djaballah (L24) sont des **postes** de leur congrès (SAI, ASARI), imputés Événements › Symposium | `DEMANDES_2026` |
| Montants retenus : Staff = 130 316,74 + repas ; symposium SAI 215 475 (195 475 + 8 000 + 12 000) ; pharmaciens 124 750 (octobre) ; webinaire SAI 53 550 ; Sapsox 300 000 (février) ; lettre 14 280 ; Oran 2 157 018,50 | `DECISIONS_LIGNES.montantRetenu` (centimes) |
| Date = **dernier jour du mois** (2026), midi UTC | `dateDeLaDepense` |
| Libellés : « Santé Expo (Paris) », « 2ème conférence de Tlemcen », « ASARI + symposium Pr Djaballah » | `DEMANDES_2026.libelle` |
| Catégories : PEC internationale, PEC nationale, Sponsoring, Matériel promotionnel, Formation, Consulting, Événements › Réunions / Symposium / Staff post-event / Tables rondes ; Taghit → Événements › Réunions ; visa → Matériel promotionnel | `CATEGORIES_2026`, `ALIAS_*` |
| Demandeur affiché « Direction Marketing » ; pièces obligatoires **non bloquantes** | `DEMANDEUR_AFFICHE`, `piecesAttendues` |

Toutes ces décisions sont dans **`src/lib/budget-marketing/integration-2026.ts`** (pur, versionné `VERSION_INTEGRATION_2026`,
gardé sur le lot). `controlerFichier` **refuse** un fichier qui ne correspond plus (détail, dépense à 0,01 DZD, mois de
chaque ligne décidée ; une ligne NOUVELLE avec une dépense ; la ligne écartée changée) ; `incoherences()` vérifie que les
postes d'une ligne font son montant retenu et que le total fait **33 558 715,94** au centime.

Totaux par catégorie (vérifiés sur le vrai fichier, script local non commité) : PEC internationale 18 789 940 · PEC
nationale 124 750 · Sponsoring 8 043 208,50 · Matériel promotionnel 3 055 675 (dont visa 240 000) · Formation 350 000 ·
Événements 3 195 142,44 (Réunions 1 643 792 ; Symposium 410 950 ; Staff post-event 1 140 400,44). Les montants **alloués**
de l'enveloppe ne sont pas modifiés ; une catégorie absente est créée allouée à 0.

### L'assistant (Budget Marketing › onglet **Intégration 2026** → `/budget-marketing/integration`)

> Depuis la maquette « onglets » (10/2026), l'intégration est un **onglet** du module (plus un bandeau des Réglages),
> visible du seul gestionnaire de l'enveloppe, avec la pastille du nombre d'éléments « absents du fichier » à décider
> (`budget-marketing/onglets.ts`).

Gestionnaire de l'enveloppe ou Super Admin (`canManageEnvelope`), sur une enveloppe **MARKETING** couvrant 2026.

1. **Lire le fichier** — total au centime, catégories retrouvées (par alias) ou à créer.
2. **Trouver ou créer la demande** — pour chaque ligne, les demandes 2026 qui ressemblent (nom, mois, montant ; un
   indice de la maquette — SPO-2026-003, le poste billetterie 124 750 de Genius Travel — met la demande en tête et la
   coche d'avance). « Compléter » ou « Créer la demande historique ». Visa : dossier promotionnel couvert, facultatif.
   Règles pures : `integration-suggestions.ts` (`scorer`, `apparierPostes`).
3. **Pièces** (facultatif à ce stade) — la liste attendue par demande ; les pièces déjà repérées (facture ePrint
   226-00572) sont rattachées à la validation.
4. **Vérifier et valider** — budget **avant → après** par catégorie et sous-catégorie (la MÊME règle, sur un lot simulé),
   ce que le fichier remplace, la liste « absentes du fichier » ; **double confirmation** (case + mot « INTÉGRER »,
   tenue au serveur) ; écriture **atomique** (`ecrireLot`, une transaction ; un seul lot actif par enveloppe — index
   partiel `AdProIntegrationLot_actif`). Le fichier est **relu et recontrôlé** à chaque étape : le navigateur ne porte que
   les choix.

Lot validé : ses 30 demandes (badge, pièces manquantes, lien), « Remplacées par le fichier », « Dans la plateforme,
absentes du fichier » (**garder / sortir**, à tout moment, rien n'est effacé — `deciderAbsenteIntegration`), et
**Annuler d'un bloc** (motif + mot « ANNULER » — `annulerLot` : retire les demandes historiques créées et leurs postes,
rend aux postes repris leur état d'avant, retire les postes ajoutés aux demandes complétées, retire les catégories créées
si plus rien ne les porte ; le lot reste, marqué annulé).

### La règle du budget — une seule, pour tous les lecteurs

`src/lib/budget/integration-regle.ts` (pur) : une fois un lot validé sur une enveloppe, y comptent **(a)** les postes
historiques (payés, à leur date, dans leur catégorie ou sous-catégorie, nature dérivée du poste), **(b)** ce qui naît
**après** la date d'intégration, **(c)** jamais deux fois une source d'une demande intégrée (créée, complétée, ou d'une
écriture RELIÉE à elle) ni d'un poste historique. Ce qui comptait avant et ne correspond à aucune ligne est « absent du
fichier » : compté tant qu'on n'a rien décidé, puis gardé ou sorti. Verdicts : `POSTE_HISTORIQUE`, `APRES_INTEGRATION`,
`REMPLACEE_PAR_LE_FICHIER`, `ABSENTE_A_DECIDER`, `ABSENTE_GARDEE`, `ABSENTE_SORTIE`.

Lectures : `src/lib/queries/budget-integration.ts` (contexte du lot actif, origine de chaque écriture — ordre, poste,
case de prise en charge, déclaration, dossier promo, facture réglée directement —, `jugerEcritures`, `jugerLignes`,
`jugerEngagements`, `consommationIntegree`). Lecteurs couverts : `queries/budget.ts` (vue d'ensemble, total des
enveloppes — donc tous les écrans, l'Excel, le cockpit, l'assistant), `budget-sources.ts` (`engagementsDesCategories` =
`engagementsBruts` + règle, y compris l'atterrissage automatique `pickAutoCategory`), `budget-marketing-depenses.ts`
(un poste historique s'y lit **Payée**), `budget-marketing.ts`, `budget-marketing-rapport.ts` (faits, PDF, PPTX, CSV),
`budget-campagne/prefill.ts`, `adventum/risks.ts`. **Cliquet** : `integration-regle.cliquet.test.ts` échoue si un fichier
agrège la consommation d'une catégorie sans importer la règle (ou sans exemption motivée), si `pickAutoCategory` gagne
un appelant non classé, ou si un export lit la base au lieu de la vue d'ensemble.

### Les écrans Ad & Pro

Bloc **« Historique 2026 »** (`components/ad-pro/bloc-historique.tsx`) en tête des fiches sponsoring, congrès national /
international, événement, matériel promotionnel, information médicale — et `/budget-marketing/integration/demande/<type>/<id>`
pour une formation (qui n'a pas de fiche) : badge, « Demandé par : Direction Marketing » (aussi dans l'en-tête du
sponsoring et du dossier promo), « aucun circuit », **postes payés** (montant, date, imputation, ligne du fichier),
écriture de trésorerie **reliée en lecture seule** et son **écart** (webinaire : 53 550 retenus / 53 350 payés),
**pièces attendues / manquantes** avec dépôt **multi-fichiers à tout moment** (`joindrePiecesIntegration` : Luna lit, le
montant et le fournisseur sont comparés à la ligne ; une facture déjà connue — `factures/connues.ts` — est **rattachée,
jamais redéposée** ; un doublon probable est signalé) et **rattachement** d'une pièce déjà sur la demande, un poste ou au
registre. Les postes historiques s'affichent payés dans la liste des postes (sans frise ni geste) ; les fiches voyageurs
des prises en charge s'ajoutent à tout moment (`addCareBeneficiary`, sans garde de statut). Le visa : une **déclaration
DIM « visa publicitaire »** (DIM-2026-…, validée), son **bon de versement payé** 240 000 (quittance attendue en pièce),
budget en Matériel promotionnel, rattachée au dossier promo couvert s'il est choisi.

**Aucun circuit** sur un poste historique : `loadItem` le signale et 28 gestes de `ad-pro-item-actions.ts` le refusent
(soumission, décision, devis, BC, paiement, révision…), comme l'imputation / la consommation / l'annulation du Budget
Marketing ; restent ouverts les pièces, la discussion et les fiches voyageurs / hôtellerie.

### Modèle (migration `20270124100000_integration_adpro_2026`, additive et idempotente)

`AdProIntegrationLot` (enveloppe, version, fichier + SHA-256 + pièce rangée, total, `integreLe`, créé / annulé par / le,
motif, **instantané avant** par catégorie, plan validé) ; `AdProIntegrationDemande` (lot, ligne(s) Excel, type + id de la
demande, mode `CREEE` / `COMPLETEE`, demandeur affiché, **pièces attendues**, pièces rattachées, écriture reliée, état
d'avant) ; `AdProIntegrationDecision` (garder / sortir par clé de source). Sur `AdProItem` : `historiqueLotId`,
`historiqueLigne`, `montantPayeHistorique`, `historiquePayeLe`, `historiqueAvant`, et deux porteurs de plus
(`promoMaterialParentId`, `declarationInfoMedId`) — la contrainte `AdProItem_one_parent` compte sept parents.

**Jamais touchés** : le livre de trésorerie (aucune `FinanceTransaction` créée, modifiée, supprimée) et les ordres de
dépense (aucun `ExpenseOrder`). Le test de flux le vérifie ligne à ligne, avant, pendant et après l'annulation.

### Fichiers clés

`src/lib/budget-marketing/{integration-2026,integration-suggestions,integration-vue,integration-serveur,integration-fixture}.ts`,
`src/lib/budget/integration-regle.ts`, `src/lib/queries/budget-integration.ts`, `src/lib/actions/integration-adpro-actions.ts`,
`src/app/(app)/budget-marketing/integration/` (assistant, lot, fiche), `src/components/ad-pro/{bloc-historique,pieces-historique}.tsx`.
Tests : `integration-2026.test.ts`, `integration-suggestions.test.ts`, `integration-regle.test.ts`,
`integration-regle.cliquet.test.ts`, `integration-flow.test.ts` (base locale, fixture synthétique du format).
