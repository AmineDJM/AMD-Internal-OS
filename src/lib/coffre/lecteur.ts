import { userCan, type SessionUser } from "@/lib/rbac";
import type { LecteurCoffre } from "./politique";

/**
 * Le lecteur du coffre tel que le RBAC le voit. « Tenir » un module, c'est pouvoir le MODIFIER :
 * une lecture des RH accordée pour consulter un organigramme n'ouvre pas les salaires, une lecture
 * des Finances accordée pour suivre un budget n'ouvre pas les RIB.
 */
export function lecteurDepuisSession(user: SessionUser): LecteurCoffre {
  return {
    genre: "UTILISATEUR",
    userId: user.id,
    superAdmin: user.role === "SUPER_ADMIN",
    tientRH: userCan(user, "RH", "UPDATE"),
    tientFinances: userCan(user, "FINANCES", "UPDATE"),
  };
}
