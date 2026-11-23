import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasRole, type Action, type SessionUser } from "@/lib/rbac";
import { PARENT_COLONNE, type AdProParent } from "@/lib/chemins/ad-pro";

/**
 * LE PHARMACIEN LIT LE POSTE DONT IL CONTRÔLE LE BAT (Direction, 23/11/2026).
 *
 * La conformité d'un BAT est SON geste — pour un sponsoring comme pour une « Autre demande ». Mais il n'a pas le module des
 * « Autres demandes » (ni la portée de toutes les lignes ailleurs) : la décision répondait « Poste introuvable », et le BAT ne
 * se téléchargeait pas. La porte est étroite :
 *   • le rôle de pharmacien responsable de l'information médicale ;
 *   • en LECTURE seulement ;
 *   • un poste SOUMIS au contrôle de conformité dont un BAT lui a été envoyé (`conformiteStatut` posé), et la demande qui le
 *     porte (c'est par elle que `loadItem` ouvre un poste) — rien d'autre de la demande ne s'écrit par ici.
 */
export async function lecturePourConformite(user: SessionUser, entityType: EntityType, entityId: string, action: Action): Promise<boolean> {
  if (action !== "VIEW" || !hasRole(user, "MEDICAL_INFO_PHARMACIST")) return false;
  const batEnvoye = { conformiteRequise: true, execution: { conformiteStatut: { not: null } } };
  if (entityType === "AD_PRO_ITEM") return (await prisma.adProItem.count({ where: { id: entityId, ...batEnvoye } })) > 0;
  if (!(entityType in PARENT_COLONNE)) return false;
  return (await prisma.adProItem.count({ where: { [PARENT_COLONNE[entityType as AdProParent]]: entityId, ...batEnvoye } })) > 0;
}
