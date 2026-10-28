### Ad & Pro — rapprochement assisté par Luna ; « Déjà imputé » hors postes (2026-10-14)

« Ce qui a déjà été intégré au budget, dans les demandes Ad & Pro ; chercher bien profond dans tous nos fichiers et les
faire matcher. » **Onglet Dépenses** : « Déjà imputé » devient « Déjà imputé hors postes Ad & Pro » et ne relit plus les
postes Historique 2026 (déjà au tableau des postes) — les chiffres ne comptaient qu'une fois, l'affichage le dit
(`budget-marketing/depenses-autres.ts`, test « chaque dinar consommé apparaît une fois »). **Rapprochement**
(`/budget-marketing/integration/rapprochement`, gestionnaire de l'enveloppe) : chaque dépense hors poste (écriture,
ligne budgétaire, ordre) et chaque écriture « à imputer » reçoit des propositions vers les demandes du lot (montant exact /
1 DZD / somme de plusieurs écritures, fournisseur, mois, libellés, références, pièces lues par Luna), avec score et
justification ; les fichiers de la plateforme (Legal, Ad & Pro, secrétariat, ordres, Drive, messagerie de la personne) sont
lus **par tranches** depuis l'écran — une fois par empreinte — et proposés pour les pièces manquantes. Rien sans
validation ; « certaine » = montant au centime + même fournisseur + référence, une seule cible. Une écriture rattachée ne
compte plus deux fois (la règle du lot la lit), une pièce rattachée est un lien. « Pas Ad & Pro » (enveloppe plausible,
rien d'imputé), doublons probables avec renvoi. Migration `20270125100000_rapprochement_adpro`. Détail :
[36-integration-depenses-adpro-2026.md](36-integration-depenses-adpro-2026.md#le-rapprochement-assisté-par-luna).

### Budget Marketing : les onglets — Intégration 2026 en onglet, une ligne par demande, cumul des sous-catégories, réallocation bornée (2026-10-14)

Maquette « onglets » validée par la Direction (Dépenses inchangé). **Onglet Intégration 2026** (gestionnaire seulement,
pastille des absentes à décider) au lieu du bandeau des Réglages. **Vue d'ensemble** : « À traiter » enrichi (payée sans
allocation → Réallouer ; pièces manquantes ; absentes du fichier), camemberts remplacés par deux barres à 100 % et un
classement par nature, cumul payé face au rythme sur son graphique, tableau « Par catégorie » dépliable (cumul des
sous-catégories) qui ouvre les demandes filtrées. **Réallouer** borné à la part cessible (au-dessus du payé + engagé et
de ce que répartissent les sous-catégories), seconde confirmation, audit. **Demandes Ad & Pro** : une ligne par demande,
tuiles, filtres dans l'adresse (statut dont pièces manquantes, catégorie sous-catégories comprises, origine, recherche),
fiche en panneau avec dépôt des pièces. **Réglages** : cartes dépliables, formule du cumul, « Sans allocation », part
répartie. Calculs purs : `budget/marketing-vue.ts` (`arbreCategories`, `cessible`, `alertesBudget`…),
`budget-marketing/demandes-vue.ts` ; tests purs + flux `reallocation-flow.test.ts`.

### Ad & Pro — intégration des dépenses réelles 2026 : 32 dépenses, 30 demandes, 33 558 715,94 DZD (2026-10-14)

Maquette « adpro-integration » validée par la Direction : le fichier « Dépenses AP » (Feuil1) entre dans Ad & Pro d'un bloc,
chaque dépense dans SA demande — créée **« Historique 2026 »** (demandée par la Direction Marketing, aucun circuit : ni
validation, ni BC, ni centre de paiement, ni ordre de dépense) ou existante **complétée** — avec ses postes payés, ses
pièces attendues (obligatoires, non bloquantes, jointes à tout moment, plusieurs fichiers, lues par Luna, une facture déjà
connue rattachée au lieu d'être redéposée) et son imputation (catégories et sous-catégories d'Événements). Les symposiums
SAI et Pr Djaballah sont des postes de leur congrès ; le visa de publicité est une déclaration DIM « visa publicitaire »
avec son bon de versement payé. Les décisions sont versionnées (`budget-marketing/integration-2026.ts`) et un fichier qui
ne leur correspond plus est refusé. Assistant en quatre étapes (`/budget-marketing/integration`, depuis Réglages) : lire,
trouver ou créer, pièces, vérifier (avant → après au centime) et valider (double confirmation, écriture atomique) ;
**annulable d'un bloc**. **Une seule règle de budget** pour tous les lecteurs (`budget/integration-regle.ts` +
`queries/budget-integration.ts`) : postes historiques, ce qui naît après, jamais deux fois ; la liste « Dans la
plateforme, absentes du fichier » se tranche élément par élément (garder / sortir). Cliquet
`integration-regle.cliquet.test.ts`. Livre de trésorerie et ordres de dépense jamais touchés. Migration
`20270124100000_integration_adpro_2026`. Détail : [36-integration-depenses-adpro-2026.md](36-integration-depenses-adpro-2026.md).

---

### Factures — « pas deux factures » : doublons bloqués, relance unifiée, recensement (2026-10-14)

Décision de la Direction (14/10) : une facture déjà connue — même fichier (SHA-256), ou même fournisseur et même numéro
lus par Luna — est **refusée avant toute écriture** à chaque porte de dépôt (demande de paiement, poste Ad & Pro, Budget
Marketing, registre Legal, dépôt libre d'une facture, fin d'une demande au secrétariat), dans les deux sens. Le message
dit « Cette facture existe déjà … elle est en cours de traitement — au centre de paiement / chez les Finances » (ou
« déjà payée ») ; le dossier n'est nommé qu'à qui y a accès ; un seul geste : **Relancer** (un clic, commentaire
facultatif, jeton signé). Un doublon **probable** (même fournisseur, même TTC, même date sans numéro lisible ; NIF à un
caractère près…) passe avec un avertissement et la marque « doublon possible », lue au centre de paiement et dans
« Banque & paiements ». Une pro forma face à sa facture finale, un avoir, deux acomptes ne sont pas des doublons. La
comparaison est du code (`factures/identite.ts`), la lecture vient de Luna avec ses garde-fous ; le banc
`identite.banc.test.ts` exige zéro faux CERTAIN. **Relance unifiée** `relancerPaiement` (demande OU ordre de dépense, à
qui a la main : centre, puis Finances ; une par heure), aussi depuis la case Paiement d'un poste Ad & Pro ; la relance du
dossier (`nudgePaymentRequest`) partage le délai et les destinataires. **Recensement unique** en lecture seule :
`npm run factures:doublons` et Finances › **Doublons de factures** (`/finances/doublons-factures`, « à examiner /
examiné » au journal d'audit, sans migration). Détail : [35-doublons-de-factures.md](35-doublons-de-factures.md).

---

### BC et factures — titre centré, bleu canard, premier numéro, taxes, Excel, aperçu (2026-10)

Ajustements de la Direction sur les bons de commande et les factures (§118.203) :

- **Titre** « BON DE COMMANDE » (« DEVIS » pour un devis), centré, en gras, à l'accent, sous l'en-tête et avant « B.C : N° … ».
- **Bleu canard** `#087084` (R 8, V 112, B 132) à la place du rouge : accent par défaut du Word, du PDF et du classeur Excel.
  La charte tranche *marque > bleu canard* ; **la pastille de la société** (`Company.color`, une couleur d'écran) **ne colore plus
  aucune pièce**. Une pièce déjà émise garde sa couleur (un document émis ne se repeint pas) ; une **révision** repeint l'accent
  d'après la charte du jour. Un accent rouge réglé dans **Administration › Marque** l'emporte encore : il se change là.
- **Premier numéro de la série** : Legal › Composer un bon de commande › Numérotation › « Premier numéro de 2026 » (par nature et par
  année). C'est un **plancher** : le numéro attribué vaut `max(dernier + 1, départ)`, le compteur ne recule jamais, une autre année
  repart à 001. La migration `20270105090000` pose 32 pour 2026 sur les profils dont le motif des BC porte `/DG/` (le BC
  `032/DG/2026` est donc le premier) ; une société sans motif règle motif et premier numéro ensemble.
- **Taxes supplémentaires** : une ligne « libellé + taux » toujours visible (composeur, génération et modification du BC d'un
  dossier promotionnel) ; « Taxe Pub 2 % » en un clic ; calculée sur le HT, **hors base de TVA**.
- **Aperçu avant impression** : le PDF à blanc dans la page, avec le numéro prévu — aucun numéro consommé, rien d'écrit.
- **Générer sur Excel** : la pièce rendue en classeur à formules vivantes (fiche Legal, résultat du composeur, ligne du BC d'un
  dossier promotionnel) ; comparé au centime au calcul du Word, non livré s'il s'en écarte ; même porte que le Word. La somme en
  lettres est un texte arrêté à l'émission (le classeur le dit).
- **Devis déposés → devis de la plateforme** : déjà en place (lecture par Luna, tableau par devis, validation d'un devis entier ou de
  lignes de plusieurs devis, génération des BC d'après ce qui est validé, BC modifiable en natif, révisions). Un scan par
  « Retranscrire un devis ».

**Regulatory — la « CTD initiale » (§118.213)** : à la création d'un dossier, un champ facultatif « CTD initiale » prend un
**.zip complet ou un dossier entier** (arborescence conservée) ; il part, **une fois le dossier créé**, vers l'**étape 1** du
processus (« Réception du CTD complet ») par le gestionnaire d'envois d'arrière-plan (dépôt direct au bucket pour les gros
fichiers, « Réessayer » dans la pastille en cas d'échec) sans retenir la création. Sur la fiche, l'étape 1 porte un bloc bien visible
**« CTD initiale »** (même importance que « Réserves & réponses (ANPP) ») : contenu en dossiers dépliables, un .zip se parcourt
sans être téléchargé, **ajouter** des fichiers ou un dossier dans un sous-dossier choisi (existant ou nouveau), **remplacer** la CTD,
**supprimer** la CTD (aperçu + double confirmation), **renommer** un dossier. Remplacer et supprimer mettent la CTD à la
**corbeille** d'un bloc (type `REGULATORY_CTD`, fichiers conservés) : le Super Admin la restaure depuis Administration › Corbeille,
sauf si une autre CTD vit déjà sur le dossier. Une CTD est **reconnue par un fait** — pièce du dossier, étape 1, catégorie « CTD
complet » (`lib/regulatory/ctd-initiale.ts`) —, donc les dossiers d'avant en ont déjà une. Droits : ceux du dépôt de documents du
dossier (`canAccessEntity` UPLOAD, portée de ligne, gamme, verrou) ; retirer, remplacer et renommer exigent en plus de pouvoir
**modifier** le dossier. Un dépôt « CTD complet » sur l'étape 1 qui ne vient pas du bloc est refusé, avec le geste qui existe.

---


### Matériel promotionnel — « Commandes » : une ligne par BC, un bouton, clôture automatique (2026-10)

Étape 4 de la maquette validée (« Commande, livraison, paiement ») : la carte « Bons de commande, réception, factures » devient
**« Commandes »**, pleine largeur ; la carte « Visa / déclaration » disparaît (sa colonne entre dans le tableau). Une ligne par BC :
Fournisseur (figé, avec les articles commandés) · BC (NNN/DG/AAAA, le PDF) · TTC · Livraison · Facture · Paiement · Visa /
déclaration IM, chaque état en une pastille, et **un seul bouton** — le prochain geste de qui regarde : « Joindre la facture »,
« J'ai reçu » (la réception se coche sur les lignes de la facture, ce qui entre au stock), « Demander le paiement ». Le reste
(aperçu, fichiers, envoi, modification, suppression, détail, renoncement, rattrapage du visa) reste dans « ⋯ ». Total en pied.
La demande de visa / déclaration part avec chaque paiement (formalité proposée : celle de la demande précédente du dossier).
**Clôture automatique** (`lib/promo-cloture.ts`) : quand chaque BC est signé, entièrement facturé, reçu, réglé et visé, le dossier
passe « terminé » — au règlement de l'ordre (`settleExpenseOrder`) ou au rattrapage du visa ; mêmes vérifications que
`completePromoTrack` (extraites, inchangées) ; « Clore le dossier » reste offert aux pilotes en repli. Règles pures :
`promo-material/fiche.ts` (`pastillesDeLaCommande`, `gesteDeLaCommande`, `totalDesCommandes`, `commandesSoldees`,
`formaliteDuDossier`), testées dans `commandes.test.ts`.

---


### Éditeur Office — « Tester l'éditeur Office » et aperçu de secours (2026-10)

**Administration › carte « Éditeur Office (OnlyOffice) »** (Super Admin, sous « Stockage objet », ancre `#editeur-office`) :
« Tester l'éditeur Office » (`onlyoffice-diagnostic-actions:testerEditeurOffice`, lecture seule) rend ✓ / ⚠ / ✗ + correctif pour
les variables (`ONLYOFFICE_URL`, `ONLYOFFICE_JWT_SECRET` — « défini, N caractères », jamais la valeur —, `APP_URL` ou son repli),
la forme des adresses (https, barre finale, adresse interne), `/healthcheck` et `api.js` vus de notre serveur (DNS, refus,
certificat, délai, 502/503 « endormi » distingués), la même adresse en https si elle est en http, `{APP_URL}/api/onlyoffice/file`
(401 attendu), puis le chargement d'`api.js` **dans le navigateur** (contenu mixte, réseau interne). Interprétation pure :
`lib/onlyoffice-diagnostic.ts` (testée). **Écran d'édition** : quand l'éditeur ne se charge pas, une ligne « Éditeur indisponible
— aperçu en lecture seule » (Réessayer, Télécharger, Diagnostiquer pour le Super Admin) au-dessus de l'aperçu du navigateur
(Word, Excel, PowerPoint, PDF, texte) ; un document neuf jamais enregistré dit « Document vierge » (`estDocumentVierge`).
**Correctif** : `/api/onlyoffice/file` et `/callback` étaient derrière la connexion (middleware) — le Document Server, sans
session, recevait `/login` ; ils sont exemptés (chemins exacts, jeton signé vérifié par chaque route).

---
---

### Ad & Pro — pièces jointes multiples : passeports, fils de discussion, fiches saisies avec le poste (2026-10)

- **Passeport en plusieurs fichiers** (recto, verso, pages, visa). *Voyageurs d'un poste billetterie* (`voyageurs-bloc.tsx`) :
  « Joindre le passeport » ouvre deux rubriques — **Passeport** (dépôt `ID_DOCUMENT` multiple, liste des fichiers avec aperçu et
  retrait) et **Autres documents** ; « passeport manquant » disparaît dès le premier fichier ; à la création, `ChoixFichiers`
  accumule plusieurs fichiers. *Fiche voyageur d'une prise en charge* (`care/fiche-voyageur.tsx`) : chaque pièce liste TOUS ses
  fichiers (`Document` de la demande dont `stepKey` = la case ; `CellRow.fichiers` lu par `getCareDossier`), « déposer / ajouter
  des fichiers » en sélection multiple (`deposerPiecePriseEnCharge`, `file` répété, lot contrôlé avant écriture), retrait par
  fichier (`retirerFichierPiecePriseEnCharge`) ; le dernier retiré, la pièce redevient attendue. Règles pures : `lib/care-pieces.ts` ;
  écritures : `lib/care-pieces-db.ts`.
- **Pièces jointes dans tous les fils Ad & Pro** — un seul composant (`CommentThread`, option `piecesJointes`, monté par
  `AdProDiscussionCard` sur les sept natures) et un seul écrivain (`addAdProComment`, champ `files`, `validateAttachments` avant
  d'écrire, `attachFiles`). Une pièce = un `Document` de la MÊME entité, `stepKey` = `fil-message:<id>` (`lib/fil-pieces.ts`) :
  elle s'ouvre sous la porte du fil (`canAccessEntity` sur la demande) et figure aussi parmi les documents du dossier.
  Supprimer un message emporte ses pièces (`deleteComment` → `lib/fil-pieces-db.ts`). Aucune migration.
- **Fiches saisies avec le poste** : « Ajouter un poste » de nature billetterie ou hôtellerie affiche les fiches (mêmes champs
  que « Ajouter un voyageur » / « une fiche hôtellerie » : `ChampsVoyageur`, `ChampsHebergement`, préfixe `ficheN_` —
  `lib/ad-pro/fiches-saisie.ts`) avec « + Ajouter une fiche ». `addAdProItem` lit toutes les fiches et contrôle leurs pièces AVANT
  d'écrire (`lireFichesDuFormulaire`), crée le poste et ses fiches en une transaction, puis les pièces ; un échec défait tout
  (`creerPosteEtFiches`, `lib/ad-pro/fiches-poste.ts`). Banc : `ad-pro/pieces-multiples-flow.test.ts`.

---

### Assistant IA (`/assistant`) — l'agent qui agit, la mémoire, les documents, les routines (2026-10-27)

- **Ouvert par personne** (module `ASSISTANT_IA`), Super Admin par défaut ; l'assistant s'adapte à la personne et
  n'a que ce qu'elle voit. Limites prouvées par un test chacune, sur une assistante de direction (`limites.test.ts`).
- **Agir** : registre `src/lib/agent/operations/` — chaque geste = carte confirmée puis action de l'écran (jamais
  d'écriture directe). Ad & Pro (sponsoring, prise en charge, événement créé et soumis, matériel promo, « autre »,
  poste de coût), BC (+ depuis un devis), relance, dépôt, rendez-vous, réponse, document, traduction, formulaire PDF,
  voyageur depuis un passeport, routines.
- **Mémoire personnelle** : `AssistantMemoryItem`, panneau « Ma mémoire ».
- **Documents** : `documents-lus.ts` (portes : identité et paie refusées, RIB/IBAN/NIN masqués), `mrz.ts`, `traduction.ts`,
  `formulaire-pdf.ts`, `devis-lu.ts` + `bc-depuis-devis.ts`, `document-modele.ts`.
- **Routines** : tables `AssistantRoutine` / `AssistantRoutineRun` (migration `20270128100000_assistant_routines`),
  `src/lib/agent/routines/` (calendrier, passage, service), balayage dans `runScheduledJobs`, onglet « Routines ».
- **Recherche web** (`web_research` de l'ERP) ouverte à l'assistant, question censurée.
- Décision : `docs/assistant/decisions/0008-agent-qui-agit-memoire-documents-routines.md`.

---

### Ad & Pro — le circuit du 27/10/2026 : prévalidation, postes, le DG sur le TOTAL

Décision de la Direction validée sur l'artefact « Circuits Ad & Pro » v3 — détail et table des 29 décisions :
`docs/architecture/adpro-circuit-2026-10-27.md` ; vue d'ensemble : [workflows critiques](11-workflows-critiques.md).

- **Prévalidation** (sponsoring, prises en charge, événements, « autre ») : délégué → National Sales → Directeur des
  opérations (`OPERATIONS_DIRECTOR`) → Direction Marketing ; tout autre demandeur → Directeur des opérations → Direction
  Marketing ; rang 3 → Direction Marketing ; Direction Marketing → prévalidée d'office. L'étape marketing ne fixe ni montant
  ni catégorie. Le DG n'est plus une étape. À la création, tous les acteurs sont prévenus (`ouvrirLeCircuit`).
- **Postes** : aucun avant la prévalidation ; un seul accord, la Direction Marketing (une autre personne sur sa demande).
- **Porte du DG sur le total** (`AdProPorteDg`, `lib/ad-pro/porte-dg.ts`) : somme des postes non refusés + devis de
  personnes retenus/acceptés d'une prise en charge ; au-dessus du seuil, ni BC, ni visa, ni paiement, ni acceptation de
  devis sans « Valider le total » (DG, rôle principal ou secondaire, ou Super Admin) ; une rallonge rouvre la porte.
- **Appel** pour toute nature refusée (`faireAppelAdPro`) ; **transfert** recalculé sur le créateur.
- **Lots fusionnés** : devis/BC/ordre de PEC gardés (personnes « Accordées », catégorie sur l'ordre, DZD reste DZD,
  USD × 240) ; « Marquer réalisée » et réservation par fiche seule ; événements externes (plus de capacité, liste d'attente,
  inscription publique ; type + organisateur) ; catégorie budgétaire vérifiée (nature, exercice, BU) ; libellé « Paiement
  demandé (ordre émis) » ; matériel promotionnel imputé au budget ; DG au centre de paiement ; rôle secondaire au centre Ad & Pro.
- **Migrations** (additives) : `20270131110000_materiel_promo_budget`, `20270131120000_reservation_par_fiche_seule`,
  `20270131130000_evenement_organisateur`, `20270131130500_adpro_circuit_prevalidation`, `20270131140000_adpro_porte_dg_total`,
  `20270131150000_adpro_autre_postes`.
- ⚠️ **À faire par l'administration** : attribuer le rôle `OPERATIONS_DIRECTOR` au Directeur des opérations, puis retirer
  `DIRECTION` de l'étape « Validation (Directeur des opérations) » dans Administration › Circuits.

### Refonte des données, vague 2 — lot V2-D « Lieux et coordonnées » (2026-10-27)

« Par wilaya » se compte sans nettoyage manuel. Les fiches qui portent un lieu saisi à la main (praticiens,
établissements, partenaires, fournisseurs, secteurs de vente) gagnent une colonne **`wilayaCode`** (FK → `Wilaya`, 69
wilayas déjà chargées par la vague 1), **à côté** du texte, qui reste la saisie. Règle unique (`lib/lieux/rattachement.ts`) :
la colonne wilaya prime, la ville puis la région parlent si elle est vide ; ambigu → nul et listé ; fournisseur étranger →
pas de wilaya. **Administration › Refonte des données** (`/admin/refonte-donnees`, Super Admin) : une carte par reprise
(aperçu à blanc, lots de 500, journal `AuditLog`, reprise au dernier curseur) — `lieux-wilaya`, `adresses`,
`points-de-contact` (R3 depuis les fiches des Personnes / Organisations **déjà** créées, identifiants déterministes :
rejouables après les lots V2-B / V2-C). **Double écriture** à chaque saisie (interrupteur `AppSetting.lieuxDoubleEcriture`,
allumé), gardée par `lib/lieux/double-ecriture-garde.test.ts`. Premier écran lecteur : bandeau « Par wilaya » de
**Annuaires › Établissements**. Communes : table laissée vide (aucune source officielle complète). Migration additive
`20270131170000_lieux_wilaya_code`. Détail, activation et décisions : `docs/architecture/refonte-v2-lieux.md`.

---

### Refonte des données, vague 2 — lot V2-B « Personnes » (27/10/2026)

Cadre : `docs/architecture/refonte-vague-2.md`. Rien ne tourne au déploiement ; tout est additif et réversible.

- **Reprise R1** (`src/lib/referentiels/personnes/`) : une reprise par table (`User`, `Employee`, `MedicalDoctor`,
  `CareBeneficiary`, `AdProVoyageur`, `AdProHebergement`, `RecruitmentCandidate`, `DirectoryEntry`, `SupplierUser`). Seuls
  les liens que l'ERP porte déjà rapprochent d'office (compte ↔ salarié ↔ candidat embauché, praticien ↔ bénéficiaire tiré
  de l'annuaire) ; identifiant de Personne déterministe ; rejouable. Aucune donnée sensible recopiée.
- **Doublons PROPOSÉS** (reprise `personnes-doublons`, table `DoublonPersonne`), tranchés par le Super Admin dans
  **Personnes › Doublons** (`/personnes/doublons`) : fusionner (tracé `fusionneeDansId`, réversible), écarter, défaire.
- **Double écriture** derrière l'interrupteur `AppSetting.refontePersonnesDoubleEcriture` (éteint) : 12 écrivains de
  création relient la Personne dans leur transaction.
- **Fiche Personne 360°** `/personnes/[id]` (lien depuis `/praticiens/[id]` et `/rh/[id]`) : chaque ligne derrière la porte
  de son écran d'origine ; 404 pour qui ne voit la personne nulle part.
- **Écran commun** `Administration › Refonte des données` (`/admin/refonte-donnees`) : une carte par reprise (aperçu à
  blanc, un lot, tout exécuter, journal), interrupteur de la double écriture.
- Migration : `20270131170000_personnes_reprise`.
