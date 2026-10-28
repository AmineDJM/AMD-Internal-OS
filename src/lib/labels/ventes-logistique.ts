/**
 * Libellés — VENTES et LOGISTIQUE : paiement et livraison, logistique, marchés PCH (appels d'offres,
 * niveaux, lignes, commandes), sens des mouvements de stock.
 * Module PUR (composants client compris) : réexporté par la porte `lib/labels`.
 */

import type { Display } from "./ton";

export const PAYMENT_STATUS: Record<string, Display> = {
  UNPAID: { label: "Non payé", tone: "warning" },
  PARTIAL: { label: "Partiel", tone: "info" },
  PAID: { label: "Payé", tone: "success" },
  OVERDUE: { label: "En retard", tone: "danger" },
};

export const DELIVERY_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "neutral" },
  IN_TRANSIT: { label: "En transit", tone: "info" },
  DELIVERED: { label: "Livré", tone: "success" },
  RETURNED: { label: "Retourné", tone: "danger" },
};

export const LOGISTICS_STATUS: Record<string, Display> = {
  ORDERED: { label: "Commandé", tone: "neutral" },
  PRODUCTION: { label: "Production", tone: "info" },
  SHIPPED: { label: "Expédié", tone: "info" },
  ARRIVED_TERMINAL: { label: "Arrivé port/aéroport", tone: "warning" },
  CUSTOMS: { label: "Dédouanement", tone: "warning" },
  DELIVERED: { label: "Livré", tone: "success" },
  BLOCKED: { label: "Bloqué", tone: "danger" },
};

export const PCH_TENDER_STATUS: Record<string, Display> = {
  NOT_STARTED: { label: "Pas encore commencé", tone: "neutral" },
  IN_PROGRESS: { label: "En cours", tone: "info" },
  COMPLETED: { label: "Terminé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
  SUSPENDED: { label: "Suspendu", tone: "warning" },
  LOST: { label: "Perdu", tone: "danger" },
};

/**
 * LE NIVEAU DÉRIVÉ d'un marché (Market 360°). Distinct du statut STOCKÉ ci-dessus : le statut
 * est ce qu'un humain a décidé (annulé, suspendu…), le niveau est ce que les FAITS racontent —
 * calculé par `lib/pch/market-math.ts` (même doctrine que le niveau de process Regulatory).
 */
export const PCH_MARKET_NIVEAU: Record<string, Display> = {
  BROUILLON: { label: "Brouillon", tone: "neutral" },
  PREPARATION: { label: "En préparation", tone: "info" },
  SOUMIS: { label: "Soumis", tone: "info" },
  PERDU: { label: "Perdu", tone: "danger" },
  CONTRACTUALISATION: { label: "Attribué — contrat à enregistrer", tone: "warning" },
  EXECUTION: { label: "En exécution", tone: "success" },
  CLOTURE: { label: "Clôturé", tone: "neutral" },
  ANNULE: { label: "Annulé", tone: "danger" },
  SUSPENDU: { label: "Suspendu", tone: "warning" },
};

/** Le RÉSULTAT d'un lot d'appel d'offres (§14) — cinq issues, plus les états de préparation. */
export const PCH_LINE_STATUS: Record<string, Display> = {
  PENDING: { label: "À étudier", tone: "neutral" },
  QUOTED: { label: "Chiffré", tone: "info" },
  SUBMITTED: { label: "Soumissionné", tone: "info" },
  WON: { label: "Gagné", tone: "success" },
  LOST: { label: "Perdu", tone: "danger" },
  UNSUCCESSFUL: { label: "Infructueux", tone: "warning" },
  CANCELLED: { label: "Lot annulé", tone: "neutral" },
};

export const PCH_ORDER_STATUS: Record<string, Display> = {
  PENDING: { label: "En attente", tone: "warning" },
  VALIDATED: { label: "Validé", tone: "info" },
  DELIVERED: { label: "Livré", tone: "success" },
  PAID: { label: "Payé", tone: "success" },
  CANCELLED: { label: "Annulé", tone: "danger" },
};
