/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE AD & PRO — LA PORTE PURE (règles du métier, importables partout, navigateur compris).
 *
 * Elle ne réexporte que `domaine/` : les natures de demande et leurs états (`unified`), les postes
 * (`postes` : ventilation, émission d'ordre), le centre de validation (`centre`), la clôture d'un
 * sponsoring, les fiches voyageurs / hébergements, la prise en charge (`prise-en-charge/`), l'état et
 * la portée de modification d'un événement (`evenements/`), la correction d'une demande (`edition`).
 * Aucune base, aucun Node, aucun React.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { attachHint, canAttachToAdPro, isOwnBusiness } from "./domaine/attachments";
export { beneficiaireDuPaiement, type EtatBcPoste, gesteVisaPoste, type GesteVisaPoste, memePrestataire } from "./domaine/bc-poste";
export { compteursCentre, type FormeBC, type FormePorte, type LigneCentre, REFUS_BC_CENTRE_AD_PRO, REFUS_CENTRE_AD_PRO, siegeAuCentreAdPro, trierCentre } from "./domaine/centre";
export { bilanCloture, type BilanCloture, etatPostesSponsoring, LIBELLE_QUI_CLOTURE, peutCloturer, quiCloture, type QuiCloture, refusCloture, STATUTS_SOLDES_PAR_UN_REGLEMENT } from "./domaine/cloture-sponsoring";
export { composerContexte, type ConseilPiece, CONSIGNE_CONSEIL, type ContexteConseil, lireConseilModele, lireEmplacement, type NatureDemandeConseil, NATURES_DEMANDE_CONSEIL, type PosteDuContexte, SCHEMA_CONSEIL } from "./domaine/conseil-pieces";
export { billingSuffix, isAwaitingDecision, isContractEditable, isOverdue, nextConsultingStatus, totalCommitment } from "./domaine/consulting";
export { type AdProCreateData, adProOtherCreateFields, businessUnitField, CHAMP_PIECES_COMPLEMENTAIRES, consultingCreateFields, consultingRhCreateFields, sponsoringCreateFields, toPeople } from "./domaine/create-fields";
export { type ArticleADeviser, ETAPE_DEMANDE_DEVIS, lettreDeSecours, type LettreDevis, lettreValide, quantiteEnLettre, texteDeLaLettre } from "./domaine/demande-devis-lettre";
export { doutesDeLaLecture, type LigneDevisPoste, lignesDepuisLaLecture, noteApresCorrection, noteDeLecture, refusChangementDeValidation, refusDepassement, refusEditionDesLignes, refusGenerationBC, refusTauxDuDevis, reservesEncoreVraies } from "./domaine/devis-poste";
export { AD_PRO_DOC_CATEGORIES, categorieDuPdf, categoriesDuDepotDeLaDemande, type NatureDeChaine, natureDeLaCategorie, naturesDEngagement, PROMO_MATERIAL_DOC_CATEGORIES, sectionDeLaNature, type SectionPieces } from "./domaine/doc-categories";
export { canEditAdProRequest, describeChanges, editableField, isAdProDecided, type NatureEditable, PERIODE_DE_LA_DEMANDE } from "./domaine/edition";
export { estStatutInscriptionRetire, estStatutOrganisation, estTypeExterne, REFUS_INSCRIPTION_PUBLIQUE, REFUS_LISTE_ATTENTE, REFUS_ORGANISATION, TYPES_EVENEMENT_EXTERNE } from "./domaine/evenements/externe";
export { CHAMPS_ORGANISATION, champsModifies, porteeModificationEvenement } from "./domaine/evenements/modification";
export { estStatutDuCircuit, statutDepuisCircuit, statutManuelOuRien, STATUTS_MANUELS } from "./domaine/evenements/statut";
export { FICHES_MAX, prefixeFiche, prefixesRecus, refusDeFiche } from "./domaine/fiches-saisie";
export { changementsHebergement, type HebergementLu, lireHebergement, nuitsLisibles, porteDesHebergements, refusChangementNatureFiches, type SaisieHebergement } from "./domaine/hebergements";
export { CHEMIN_DEMANDE, demandeAbandonnee, estTypeMedecinsConcernes, LIBELLE_NATURE_DEMANDE, LIBELLE_ROLE_MEDECIN, type RoleMedecin, type TypeMedecinsConcernes, TYPES_MEDECINS_CONCERNES } from "./domaine/medecins-concernes";
export { montantDeLaDemande } from "./domaine/montant-demande";
export { AVAILABLE_PRODUCT_STATUSES, availableProductOptions, CHAMPS_MEDECINS, doctorOptions, type DoctorRow, lireMedecinsDemande, type ProductRow, readMultiField, repartirMedecins, specialtyOptions, type SpecialtyRow, splitMulti } from "./domaine/pickers";
export { estDemandeBcAEtablir, type NaturePieceSecretariat, NATURES_PIECE_SECRETARIAT, peutDemanderPiece, PIECE_SECRETARIAT, TITRE_BC_A_ETABLIR, titrePiece } from "./domaine/pieces-secretariat";
export { etatDuPaiement, facturePourPayer, LIBELLE_JUSTIFICATIF_DIRECT, phrasePaiementBloque, STATUTS_EDITABLES, VERSEMENT_SANS_BC } from "./domaine/poste-etapes";
export { type PostePropose, versFormulairePoste } from "./domaine/postes-luna";
export { AD_PRO_PARENTS, type AdProParent, breakdown, budgetKindLocked, canEmitOrder, canRemoveItem, canRequestPurchaseOrder, canSubmitItem, ITEM_KIND_LABELS, ITEM_KINDS, PARENT_COLONNE, PARENT_ENTITE, parentDuPoste, REFUS_INDIRECT_NON_REPARTI } from "./domaine/postes";
export { casesDeLaCategorie, type CellRow, DECISION_LIBELLE, detailsStockes, type DetailTrajet, deviseDuDevis, deviseDuPoste, etapesDuBillet, etapesStockees, hotelPrerempli, libelleNouveauPoste, lignesReservationFiche, lireDetailsTrajets, lireMode, lireMontant, lirePosteSaisi, manquesBillet, manquesHotel, manquesPourReserverFiche, montantLisible, type Perimetre, personnePasseport, personneVivante, peutMarquerRealisee, peutTeleverserBillet, resumeBillet, resumeDesFiches, resumeHotel, TAUX_USD_DZD_DEFAUT, tauxDeLaDemande, typePoste, versDzd } from "./domaine/prise-en-charge/fiches";
export { cleLivret, natureDuLivret, peutLirePiecePriseEnCharge } from "./domaine/prise-en-charge/pieces-acces";
export { etatApresRetrait, fichiersDeLaCase, phraseDepot, principalApresDepot } from "./domaine/prise-en-charge/pieces";
export { beneficiaryName, careProgress, defaultCells, financeReadiness, OPINION_LABELS, piecesADemander, piecesAttendues, quoteConflicts, SERVICE_KIND_LABELS } from "./domaine/prise-en-charge/regles";
export { ecrireRepartition, type PosteReparti } from "./domaine/repartition-ecriture";
export { libelleLigne, type LigneRepartition, lireRepartition } from "./domaine/repartition";
export { estDemandeAdProSupprimable, REFUS_SUPPRESSION_AD_PRO } from "./domaine/suppression";
export { AD_PRO_ENTITY_TYPE, AD_PRO_KINDS, AD_PRO_STATE, type AdProKind, type AdProRequest, adProState, type AdProState, countByState, creatableKinds, dejaPorteParSaFiche, kindSpec, type KindSpec, TYPES_ENTITE_AD_PRO } from "./domaine/unified";
export { droitsValidation, type DroitsValidation, estDirectionMarketingPoste, estDirectionOperations, libelleTemps, opsFranchiALaSoumission, peutTenir, type Porteur, rolesAPrevenir, tempsEnAttente } from "./domaine/validation-poste";
export { changementsVoyageur, depassementDevisRetenus, type EtapeTrajet, ligneVoyageur, lireEtapes, lireVoyageur, manquesPourReserver, nomComplet, porteDesVoyageurs, type SaisieVoyageur, TRAJET_LIBELLE, TRANSPORT_LIBELLE, type VoyageurLu } from "./domaine/voyageurs";
