/**
 * QUI TIENT LA DIRECTION ARTISTIQUE D'UNE ENTITÉ.
 *
 * Deux portes, cumulées :
 *   • la responsabilité historique de la papeterie (`canManageLetterheads` : assistante de
 *     direction, Super Admin) — gardée telle quelle, rien de ce qui marchait ne se ferme ;
 *   • le module « Direction artistique » (ART_DIRECTION) ouvert PAR LA CONSOLE à une personne :
 *     le Super Admin qui l'accorde à quelqu'un doit voir cette personne pouvoir agir — un droit
 *     accordé qui ne débloque aucun geste est un mensonge de l'écran des accès.
 *
 * Le PÉRIMÈTRE (quelle entité) n'est pas décidé ici : chaque geste revérifie que l'entité visée
 * est dans celles que la personne voit (`getMyCompanies`).
 */

import { userCan, type Action } from "@/lib/rbac";
import { canManageLetterheads } from "@/lib/office/letterhead";
import type { CurrentUser } from "@/lib/session";

export type GesteDirectionArtistique = Extract<Action, "CREATE" | "UPDATE" | "DELETE" | "UPLOAD">;

type Porteur = { role: string; secondaryRole?: string | null; access?: CurrentUser["access"] };

export function peutGererDirectionArtistique(user: Porteur, geste: GesteDirectionArtistique = "UPDATE"): boolean {
  if (canManageLetterheads(user)) return true;
  return user.access ? userCan(user as unknown as CurrentUser, "ART_DIRECTION", geste) : false;
}
