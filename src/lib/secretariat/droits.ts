import { hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { peutValiderLeBrouillon } from "@/lib/bons-de-commande/brouillon";

/**
 * QUI GÈRE UNE DEMANDE AU SECRÉTARIAT — la règle de la fiche (`/demandes/[id]`) : la vue globale,
 * le droit de modifier du module, la personne chargée, et l'assistante de direction, qui tient le
 * bureau. Écrite ici une fois pour les gestes des devis natifs ; la fiche et les actions d'avant
 * (`admin-request-actions.ts`) lisent la même chose.
 */
export function gereLaDemande(user: SessionUser, demande: { assignedToId: string | null }): boolean {
  return hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE") || demande.assignedToId === user.id || user.role === "DIRECTION_ASSISTANT";
}

/**
 * QUI RETIENT LES LIGNES DES DEVIS ET GÉNÈRE LE BON DE COMMANDE — le DEMANDEUR, ou le Super Admin.
 * Pas l'assistante qui a retranscrit : la règle de l'aperçu du BC d'un poste Ad & Pro
 * (`peutValiderLeBrouillon`, Direction 10/2026) — celui qui prépare ne choisit pas pour celui qui
 * commande. Une seule écriture de la règle, lue par l'écran et par l'action.
 */
export function commandeLaDemande(user: { id: string; role: string }, demande: { requesterId: string | null }): boolean {
  return peutValiderLeBrouillon({ userId: user.id, role: user.role, demandeurId: demande.requesterId });
}

export const REFUS_COMMANDE = "Seul le demandeur (ou le Super Admin) retient les lignes des devis et génère le bon de commande.";
