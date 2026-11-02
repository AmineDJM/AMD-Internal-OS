/**
 * INFORMATION MÉDICALE — qui pilote une déclaration, qui la tranche (et ce qu'on dit de lui), et les pages à
 * rafraîchir.
 *
 * Sorti de `actions/medical-info-actions.ts` (lot V4) : règles pures et chemins, aucune écriture.
 */
import { revalidatePath } from "next/cache";
import { userCan, hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { estDecideurInfoMed, DECIDEUR_INFO_MED_LABEL, ROLE_DECIDEUR_INFO_MED } from "@/lib/medical-info/decideur";

export const PATH = "/information-medicale";

/** Le pharmacien responsable (ou la Direction / un admin) pilote la déclaration. */
export function canManage(user: SessionUser): boolean {
  return hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE");
}

export function revalidate(id: string) {
  revalidatePath(PATH);
  revalidatePath(`${PATH}/${id}`);
}

/** Ce que l'écran et le journal disent de celui qui tranche. */
export function qualiteDuDecideur(user: SessionUser): string {
  return hasRole(user, ROLE_DECIDEUR_INFO_MED) ? DECIDEUR_INFO_MED_LABEL : "Super Admin";
}

/**
 * La porte commune aux deux décisions finales : le décideur, et jamais le pharmacien qui a validé
 * lui-même le dossier (un PRIM qui porterait aussi le rôle de directeur ne se valide pas).
 */
export function refusDecideur(user: SessionUser, decl: { pharmacistValidatedById: string | null }): string | null {
  if (!estDecideurInfoMed(user)) return `Validation finale réservée au ${DECIDEUR_INFO_MED_LABEL} (à défaut, au Super Admin).`;
  if (user.role !== "SUPER_ADMIN" && decl.pharmacistValidatedById === user.id) {
    return "Vous avez validé ce dossier comme pharmacien : la validation finale revient à un autre décideur.";
  }
  return null;
}

export const DEJA_TRANCHE = "Ce dossier vient d'être tranché par un autre décideur — rechargez la page.";
