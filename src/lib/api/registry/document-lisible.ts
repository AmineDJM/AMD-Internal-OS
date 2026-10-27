import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { ENTITIES, canReadEntity } from "./entities";
import { porteeEntite } from "./portee";

/**
 * UNE PIÈCE SE LIT PAR L'OBJET QUI LA PORTE — pour TOUS les types, pas seulement ceux du registre API.
 *
 * Le registre (`ENTITIES`) ne décrit qu'une quinzaine de types ; pour les autres (bulletin de paie, demande RH,
 * CV de candidat, pièce Legal, cas de pharmacovigilance…), la route `GET /api/v1/documents/:id/content` ne
 * contrôlait RIEN : un client `erp.documents.read` téléchargeait n'importe quelle pièce dont il connaissait
 * l'identifiant (audit du 27/10/2026, RH-DOCUMENTS-COMMS-01). Hors registre, on applique la règle de l'écran
 * (`canAccessEntity`, la même que `/api/documents/[id]`). Une pièce sans objet porteur ne se lit pas.
 */
export async function documentLisibleParApi(
  user: SessionUser,
  doc: { entityType: string | null; entityId: string | null },
): Promise<boolean> {
  if (!doc.entityType || !doc.entityId) return false;
  const def = ENTITIES.find((e) => e.entityType && e.entityType === doc.entityType);
  if (def) {
    if (!canReadEntity(user, def)) return false;
    const model = (prisma as any)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];
    const owner = await model.findFirst({ where: { AND: [await porteeEntite(user, def), { id: doc.entityId }] }, select: { id: true } });
    return Boolean(owner);
  }
  return canAccessEntity(user, doc.entityType as EntityType, doc.entityId, "VIEW");
}
