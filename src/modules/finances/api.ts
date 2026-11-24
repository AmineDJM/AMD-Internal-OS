/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE FINANCES — LA PORTE SERVEUR.
 *
 * L'argent qui sort et qui entre : les ORDRES DE DÉPENSE (un seul écrivain, `createExpenseOrder`,
 * qui fait naître tout ordre en attente du centre de paiement), leur révision et leur annulation
 * tant qu'ils ne sont pas réglés, le paiement d'une remise de caisse d'avance par les Finances
 * (`verserLaRemise` — elle compte dans la caisse à la confirmation du caissier, 24/11/2026), le règlement des factures, la trésorerie et
 * les comptes, et les lectures des écrans `/finances`, `/centre-de-paiement`, `/validations/paiements`.
 *
 * Hors de `src/modules/finances/`, on importe CE fichier (ou `./partage` pour les règles pures,
 * `./actions-*` pour les actions), jamais `domaine/` ni `infra/` : tenu par ESLint et
 * `src/modules/frontieres.test.ts`. Chaque réexportation pointe DIRECTEMENT son fichier d'`infra/` :
 * le scanner du contrat des actions la suit (un niveau) pour décrire ce qu'une action écrit.
 *
 * Tables possédées : `ExpenseOrder`, `PaymentCentreSeat`, `PaymentCentreMessage`, `PaymentRequest`,
 * `PaymentPiece`, `PaymentRequestEvent`, `FinanceTransaction`, `TreasuryAccount`.
 * Les écrivains de `PAID` et de l'autorisation forment une liste FERMÉE (`centre-ecrivains.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";
// La TVA des factures (lot « tva ») : la porte étroite, réexportée.
export * from "./api-tva";

// ── Commandes : l'ordre de dépense, de sa naissance au centre à sa fin ───────────────────────
export { createExpenseOrder, dossierHrefByOrder, SERIE_DEMANDES_PAIEMENT } from "./infra/expense-orders";
export { apresRevisionOrdre, type ResultatRevision, reviserOrdreNonRegle } from "./infra/revision-ordre";
export { annulerOrdreNonRegle } from "./infra/annulation";
export { prevenirQuiALaMain } from "./infra/relance-destinataires";
// Le justificatif obligatoire (24/11/2026) : l'entrée au centre à la pièce jointe, et l'état des pièces pour le centre.
export {
  type JustificatifDeLOrdre, justificatifsDesOrdres, libererLesOrdresJustifies,
} from "./infra/justificatif";

// ── Commandes : le règlement (l'argent sort, l'écriture se pose) ─────────────────────────────
export { verserLaRemise } from "./infra/verser-remise";
export { syncInvoiceSettlement } from "./infra/settle-invoice";
export { solderLeDossierCompagnon } from "./infra/compagnon-regle";
export { nextFinanceRef } from "./infra/next-ref";
// La paie versée par le centre : le virement soldé au règlement, l'instant de la bascule (§118.176).
export { instantDuCentreDePaie, solderVirementPaie } from "./infra/paie-centre";

// ── Requêtes : trésorerie, comptes, pièces ───────────────────────────────────────────────────
export { compteDeLEcriture, comptesTresorerie } from "./infra/comptes";
export { clauseAImputer } from "./infra/a-imputer";
export { ficheAFacture, ordreAFacture, ordresAvecFacture } from "./infra/facture-ordre";
export { type LienDepense, type PieceDepense, piecesDesEcritures } from "./infra/pieces-depense";

// ── Requêtes : ce que montrent les écrans (une page ne lit pas Prisma) ───────────────────────
export { chargerCentre, type EntiteDuCentre } from "./infra/requetes/centre-paiement";
export {
  type ApportContexte, type BriquesContexte, contexteDecisionDesOrdres, historiqueDuCentre, type LigneHistoriqueCentre,
  type OrdrePourBrique,
} from "./infra/requetes/contexte-decision";
export {
  seuilsDeFractionnementEnVigueur, signauxDeFractionnement, signalDeFractionnementPour,
} from "./infra/requetes/fractionnement";
export { approbateursEnAmont, approbateursEnAmontDesOrdres } from "./infra/approbateurs-amont";
export { chargerOrdresDesFinances, HISTORIQUE_MAX } from "./infra/requetes/paiements-a-faire";
export { chargerDossiersDesLignes, type DossierDeLigne, type MessageFil, type PieceVue } from "./infra/requetes/banque-paiements";
// La question des Finances au demandeur, sur le fil du dossier compagnon (24/11/2026).
export {
  dossierDeLOrdre, etatsDesQuestions, lienQuestionDemandeur, lireQuestion, prevenirFinancesDeLaReponse,
  rappelerQuestionsSansReponse,
} from "./infra/questions-finances";
export {
  chargerTresorerie, type CompteLu, ORDRES_AUTORISES_NON_REGLES,
} from "./infra/requetes/finance";
export { getComptaData, getResultatMensuel } from "./infra/requetes/compta";
// L'écran « Comptabilité » (maquette validée, 24/11/2026) : la société, l'onglet, la recherche, les panneaux, le Résultat.
export {
  type CandidatRattachement, chargerComptabilite, type ControleCompta, type DetailEcriture, type DonneesComptabilite,
  type EtapeChaine, type FactureCompta, type LigneCompta, type ParamsComptabilite, type PieceCompta, SANS_SOCIETE,
} from "./infra/requetes/comptabilite";
export { fileAInstruire, instruitLesDemandes, myPaymentRequests } from "./infra/requetes/my-payment-requests";
export {
  peutSupprimerUneDemandePaiement, refusSuppressionDemandePaiement,
} from "./infra/requetes/demande-paiement-suppression";
