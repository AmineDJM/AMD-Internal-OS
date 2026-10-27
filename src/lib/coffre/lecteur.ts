import { userCan, type SessionUser } from "@/lib/rbac";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import type { LecteurCoffre } from "./politique";

/**
 * Le lecteur du coffre tel que le RBAC le voit. « Tenir » un module, c'est pouvoir le GÉRER : une
 * lecture des RH accordée pour consulter un organigramme n'ouvre pas les salaires, une lecture des
 * Finances accordée pour suivre un budget n'ouvre pas les RIB.
 *
 * Les RH, c'est la règle déjà lue par chaque écran de la paie (`voitLesSalaires` : modifier OU valider
 * le module) : le coffre ne doit pas montrer moins, ni plus, que l'écran qui le précédait (V2-E).
 */
export function lecteurDepuisSession(user: SessionUser): LecteurCoffre {
  return {
    genre: "UTILISATEUR",
    userId: user.id,
    superAdmin: user.role === "SUPER_ADMIN",
    tientRH: voitLesSalaires(user),
    tientFinances: userCan(user, "FINANCES", "UPDATE"),
  };
}
