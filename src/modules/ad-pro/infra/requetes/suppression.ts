import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { DELETE_REGISTRY } from "@/lib/admin-delete-registry";
import { estDemandeAdProSupprimable, peutSupprimerDemandeAdPro } from "../../domaine/suppression";
import { cheffesMarketingActuelles } from "@/lib/queries/promo-circuit";

/**
 * PEUT-ON SUPPRIMER CETTE DEMANDE AD & PRO ? — la porte de l'écran, de l'aperçu ET de l'action
 * (§118.175). Une seule lecture : un bouton armé que l'action refuse ensuite fait chercher une panne
 * qui n'existe pas, et un aperçu plus large que l'action dirait à quelqu'un ce qui dépend d'une
 * demande qu'il ne peut pas toucher.
 *
 * Trois faits, tous nécessaires :
 *   1. QUI : Super Admin, directeur des opérations (ses deux libellés), directrice marketing — la
 *      cheffe lue sur l'organigramme (`peutSupprimerDemandeAdPro`, pur et testé) ;
 *   2. QUOI : une demande DU PÔLE — un contrat de consulting passé aux RH (§118.150) n'en est plus
 *      une, et seul le Super Admin le supprime ;
 *   3. OÙ : la ligne est visible de la personne (`canAccessEntity`). Supprimer ce qu'on ne voit pas
 *      serait supprimer par un identifiant deviné.
 *
 * Ce module n'est pas un fichier `"use server"` : tout ce qu'un tel fichier exporte est un point
 * d'entrée public, et ceci est une QUESTION posée par des actions qui ont déjà la session.
 */
export async function peutSupprimerUneDemandeAdPro(user: SessionUser, kind: string, id: string): Promise<boolean> {
  if (!estDemandeAdProSupprimable(kind)) return false;
  if (user.role === "SUPER_ADMIN") return true;
  const cheffes = await cheffesMarketingActuelles();
  if (!peutSupprimerDemandeAdPro({ role: user.role, secondaryRole: user.secondaryRole ?? null, estCheffeMarketing: cheffes.includes(user.id) })) {
    return false;
  }
  if (kind === "CONSULTING_CONTRACT") {
    const c = await prisma.consultingContract.findUnique({ where: { id }, select: { pole: true } });
    if (!c || c.pole !== "AD_PRO") return false;
  }
  const entite = DELETE_REGISTRY[kind].entityType;
  return entite ? canAccessEntity(user, entite, id, "VIEW") : false;
}
