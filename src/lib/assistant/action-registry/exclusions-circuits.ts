import { X } from "./classement";

/**
 * EXCLUDED (1/2) — les gestes de circuit et de fiche décidés par la Direction comme gestes
 * d'ÉCRAN : Ad & Pro, prises en charge, budgets, matériel promotionnel, stocks, centres.
 */
export function classerExclusionsCircuits(): void {
  // ── EXCLUDED : pas un travail d'assistant — raison donnée, pas un oubli. ──
  X("LES BORNES DE L'ASSISTANT IA (lot V3-D, audit 27/10 rapport 06) : plafonds de jetons par personne, par jour et par "
    + "tour, étapes d'un tour, et les décisions de Direction (filtre de la saisie, retrait des cartes caduques, expiration). "
    + "Une IA ne règle JAMAIS ses propres plafonds ni ses propres garde-fous : c'est le geste du Super Admin, sur l'écran "
    + "`/admin/ai/consommation`, en regardant la consommation réelle.", [
    "assistant-ia-consommation-actions:enregistrerReglagesAssistantIa",
  ]);
  X("SEGMENTATION STUDIO (Direction, 06/10) : stratégie, classement des produits, règles VERSIONNÉES publiées après l'aperçu "
    + "de leur impact, import d'un classeur relu ligne à ligne, potentiel terrain, statut, dérogations MOTIVÉES. Chaque geste "
    + "demande de VOIR ce qu'il change (impact, aperçu d'import, valeur calculée à côté de la dérogation) : c'est l'écran "
    + "`/segmentation` qui le montre. Adam est en pause de développement (Super Admin seul) ; ses outils viendront avec la "
    + "phase « interrogation assistée » du cahier des charges.", [
    "segmentation-actions:creerStrategie", "segmentation-actions:classerProduits", "segmentation-actions:apercuRegles",
    "segmentation-actions:publierRegles", "segmentation-actions:apercuImportSegmentation", "segmentation-actions:importerSegmentation",
    "segmentation-actions:enregistrerPotentiel", "segmentation-actions:changerStatut", "segmentation-actions:ajouterAuPanel",
    "segmentation-actions:retirerDuPanel", "segmentation-actions:poserDerogation", "segmentation-actions:leverDerogation",
    "segmentation-actions:ciblerSpecialitesProduit", "segmentation-actions:ouvrirCycleSegmentation",
    "segmentation-actions:cloreCycleSegmentation",
    // La lettre forcée (droit accordé par le Super Admin), le secteur d'une fiche, la recherche pour ajouter au panel.
    "segmentation-actions:forcerLettre", "segmentation-actions:rendreLettreCalculee", "segmentation-actions:changerSecteur",
    "segmentation-actions:chercherPraticiensHorsPanel",
    // Le classeur de la Direction importé « en une fois » : un fichier, une BU, un aperçu lu à l'écran avant d'importer.
    "segmentation-actions:apercuImportClasseurDirection", "segmentation-actions:importerClasseurDirection",
  ]);
  X("REFONTE DES DONNÉES — LES REPRISES ET LE RÉFÉRENTIEL DES ORGANISATIONS (vague 2, lot V2-C) : aperçu à blanc et "
    + "exécution par lots d'une reprise, fusion ou écart d'une proposition de doublon d'organisations, fusion défaite, "
    + "interrupteur de la double écriture. Gestes d'administration du Super Admin SEUL, décidés en REGARDANT l'aperçu "
    + "chiffré et les deux fiches côte à côte (`/admin/refonte-donnees`) ; jamais d'office, jamais par un assistant.", [
    "refonte-reprise-actions:apercuReprise", "refonte-reprise-actions:executerReprise",
    "organisation-actions:fusionnerOrganisations", "organisation-actions:ecarterDoublonOrganisation",
    "organisation-actions:defaireFusionOrganisation", "organisation-actions:reglerDoubleEcritureOrganisations",
  ]);
  X("CONGRÈS / ÉVÉNEMENT — ANCIENNES DÉCISIONS HORS CIRCUIT (Direction, 27/10) : préliminaire, analyse Direction Marketing, "
    + "validation définitive et budget accordé global écrivaient `requestStatus` et le montant SANS le moteur de circuit. "
    + "Aucun écran ne les propose plus ; Adam passe par les mêmes gestes que l'écran (`advance_workflow`, puis les postes). "
    + "Elles ne sont pas un geste d'assistant.", [
    "congress-request-actions:preliminaryDecision", "congress-request-actions:submitProductAnalysis",
    "congress-request-actions:finalDecision", "congress-request-actions:updateGrantedBudget",
  ]);
  X("L'ANCIENNE RÉSERVATION EN BLOC, FERMÉE (Direction, 27/10) : demander / retirer la réservation de tous les voyageurs "
    + "d'un poste, ou de toutes les fiches d'une prise en charge, en un sujet. La Direction garde la RÉSERVATION PAR FICHE "
    + "(`reservation-fiche-actions`) : ces gestes refusent et n'écrivent plus rien, leurs envois passés ont été repris en "
    + "fiches. Aucun geste à offrir.", [
    "ad-pro-item-actions:demanderReservation", "ad-pro-item-actions:retirerReservation",
    "care-actions:demanderReservationPriseEnCharge",
  ]);
  X("PIÈCES DEMANDÉES › CONFIER LE BC D'UN POSTE À UNE AUTRE ASSISTANTE (audit Assistante de direction, 10/2026) : le geste se "
    + "décide en REGARDANT le fil de la pièce (`/pieces/[id]`) — qui la tient, depuis quand, si elle est déposée — et ne vise "
    + "qu'une assistante de direction ACTIVE, proposée par l'écran. Adam est en pause de développement (Super Admin seul).", [
    "document-request-actions:reaffecterDemandeBC",
  ]);
  X("FORCE DE VENTE › TERRITOIRES (Direction, 07/10) : rattacher en un clic une cible H ou A hors panel au délégué de son "
    + "secteur. Le geste se décide en REGARDANT la liste du secteur (lettre, statut, établissement) que l'écran "
    + "`/planning/territoires` montre ; il ne réaffecte jamais un praticien déjà suivi.", [
    "force-de-vente-actions:affecterAuDelegue",
  ]);
  X("INTELLIGENCE TERRAIN (console d'administration, Direction 10/2026 : « visible uniquement par le Super Administrateur ») : "
    + "relancer l'analyse d'influence (Luna lit les nouveaux rapports) et confirmer / rejeter un lien proposé, preuve citée sous "
    + "les yeux. Réservé au SUPER ADMIN, non délégable — chaque action relit le rôle ; aucune ouverture conversationnelle.", [
    "intelligence-terrain-actions:relancerAnalyseInfluence", "intelligence-terrain-actions:deciderLienInfluence",
  ]);
  X("REFONTE DES DONNÉES (Administration, Super Admin) : lancer une reprise vers les référentiels (aperçu à blanc, puis "
    + "un lot au curseur) et allumer / éteindre la double écriture des lieux et la double écriture / double lecture du coffre (un modèle d'IA n'a JAMAIS accès au coffre). Une reprise écrit dans les référentiels de toute "
    + "l'entreprise : elle se décide devant l'aperçu chiffré et la liste des cas ambigus que l'écran `/admin/refonte-donnees` "
    + "montre, lot par lot, et chaque geste relit le rôle. Réservé au SUPER ADMIN, non délégable ; aucune ouverture conversationnelle.", [
    "refonte-reprise-actions:apercuReprise", "refonte-reprise-actions:executerReprise", "lieux-actions:reglerDoubleEcritureLieux", "coffre-actions:basculerCoffre",
  ]);
  X("BIBLIOTHÈQUE (J1, Super Admin) : lancer un passage de rattrapage et de lecture des pièces, ou remettre une pièce en "
    + "file. Des gestes d'EXPLOITATION de l'index (ils ne modifient aucune pièce) décidés devant l'état de la file que l'écran "
    + "`/bibliotheque` montre ; chaque geste relit le rôle. Réservé au SUPER ADMIN ; aucune ouverture conversationnelle.", [
    "bibliotheque-actions:lancerPassageBibliotheque", "bibliotheque-actions:relancerFicheBibliotheque",
  ]);
  X("TESTER L'ÉDITEUR OFFICE (Administration, Super Admin) : diagnostic de configuration — variables, adresses, réponse du "
    + "Document Server. Une moitié du test se joue DANS LE NAVIGATEUR de l'administrateur (chargement d'api.js) : une "
    + "conversation ne peut pas la faire. C'est un écran de dépannage, pas un geste métier.", [
    "onlyoffice-diagnostic-actions:testerEditeurOffice",
  ]);
  X("FINANCES › RÉPONDRE À UNE DEMANDE D'ACTUALISATION DES SOLDES (Direction, 10/2026) : le responsable Finance saisit, "
    + "compte par compte, le solde du relevé bancaire qu'il a SOUS LES YEUX et sa date — ou « pas encore reçu ». C'est une "
    + "attestation de ce que dit la banque, qui réancre le compte : elle se donne devant l'écran de la demande "
    + "(`/finances/actualisation-soldes/[id]`), ouvert par sa notification. Adam est en pause de développement (Super Admin seul).", [
    "actualisation-soldes-actions:repondreActualisationSoldes",
  ]);
  X("INFORMATION MÉDICALE › RELANCER UNE PIÈCE (Direction, 07/10) : une notification à la personne sollicitée, limitée à une "
    + "toutes les quatre heures. Le geste se décide en REGARDANT la fiche du dossier (depuis quand la pièce est attendue, "
    + "dernière relance) ; Adam est en pause de développement (Super Admin seul).", [
    "medical-info-actions:relancerPieceInfoMed",
  ]);
  X("CONSUMPTION INTELLIGENCE : importer un fichier de consommation, trancher ce qui n'est pas sûr (une correspondance "
    + "confirmée s'apprend), écarter une ligne, VALIDER pour que les lignes comptent, annuler, régler l'affinité d'un "
    + "produit. Chaque geste se décide en REGARDANT la revue (colonnes lues, confiance, impact sur la segmentation) : "
    + "c'est l'écran `/consommation`. Adam est en pause de développement (Super Admin seul).", [
    "consommation-actions:importerFichierConsommation", "consommation-actions:confirmerCorrespondanceConso",
    "consommation-actions:ignorerLigneConso", "consommation-actions:validerImportConso", "consommation-actions:annulerImportConso",
    "consommation-actions:enregistrerAffiniteConfig",
  ]);
  X("VENTES PCH (Direction, 08/10) : importer les fichiers de la PCH (ventes des DR, réceptions de la PCH centrale) se "
    + "décide en REGARDANT l'aperçu (nature, période, établissements et produits reconnus, mois remplacés) ; rattacher un "
    + "client, un poste PCH, un fournisseur « à nous » ou nommer une DR se fait en lisant les listes « à rattacher » de "
    + "l'écran `/sales/importer`. Adam est en pause de développement (Super Admin seul).", [
    "ventes-pch-actions:apercuFichiersVentesPch", "ventes-pch-actions:appliquerFichiersVentesPch",
    "ventes-pch-actions:rattacherEtablissementVentesPch", "ventes-pch-actions:rattacherPosteVentesPch",
    "ventes-pch-actions:reglerFournisseurVentesPch", "ventes-pch-actions:enregistrerDrVentesPch",
  ]);
  X("RATTACHEMENT AUTOMATIQUE DES PRATICIENS À LEUR ÉTABLISSEMENT (Direction, 06/10) : un geste en lot de la feuille de "
    + "l'annuaire, sur les fiches de la vue, après confirmation — la même règle s'applique d'elle-même à chaque écriture "
    + "(cellule, ajout, import). Adam est en pause de développement (Super Admin seul).", [
    "medical-directory-actions:rattacherAutomatiquement",
  ]);
  X("ANNUAIRES (Direction, 06/10) : l'annuaire des FOURNISSEURS REGULATORY (ajouter, corriger, retirer — désactivé "
    + "quand il porte des dossiers) et la MODIFICATION d'une coordonnée d'une personne. Des gestes d'écran, faits en "
    + "regardant la fiche. Adam est en pause de développement (Super Admin seul).", [
    "fournisseurs-annuaire-actions:creerFournisseurAnnuaire", "fournisseurs-annuaire-actions:modifierFournisseurAnnuaire",
    "fournisseurs-annuaire-actions:retirerFournisseurAnnuaire", "directory-actions:updateDirectoryEndpoint",
  ]);
  X("METTRE AU PIPELINE TOUS LES DOSSIERS NON ENTAMÉS (Direction, 06/10) : un geste du Super Admin, sur l'écran du "
    + "suivi, qui compte puis confirme avant de verrouiller un portefeuille entier. Pas un travail d'assistant.", [
    "regulatory-actions:mettreAuPipelineNonEntames", "regulatory-actions:compterDossiersNonEntames",
  ]);
  X("RÉPARTITION DES COÛTS PARTAGÉS D'UNE BU (cahier des charges §15, §85) : un geste des Finances qui décide quelle part "
    + "des dépenses de la BU revient à chaque produit pour l'année. Il se décide en regardant la vue 360° du produit "
    + "(direct, alloué, non alloué). Adam est en pause de développement (Super Admin seul).", [
    "repartition-couts-actions:enregistrerRepartitionBu",
  ]);
  X("LES PRIX D'UN PRODUIT, À LA MAIN (Produits 360, Direction 07/10) : une saisie l'emporte sur le prix observé dans "
    + "l'Explorateur produits, à partir de sa date d'effet, et l'historique garde chaque ligne. Le geste se décide devant la "
    + "fiche du produit, à côté de la valeur de l'Explorateur. Adam est en pause de développement (Super Admin seul).", [
    "prix-produit-actions:enregistrerPrixProduit",
    "prix-produit-actions:revenirAuPrixExplorateur",
  ]);
  X("BUDGETS DES PÔLES — Budget Marketing, Budget Regulatory, Budget Operations & Sales (Direction, 08/10) : créer, régler "
    + "et retirer une enveloppe de son pôle ; compléter ses catégories d'office (BV 25 % / 75 %, masse salariale par BU) ; "
    + "saisir un BV payé hors circuit ; ranger un BV demandé ou payé dans l'enveloppe. Des gestes d'écran neufs, sur les "
    + "Réglages, l'onglet « BV par dossier » et l'onglet « Masse salariale » de chaque module, décidés devant les chiffres "
    + "de l'enveloppe ; le contenu ordinaire (catégories, lignes, imputation) passe par les actions de Budgets, déjà "
    + "classées. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "budget-pole-actions:createPoleEnvelope",
    "budget-pole-actions:updatePoleEnvelope",
    "budget-pole-actions:deletePoleEnvelope",
    "budget-pole-actions:completerCategoriesPole",
    "budget-pole-actions:saisirBvManuel",
    "budget-pole-actions:imputerBv",
    // RÉALLOUER entre deux catégories (Budget Marketing, 10/2026) : un montant déplacé, motif obligatoire gardé dans
    // l'historique — décidé devant le tableau « Par catégorie » de la vue d'ensemble, pas par un appel d'Adam.
    "budget-pole-actions:reallouerCategorie",
  ]);
  X("RESOUMETTRE ET RETIRER UNE DEMANDE AD & PRO (§118.186, audit R02/R24) : deux gestes du DEMANDEUR sur SA "
    + "demande, ajoutés avec le renvoi pour correction. Resoumettre suppose qu'une personne a corrigé ce que le "
    + "validateur demandait — la fiche est l'endroit où elle le fait ; retirer clôt un circuit, motif à l'appui. "
    + "Adam est en pause de développement (Super Admin seul) : un clic sur la fiche de la demande, panneau du circuit.", [
    "workflow-actions:resoumettreDemande", "workflow-actions:retirerDemandeAdPro",
  ]);
  X("CIRCUIT AD & PRO DU 27/10/2026 — la VALIDATION DU TOTAL par le Directeur Général (au-dessus du seuil, sur la "
    + "somme des postes de toute la demande) et l'APPEL d'une prise en charge ou d'un événement refusé. L'un ouvre la "
    + "porte de l'argent engagé (bons de commande, paiements), l'autre relance un circuit clos, motif à l'appui : deux "
    + "décisions qu'une personne prend devant la fiche. Adam est en pause de développement : aucun geste neuf ne lui est "
    + "ouvert. Un clic sur la fiche de la demande (carte « Validation du Directeur Général », panneau du circuit).", [
    "porte-dg-actions:statuerTotalDg", "workflow-actions:faireAppelAdPro",
  ]);
  X("RÉVISER UN POSTE AD & PRO APRÈS COUP (§118.187, audit R05/R06/R12) — RETIRER ou MODIFIER la demande de bon de "
    + "commande tant qu'aucun ordre n'est parti, ANNULER un ordre émis non réglé pour le réémettre, DEMANDER une révision "
    + "d'un poste accordé. Chacun touche à de l'argent engagé (le visa du centre, l'ordre transmis aux Finances) et exige un "
    + "motif qu'une personne écrit devant la carte du poste ; « Revoir la décision » passe, lui, par `decideAdProItem`, déjà "
    + "couvert. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la fiche de la demande, "
    + "menu « ⋯ » de la carte du poste.", [
    "ad-pro-item-actions:retirerDemandeBC", "ad-pro-item-actions:modifierDemandeBC",
    "ad-pro-item-actions:annulerOrdrePoste", "ad-pro-item-actions:demanderRevisionPoste",
  ]);
  X("ANNULER SA DEMANDE TANT QU'ELLE N'EST PAS EXÉCUTÉE (audit du 04/10, constats 35 et 37) — retirer la demande de "
    + "devis d'un dossier de matériel promotionnel (le dossier recule à l'étape d'avant), retirer la demande de réservation "
    + "des billets d'un poste (son sujet se clôt). Deux gestes du DEMANDEUR, motif à l'appui, qu'une assistante lira. Adam est "
    + "en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la fiche du dossier, ou sur la carte du poste.", [
    "promo-devis-actions:retirerDemandeDevisPromo",
  ]);
  X("LES PIÈCES D'ACHAT D'UN POSTE (§118.204) — déposer un devis ou une facture pro forma (commun à plusieurs postes), "
    + "le retirer d'un poste où il a été mal placé, et déposer la FACTURE qui demande le paiement. Chacun dépose un "
    + "FICHIER que la personne a sous la main (une carte de confirmation ne transporte pas un fichier), et le dernier "
    + "ouvre un ordre de dépense au centre de paiement. Adam est en pause de développement : aucun geste neuf ne lui est "
    + "ouvert. Un clic sur la carte du poste, fiche de la demande.", [
    "ad-pro-item-actions:ajouterDevisPoste", "ad-pro-item-actions:retirerDevisDuPoste", "ad-pro-item-actions:demanderPaiementPoste",
    // Les voyageurs d'une billetterie (§118.205) : le devis d'un voyageur est un FICHIER, le choix d'une
    // proposition et la demande de BC qui en découle se font devant la carte du poste.
    "ad-pro-item-actions:ajouterDevisVoyageur", "ad-pro-item-actions:validerDevisVoyageur", "ad-pro-item-actions:demanderBCBilletterie",
  ]);
  X("LES LIGNES DES DEVIS D'UN POSTE ET LES BC QU'ELLES FONT GÉNÉRER (§118.206) — lire un devis, saisir ou corriger ses "
    + "lignes, VALIDER celles qu'on commande, GÉNÉRER (ou régénérer) le bon de commande de chaque devis. Une ligne "
    + "validée est un PRIX que la société commande, et la validation atteste qu'une personne l'a comparée au papier "
    + "(§118.15, §118.152 i) : un document lu par Adam est une DONNÉE, jamais la main qui écrit ce qui sera commandé "
    + "(§118.7). Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la carte du poste, "
    + "case « Bon de commande » et panneau « Lignes » du devis.", [
    "ad-pro-item-actions:validerLignesDuDevis", "ad-pro-item-actions:enregistrerLignesDuDevis",
    "ad-pro-item-actions:lireLesLignesDuDevis", "ad-pro-item-actions:genererBonDeCommandePoste",
    // L'APERÇU DU BC À VALIDER PAR LE DEMANDEUR (Direction, 10/2026) : « Générer le BC » dépose un brouillon (aucun numéro) ; le demandeur le
    // relit (`apercuBcPoste`), le corrige (`modifierApercuBcPoste`), le retire (`annulerApercuBcPoste`) ou le valide — et seule la validation
    // attribue le numéro NNN/DG/AAAA et envoie aux Finances (`validerEtEnvoyerBcPoste`). Des gestes d'écran, jamais des appels d'Adam.
    "ad-pro-item-actions:apercuBcPoste", "ad-pro-item-actions:modifierApercuBcPoste", "ad-pro-item-actions:annulerApercuBcPoste",
    "ad-pro-item-actions:validerEtEnvoyerBcPoste",
    // L'APERÇU OBLIGATOIRE ET ULTRA COMPLET (Direction, 14/10/2026) : l'aperçu se corrige dans le composeur de pièces, qui en lit les
    // totaux (`previsualiserApercuBcPoste`) et le PDF (`imprimerApercuBcPoste`) à blanc — des lectures d'écran, pas des gestes d'Adam.
    // Le geste « en un clic » qui émettait sans aperçu est retiré : un seul chemin, Générer → aperçu → Valider et envoyer.
    "ad-pro-item-actions:previsualiserApercuBcPoste", "ad-pro-item-actions:imprimerApercuBcPoste",
    // LE BC MODIFIÉ EN NATIF ET LA FACTURE CONTRÔLÉE PAR LUNA (Direction, 06/10) : une révision du Word et du PDF, et un
    // fichier de facture lu puis comparé au(x) BC signé(s) — des gestes devant la carte du poste, pas des appels d'Adam.
    "ad-pro-item-actions:modifierBcDuPoste", "ad-pro-item-actions:deposerFacturePoste",
    // L'APERÇU DU BC MODIFIÉ DE A À Z (Direction, 10/2026) : le composeur montre les totaux de la version à venir, à blanc,
    // sous la porte du poste — une lecture d'écran qui n'écrit rien, pas un geste d'Adam.
    "ad-pro-item-actions:previsualiserBcDuPoste",
    // LA LETTRE DE DEMANDE DE DEVIS (Direction, 07/10) : rédigée par Luna, posée sur le poste — un bouton de l'étape.
    "ad-pro-item-actions:genererDemandeDevisPoste", "promo-devis-actions:regenererDemandeDevisPromo",
    // LE CHAMP « RÉFÉRENCE » DES FORMULAIRES DE GÉNÉRATION (registre commun NNN/DG/AAAA, Direction 10/2026) : lire le prochain numéro
    // de la société (prévu, jamais réservé) et vérifier en direct un numéro saisi — des lectures d'écran, pas des gestes d'Adam.
    "ad-pro-item-actions:referenceDemandeDevisPoste", "promo-devis-actions:referenceDemandeDevisPromo",
    "hr-document-actions:referenceOrdreDeMission", "registre-references-actions:verifierReferenceRegistre",
    // LE « N° DE RÉFÉRENCE » D'UN BC MODIFIABLE (Direction, 14/10/2026) : la vérification en direct du champ du composeur
    // (révision, BC à régénérer, composition hors registre) — une lecture d'écran qui ne réserve rien.
    "fabrique-actions:verifierNumeroPiece",
  ]);
  X("DEMANDER À SON N+1 UN AVIS SUR UN CONGÉ (Direction, 06/10) : le responsable remonte la marche du N+1 à son propre N+1, "
    + "qui la redescend validée ou refusée. Un geste de la ligne « Mon équipe », devant la demande — pas un appel d'Adam.", [
    "hr-actions:demanderAvisN1Conge",
    // LA DISCUSSION D'UN CONGÉ (Direction, 07/10) : le salarié, son N+1 et les RH s'écrivent sous la ligne du congé.
    "conge-discussion-actions:commenterConge",
    // L'ORDRE DE MISSION GÉNÉRÉ par les RH sur le document de la Direction : un formulaire devant la demande du salarié.
    "hr-document-actions:genererOrdreDeMission",
    // LA DISCUSSION ET LES PARTICIPANTS D'UNE DEMANDE DE VALIDATION : des gestes de la fiche de la demande.
    "validation-actions:commenterValidation", "validation-actions:ajouterParticipantsValidation", "validation-actions:retirerParticipantValidation",
    // DÉPLACER UNE DÉPENSE « À IMPUTER » VERS SA SOCIÉTÉ : un geste de l'écran Budgets › Dépenses.
    "budget-envelope-actions:changerSocieteEcriture",
    // PRÉPARER LE DOSSIER D'UN ENVOI DE LA MESSAGERIE : le composeur dépose ensuite les fichiers par la file du Drive.
    "messaging-actions:preparerDepotMessagerie",
    // LES FICHES HÔTELLERIE D'UN POSTE (une par personne) : des gestes de la carte du poste, comme les voyageurs.
    "ad-pro-item-actions:ajouterHebergement", "ad-pro-item-actions:modifierHebergement", "ad-pro-item-actions:retirerHebergement",
    // RANGER LES DOSSIERS REGULATORY DANS LE DRIVE : le rattrapage du Super Admin, un bouton de la page Regulatory.
    "regulatory-drive-actions:synchroniserDriveRegulatory",
    // LA PHARMACOVIGILANCE : le signalement du KAM, l'échange, le statut, l'enquête, les participants — des gestes de la
    // fiche du cas, devant le cas, pas des appels d'Adam (un signalement de sécurité ne se fait pas par délégation).
    "pharmacovigilance-actions:signalerCasPv", "pharmacovigilance-actions:commenterCasPv", "pharmacovigilance-actions:changerStatutCasPv",
    "pharmacovigilance-actions:ouvrirEnquetePv", "pharmacovigilance-actions:ajouterParticipantsPv", "pharmacovigilance-actions:retirerParticipantPv",
    // LES DEMANDES DE STOCKS DO → KAM : créer, saisir par hôpital, relancer, clore, supprimer — des gestes des écrans Stocks.
    "demande-stocks-actions:creerDemandeStocks", "demande-stocks-actions:saisirStocksDemande", "demande-stocks-actions:relancerDemandeStocks",
    "demande-stocks-actions:cloreDemandeStocks", "demande-stocks-actions:supprimerDemandeStocks",
  ]);
  X("OPERATIONS & SALES (Direction, 08/10) — le STOCK PCH CENTRAL saisi depuis le mail de la PCH (quantités par produit, "
    + "collage confirmé à l'écran, mail joint). Un geste d'écran, devant le relevé : Adam est en pause de développement, "
    + "aucun geste neuf ne lui est ouvert.", [
    "stock-pch-actions:enregistrerStockPch",
    // LE RELEVÉ EN FICHIER (Excel / CSV de la PCH) : une LECTURE du fichier déposé à l'écran (rien n'est écrit) — la vérification
    // et l'enregistrement sont le geste d'écran ci-dessus.
    "stock-pch-actions:lireReleveStockPch",
  ]);
  X("COMPLÉMENTS (Direction, 10/2026) — le produit d'une déclaration d'information médicale (corrigé par le pharmacien dans la "
    + "déclaration) et la date de besoin d'une demande de matériel promotionnel (modifiée par le demandeur sur sa demande). "
    + "Des champs d'une fiche, corrigés devant elle : Adam est en pause de développement, aucun geste neuf ne lui est ouvert.", [
    "medical-info-actions:changerProduitDeclaration", "promo-material-actions:modifierDateBesoinPromo",
  ]);
  X("PRISES EN CHARGE — PROFESSIONNELS PROPOSÉS ET LEURS PIÈCES (§118.205) : créer le profil d'un professionnel, "
    + "demander ses pièces (passeport, visa, informations de voyage) et les déposer. Chacun touche à une identité ou "
    + "dépose un FICHIER devant la fiche de la demande. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "care-actions:creerProfilProfessionnel", "care-actions:demanderPiecesPriseEnCharge", "care-actions:deposerPiecePriseEnCharge",
  ]);
  X("PRISES EN CHARGE — PLUSIEURS FICHIERS PAR PIÈCE (Direction, 10/2026) : retirer UN fichier d'une pièce (la page en trop, "
    + "le scan illisible) ; le dernier retiré, la pièce redevient attendue. Un geste fait DEVANT l'aperçu du fichier, sur une "
    + "pièce d'identité. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "care-actions:retirerFichierPiecePriseEnCharge",
  ]);
  X("PRISES EN CHARGE — FICHES VOYAGEUR (Direction, 10/2026) : enregistrer un poste de la fiche (billet, hôtel, autre poste, "
    + "montant en dollars à l'international), déposer le billet émis ou la confirmation d'hôtel, retenir un devis, demander "
    + "la réservation et le BC à l'assistante de direction, gérer les postes de groupe. Des gestes faits DEVANT la fiche "
    + "(fichiers, horaires, choix d'une proposition), ou qui ouvrent un sujet chez l'assistante. Adam est en pause de "
    + "développement : aucun geste neuf ne lui est ouvert.", [
    "care-actions:modifierPosteFiche", "care-actions:enregistrerBilletEmis", "care-actions:retenirDevisPriseEnCharge",
    "care-actions:demanderBCPriseEnCharge",
    "care-actions:ajouterPosteGroupe", "care-actions:modifierPosteGroupe", "care-actions:retirerPosteGroupe",
  ]);
  X("LES FICHES DE VOYAGE CHEZ L'ASSISTANTE DE DIRECTION (Direction, 14/10/2026) — côté demandeur : envoyer UNE fiche "
    + "(billet ou hôtel) ou « les fiches prêtes » (chacune séparément), relancer (une fois par 24 h), retirer ; côté "
    + "assistante, dans l'onglet « Ad & Pro » du Bureau du secrétariat : prendre la fiche, signaler un manque, joindre "
    + "le devis de l'agence (par le circuit devis existant du poste) et déposer le billet ou la confirmation d'hôtel "
    + "(des FICHIERS, après l'accord du poste). Des gestes faits DEVANT la fiche, qui engagent le travail d'une personne "
    + "ou portent une pièce. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "reservation-fiche-actions:envoyerFiche", "reservation-fiche-actions:envoyerFichesPretes",
    "reservation-fiche-actions:relancerFiche", "reservation-fiche-actions:retirerFiche",
    "reservation-fiche-actions:prendreFiche", "reservation-fiche-actions:signalerManque",
    "reservation-fiche-actions:joindreDevisAgence", "reservation-fiche-actions:deposerBillet",
  ]);
  X("ANNULER SA DEMANDE TANT QU'ELLE N'EST PAS EXÉCUTÉE (décision du 04/10) — rallonges de budget et de caisse, "
    + "document RH, ordre de mission, tâche demandée, formation. Des gestes qui RÉDUISENT, mais Adam est en pause de "
    + "développement : aucun geste neuf ne lui est ouvert. Un clic du demandeur sur sa demande.", [
    "department-budget-actions:annulerDemandeBudgetDepartement", "hr-document-actions:annulerDemandeRh",
    "mission-actions:retirerDemandeOrdreMission", "petty-cash-actions:annulerRallongeCaisse",
    "task-actions:annulerDemandeTache", "training-actions:annulerFormation",
  ]);
  X("RENVOYER, RÉEXAMINER, RESOUMETTRE DANS LES CENTRES (§118.188, audit R07/R08/R10) — resoumettre une demande de "
    + "validation renvoyée pour correction (sur elle-même, elle reprend à l'étape qui l'a renvoyée), resoumettre au centre "
    + "Ad & Pro une demande qu'il a renvoyée, et réexaminer un refus du centre. Les deux premiers sont des gestes du "
    + "DEMANDEUR qui dit ce qu'il a corrigé ; le troisième rouvre une décision d'arbitrage, motif à l'appui, par un siège "
    + "du centre. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la fiche de la "
    + "demande (validations, consulting, autre demande) ou sur le centre de validation Ad & Pro.", [
    "validation-actions:resoumettreValidation",
    "ad-pro-centre-actions:resoumettreAuCentreAdPro", "ad-pro-centre-actions:reexaminerVisaCentreAdPro",
  ]);
  X("BUDGET MARKETING — LA DÉPENSE D'UN POSTE AD & PRO (onglet « Dépenses », maquette validée 10/2026) : imputer un poste "
    + "aux BC signés (il devient engagé), changer son budget à tout moment (le poste, ses ordres et ses écritures suivent), "
    + "le consommer (montant ≤ l'engagé, facture facultative : un ordre de dépense naît au centre de paiement) ou l'annuler. "
    + "Chaque geste engage le budget et passe par une seconde confirmation à l'écran, qui dit ce qui va se passer. Adam est "
    + "en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "budget-depense-poste-actions:imputerDepensePoste",
    "budget-depense-poste-actions:changerBudgetDepensePoste",
    "budget-depense-poste-actions:consommerDepensePoste",
    "budget-depense-poste-actions:annulerDepensePoste",
  ]);
  X("BUDGET MARKETING — IMPUTER UN MATÉRIEL PROMOTIONNEL (Direction, 27/10 — point 21) : la Direction Marketing choisit la "
    + "catégorie du Budget Marketing qui porte le dossier ; ses BC signés y comptent en engagé, ses ordres fournisseur en "
    + "consommé, et les ordres déjà nés suivent. Le geste engage le budget et passe par une seconde confirmation à l'écran. "
    + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "promo-budget-actions:imputerBudgetMaterielPromo",
  ]);
  X("DEMANDER LA VALIDATION FINALE D'UN BON DE COMMANDE PRÉ-VALIDÉ (Demandes de validations, 10/2026) — le geste du "
    + "DEMANDEUR une fois que tous ses validateurs ont accepté : la retenue du BC tombe et l'aiguillage ordinaire l'adresse "
    + "à son centre de validation, puis à la signature. Adam est en pause de développement : aucun geste neuf ne lui est "
    + "ouvert. Un clic, confirmé, sur la carte de la demande.", [
    "validation-actions:demanderValidationFinaleBC",
  ]);
  X("REFUSER LA VALIDATION FINALE D'UNE DÉCLARATION D'INFORMATION MÉDICALE (Direction, 10/2026) — le geste du Directeur "
    + "des Opérations (à défaut, du Super Admin), motif EXIGÉ : le dossier revient au pharmacien avec le motif. Adam est en "
    + "pause de développement : aucun geste neuf ne lui est ouvert. Un formulaire sur la fiche de la déclaration.", [
    "medical-info-actions:refuseDeclarationByDirection",
  ]);
  X("BUDGET MARKETING — L'INTÉGRATION DES DÉPENSES RÉELLES AD & PRO 2026 (maquette validée, 10/2026) : lire le fichier "
    + "« Dépenses AP » et proposer les demandes existantes, calculer le budget avant → après, VALIDER (écriture d'un bloc de "
    + "30 demandes, double confirmation : case cochée et mot « INTÉGRER »), ANNULER d'un bloc (motif, mot « ANNULER »), "
    + "garder ou sortir du budget un élément « absent du fichier », joindre des pièces (plusieurs fichiers, lus par Luna) ou "
    + "rattacher une pièce déjà dans la plateforme, relier (en lecture seule) l'écriture de trésorerie qui a payé la dépense. Des gestes d'écran : ils portent un FICHIER que le navigateur envoie, "
    + "et les plus lourds réécrivent le budget d'une enveloppe devant l'aperçu qui en montre l'effet — gestionnaire de "
    + "l'enveloppe ou Super Admin. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "integration-adpro-actions:lireFichierIntegrationAdPro", "integration-adpro-actions:apercuIntegrationAdPro",
    "integration-adpro-actions:validerIntegrationAdPro", "integration-adpro-actions:annulerIntegrationAdPro",
    "integration-adpro-actions:deciderAbsenteIntegration", "integration-adpro-actions:joindrePiecesIntegration",
    "integration-adpro-actions:rattacherPieceIntegration", "integration-adpro-actions:relierEcritureIntegration",
    // LIRE la fiche « Historique 2026 » d'une demande pour le panneau latéral des onglets Demandes Ad & Pro et
    // Intégration 2026 (maquette « onglets », 10/2026) : une lecture d'écran, gardée par l'enveloppe du lot.
    "integration-adpro-actions:ficheHistoriqueIntegration",
  ]);
  X("BUDGET MARKETING — LE RAPPROCHEMENT AD & PRO ASSISTÉ PAR LUNA (Direction, 14/10/2026) : lire par tranches les pièces "
    + "de la plateforme (Luna, une fois par empreinte), accepter / refuser une proposition de rattachement d'une dépense hors "
    + "poste ou d'une pièce à une demande intégrée, choisir une autre demande, signaler « pas Ad & Pro », accepter toutes "
    + "les propositions certaines (confirmation exigée), annuler une décision. Des gestes d'écran qui changent ce que compte "
    + "le budget d'une enveloppe et les pièces d'une demande, devant les propositions et leurs justifications — gestionnaire "
    + "de l'enveloppe ou Super Admin. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "rapprochement-adpro-actions:lireTranchePiecesRapprochement", "rapprochement-adpro-actions:deciderRapprochement",
    "rapprochement-adpro-actions:accepterRapprochementsCertains", "rapprochement-adpro-actions:annulerDecisionRapprochement",
  ]);
  X("DEVIS NATIFS → BON DE COMMANDE AU BUREAU DU SECRÉTARIAT (Direction, 10/2026, « comme dans Ad & Pro ») — l'assistante "
    + "dépose et RETRANSCRIT le devis ligne à ligne devant le papier ; le DEMANDEUR coche les lignes qu'il retient, puis génère "
    + "(fabrique, sous délégation de la demande) ou dépose le BC, qui part au centre de validations puis à la signature. Des "
    + "gestes d'écran qui attestent un papier ou engagent la société ; Adam est en pause de développement : aucun geste neuf "
    + "ne lui est ouvert. « Relancer » est un clic sur la fiche, une fois par jour.", [
    "secretariat-devis-actions:deposerDevisDemande", "secretariat-devis-actions:enregistrerLignesDevisDemande",
    "secretariat-devis-actions:retenirLignesDevisDemande", "secretariat-devis-actions:genererBonDeCommandeDemande",
    "secretariat-devis-actions:deposerBonDeCommandeDemande", "secretariat-devis-actions:relancerDemande",
    // L'APERÇU OBLIGATOIRE DU BC (Direction, 14/10/2026) : le composeur s'ouvre pré-rempli (`ouvrirApercuBcDemande`), en lit les
    // totaux et le PDF à blanc — rien n'est écrit avant « Valider et envoyer » (`genererBonDeCommandeDemande`). Lectures d'écran.
    "secretariat-devis-actions:ouvrirApercuBcDemande", "secretariat-devis-actions:previsualiserApercuBcDemande",
    "secretariat-devis-actions:imprimerApercuBcDemande",
  ]);
  X("DIRECTION ARTISTIQUE (Transverse, 10/2026) — déposer un modèle Word/Excel/PowerPoint POUR UNE ENTITÉ, désigner son "
    + "papier en-tête par défaut et le modèle de chaque nature de pièce (bon de commande, devis, facture, avoir) que la "
    + "fabrique applique. Geste de l'assistante de direction (ou de qui tient le module), sur un FICHIER choisi à l'écran. "
    + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
    "direction-artistique-actions:televerserModele",
    "direction-artistique-actions:definirPapierParDefaut",
    "direction-artistique-actions:definirModeleDePiece",
    "direction-artistique-actions:televerserModeleDePiece",
  ]);
  X("GÉNÉRER L'ATTESTATION DE TRAVAIL D'UNE DEMANDE RH (Direction, 10/2026) — comme l'ordre de mission : le formulaire des "
    + "RH s'ouvre prérempli (fiche RH, puis le contrat de travail lu par Luna — ou, IA fermée, par la lecture déterministe), "
    + "les RH relisent chaque champ et choisissent le signataire en fin de formulaire ; la plateforme remplit le modèle sur "
    + "papier à en-tête, attribue la référence au registre NNN/DG/AAAA et remet le PDF au salarié (régénérer = une nouvelle "
    + "version). Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un formulaire devant la demande.", [
    "hr-document-actions:preparerAttestationDeTravail", "hr-document-actions:genererAttestationDeTravail",
  ]);
  X("RÉGLER LE SEUIL DES BONS DE COMMANDE HORS AD & PRO (Direction, 10/2026) — depuis le centre de validations, par ses "
    + "sièges (DG, Super Admin) ; le centre Ad & Pro garde le sien. Le changement réaiguille les BC en vol de ce centre. "
    + "Adam est en pause : aucun geste neuf. Un formulaire sur l'écran du centre. — SUSPENDRE LA SÉPARATION DES TÂCHES DU CENTRE DE PAIEMENT (ARGENT-06) : lever un garde-fou, interdit à un agent (§118.6), geste journalisé du Super Admin.", [
    "settings-actions:setBcValidationThresholdCentre", "settings-actions:setSeparationTachesPaiement",
  ]);
  X("RESOUMETTRE UNE « AUTRE DEMANDE » REFUSÉE ET PROLONGER UN CONTRAT DE CONSULTING (audit 360°, lot C4a) — la "
    + "resoumission est le geste du DEMANDEUR qui dit ce qui a changé depuis le refus (elle peut corriger la description "
    + "et le montant, que le centre Ad & Pro relit) ; la prolongation engage la société sur un terme plus long et "
    + "revient à qui peut valider le contrat, avec ce qui la fonde (l'avenant). Adam est en pause de développement : "
    + "aucun geste neuf ne lui est ouvert. Un clic sur la fiche de la demande ou du contrat.", [
    "ad-pro-other-actions:resoumettreAdProOtherRequest",
    "consulting-actions:prolongerConsultingContract",
  ]);
  X("RENVOYER, RESOUMETTRE, REDEMANDER — LE MATÉRIEL PROMOTIONNEL SE CORRIGE (audit 360°, lot C4b, §118.190). RENVOYER un "
    + "dossier pour correction est une issue de VALIDATION, au même titre que valider et refuser : elle se tranche par la "
    + "personne que l'étape désigne, devant le dossier ; RESOUMETTRE la demande corrigée et REDEMANDER des devis sont des "
    + "gestes du DEMANDEUR qui disent ce qui a changé ou ce qu'il cherche ; CORRIGER UN COMPTAGE est l'attestation de celui "
    + "qui a compté, comme sa saisie (§118.15). Adam est en pause de développement : aucun geste neuf ne lui est ouvert. "
    + "Un clic sur /promo-material/<id> ou sur Sales & Marketing › Stock promotionnel, onglet « Comptages ».", [
    "promo-circuit-actions:renvoyerPromoStep", "promo-circuit-actions:resoumettrePromoDemande",
    "promo-devis-actions:redemanderDevisPromo", "promo-comptage-actions:corrigerComptage",
  ]);
  X("RANGER UN DEVIS DÉPOSÉ COMME DEVIS D'UNE AGENCE (§118.204) — un fichier « devis » posé sur une demande de matériel "
    + "promotionnel devient un devis du circuit, rattaché à l'agence que la personne choisit dans l'annuaire. C'est un geste "
    + "de RETRANSCRIPTION (l'assistante de direction, ou la Direction), devant le fichier : dire à qui appartient un devis "
    + "engage le bon de commande qui en sortira. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. "
    + "Un clic sur /promo-material/<id> › carte « Devis » › « Ranger comme devis de cette agence ».", [
    "promo-devis-actions:rangerDevisPromo",
  ]);
  X("CORRIGER SA DEMANDE DE PAIEMENT (audit 360°, lot C4c, §118.191) — l'objet, le bénéficiaire, le montant, le "
    + "contexte et l'échéance, tant que le dossier est chez le demandeur (brouillon, ou renvoyé par les Finances). C'est le "
    + "geste du DEMANDEUR, qui dit après transmission ce qui a changé ; il fait suivre l'ordre de dépense et peut rouvrir "
    + "l'autorisation du centre de paiement. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un "
    + "clic sur /validations/paiements/<id> › « Corriger la demande ».", [
    "payment-request-actions:corrigerDemandePaiement",
  ]);
  X("SUPPRIMER DÉFINITIVEMENT SA DEMANDE DE PAIEMENT (Direction, 19/10/2026) — retirée ou restée brouillon, elle part en "
    + "lot avec son ordre de dépense annulé, ses pièces et son fil, restaurable depuis la corbeille. Le geste du DEMANDEUR (ou "
    + "du Super Admin), décidé devant la fenêtre qui montre ce qui part avec. Adam est en pause de développement : aucun "
    + "geste neuf ne lui est ouvert.", [
    "payment-request-actions:supprimerDemandePaiement",
  ]);
  X("ROUVRIR ET ANNULER UNE DEMANDE AU SECRÉTARIAT (audit 360°, lot C4c, §118.191) — les gestes nommés qui remplacent le "
    + "menu de statut libre : rouvrir une demande TERMINÉE avec son motif, annuler une demande par l'annulation commune (qui "
    + "retire aussi la validation, l'approbation et le paiement en attente). Ce sont des gestes du SECRÉTARIAT qui disent "
    + "pourquoi au demandeur. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur "
    + "/demandes/<id> › « Rouvrir… » ou « Annuler la demande… ».", [
    "admin-request-actions:rouvrirDemande", "admin-request-actions:annulerDemandeAuSecretariat",
  ]);
  X("RENVOYER, CORRIGER, ROUVRIR UN RECRUTEMENT, ANNULER UNE EMBAUCHE (audit 360°, lot C4d1, §118.192) — renvoyer une "
    + "demande pour correction (qui peut trancher la marche, ou les RH), la corriger et la renvoyer (son demandeur, qui dit "
    + "ce qui a changé ; une correction matérielle fait repartir la chaîne), rouvrir une demande refusée ou close sans "
    + "recrutement (les RH ou le sommet, motif à l'appui), annuler une embauche avant sa fiche employé. Ce sont des "
    + "DÉCISIONS sur un engagement pluriannuel et des données personnelles, prises par une personne qui dit pourquoi. Adam "
    + "est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur /recrutement/<id>.", [
    "recruitment-actions:renvoyerDemandeRecrutement", "recruitment-actions:resoumettreDemandeRecrutement",
    "recruitment-actions:rouvrirDemandeRecrutement", "recruitment-actions:annulerEmbaucheRecrutement",
  ]);
  X("LA DIFFUSION D'UNE OFFRE ET LE FIL D'UN RECRUTEMENT (Direction, 07/10) — préparer le post LinkedIn (Luna, selon "
    + "l'entité), en modifier le texte, le marquer publié ou retiré, publier ou retirer l'offre du site depuis la fiche, "
    + "l'envoyer à Emploitic (quand l'API sera configurée), écrire au fil de la demande. Publier une offre engage "
    + "l'entreprise auprès de candidats : c'est un clic des RH, devant la carte « Diffusion » ; un message au fil est "
    + "écrit par une personne. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur "
    + "/recrutement/<id>.", [
    "recrutement-diffusion-actions:preparerPostLinkedIn", "recrutement-diffusion-actions:enregistrerTexteCanal",
    "recrutement-diffusion-actions:marquerCanalPublie", "recrutement-diffusion-actions:retirerCanal",
    "recrutement-diffusion-actions:publierOffreSiteDuRecrutement", "recrutement-diffusion-actions:envoyerOffreEmploitic",
    "recruitment-actions:commenterDemandeRecrutement",
  ]);
  X("RÉTABLIR UN DOCUMENT LEGAL ANNULÉ (§118.184, audit L04) : le retour d'une annulation, ajouté parce que "
    + "l'annulation n'en avait aucun. C'est un geste de correction qu'une personne fait devant la ligne qu'elle "
    + "vient d'annuler par erreur ; Adam est en pause de développement (Super Admin seul) et l'annulation qu'il "
    + "couvre reste celle de l'écran. Un clic sur Legal › la ligne annulée › Rétablir.", [
    "legal-actions:restoreLegalDocument",
  ]);
  X("LE STOCK PROMOTIONNEL (§118.164) : chaque geste ATTESTE un fait physique — « je l'ai reçu » (confirmer "
    + "une réception), « je l'ai remis » (doter, transférer, rendre), « je l'ai perdu », « je l'ai compté » "
    + "(inventaire d'ouverture, correction), « il est entré au magasin ». Un modèle ne voit ni le magasin ni la "
    + "voiture d'un délégué : lui confier ces gestes ferait porter au nom d'une personne un stock qu'elle n'a "
    + "jamais vu, et une confirmation de réception est précisément ce qu'un document injecté demanderait (§118.15). "
    + "Adam est de plus en pause de développement. Un clic sur Sales & Marketing › Stock promotionnel.", [
    "promo-stock-actions:entrerEnStock", "promo-stock-actions:poserInventaireOuverture",
    "promo-stock-actions:declarerSupportNumerique", "promo-stock-actions:modifierArticleStock",
    "promo-stock-actions:modifierLot", "promo-stock-actions:doter", "promo-stock-actions:transferer",
    "promo-stock-actions:confirmerReception", "promo-stock-actions:refuserReception",
    "promo-stock-actions:annulerTransfert", "promo-stock-actions:declarerPerte",
    "promo-stock-actions:corrigerInventaire", "promo-stock-actions:annulerMouvement",
    "promo-stock-actions:demanderMateriel", "promo-stock-actions:servirDemande",
    "promo-stock-actions:refuserDemande", "promo-stock-actions:annulerDemande",
  ]);
  X("LES MISSIONS AD & PRO RELIÉES AU PROFIL (Direction, 10/2026) — confirmer ou décliner une invitation, ajouter ses "
    + "étapes, demander son transport, son hébergement, son matériel ou déposer sa note de frais depuis « Mes missions », "
    + "valider comme N+1 l'ordre de mission d'un membre de son équipe, relancer, remplacer, modifier les dates, intégrer "
    + "À LA MAIN les frais de l'équipe au budget de la demande. Chacun de ces gestes engage une PERSONNE (sa présence, sa "
    + "signature de N+1, un montant exact qu'elle a lu sur une facture) : un modèle ne les pose pas à sa place, et Adam est "
    + "en pause de développement. Un clic sur Mon espace › Mes missions, ou sur la carte « Équipe Adventum » de la demande.", [
    "mission-actions:repondreMission", "mission-actions:relancerMission", "mission-actions:remplacerMission",
    "mission-actions:modifierMission", "mission-actions:ajouterEtapeMission", "mission-actions:retirerEtapeMission",
    "mission-actions:deciderOrdreMissionN1", "mission-actions:demanderLogistiqueMission",
    "mission-actions:demanderMaterielMission", "mission-actions:deposerNoteFraisMission",
    "mission-actions:integrerFraisEquipe",
  ]);
  X("LA DEMANDE DE PARTICIPATION ET LA MISSION D'UN MEMBRE DE L'ÉQUIPE ADVENTUM (Direction, 10/2026) — envoyer sa fiche, "
    + "contre-proposer, accepter ou refuser une version, déposer le billet émis ou la confirmation d'hôtel, choisir "
    + "l'imputation des frais (Direction Marketing), saisir ses dépenses et leurs justificatifs, rédiger le rapport, clôturer "
    + "la mission. Chacun engage une PERSONNE — sa présence et ses dates, la parole d'Adventum dans une négociation, un "
    + "billet réellement émis, une ligne budgétaire, une dépense et son justificatif lus sur un reçu — et la clôture fait "
    + "partir une note de frais au N+1 puis aux RH : un modèle ne les pose pas à sa place, et Adam est en pause de "
    + "développement. Un clic sur Mon espace › Missions › la mission, ou sur la carte « Équipe Adventum » de la demande.", [
    "mission-actions:proposerParticipation", "mission-actions:deciderParticipation",
    "mission-actions:enregistrerBilletMission", "mission-actions:enregistrerHotelMission",
    "mission-actions:choisirBudgetMission", "mission-actions:ajouterFraisMission",
    "mission-actions:joindreJustificatifFrais", "mission-actions:retirerFraisMission",
    "mission-actions:enregistrerRapportMission", "mission-actions:cloturerMission",
  ]);
  X("LE CATALOGUE PROMOTIONNEL (§118.164) : la liste de RÉFÉRENCE que citent les stocks et les demandes "
    + "d'achat — ses références CAT-NNNN sont fixes, et le Super Admin choisit nommément qui la lit et qui l'écrit "
    + "(Administration › Accès). La tenir est une décision d'organisation, pas une demande de conversation ; et Adam "
    + "est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur Sales & Marketing › Stock promotionnel › Catalogue.", [
    "promo-catalogue-actions:creerArticleCatalogue", "promo-catalogue-actions:modifierArticleCatalogue",
    "promo-catalogue-actions:archiverArticleCatalogue",
  ]);
  X("LES ACHATS DU MATÉRIEL PROMOTIONNEL (§118.165) — la RÉCEPTION d'une ligne de facture, son annulation, et "
    + "l'annulation d'une facture. Cocher « reçu » est une ATTESTATION : c'est elle qui fait entrer des unités au "
    + "magasin central et qui ouvre le paiement, et l'audit porte le nom du demandeur. Un modèle ne voit pas le carton "
    + "arriver ; une facture ou un mail lu par une étape peut contenir « tout est arrivé », et rien ne distinguerait plus "
    + "la réception forgée de la vraie — le stock compterait ce que personne n'a vu, et le paiement partirait (§118.15). "
    + "Annuler une facture ou une réception défait ce qu'une personne a attesté : même raison. Un clic du demandeur sur "
    + "/promo-material/<id>, facture en tableau sous les yeux.", [
    "promo-execution-actions:receptionnerLigneFacturePromo", "promo-execution-actions:annulerReceptionLigneFacturePromo",
    "promo-execution-actions:annulerFacturePromo",
  ]);
  X("LA DEMANDE D'ACHAT DU MATÉRIEL PROMOTIONNEL (§118.165) se compose en PIOCHANT dans le catalogue : l'article, ses "
    + "produits, la quantité, ce qu'on attend du fournisseur. C'est ce que l'assistante fera chiffrer, mot pour mot. "
    + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic du demandeur sur "
    + "/promo-material/<id>, carte « Articles demandés ».", [
    "promo-demande-actions:enregistrerArticleDemandePromo", "promo-demande-actions:retirerArticleDemandePromo",
    // « AUTRE ARTICLE » PROPOSÉ AU CATALOGUE (Direction, 10/2026) : ajouté d'un clic par qui tient le catalogue, sinon ses
    // gestionnaires sont prévenus — un geste du demandeur devant sa demande, jamais un appel d'Adam.
    "promo-demande-actions:proposerArticleAuCataloguePromo",
  ]);
  X("L'APERÇU DU BC D'UN DOSSIER DE MATÉRIEL PROMOTIONNEL, À VALIDER PAR LE DEMANDEUR (Direction, 10/2026) : la génération "
    + "(automatique à la dernière validation, ou le geste de repli) dépose un aperçu SANS numéro ; on le relit "
    + "(`apercuBcPromo`), on le corrige (`modifierApercuBcPromo`), on le retire (`annulerApercuBcPromo`) — et seule la "
    + "validation du demandeur (ou du Super Admin) attribue le numéro NNN/DG/AAAA et envoie le BC aux Finances "
    + "(`validerEtEnvoyerBcPromo`). Engager la société se décide devant le PDF, pas dans une conversation. RELANCER "
    + "(`relancerPromo`) prévient la personne attendue, une fois par jour : un geste de la fiche, pas d'Adam. "
    + "Un clic sur /promo-material/<id>.", [
    "promo-execution-actions:apercuBcPromo", "promo-execution-actions:modifierApercuBcPromo",
    "promo-execution-actions:annulerApercuBcPromo", "promo-execution-actions:validerEtEnvoyerBcPromo",
    "promo-circuit-actions:relancerPromo",
  ]);
  X("LE MATÉRIEL DU STOCK D'UN POSTE AD & PRO (§118.167) — lister les articles du magasin qu'un événement emporte, et "
    + "CONFIRMER après l'événement ce qui a été remis, rendu, abîmé ou perdu. La confirmation est une ATTESTATION : elle fait "
    + "rentrer le reste au magasin, sort définitivement le remis du registre, et l'audit porte le nom de qui l'a dite. Un "
    + "modèle n'était pas sur le stand ; un compte rendu lu par une étape peut écrire « tout a été distribué », et rien ne "
    + "distinguerait plus la confirmation forgée de la vraie — le magasin perdrait des kakémonos qui sont rentrés (§118.15). "
    + "Lister reste une décision du demandeur, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. "
    + "Un clic sur la fiche de la demande, bloc « Matériel pris au magasin ».", [
    "ad-pro-item-actions:ajouterArticleStockAuPoste", "ad-pro-item-actions:confirmerMaterielStock",
  ]);
  X("LES POSTES D'UNE DEMANDE AD & PRO, SIMPLIFIÉS (§118.175) — RÉPARTIR un sponsoring indirect par nature (« 400 000 en "
    + "imprimerie, 600 000 en hôtellerie ») et tenir les VOYAGEURS d'un poste de billetterie (nom, trajet, dates, passeport), "
    + "puis en DEMANDER la réservation à l'assistante de direction, qui reçoit un sujet. Répartir est la décision du demandeur "
    + "sur sa propre dépense ; un voyageur porte des données personnelles et une pièce d'identité qui se dépose en FICHIER ; "
    + "la réservation engage le travail d'une personne. Adam est en pause de développement : aucun geste neuf ne lui est "
    + "ouvert. Un clic sur la fiche de la demande, carte du poste (« Répartir par nature », bloc « Voyageurs »).", [
    "ad-pro-item-actions:repartirPoste", "ad-pro-item-actions:ajouterVoyageur", "ad-pro-item-actions:modifierVoyageur",
    "ad-pro-item-actions:retirerVoyageur",
  ]);
  X("SUPPRIMER UNE SÉLECTION D'ÉCRITURES « À IMPUTER » (§118.176) — le geste du Super Admin sur la liste des Budgets, "
    + "« une ou plusieurs ». Adam supprime déjà une écriture par `delete_record`, qui passe par le même cœur réversible ; une "
    + "SÉLECTION se fait devant la liste, avec l'aperçu de ce que chaque écriture laisse sans lien (la facture qu'elle règle, "
    + "l'ordre de dépense, la dotation de caisse, §118.53). Adam est en pause de développement : aucun geste neuf ne lui est "
    + "ouvert. Un clic sur Budgets › Dépenses, « Supprimer la sélection ».", [
    "admin-delete-actions:superAdminDeleteMany", "admin-delete-actions:apercuSuppressionGroupee",
  ]);
  X("SUPPRIMER UNE DEMANDE AD & PRO depuis sa fiche — la porte ouverte au directeur des opérations et à la directrice "
    + "marketing (§118.175), à côté de celle du Super Admin. Adam n'est visible que du Super Admin (§118.153), qui supprime "
    + "déjà par `delete_record` ; offrir cette seconde porte à Adam ne servirait personne. Et le geste se fait devant son "
    + "APERÇU — ce qui part avec la demande, ce qui perd son lien (§118.53, §118.162). Un clic sur la fiche, « Supprimer la "
    + "demande ».", [
    "admin-delete-actions:supprimerDemandeAdPro",
  ]);
  X("SUPPRIMER UNE PIÈCE LEGAL, OU L'UN DE SES FICHIERS, depuis la fiche de la demande Ad & Pro (§118.209) — « on doit pouvoir "
    + "supprimer les documents dans les demandes ». Adam n'est visible que du Super Admin (§118.153), qui supprime déjà une pièce "
    + "par `delete_record` (même cœur réversible, même refus de ce qui engage la pièce) ; offrir une seconde porte à Adam ne "
    + "servirait personne. Et le geste se fait devant l'APERÇU de ce qui part (fichiers, commentaires, lecteurs) et sous un "
    + "double geste — retirer un devis, un bon de commande ou une facture du registre n'est pas un rangement qu'un modèle décide "
    + "d'après un document lu (§118.7). Un clic sur la fiche de la demande, bloc « Pièces Legal de la demande » ou « Pièces liées ».", [
    "ad-pro-pieces-actions:supprimerPieceDeLaDemande", "ad-pro-pieces-actions:apercuSuppressionPieceDeLaDemande",
    "ad-pro-pieces-actions:supprimerFichierDePieceDeLaDemande",
  ]);
  X("LES COMPTAGES, ALERTES ET REFONTES DU STOCK PROMOTIONNEL (§118.168). SAISIR un comptage est une ATTESTATION — « j'en ai "
    + "40 en main » — que seul celui qui détient le matériel donne : chaque écart devient une correction au registre portée à "
    + "son nom. Un modèle ne voit ni le carton ni la voiture ; un compte rendu lu par une étape peut écrire « tout y est », et le "
    + "registre recopierait ce que personne n'a compté (§118.15). DEMANDER ou PLANIFIER un comptage engage le travail d'une "
    + "personne au nom du directeur des opérations, et son autorité est relue à chaque déclenchement ; RETENIR une refonte est une "
    + "décision de la Direction Marketing. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur "
    + "Sales & Marketing › Stock promotionnel, onglets « Comptages » et « Tableau de bord ».", [
    "promo-comptage-actions:demanderComptage", "promo-comptage-actions:saisirComptage",
    "promo-comptage-actions:annulerComptage", "promo-comptage-actions:planifierComptage",
    "promo-comptage-actions:suspendreRecurrenceComptage", "promo-comptage-actions:reprendreRecurrenceComptage",
    "promo-comptage-actions:supprimerRecurrenceComptage", "promo-comptage-actions:proposerRefonte",
    "promo-comptage-actions:deciderRefonte",
  ]);
}
