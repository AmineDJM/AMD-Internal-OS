import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ENTITY_MODULE } from "@/lib/entity-access";
import {
  userCan,
  scopeRegulatory,
  scopeMedicalDoctors,
  scopeMedicalVisits,
  scopeSales,
  scopeBusinessDevelopment,
  type SessionUser,
} from "@/lib/rbac";

const ALL_ENTITY_TYPES: EntityType[] = [
  "REGULATORY_PRODUCT", "REGULATORY_STEP", "SPONSORING", "BUDGET",
  "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "SALE", "LOGISTICS",
  "DOCTOR", "VISIT", "DELEGATE_PLAN", "BD_OPPORTUNITY",
];

function isAll(where: Record<string, unknown>) {
  return Object.keys(where).length === 0;
}
function isNone(where: Record<string, unknown>) {
  return (where as { id?: string }).id === "__none__";
}

/**
 * Builds a Document `where` filter that returns only documents the user is
 * allowed to see — enforcing both module permission and row-level scope so the
 * centralized library never leaks rows from a pole the user can't access.
 */
export async function accessibleDocumentWhere(
  user: SessionUser,
): Promise<Prisma.DocumentWhereInput> {
  const ors: Prisma.DocumentWhereInput[] = [];

  for (const entityType of ALL_ENTITY_TYPES) {
    const module = ENTITY_MODULE[entityType];
    if (!userCan(user, module, "VIEW")) continue;

    // Row-scoped poles: narrow to the entity ids the user may see.
    if (entityType === "REGULATORY_PRODUCT" || entityType === "REGULATORY_STEP") {
      const scope = scopeRegulatory(user);
      if (isNone(scope)) continue;
      if (isAll(scope)) {
        ors.push({ entityType });
      } else {
        const ids = (await prisma.regulatoryProduct.findMany({ where: scope, select: { id: true } })).map((r) => r.id);
        ors.push({ entityType, entityId: { in: ids.length ? ids : ["__none__"] } });
      }
    } else if (entityType === "DOCTOR") {
      const scope = scopeMedicalDoctors(user);
      if (isNone(scope)) continue;
      if (isAll(scope)) ors.push({ entityType });
      else {
        const ids = (await prisma.medicalDoctor.findMany({ where: scope, select: { id: true } })).map((r) => r.id);
        ors.push({ entityType, entityId: { in: ids.length ? ids : ["__none__"] } });
      }
    } else if (entityType === "VISIT") {
      const scope = scopeMedicalVisits(user);
      if (isNone(scope)) continue;
      if (isAll(scope)) ors.push({ entityType });
      else {
        const ids = (await prisma.medicalVisit.findMany({ where: scope, select: { id: true } })).map((r) => r.id);
        ors.push({ entityType, entityId: { in: ids.length ? ids : ["__none__"] } });
      }
    } else if (entityType === "SALE") {
      const scope = scopeSales(user);
      if (isNone(scope)) continue;
      if (isAll(scope)) ors.push({ entityType });
      else {
        const ids = (await prisma.sale.findMany({ where: scope, select: { id: true } })).map((r) => r.id);
        ors.push({ entityType, entityId: { in: ids.length ? ids : ["__none__"] } });
      }
    } else if (entityType === "BD_OPPORTUNITY") {
      const scope = scopeBusinessDevelopment(user);
      if (isNone(scope)) continue;
      if (isAll(scope)) ors.push({ entityType });
      else {
        const ids = (await prisma.businessDevelopmentOpportunity.findMany({ where: scope, select: { id: true } })).map((r) => r.id);
        ors.push({ entityType, entityId: { in: ids.length ? ids : ["__none__"] } });
      }
    } else {
      // Non row-scoped poles: module permission is sufficient.
      ors.push({ entityType });
    }
  }

  if (ors.length === 0) return { id: "__none__" };
  // UNE PIÈCE CONFIDENTIELLE ne se liste qu'à qui pourrait l'ouvrir (audit Drive du 24/11, F9 — `peutOuvrirPieceConfidentielle`) :
  // son déposant, ou qui peut MODIFIER dans le module. La liste ne promet pas ce que le téléchargement refuserait.
  return {
    OR: ors.map((o) => userCan(user, ENTITY_MODULE[o.entityType as EntityType], "UPDATE")
      ? o
      : { AND: [o, { OR: [{ confidentiality: { not: "CONFIDENTIAL" as const } }, { uploadedById: user.id }] }] }),
  };
}
