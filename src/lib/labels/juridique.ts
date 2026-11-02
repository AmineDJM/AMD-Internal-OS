/**
 * Libellés — JURIDIQUE et COURRIER : natures et statuts des documents légaux, échéances, sens du
 * courrier, la nature « facture » et son état de règlement, les demandes de pièces.
 * Module PUR (composants client compris) : réexporté par la porte `lib/labels`.
 */

import type { Display } from "./ton";

/** LEGAL — nature d'un engagement. Les bons de commande vivent ici avec les contrats. */
export const LEGAL_DOC_KIND: Record<string, string> = {
  CONTRACT: "Contrat",
  QUOTE: "Devis",
  PURCHASE_ORDER: "Bon de commande",
  INVOICE: "Facture",
  AGREEMENT: "Convention / accord-cadre",
  NDA: "Accord de confidentialité",
  INSURANCE: "Assurance",
  LICENSE: "Licence / autorisation",
  LEASE: "Bail",
  OTHER: "Autre",
};

/**
 * LE LIBELLÉ D'UNE NATURE LEGAL, POUR L'AFFICHER — toutes les natures, avenant compris.
 *
 * `LEGAL_DOC_KIND` a DEUX usages qui ne se confondent pas : la liste des natures qu'on CRÉE depuis
 * un formulaire générique, et le libellé qu'on AFFICHE. L'avenant n'est pas dans la première — il
 * naît de SON contrat (`amendsId`), avec son impact marché, et un avenant créé sans contrat serait
 * une pièce mal formée — donc il manquait à la seconde : la liste de Legal, la chaîne d'une pièce
 * et les pièces liées d'une fiche affichaient « AMENDMENT », le nom anglais de l'énumération, à une
 * personne qui lit « Avenant » partout ailleurs. Le libellé d'affichage couvre CHAQUE nature du
 * schéma (un test l'exige) ; la liste des natures créables ne bouge pas.
 */
// L'AVOIR suit la même règle que l'avenant : il naît de SA facture (§118.195), jamais d'un formulaire générique —
// donc il se LIT partout, et ne se CRÉE pas depuis la liste des natures.
const LIBELLE_NATURE_LEGALE: Record<string, string> = { ...LEGAL_DOC_KIND, AMENDMENT: "Avenant", CREDIT_NOTE: "Avoir" };

export function natureLegale(kind: string): string {
  return LIBELLE_NATURE_LEGALE[kind] ?? kind;
}

export const LEGAL_DOC_STATUS: Record<string, Display> = {
  ACTIVE: { label: "En vigueur", tone: "success" },
  EXPIRED: { label: "Échu", tone: "danger" },
  RENEWED: { label: "Renouvelé", tone: "info" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
};

/** L'urgence d'une échéance — même échelle que le module pur `legal/lifecycle`. */
export const LEGAL_EXPIRY_LEVEL: Record<string, Display> = {
  NONE: { label: "Sans échéance", tone: "neutral" },
  SCHEDULED: { label: "À terme", tone: "neutral" },
  SOON: { label: "Échéance < 3 mois", tone: "warning" },
  IMMINENT: { label: "Échéance < 1 mois", tone: "danger" },
  OVERDUE: { label: "Échéance dépassée", tone: "danger" },
};

/** COURRIERS — sens du pli. */
export const MAIL_DIRECTION: Record<string, Display> = {
  INCOMING: { label: "Entrant", tone: "info" },
  OUTGOING: { label: "Sortant", tone: "purple" },
};

/**
 * UNE FACTURE — la nature de document légal qui en est une, et OÙ EN EST SON RÈGLEMENT.
 *
 * ── POURQUOI L'ÉTAT SE DÉDUIT AU LIEU D'ÊTRE STOCKÉ ─────────────────────────────────────────
 *
 * Ce fichier portait un `INVOICE_STATUS` à quatre valeurs, écrit en base à côté d'une date de
 * paiement. Deux champs qui disent la même chose finissent par se contredire : une facture
 * « à régler » portant une date de règlement, et aucun écran pour lever le doute. L'état se
 * CALCULE désormais, à partir des seuls faits — la date de paiement, et l'ordre de dépense né de
 * la facture. Il ne peut plus mentir.
 *
 * ── ET POURQUOI TROIS ÉTATS, PAS DEUX ───────────────────────────────────────────────────────
 *
 * « Payée / à payer » ment sur le cas le plus fréquent : la facture PARTIE au circuit (centre de
 * paiement, puis Finances). Elle n'est pas payée — l'afficher comme telle ferait clore un dossier
 * ouvert — et elle n'est pas « à faire » : quelqu'un s'en occupe, et la relancer créerait un
 * second ordre pour la même somme.
 *
 * ── POURQUOI ICI, DANS LE VOCABULAIRE ───────────────────────────────────────────────────────
 *
 * Parce que la déduction n'est QUE la lecture de deux champs, et que tout le monde la lit :
 * l'écran Legal, la fiche marché, la recherche, la frise, Adam. Un module de domaine l'aurait
 * rendue inaccessible à la moitié d'entre eux, qui l'auraient alors recopiée — et deux copies
 * d'une règle d'affichage se répondent différemment le jour où l'une change.
 *
 * Le nom porte « invoice » EN ENTIER parce qu'un `settlementState` existe déjà, pour les ORDRES
 * DE DÉPENSE (`lib/finance/settlement.ts`, payé / reporté / à régler). Deux homonymes de sens
 * différents se prennent l'un pour l'autre à la première relecture pressée.
 */
export const INVOICE_KIND = "INVOICE";

export function isInvoice(kind: string): boolean {
  return kind === INVOICE_KIND;
}

export type InvoiceSettlementState = "NOT_INVOICE" | "UNPAID" | "IN_CIRCUIT" | "PAID";

/**
 * L'ordre des tests n'est pas anodin : une facture payée l'est, même si son ordre de dépense
 * existe encore. Lire le circuit d'abord afficherait « en règlement » sur une facture soldée, et
 * l'on relancerait la comptabilité pour un virement déjà parti.
 */
export function invoiceSettlementState(doc: {
  kind: string;
  paidDate: Date | string | null;
  expenseOrderId?: string | null;
}): InvoiceSettlementState {
  if (!isInvoice(doc.kind)) return "NOT_INVOICE";
  if (doc.paidDate) return "PAID";
  if (doc.expenseOrderId) return "IN_CIRCUIT";
  return "UNPAID";
}

/** Comment l'état se dit à l'écran. Rien pour ce qui n'est pas une facture : c'est voulu. */
export const INVOICE_SETTLEMENT: Record<string, Display> = {
  UNPAID: { label: "À régler", tone: "warning" },
  IN_CIRCUIT: { label: "En règlement", tone: "info" },
  PAID: { label: "Réglée", tone: "success" },
};

export const PIECE_REQUEST_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente de dépôt", tone: "warning" },
  SUBMITTED: { label: "Déposé — à confirmer", tone: "info" },
  ACCEPTED: { label: "Pièce reçue", tone: "success" },
  DECLINED: { label: "Refusé — à redéposer", tone: "danger" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};
