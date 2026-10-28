/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE FINANCES — LA PORTE SERVEUR.
 *
 * L'argent qui sort et qui entre : les ORDRES DE DÉPENSE (un seul écrivain, `createExpenseOrder`,
 * qui fait naître tout ordre en attente du centre de paiement), leur révision et leur annulation
 * tant qu'ils ne sont pas réglés, le versement d'une remise de caisse d'avance autorisée par le
 * centre (`verserLaRemise`, Direction 28/10/2026), le règlement des factures, la trésorerie et
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

// ── Commandes : l'ordre de dépense, de sa naissance au centre à sa fin ───────────────────────
export { createExpenseOrder, dossierHrefByOrder, SERIE_DEMANDES_PAIEMENT } from "./infra/expense-orders";
export { apresRevisionOrdre, type ResultatRevision, reviserOrdreNonRegle } from "./infra/revision-ordre";
export { annulerOrdreNonRegle } from "./infra/annulation";
export { prevenirQuiALaMain } from "./infra/relance-destinataires";

// ── Commandes : le règlement (l'argent sort, l'écriture se pose) ─────────────────────────────
export { verserLaRemise } from "./infra/verser-remise";
export { syncInvoiceSettlement } from "./infra/settle-invoice";
export { solderLeDossierCompagnon } from "./infra/compagnon-regle";
export { nextFinanceRef } from "./infra/next-ref";

// ── Requêtes : trésorerie, comptes, pièces ───────────────────────────────────────────────────
export { compteDeLEcriture, comptesTresorerie } from "./infra/comptes";
export { clauseAImputer } from "./infra/a-imputer";
export { ficheAFacture, ordreAFacture, ordresAvecFacture } from "./infra/facture-ordre";
export { type LienDepense, type PieceDepense, piecesDesEcritures } from "./infra/pieces-depense";

// ── Requêtes : ce que montrent les écrans (une page ne lit pas Prisma) ───────────────────────
export { chargerCentre, type EntiteDuCentre, type SectionDuCentre } from "./infra/requetes/centre-paiement";
export { chargerOrdresDesFinances, HISTORIQUE_MAX } from "./infra/requetes/paiements-a-faire";
export {
  chargerTresorerie, type CompteLu, getFinanceData, type LedgerRow, ORDRES_AUTORISES_NON_REGLES,
} from "./infra/requetes/finance";
export { type ComptaItem, getComptaData, getResultatMensuel } from "./infra/requetes/compta";
export { myPaymentRequests } from "./infra/requetes/my-payment-requests";
export {
  peutSupprimerUneDemandePaiement, refusSuppressionDemandePaiement,
} from "./infra/requetes/demande-paiement-suppression";
