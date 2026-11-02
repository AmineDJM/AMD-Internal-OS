/**
 * Libellés — FINANCE : mouvements, catégories, moyens et statuts, avances, ordres de dépense,
 * demandes de paiement, pièces et urgences (avec leurs listes d'options).
 * Module PUR (composants client compris) : réexporté par la porte `lib/labels`.
 */

import type { Display } from "./ton";

export const FINANCE_DIRECTION: Record<string, Display> = {
  IN: { label: "Encaissement", tone: "success" },
  OUT: { label: "Décaissement", tone: "danger" },
};

export const FINANCE_CATEGORY: Record<string, string> = {
  RECETTE: "Recette / Vente",
  CCA: "Compte courant associé",
  PRET: "Emprunt reçu",
  REMBOURSEMENT: "Remboursement emprunt",
  SALAIRE: "Salaires / Personnel",
  AVANCE: "Avance sur salaire",
  LOYER: "Loyer",
  VOYAGE: "Voyages / Déplacements",
  EVENEMENT: "Événement / Table ronde",
  BUREAUTIQUE: "Bureautique / Mobilier",
  FOURNISSEUR: "Achats fournisseurs",
  CHARGES: "Charges (élec, eau, internet…)",
  IMPOT: "Impôts & taxes",
  BANQUE: "Frais bancaires",
  AUTRE: "Autre",
};

export const FINANCE_METHOD: Record<string, string> = {
  CASH: "Espèces",
  BANK_TRANSFER: "Virement",
  CHEQUE: "Chèque",
  CARD: "Carte",
  OTHER: "Autre",
};

export const FINANCE_STATUS: Record<string, Display> = {
  PENDING: { label: "Prévu", tone: "warning" },
  SETTLED: { label: "Réalisé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};

export const ADVANCE_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  APPROVED: { label: "Approuvée", tone: "info" },
  REJECTED: { label: "Refusée", tone: "danger" },
  PAID: { label: "Réglée", tone: "success" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};

export const EXPENSE_ORDER_STATUS: Record<string, Display> = {
  PENDING: { label: "À régler", tone: "warning" },
  REVISION_REQUESTED: { label: "Révision budget demandée", tone: "purple" },
  PAID: { label: "Réglé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "neutral" },
};

/**
 * DEMANDE DE PAIEMENT — les états d'un dossier qui fait des allers-retours.
 *
 * « En attente » n'est pas « refusée » : la première reviendra, la seconde non. Les confondre,
 * c'est relancer les Finances pour rien, ou laisser mourir un dossier qui attendait une simple
 * trésorerie.
 */
export const PAYMENT_REQUEST_STATUS: Record<string, Display> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  SUBMITTED: { label: "Chez les Finances", tone: "info" },
  UNDER_REVIEW: { label: "En cours d'instruction", tone: "info" },
  ON_HOLD: { label: "Mise en attente", tone: "warning" },
  CHANGES_REQUESTED: { label: "À revoir — chez le demandeur", tone: "warning" },
  APPROVED: { label: "Bon à payer", tone: "success" },
  REJECTED: { label: "Refusée", tone: "danger" },
  CANCELLED: { label: "Annulée", tone: "neutral" },
};

/** Le verdict des Finances sur UNE pièce — refuser un dossier entier pour une facture floue obligerait à tout redéposer. */
export const PAYMENT_PIECE_STATUS: Record<string, Display> = {
  PENDING: { label: "À examiner", tone: "neutral" },
  ACCEPTED: { label: "Acceptée", tone: "success" },
  CHANGES_REQUESTED: { label: "À revoir", tone: "warning" },
  REJECTED: { label: "Refusée", tone: "danger" },
};

/** Les Finances ne cherchent pas « la pièce n° 3 » : elles cherchent LA FACTURE. */
export const PAYMENT_PIECE_KIND: Record<string, string> = {
  INVOICE: "Facture",
  PURCHASE_ORDER: "Bon de commande",
  QUOTE: "Devis",
  DELIVERY_NOTE: "Bon de livraison",
  CONTRACT: "Contrat",
  PROOF: "Justificatif",
  OTHER: "Autre pièce",
};

export const PAYMENT_PIECE_KIND_OPTIONS: { value: string; label: string }[] =
  Object.entries(PAYMENT_PIECE_KIND).map(([value, label]) => ({ value, label }));

/** À défaut de date convenue, l'urgence — sans quoi la demande finit au bas de la pile. */
export const PAYMENT_URGENCY: Record<string, string> = {
  URGENT: "Urgent",
  THIS_WEEK: "Cette semaine",
  THIS_MONTH: "Ce mois-ci",
  WHEN_POSSIBLE: "Dès que possible",
};

export const PAYMENT_URGENCY_OPTIONS: { value: string; label: string }[] =
  Object.entries(PAYMENT_URGENCY).map(([value, label]) => ({ value, label }));
