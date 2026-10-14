# Audit Ad & Pro — 14/10/2026

Demande de la Direction : « un audit extrêmement complet, poussé, profond sur Ad & Pro : les demandes, les uploads de devis (qu'on puisse mettre plusieurs devis, qu'ils soient tous transformés en natif dans la plateforme), que les validations sont bonnes, qu'il n'y a pas de doubles sources de vérité, que les bons de commande peuvent être générés, qu'ils peuvent être modifiés parfaitement (tous les détails), qu'il n'y a pas d'hallucinations ni d'augmentation de la TVA quand Luna transforme le devis en natif, que les demandes de paiement passent bien, que les factures acceptent plusieurs PJ, que toutes les infos sur n'importe quelle demande sont justes… »

## 1. Méthode et périmètre

- Chaque circuit a été suivi **dans le code** : actions serveur (`src/lib/actions/ad-pro-item-actions.ts`, `bc-signature-actions.ts`, `payment-centre-actions.ts`, `legal-actions.ts`), lectures (`src/lib/queries/ad-pro-items.ts`, `ad-pro-devis-poste.ts`, `action-center.ts`), règles pures (`src/lib/ad-pro/*`, `src/lib/pieces-lues/*`, `src/lib/bons-de-commande/*`, `src/lib/budget/engage.ts`) et écrans (`src/components/ad-pro/*`).
- La lecture « Luna → natif » a été éprouvée sur les **vraies règles pures**, avec des **sorties de modèle simulées et piégeuses** : TVA inventée, ligne doublée, ligne inventée, total faux, TTC recopié comme HT, nombres déjà convertis, séparateur ambigu, injection dans une désignation, remise, devise étrangère. **Aucun fournisseur d'IA n'est appelé** par les bancs (`@/lib/openai-luna` est coupé, la lecture est remplacée par un texte + une sortie de modèle).
- Les flux ont été rejoués sur la base locale par les **vrais points d'entrée**, avec des acteurs nommés (demandeur sans vue globale, Direction des opérations, Direction Marketing, Finances, une personne à deux rôles), un préfixe unique par run, et une course forcée (deux demandes de paiement simultanées).
- Les sujets confiés à d'autres branches (BC de Legal modifiables de A à Z, BC en un clic des prises en charge et comptage des pro forma dupliquées, PJ multiples du passeport et des fils, imputation Operations & Sales, Budget Marketing engagé/consommé, Bureau du secrétariat, `care-actions`) n'ont **pas été modifiés** : constat + test `it.fails` quand c'est utile.

## 2. Synthèse

| # | Gravité | Défaut | Statut |
|---|---|---|---|
| H-01 | Haute | Une TVA **inventée par le modèle** était reprise sur un devis qui n'en imprime aucune | **Corrigé** + 7 tests |
| H-02 | Haute | Le contrôle des totaux de la lecture était **calculé puis jeté** ; les lignes étaient validées d'office malgré un TTC imprimé contradictoire | **Corrigé** + tests |
| H-03 | Haute | Plusieurs devis joints d'un geste = **un seul devis**, et **seul le premier fichier** était transformé en lignes | **Corrigé** (un devis par fichier) + tests ; lecture multi-pages : proposée |
| H-04 | Haute | Facture d'un poste à BC : **une seule PJ gardée**, les autres jetées sans un mot | **Corrigé** + test |
| H-05 | Haute | L'ordre de dépense partait **au nom de l'opération** (« Congrès d'Oran ») au lieu du fournisseur qui a facturé | **Corrigé** + tests |
| H-06 | Haute | Paiement **refusé par le centre** ou **annulé** (facture annulée dans Legal) : le poste disait « Paiement en cours » pour toujours ; le geste qui libère était caché au demandeur, et absent pour un ordre annulé (**impasse**) | **Corrigé** (affichage, refus, menu) + tests ; libération automatique côté Legal : proposée |
| H-07 | Haute | Pro forma dupliquée comptée N fois (5 × 117 250 = 586 250 DZD) | Chantier d'une autre branche — **`it.fails` documenté** |
| H-08 | Haute | **Auto-validation** : une personne Direction des opérations ET Direction Marketing accordait seule montant et budget de **sa propre demande** | **Corrigé** + tests (pur + flux) |
| M-01 | Moyenne | Facture illisible sans montant saisi : la case paiement n'avait **aucun champ montant** alors que l'action l'exige (impasse) | **Corrigé** + test de flux |
| M-02 | Moyenne | La TVA retenue d'un devis n'était **pas affichée** sur la carte des lignes | **Corrigé** (écran) |
| M-03 | Moyenne | **Deux plafonds** pour le même accordé : la génération compare le TTC, « Modifier le BC » et l'aperçu corrigé ne comparent que le HT | **`it.fails` documenté**, proposé |
| M-04 | Moyenne | « Modifier le BC » depuis le poste ne lit ni le fournisseur, ni la TVA, ni le mode/les conditions de paiement, ni la date de livraison | Chantier « BC de A à Z » — **`it.fails` documenté** |
| M-05 | Moyenne | Aperçu corrigé : le plafond ne compte pas les BC déjà émis des autres devis du poste | Proposé |
| M-06 | Moyenne | Validation d'office possible **sans aucun total imprimé** de contrôle | Proposé |
| M-07 | Moyenne | Pages d'un même devis : seul le premier fichier est lu (désormais **dit**) | Proposé (lecture fusionnée) |
| M-08 | Moyenne | L'engagé budgétaire compte les ordres **refusés par le centre** | Chantier Budget Marketing — constat |
| M-09 | Moyenne | Le visa du centre porte sur le prestataire **texte libre** du poste, pas sur le fournisseur du BC | Proposé |
| M-10 | Moyenne | Re-décision à un montant plus bas : les BC déjà émis au-dessus du nouvel accordé ne sont pas signalés | Proposé |
| M-11 | Moyenne | Montant « devis » saisi à la main (`LegalDocument.amount`) ≠ total des lignes natives : deux vérités | Proposé |
| B-01 | Basse | Le bilan de génération écrit « … DZD TTC » même pour un BC sans TVA | Proposé |
| B-02 | Basse | Bancs rouges préexistants (mock de session sans `requireUserAuNomDeLaVue`, dérives de libellés) | 3 corrigés, le reste constaté |

**Tests ajoutés : 58** (30 purs « Luna → natif », 13 règles dont 3 `it.fails` documentés, 15 de flux sur la base locale). Tests existants ajustés : `poste-etapes.test.ts` (+1 assertion), `devis-bc-flow.test.ts` (libellé), mocks de session de `ad-pro-postes-flow.test.ts` et `promo-devis-lecture-flow.test.ts`.

## 3. Les circuits, de bout en bout

### 3.1 Demandes (sponsoring, congrès, événement, prise en charge)

- Création par module (`PARENTS`, `ad-pro-item-actions.ts:156`), postes (`addAdProItem`), soumission (`submitAdProItem`) puis **validation en deux temps** (`decideAdProItem:1854`) : Direction des opérations, puis Direction Marketing qui fixe **montant et budget** (exigés ensemble). Écriture conditionnelle (`ecrireDecision:1981`) : deux décisions croisées n'en posent qu'une ; une décision ne s'applique pas à un poste dont le temps a changé.
- Rallonges : `montantDeLaDemande` (pur) reprojette le montant de la demande à chaque décision, révision et suppression (`reprojeterMontantDemande`) — recalcul, pas incrément : correct.
- Gardes : `loadItem` (porte de la fiche), `canEditItems` / `canAllocate`, `refusSiClos` / `refusDemandeFermee` (décision sur objet clos ou refusé), `refusArgentSurPosteStock`. Matériel du stock : décision unique. Sponsoring indirect non réparti : ne s'accorde pas.
- **Défaut H-08** (corrigé) : la règle « on n'arbitre pas sa propre demande » se lisait **sur les rôles** (`peutTenir`, `validation-poste.ts`). Une personne `DIRECTION` + `PRODUCT_MANAGER` voyait son premier temps franchi d'office, puis tenait le second (« demande de la Direction Marketing → la Direction des opérations tranche ») : elle accordait seule sa demande. Scénario reproduit dans `audit-ad-pro-flow.test.ts` (« ON N'ARBITRE PAS SA PROPRE DEMANDE ») : avant correctif, l'accord passe ; après, refus et une autre Direction des opérations tranche. Correctif : `Porteur.id`, `peutTenir` refuse quand la personne **est** le demandeur (le Super Admin garde la suppléance) ; les trois lecteurs passent l'identifiant (`ad-pro-item-actions.ts:309`, `queries/ad-pro-items.ts` `contextePostes`, `queries/action-center.ts`).

### 3.2 Devis : dépôt, plusieurs devis, doublons

- `ajouterDevisPoste` (`ad-pro-item-actions.ts:1087`) : fichier exigé, jugé avant toute écriture, pièce au registre Legal (`kind: QUOTE`), rattachée au(x) poste(s) (`AdProItemPiece`), puis **lue** (`ingererDevisDuPoste`).
- **Défaut H-03** (corrigé) : le champ fichier est `multiple`, mais tous les fichiers devenaient UN devis et seul `fichiers[0]` était lu. Trois devis de trois fournisseurs joints d'un coup = un « devis » au titre unique, deux devis jamais transformés en lignes, invisibles du contrôle et du BC. Correctif : `unDevisParFichier` (`:1120`) — chaque fichier devient SON devis, lu, contrôlé, validable ; la carte coche la case d'office dès qu'on joint plusieurs fichiers et masque montant/référence (une valeur ne vaut pas pour trois devis ; l'action refuse aussi). Décochée, les fichiers sont les pages d'un même devis : le message dit désormais que seul le premier a été lu (M-07). La proposition d'un voyageur reste un devis (le champ est retiré dans `ajouterDevisVoyageur`).
- **H-07** (autre branche) : `depassementDevisRetenus` (`voyageurs.ts:350`) et `depassementDuPoste` (`ad-pro-item-actions.ts:3468`) additionnent les montants des devis retenus **par voyageur** ; la même pro forma de groupe déposée cinq fois fait 586 250 DZD. `it.fails` dans `audit-ad-pro-regles.test.ts` (à retourner quand le correctif est fusionné). Rien n'empêche non plus de déposer deux fois le même fichier sur un poste (empreinte non comparée).

### 3.3 Luna transforme le devis en natif

Chaîne : `proposerLecture` (`pieces-lues/service.ts` — texte natif, sinon Luna transcrit le scan, `moteur-luna.ts`) → `repererEntetes` (repérage déterministe du papier) → modèle structuré (`SCHEMA_PIECE_LUE`, chaque nombre en **chaîne**) → `lireStructureModele` (relecture stricte, `montants.ts`) → `controlerPiece` → `preremplirDevisPromo` → `lignesDepuisLaLecture` → `AdProDevis` / `AdProDevisLigne`.

Ce qui tenait déjà (vérifié par tests) : un nombre déjà converti par le modèle est illisible ; « 1.200 » n'est jamais tranché ; « 1,500 DZD » se lit 1 500 ; une remise n'est jamais convertie en prix net ; une devise étrangère ne préremplit aucun montant ; une injection dans une désignation reste un libellé signalé ; le **total HT prérempli est celui du papier**, jamais celui du modèle ; quantité × prix ≠ montant de ligne imprimé → réserve sur la ligne ; arrondis au centime par ligne, TVA sur le total.

- **Défaut H-01** (corrigé) : la TVA, elle, était prise **chez le modèle** (`tvaDefaut` ou TVA de ligne) même quand le papier n'en imprime aucune. Scénario (celui de la Direction) : pro forma de billetterie de 117 250 DZD, « Total HT 117 250 / Total TTC 117 250 », le modèle rend `tvaDefaut: "19"` → `tvaRate = 19` en base → BC à 139 527,50 DZD (ou refusé « au-delà de l'accordé »). Correctif : `tvaCorroboree` (`prerempli-devis-promo.ts:269`) — un taux du modèle n'est repris que si le papier imprime une TVA (au même taux, un « Total TVA » non nul, ou un conflit de TVA) ou si **les totaux imprimés la contiennent** (TTC ou net = HT imprimé — ou HT des lignes — × (1 + taux) + taxes additionnelles (+ timbre), à 1 DZD). Sinon `tvaRate` reste `null` (« pas de TVA imprimée, pas de TVA ») et une réserve le dit. « TVA : 0,00 » ne confirme rien. La règle sert aussi le matériel promotionnel (même module).
- **Défaut H-02** (corrigé) : `controlerPiece` calculait écarts (TTC, TVA, HT…) et désaccords (repérage contre modèle), mais `ingererDevisDuPoste` n'en gardait que les désaccords **de ligne**. Un TTC imprimé de 400 000 contre 476 000 recalculés ne se voyait nulle part et les lignes étaient **validées d'office**. Correctif : `doutesDeLaLecture` (`devis-poste.ts`) ; les doutes sont **écrits avec le devis** (`lectureNote`, « À VÉRIFIER SUR LE PAPIER : … », `devis-poste-lecture.ts:75-86`), dits en tête du message de l'upload, et **bloquent la validation d'office** (dépôt et relecture). Une correction à la main (`enregistrerLignesDuDevis`) éteint le doute (`noteApresCorrection`).
- **M-02** (corrigé) : la carte des lignes n'affichait que du HT ; la TVA retenue et le TTC validé sont désormais visibles (`devis-bc-poste.tsx:461`).
- **M-06** (proposé) : `validerAutomatiquementLesLignesLues` (`:3869`) valide d'office quand aucune ligne n'a de réserve et que le HT colle « quand le devis en porte un » : sans total imprimé, une ligne inventée ou doublée par le modèle passe. Proposition : exiger qu'un total imprimé (HT, ou TTC confirmé par `tvaCorroboree`) confirme les lignes avant toute validation d'office.
- **M-07** (proposé) : lire **toutes** les pages d'un devis multi-fichiers (une lecture par fichier, lignes concaténées, en-tête pris sur la page qui porte les totaux).

### 3.4 Validations

- Poste : deux temps (§118.204), motif exigé pour refus/renvoi, intérim et suppléance du Super Admin ; centre Ad & Pro au-delà du seuil (`porteDgRequise` : strictement au-dessus ; montant inconnu ⇒ la porte s'ouvre) ; BC : `aiguillerBC` (unique porte vers les centres), visa du poste pour les BC générés (`portesDesBC`, source « POSTE »), empreinte du visa (`gesteVisaPoste`) rouvre sur hausse de montant ou changement de prestataire.
- **M-09** (proposé) : l'empreinte du visa porte sur `AdProItem.supplier` (texte libre, souvent vide), pas sur le fournisseur du devis/BC réellement commandé. Un BC pour un autre fournisseur que celui que le centre a lu ne rouvre rien. Proposition : comparer aussi la contrepartie des BC du poste.
- **M-10** (proposé) : « Revoir la décision » à un montant plus bas (`decideAdProItem`) ne regarde pas les BC déjà émis ; un BC signé au-dessus du nouvel accordé ne se paie plus (« la facture dépasse l'accordé ») — refus honnête mais tardif. Proposition : refuser la baisse sous le TTC des BC vivants, ou le dire au moment de la décision.

### 3.5 Bons de commande

- Génération (`genererBonDeCommandePoste` → aperçu/brouillon, puis `validerEtEnvoyerBcPoste` par le demandeur seul) : un BC par devis, uniquement les lignes validées, numérotation NNN/DG/AAAA attribuée à la validation, Word + PDF par la fabrique, révision = même numéro, version + 1 ; BC signé ou facturé figé. Vérifié de bout en bout : **un devis sans TVA donne un BC sans TVA** (117 250 DZD), un devis à 19 % imprimés donne 142 800 TTC.
- **M-03** (`it.fails`) : `refusDepassement` (génération) lit le **TTC** contre l'accordé ; `modifierBcDuPoste` (`:1697`) et l'aperçu corrigé (`:4012`) ne comparent que le **HT**. Scénario : accordé 450 000, BC modifié à 440 000 HT à 19 % = 523 600 TTC → accepté avec un simple avertissement, alors que la génération l'aurait refusé. Proposition : une seule règle (`refusDepassement`) aux trois points, sur le TTC calculé par la fabrique (aperçu à blanc avant la révision).
- **M-04** (`it.fails`, chantier « BC de A à Z ») : `modifierBcDuPoste` ne lit que lignes, objet, notes, adresse et délai de livraison, contact. La fabrique (`ModificationsDocument`) accepte `tiers` (adresse, e-mail, NIF, RC), `tvaDefaut`, `modePaiement`, `conditionsPaiement`, `livraison.date`, `referenceAmont` — l'aperçu (`modifierApercuBcPoste`) les lit déjà. Quand l'éditeur commun (`reviser-piece.tsx`) enverra ces champs, l'action devra les lire, sinon ils seront ignorés en silence.
- **M-05** (proposé) : au moment de valider un aperçu corrigé, le plafond ne somme que les devis en cours (`aFaire`), pas les BC déjà émis des autres devis du poste.
- **B-01** (proposé) : `phraseBilanGeneration` (`ad-pro-bc-devis.ts:330`) écrit « … DZD TTC » même pour un BC sans TVA.

### 3.6 Demandes de paiement, centre de paiement, Finances

- `demanderPaiementPoste` → `payerLesFacturesDuPoste` (`:1546`) : tous les BC signés et facturés, facture incohérente ⇒ argumentation + confirmation, montant = somme des factures, plafonné par l'accordé, prise conditionnelle du poste (vérifié : **deux demandes simultanées ne font qu'un ordre**).
- **H-05** (corrigé) : `beneficiary: item.supplier ?? info.beneficiary` — le prestataire du poste est un texte libre souvent vide ; l'ordre partait alors au nom de l'opération (« Congrès d'Oran », l'institution d'un sponsoring) alors que la facture est celle de l'hôtel. Correctif : `beneficiaireDuPaiement` (`bc-poste.ts:75`) — le fournisseur que les factures nomment (celui du BC), s'il est unique ; sinon le prestataire du poste, sinon l'opération.
- **H-06** (corrigé) : un ordre **refusé par le centre** reste `PENDING` côté Finances (`centralStatus = REFUSED`) ; un ordre **annulé** par l'annulation de sa facture dans Legal (`legal-actions.ts:642`, `annulerOrdreNonRegle`) laisse `AdProItem.expenseOrderId` pointé dessus. Dans les deux cas la carte disait « Paiement en cours — chez le centre de paiement », `demanderPaiementPoste` et `deposerFacturePoste` refusaient « déjà demandé », et le menu « Annuler la demande de paiement » n'était offert ni au demandeur (alors que l'action l'accepte de lui) ni pour un ordre `CANCELLED`. Correctif : `etatDuPaiement` / `phrasePaiementBloque` (`poste-etapes.ts:153`) lus par la frise, le geste suivant, la case paiement et les refus d'action (`refusPaiementDejaDemande:1059`) ; menu ouvert au demandeur et aux ordres annulés (« Libérer le poste », `items-panel.tsx:584`). Proposition complémentaire : à l'annulation d'une facture dans Legal, libérer le poste dans la même écriture.
- **M-01** (corrigé) : facture illisible et aucun montant saisi au dépôt → l'action répond « indiquez-le », mais la case paiement n'avait pas de champ : seule issue, annuler la facture dans Legal. Champ « Montant TTC à payer » ajouté quand le total ne se lit pas.

### 3.7 Factures

- **H-04** (corrigé) : `deposerFacturePoste` / `payerLesFacturesDuPoste` ne prenaient que `getAll("attachment").find(...)` et l'écran n'offrait qu'un fichier. Désormais : la première pièce est la facture (lue, contrôlée), les suivantes ses annexes, toutes jugées avant écriture et gardées sur la même pièce du registre ; les échecs sont nommés.
- Facture sans fichier : refusée. Facture annulée : son ordre est annulé (Legal) — voir H-06. Contrôle Luna de la facture contre les BC (montant à 1 DZD, montant lu ≠ saisi, BC cités, fournisseur) : gardé sur la facture (`custom.facturePoste.controle`).

### 3.8 Cohérence de ce que la fiche affiche

- La frise et le « chez qui » lisent maintenant l'état réel du paiement (payé / refusé / annulé / en cours).
- Le devis dit sa TVA retenue, ses doutes de lecture, l'écart avec le total imprimé.
- Les messages de dépôt nomment les fichiers lus et non lus.

## 4. Carte des sources de vérité (montants d'un poste)

| Montant | Où il vit | Qui l'écrit | Qui le lit | Risque de divergence |
|---|---|---|---|---|
| Estimé | `AdProItem.amountEstimated` | demandeur | soumission, frise | — |
| Accordé | `AdProItem.amountGranted` | Direction Marketing (2ᵉ temps), révision | plafonds BC (TTC) et paiement, visa, budget | **M-10** (baisse sous les BC émis) |
| Montant de la demande | `SponsoringRequest.amountGranted` / `finalAmount` | `reprojeterMontantDemande` (base `WorkflowInstance.amount` + rallonges) | fiche de la demande | recalculé à chaque décision : cohérent |
| Montant d'un devis | `LegalDocument.amount` (saisi, facultatif) **et** lignes `AdProDevisLigne` | demandeur / lecture | voyageurs (`depassementDuPoste` lit `amount`), BC (lit les lignes) | **M-11** double source ; **H-07** copies |
| TVA d'un devis | `AdProDevis.tvaRate` (`null` = aucune) | lecture (désormais corroborée), correction | totaux, BC (`tvaDefaut`) | **H-01** corrigé |
| Total imprimé | `AdProDevis.announcedTotal` (HT du papier) | repérage | `ecartAvecLeTotalImprime` | TTC imprimé non gardé (les doutes le portent désormais) |
| Lignes validées | `AdProDevisLigne.validatedItemId` | demandeur, validation d'office | BC, plafond | **M-06** |
| BC | `LegalDocument` `PURCHASE_ORDER` (`amount` = TTC fabrique) + `custom.fabrique` | fabrique | facture, budget (engagé) | **M-03/M-05** plafond HT/TTC |
| Fournisseur | `AdProItem.supplier` (texte libre) **et** `LegalDocument.counterparty` du devis/BC/facture **et** `AdProDevis.supplierId`/`fournisseurLu` | demandeur / lecture / fabrique | visa (texte libre), BC (devis), ordre (désormais factures) | **M-09** ; **H-05** corrigé |
| Facture | `LegalDocument` `INVOICE` (`amount` = lu, sinon saisi) | demandeur | paiement | — |
| Ordre de dépense | `ExpenseOrder` (`status` + `centralStatus`) | `createExpenseOrder` | centre, Finances, poste, budget | **H-06** corrigé (poste) ; **M-08** (budget) |
| Payé | `ExpenseOrder.status = PAID` | Finances | frise, budget consommé | — |
| Engagé | calculé (`budget-sources.ts`) : max(ordres non réglés, BC − payé) | — | Budget Marketing | **M-08** : compte les ordres refusés par le centre |

## 5. Propositions classées

1. **(Haute)** Libérer le poste à l'annulation d'une facture dans Legal (même écriture que l'annulation de l'ordre) — supprime la dernière étape manuelle de H-06.
2. **(Haute)** Un seul plafond « TTC ≤ accordé » pour générer, modifier et valider un aperçu corrigé, calculé par la fabrique à blanc (M-03, M-05).
3. **(Haute, autre branche)** Ne compter qu'une fois une même pièce (empreinte du fichier) et lire le montant retenu sur les lignes natives plutôt que sur `LegalDocument.amount` (H-07, M-11).
4. **(Moyenne)** Validation d'office seulement quand un total imprimé confirme les lignes (M-06).
5. **(Moyenne)** Lecture fusionnée des pages d'un même devis (M-07).
6. **(Moyenne)** Empreinte du visa sur le fournisseur réellement commandé (M-09) ; garde de la baisse de l'accordé sous les BC émis (M-10).
7. **(Moyenne, autre branche)** Exclure de l'engagé les ordres refusés par le centre (M-08) ; ouvrir `modifierBcDuPoste` aux champs du fournisseur, de la TVA et des conditions (M-04).
8. **(Basse)** Libellé « TTC » du bilan de génération sans TVA (B-01) ; mocks de session des ~90 bancs qui ignorent `requireUserAuNomDeLaVue` (B-02).

## 6. Tests

- `src/lib/ad-pro/audit-luna-devis.test.ts` (30, purs) — la chaîne « Luna → natif » sur les vraies règles, sorties de modèle piégeuses ; un sabotage du correctif H-01 fait tomber 6 cas.
- `src/lib/ad-pro/audit-ad-pro-regles.test.ts` (13, purs) — état du paiement, bénéficiaire, sa propre demande, points d'appel de la carte ; `it.fails` H-07, M-03, M-04.
- `src/lib/ad-pro/audit-ad-pro-flow.test.ts` (15, base locale, vrais points d'entrée) — trois devis en un geste tous lus ; TVA inventée non reprise et doute gardé ; ligne doublée non validée d'office ; montant refusé en dépôt multiple ; pages d'un devis ; correction qui éteint le doute ; BC sans TVA à 117 250 ; signature ; facture à trois pièces ; ordre au nom du fournisseur ; course de deux demandes ; refus du centre dit et libéré ; ordre annulé dit et libéré ; facture illisible payée avec le montant saisi ; auto-validation refusée. Un sabotage de H-05 et H-08 fait tomber les cas correspondants.

### Bancs rouges préexistants constatés (hors de ce lot)

- ~90 bancs mockent `@/lib/session` sans `requireUserAuNomDeLaVue` : toute action de création qui l'appelle échoue (`createPromoMaterial`, sponsoring…). Corrigé dans `ad-pro-postes-flow.test.ts` (23/23 verts) et `promo-devis-lecture-flow.test.ts`.
- `promo-devis-lecture-flow.test.ts` : 6 cas comptent les documents d'un dossier promo (2 attendus 0) — dérive préexistante, sans lien avec la TVA (les cas TVA passent).
- `direction-marketing-flow.test.ts` DM-03 et « LE PÔLE » : prémisse d'accès à un contrat de consulting RH — sans lien avec ce lot.
- `devis-bc-flow.test.ts` « LES BC NE DÉPASSENT JAMAIS L'ACCORDÉ » : libellé attendu dépassé par `refusDepassement` — corrigé (25/25 verts).
