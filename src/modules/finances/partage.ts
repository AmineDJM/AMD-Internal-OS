/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE FINANCES — LA PORTE PURE (navigateur compris).
 *
 * Les règles de l'argent, sans base ni fichier : l'autorisation du centre de paiement
 * (`initialCentralStatus`, `canDisburse`, `applyDecision`), les chemins de paiement
 * (`PAYMENT_PATHS`), la porte budgétaire (`budgetGate`), le règlement (`settlementState`), la
 * machine d'état des demandes de paiement, la trésorerie (`resoudreCompte`) et leurs libellés.
 *
 * Ne réexporte QUE `domaine/` (tenu par `src/modules/frontieres.test.ts`) : un composant client
 * l'importe sans tirer Prisma dans le navigateur. Le serveur importe `./api`, qui la réexporte.
 *
 * Homonyme : `canResubmit` est la règle du DOSSIER de demande (`domaine/payment-request`) ; celle
 * du CENTRE (`domaine/authorization`) sort sous le nom `canResubmitAuCentre`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  estEtatLigne, etatDemande, type EtatLigne, LIBELLE_ETAT_DEMANDE, LIBELLE_ETAT_LIGNE, lireReponse,
  phraseBilan, type SaisieLigne,
} from "./domaine/actualisation-soldes";
export {
  applyDecision, applyResubmission, awaitsCentre, awaitsRequester, blockedReason, canDisburse,
  canResubmit as canResubmitAuCentre,
  CENTRAL_AUTH_THRESHOLD_DZD, CENTRAL_DECISION_LABEL, CENTRAL_STATUS_LABEL, type CentralDecision,
  type CentralStatus, memeBeneficiaire, MOTIFS_REFUS_RAPIDES, ORDRE_NON_ANNULE, PAYMENT_CENTRE_REFUSAL,
  refusOrdreFerme, ROLES_CENTRE_DE_PAIEMENT, sitsOnPaymentCentre, visibleToFinance,
  attendJustificatif, HORS_DU_CENTRE, statutApresJustificatif,
} from "./domaine/authorization";
export {
  estRegularisation, JUSTIFICATIF_DE_SOURCE, LIBELLE_LIEU_JUSTIFICATIF, LIBELLE_NATURE_JUSTIFICATIF, type LieuJustificatif,
  type NatureJustificatif, ORIGINES_JUSTIFIEES, type OrigineOrdre, phraseJustificatifAttendu, REFUS_REGLEMENT_SANS_JUSTIFICATIF,
  refusDeDepotDePiece, regleDeJustificatif, type RegleJustificatif, titreJoindreJustificatif,
} from "./domaine/justificatif";
export {
  canMarkPaidDirectly, canSendToSettlement, cleEnvoiAuReglement, dateDeReglementAEcrire, invoiceDirection,
  ordreClos, peutDaterLeReglement, REFUS_DATE_REGLEMENT_HORS_FINANCES, REFUS_FACTURE_EMISE_AU_REGLEMENT,
  refusFactureDePoste,
} from "./domaine/chemins-paiement";
export {
  alerteCourte, budgetAvantApres, type BudgetDecision, type ContexteDecision, type EtapeChaine, type EtatEtape,
  type JalonLu, phraseBudget, type PieceDecision, trierFile,
} from "./domaine/contexte-decision";
export {
  ecartsDeCorrection, phraseDeCorrection, refusDeCorrection, refusDeRetrait, refusDeSuppression, refusDuChamp,
  type ValeursDemande,
} from "./domaine/correction-demande";
export {
  DEADLINE_NATURE_OPTIONS, deadlineNatureLabel, deadlineNatureOf, deferralWarning,
} from "./domaine/deadline-nature";
export {
  type CleDeTri, dateDeLaDemande, deplacerDansMonOrdre, estTriMesDemandes, LIBELLE_TRI, mettreEnTeteDeMonOrdre, ORDRE_MAX, TRI_PAR_DEFAUT, TRIS_MES_DEMANDES,
  trierMesDemandes, type TriMesDemandes,
} from "./domaine/mes-demandes-ordre";
export { type LigneMaDemande, lignesMesDemandes } from "./domaine/mes-demandes-lignes";
export {
  canDecideFromDossier, canNudge, companionNotice, isCompanionDossier, NUDGE_LABEL, nudgeKindOf, nudgeMessage,
} from "./domaine/dossier-auto";
export {
  echeancesPaiement, type EnveloppeLue, justificatifsManquants, santeBudget, signauxBudget,
} from "./domaine/intelligence";
export { auditLedger, auditSummary } from "./domaine/ledger-audit";
export { checkMoneyEntity, groupByEntity, resolveMoneyEntity, unassignedWarning } from "./domaine/money-entity";
export {
  FAMILLES_NATURE, LIBELLE_POLE, libelleNatureDepense, NATURE_NON_PRECISEE, type NatureDepense, natureDepense, NATURES_DEMANDE,
  NATURES_DEPENSE, naturesParFamille, phraseRangement, type PoleNature, proposerNature, rechercherNatures, REFUS_SANS_NATURE,
  refusNatureDemande, type RubriqueNature,
} from "./domaine/natures-depense";
export {
  type CalculRetenue, calculerRetenue, estRegimeRetenue, LIBELLE_REGIME_RETENUE, LIBELLE_STATUT_RETENUE, libelleTaux,
  lireTauxSaisi, MENTION_A_CONFIRMER, moisDeLaRetenue, phraseRetenue, REGIMES_RETENUE, type RegimeRetenueSource,
  type StatutRetenue, TAUX_RETENUE_DEFAUT, type TauxRetenue, tauxEnVigueur, totalRetenues,
} from "./domaine/retenues";
export {
  confronterMontantAuxFactures, LIBELLE_CONFIRMATION_ECART, noteEcartAssume,
  PHRASE_MONTANT_NON_LU, phraseEcartMontant, refusEcartMontant,
} from "./domaine/montant-facture";
export { canSubmitDossier, dossierHint, isBonDeVersement } from "./domaine/payment-dossier";
export {
  canApprove, canResubmit, deadlineLabel, isClosed, isOverdue, isWithFinance, needsReplacement,
  nextPaymentStatus, type PaymentMove, piecesEnVigueur, refusDeRemplacement, sortByPriority,
  tallyPieces,
} from "./domaine/payment-request";
export {
  chantierPaiementClos, etatDeLOrdre, type EtatReglement, LIBELLE_ETAT_REGLEMENT, type PieceDeReglement,
} from "./domaine/reglement";
export {
  COMMENTAIRE_RELANCE_MAX, commentaireDeRelance, etatDuPaiement, type EtatPaiement, messageDeRelance,
  PHRASE_ETAT_PAIEMENT, QUI_A_LA_MAIN, refusDeRelance, relancable,
} from "./domaine/relance-paiement";
export { CHOIX_PERIODE, lirePeriode, moisAlger, type MontantCategorie, type Periode, type ResultatPeriode } from "./domaine/resultat-mensuel";
export {
  CATEGORIES_SAISIE, categorieDuTypePiece, choixDePeriode, etatDeLaFacture, type EtatFacture, LIBELLE_ETAT_FACTURE, libelleJustificatif,
  libelleMoisCourt, libelleMoisLong, libelleTiers, lirePeriodeListe, lireVueCompta, montantRecherche, MOTIFS_CONTRE_PASSATION,
  motifDeContrePassation, NOTE_IMPORT_RELEVE, origineDeLEcriture, origineSansDossier, type PeriodeListe, peutDemanderLePaiement,
  peutRattacherAUnPaiement, REFUS_CONTRE_PASSATION_SANS_MOTIF, REFUS_DEPENSE_SANS_JUSTIFICATIF, refusDepenseSansJustificatif,
  SENS_DE_LA_VUE, texteRecherche, TYPES_PIECE, type VueCompta,
} from "./domaine/comptabilite-vue";
export { ENTITE_SANS } from "./domaine/entite-centre";
export {
  REFUS_AUTORISER_SA_DEMANDE, REFUS_AUTORISER_SON_APPROBATION, REFUS_REGLER_SA_DEMANDE, REFUS_REGLER_SON_AUTORISATION,
  refusSeparationDesTaches,
} from "./domaine/separation";
export {
  FENETRE_FRACTIONNEMENT_JOURS, detecterFractionnement, seuilsDeFractionnement, phraseFractionnement,
  type DemandeComparable, type SeuilDeFractionnement, type SignalFractionnement,
} from "./domaine/fractionnement";
export { BUDGET_CLASSIFY_PROMPT, budgetGate, needsBudgetChoice } from "./domaine/settle-budget";
export { STATUTS_SOLDES_PAR_UN_REGLEMENT } from "./domaine/soldes-au-reglement";
export {
  checkDeferral, deferralNote, SETTLEMENT_LABEL, settlementState, type SettlementState, sortForSettlement,
} from "./domaine/settlement";
export { compteParDefaut, jourAlger, resoudreCompte } from "./domaine/tresorerie";
// Banque & paiements refait (24/11/2026) : la saisie du paiement, l'historique, la question des Finances au demandeur.
export {
  etatHistorique, etatQuestion, type EtatQuestion, EVT_QUESTION, EVT_RAPPEL, EVT_REPONSE, EVT_REPONSE_LUE, type EvenementFil,
  joursAvantRappel, jourFr, lireSaisieReglement, lireVueBanque, type LectureQuestion, MODES_REGLEMENT, type ModeReglement,
  noteDeReference, phraseRelances, rappelDu, REFERENCE_MAX, refusRappelManuel, type SaisieReglement, type VueBanque,
} from "./domaine/banque-paiements";

// La paie VERSÉE par le centre de paiement (décision du 28/10/2026) : les RH décident les salaires, les Finances les
// versent — le mois de la paie, l'état d'un salaire et du virement, le coût employeur et la masse salariale.
export {
  basisLabel, type CostBasis, defaultEmployerCost, entryBasis, entryCost, type PayrollCostInput,
} from "./domaine/payroll-cost";
export { type LigneMasseMensuelle, type MasseMensuelle, masseMensuelleParEntite } from "./domaine/payroll-mass";
export {
  clauseSalairesVersesANotifier, deMois, ETAT_VIREMENT_LABEL, etatSalaire, type EtatSalaire, etatVirement,
  libelleVirementPaie, lireSommeAVirer, moisDeLaPaie, moisDeLEntite, type MoisDeLEntite, noteVirementPaie,
  saisiAvantLeCentre, SOMME_A_VIRER_MANQUANTE, virementCouvre, type VirementDuMois,
} from "./domaine/virement-paie";

// Les pièces d'une demande de paiement choisies dans Legal, ou déposées et lues (Direction, 04/11/2026).
export {
  aRemplir, type AnnuaireDeLaPiece, avertissementUsage, type DemandeEnCours, type FichierEnCours, type ChampRempli, type ContactDeLAnnuaire, type DocumentLegalPropose, type LecturePourDemande, natureAInscrireAuLegal, natureDePieceDuLegal, natureDePieceLue,
  type NaturePieceDemande, NATURES_LEGAL_PAYABLES, pieceQuiRemplit, refusReutilisation,
  STATUTS_DEMANDE_VIVANTE, titrePourLeRegistre, type UsageDocumentLegal,
} from "./domaine/pieces-legal";
// `type Proposition` (domaine/pieces-legal) : réexport mis en commentaire — aucun appelant hors du domaine (knip, 04/11).
// export type { Proposition } from "./domaine/pieces-legal";

// LA TVA DES FACTURES (Super Admin, 24/11/2026) : les taux, la saisie et sa cohérence, la TVA du mois (collectée − déductible).
export {
  bornesDeLaPeriode, calculerTvaDuMois, CHAMP_TVA_AUTRES, CHAMP_TVA_ENVOYEE, CHAMP_TVA_LUE, champHt, CHAMPS_TVA, champTva,
  type DetailTaux, estPeriodeTva, estTauxTva, type FactureIncomplete, type FacturePourTva, LIBELLE_SENS_TVA, LIBELLE_SOURCE_TVA,
  libelleTaux as libelleTauxTva, type LigneTva, PHRASE_INCOMPLETE, periodeDeLaFacture, type RaisonIncomplete, raisonIncomplete, refusSaisieTva,
  REGLE_DE_RATTACHEMENT, type SensTva, sensDeLaDirection, type SourceTva, TAUX_TVA, type TauxTva, totauxDeLaSaisie, tvaAPreremplir,
  tvaDe, valeursDuFormulaire,
} from "./domaine/tva";
// Les charges fixes des locaux et le budget de l'Administration (Super Admin, 24/11/2026) : natures, échéances, écart de
// la facture, réserve pour imprévus, prévision de trésorerie, pré-remplissage `AUTO_CHARGES_FIXES` de la campagne.
export {
  type ChargeFixePourCalcul, type ChargeVue, CLE_DONS_MECENAT, type EcheanceVue, type LigneBudgetVue, type SocieteChargesVue,
  lireSaisieCharge, rubriqueDeNature, CLE_MOYENS_GENERAUX, CLE_REMBOURSEMENT_EMPRUNT, CLE_RESERVE_IMPREVUS,
  cleEcheance, CODE_ENVELOPPE_ADMINISTRATION, DELAI_APPARITION_JOURS, ecartFacture, type EcheanceCalculee, echeancesAApparaitre,
  echeancesEntre, estNatureChargeFixe, etatEcheance, type EtatEcheanceCharge, joursAvant, LIBELLE_ETAT_ECHEANCE,
  LIBELLE_MODE_MONTANT, LIBELLE_NATURE_CHARGE_FIXE, LIBELLE_PERIODICITE_CHARGE, libellePeriode, type LignePrefillChargeFixe,
  lignesPrefillChargesFixes, MODES_MONTANT_CHARGE, type ModeMontantCharge, montantAnnuel, type MoisPrevision,
  NATURES_CHARGE_FIXE, type NatureChargeFixe, nomEnveloppeAdministration, PERIODICITES_CHARGE, type PeriodiciteCharge,
  peutDemanderPaiement, peutLibererReserve, previsionChargesFixes, REFUS_RESERVE, refusSurReserve, SEUIL_ECART_FACTURE,
  SOURCE_PREFILL_CHARGES_FIXES, TON_ETAT_ECHEANCE,
} from "./domaine/charges-fixes";
// Les impôts et cotisations dans le budget (Super Admin, 24/11/2026, audit des dépenses) : l'enveloppe « Impôts & taxes »
// (TVA_NETTE, IBS) et les lignes IRG / CNAS de la masse salariale (MS_IRG, MS_CNAS) — des clés STABLES que la campagne
// budgétaire et les autres lots importent d'ici.
export {
  CATEGORIES_BUDGET_IMPOTS, CATEGORIES_MASSE_SALARIALE_IMPOTS, type CleLigneBudgetImpots, type CleLigneMasseSalariale,
  CODE_ENVELOPPE_IMPOTS, LIGNES_BUDGET_IMPOTS, LIGNES_MASSE_SALARIALE, nomEnveloppeImpots,
} from "./domaine/budget-impots";
