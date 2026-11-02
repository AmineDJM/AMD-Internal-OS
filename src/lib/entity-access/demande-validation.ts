/**
 * Accès par enregistrement — le LECTEUR d'une demande de validation (et les gestes d'écriture de pièce
 * qu'il ne reçoit pas). Réexporté par la porte `lib/entity-access`.
 */

import { actsForUser } from "@/lib/hr/stand-in-resolve";
import type { Action } from "@/lib/rbac";

/** Les gestes sur les fichiers d'une pièce que la fiche offre à qui peut l'écrire. */
export const GESTES_D_ECRITURE_DE_PIECE: readonly Action[] = ["UPLOAD", "UPDATE", "DELETE"];

/**
 * QUI OUVRE UNE DEMANDE DE VALIDATION — sa fiche, ses pièces, son fil (audit 360°, lot C3).
 *
 * Le DEMANDEUR et le Super Admin, pour lire comme pour joindre ; en LECTURE, chaque validateur
 * désigné — et son INTÉRIMAIRE de congé, qui peut trancher l'étape à sa place (§118.185) : lui
 * refuser la lecture de ce qu'on lui demande de décider serait un geste offert puis retiré (§118.83).
 * Joindre une pièce reste au demandeur : c'est lui qui corrige une demande renvoyée.
 */
export async function lecteurDeLaDemandeDeValidation(
  user: { id: string; role: string },
  demande: { requesterId: string; steps: { validatorId: string }[]; participants?: { userId: string }[] },
  action: Action = "VIEW",
): Promise<boolean> {
  if (user.role === "SUPER_ADMIN" || demande.requesterId === user.id) return true;
  if (action !== "VIEW") return false;
  const validateurs = [...new Set(demande.steps.map((e) => e.validatorId))];
  if (validateurs.includes(user.id)) return true;
  // LES PARTICIPANTS ajoutés à la demande (Direction, 06/10) la lisent et en discutent.
  if (demande.participants?.some((p) => p.userId === user.id)) return true;
  for (const v of validateurs) if (await actsForUser(user.id, v)) return true;
  return false;
}
