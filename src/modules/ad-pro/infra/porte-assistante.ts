import { redirect } from "next/navigation";
import { requireModule, requireUser, type CurrentUser } from "@/lib/session";
import { hasRole, userCan, type Module, type SessionUser } from "@/lib/rbac";
import { CHEMIN_BUREAU, lienPosteAssistante } from "@/lib/chemins/ad-pro";
import { estAssistanteDuPoste, loadItem } from "./postes/commun";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSISTANTE DE DIRECTION ET AD & PRO (Direction, 23/11/2026) — « retirer la page Ad & Pro à l'assistante et mettre tout ce
 * qu'elle y faisait dans UNE page : Prospection d'agences ».
 *
 * Ses modules Ad & Pro sont bloqués dans la console : elle travaille sur SES postes (`/agences/<id>`, `loadItem` l'admet par
 * `estAssistanteDuPoste`), qui sont des lignes de SON bureau (le Bureau du secrétariat, un seul tableau depuis le 24/11/2026).
 * Deux portes, pour qu'aucun lien ne la laisse devant une page refusée :
 *   • un ANCIEN lien (une notification d'hier, un favori) vers une demande, une liste du pôle → son bureau, au lieu du refus.
 *     L'ancre « #poste-<id> » survit à la redirection : le bureau la relit et ouvre le poste quand il est à elle ;
 *   • un lien VERS un poste, écrit pour elle → sa page ; pour qui ouvre la demande → la fiche ; sinon, aucun lien.
 * Toute autre personne garde exactement la porte d'avant (`requireModule`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'assistante de direction SANS le module de la page : elle travaille au Bureau du secrétariat (PUR). */
export function versLesAgences(user: SessionUser, module: Module): boolean {
  return hasRole(user, "DIRECTION_ASSISTANT") && !userCan(user, module, "VIEW");
}

/** `requireModule`, sauf pour l'assistante de direction sans le module : elle arrive sur son bureau (le secrétariat). */
export async function requireModuleOuAgences(module: Module): Promise<CurrentUser> {
  const user = await requireUser();
  if (versLesAgences(user, module)) redirect(CHEMIN_BUREAU);
  return requireModule(module);
}

/**
 * OÙ MÈNE « CE POSTE » POUR CETTE PERSONNE — sa page à elle pour l'assistante qui le prospecte, la fiche de la demande pour qui
 * l'ouvre, RIEN sinon (`null`) : un lien vers une page refusée n'est pas un geste.
 */
export async function lienDuPostePour(user: SessionUser, itemId: string, lienDemande: string | null): Promise<string | null> {
  if (await estAssistanteDuPoste(user.id, itemId)) return lienPosteAssistante(itemId);
  // Hors de l'assistante du poste, `loadItem` ne rend le poste qu'à qui ouvre sa demande (`demandeVisible`).
  return lienDemande && (await loadItem(itemId, user)) ? lienDemande : null;
}
