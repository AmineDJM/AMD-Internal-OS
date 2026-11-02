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
} from "./domaine/authorization";
export {
  canMarkPaidDirectly, canSendToSettlement, cleEnvoiAuReglement, dateDeReglementAEcrire, invoiceDirection,
  ordreClos, peutDaterLeReglement, REFUS_DATE_REGLEMENT_HORS_FINANCES, REFUS_FACTURE_EMISE_AU_REGLEMENT,
  refusFactureDePoste,
} from "./domaine/chemins-paiement";
export {
  ecartsDeCorrection, phraseDeCorrection, refusDeCorrection, refusDeRetrait, refusDeSuppression, refusDuChamp,
  type ValeursDemande,
} from "./domaine/correction-demande";
export {
  DEADLINE_NATURE_OPTIONS, deadlineNatureLabel, deadlineNatureOf, deferralWarning,
} from "./domaine/deadline-nature";
export {
  canDecideFromDossier, canNudge, companionNotice, isCompanionDossier, NUDGE_LABEL, nudgeKindOf, nudgeMessage,
} from "./domaine/dossier-auto";
export {
  echeancesPaiement, type EnveloppeLue, justificatifsManquants, santeBudget, signauxBudget,
} from "./domaine/intelligence";
export { auditLedger, auditSummary } from "./domaine/ledger-audit";
export { checkMoneyEntity, groupByEntity, resolveMoneyEntity, unassignedWarning } from "./domaine/money-entity";
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
export { CHOIX_PERIODE, lirePeriode, moisAlger, type Periode, type ResultatPeriode } from "./domaine/resultat-mensuel";
export {
  ENTITE_SANS, SECTION_CENTRE_LABEL, SECTION_CENTRE_SLUG, type SectionCentre, SECTIONS_CENTRE,
  slugSectionDeLOrdre,
} from "./domaine/sections-centre";
export {
  REFUS_AUTORISER_SA_DEMANDE, REFUS_REGLER_SA_DEMANDE, REFUS_REGLER_SON_AUTORISATION,
  refusSeparationDesTaches,
} from "./domaine/separation";
export { BUDGET_CLASSIFY_PROMPT, budgetGate, needsBudgetChoice } from "./domaine/settle-budget";
export { STATUTS_SOLDES_PAR_UN_REGLEMENT } from "./domaine/soldes-au-reglement";
export {
  checkDeferral, deferralNote, SETTLEMENT_LABEL, settlementState, type SettlementState, sortForSettlement,
} from "./domaine/settlement";
export { compteParDefaut, jourAlger, resoudreCompte } from "./domaine/tresorerie";

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
