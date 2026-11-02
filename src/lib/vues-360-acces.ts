import { userCan, type SessionUser, type Module } from "@/lib/rbac";

/**
 * QUI VOIT QUELLE FACETTE D'UNE VUE 360° — une section par module : elle n'apparaît qu'à qui a le droit de VOIR ce
 * module. Léger (il ne lit que les droits) : le menu, les pages et les tests lisent la même règle.
 */
export const SECTIONS_360 = {
  reglementaire: "REGULATORY", marches: "PCH", ventes: "SALES", segmentation: "SEGMENTATION",
  consommation: "CONSUMPTION", finances: "FINANCES", terrain: "MEDICAL", forceDeVente: "SALES_PLANNING", adpro: "SPONSORING",
  // Produits 360 (Direction, 07/10) : le stock des dossiers, les cas signalés, le matériel promotionnel, les messages.
  stock: "STOCKS", pharmacovigilance: "PHARMACOVIGILANCE", materiel: "PROMO_STOCK", marketing: "MARKETING_COCKPIT",
  // Les ventes d'Adventum = ce que la PCH reçoit de nous et distribue (Direction, 08/10) : le module Ventes PCH.
  ventesPch: "PCH_VENTES",
} as const satisfies Record<string, Module>;
export type Section360 = keyof typeof SECTIONS_360;

export function sections360(user: SessionUser): Record<Section360, boolean> {
  return Object.fromEntries(Object.entries(SECTIONS_360).map(([k, m]) => [k, userCan(user, m, "VIEW")])) as Record<Section360, boolean>;
}

/**
 * QUI CORRIGE UN PRIX À LA MAIN — « Modifier » sur Produits 360 (la console l'ouvre à qui la Direction veut), ou sur
 * Regulatory : le prix d'un médicament est fixé avec sa décision d'enregistrement (attestation de prix), c'est le
 * réglementaire qui la détient.
 */
export function peutModifierLesPrix(user: SessionUser): boolean {
  return userCan(user, "PRODUCTS", "UPDATE") || userCan(user, "REGULATORY", "UPDATE");
}
