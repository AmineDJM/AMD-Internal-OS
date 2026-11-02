/**
 * FORCE DE VENTE — les BUSINESS UNITS et leurs réglages lus ou composés par les actions : le canal d'un produit, le
 * département choisi, la Direction commerciale sous laquelle une gamme ouvre son budget (et le sous-département qu'elle
 * y reçoit), ce qu'une BU porte encore, la maille de tournée, le report des affectations d'un cycle, le référent qui
 * tranche.
 *
 * Sorti de `actions/sales-planning-actions.ts` (lot V4). Les lectures du formulaire et les gardes restent dans les
 * actions (le contrat des actions les lit dans leur corps).
 */
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buDepartmentName, buDepartmentCode } from "@/lib/sfe/bu-department";
import { GRANULARITES, GRANULARITE_LABELS, JOURS_AVANT_ECHEANCE_MAX } from "@/lib/sfe/tournee";
import { anyRoleFilter } from "@/lib/rbac";
import { ROLES_QUI_TRANCHENT } from "@/lib/personnes/referents-gamme";

/** Canal produit (Ville / Hôpital / les deux) — défaut BOTH si non renseigné. */
export function parseChannel(v: string | null): "RETAIL" | "HOSPITAL" | "BOTH" {
  return v === "RETAIL" || v === "HOSPITAL" || v === "BOTH" ? v : "BOTH";
}

/** Le département choisi pour une BU existe-t-il encore ? (Il a pu disparaître depuis l'ouverture de l'écran.) */
export async function departementExiste(departmentId: string): Promise<boolean> {
  return Boolean(await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } }));
}

/**
 * LE PARENT D'UN BUDGET DE GAMME : la Direction commerciale de la MÊME entité quand la BU en porte une — une gamme
 * d'Adventum ne se range pas sous la direction commerciale de Pharmagène.
 */
export async function directionCommercialeDe(companyId: string | null): Promise<{ id: string } | null> {
  return prisma.department.findFirst({
    where: {
      ...(companyId ? { companyId } : {}),
      OR: [
        { name: { contains: "commercial", mode: "insensitive" } },
        { code: { contains: "COMMERCIAL", mode: "insensitive" } },
      ],
      // On ne se range pas sous une BU : c'est la Direction commerciale qu'on cherche, pas une
      // gamme sœur — sans ce filtre, l'arbre s'emboîterait sur lui-même.
      businessUnits: { none: {} },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Le sous-département d'une gamme, créé sous la Direction commerciale, et la BU qui le porte désormais. */
export async function creerSousDepartementDeLaBu(
  bu: { id: string; name: string; code: string | null; companyId: string | null }, parentId: string,
): Promise<{ id: string }> {
  const dep = await prisma.department.create({
    data: {
      name: buDepartmentName(bu.name),
      code: buDepartmentCode(bu),
      companyId: bu.companyId,
      parentId,
      description: `Sous-département de la Direction commerciale — budget Ad&Pro et masse salariale de la Business Unit « ${bu.name} ».`,
    },
    select: { id: true },
  });
  await prisma.businessUnit.update({ where: { id: bu.id }, data: { departmentId: dep.id } });
  return dep;
}

/** Ce qu'une BU porte encore (KAM, produits) — dit dans le refus de sa suppression. */
export function ceQueLaBuPorte(n: { reps: number; products: number }): string {
  return [
    n.reps > 0 ? `${n.reps} KAM` : null,
    n.products > 0 ? `${n.products} produit(s)` : null,
  ].filter(Boolean).join(" et ");
}

/** Une maille de tournée inconnue : le refus nomme les valeurs admises. */
export function refusMaille(granularity: string): string {
  return `Maille inconnue « ${granularity} » — valeurs admises : ${GRANULARITES.map((g) => `${g} (${GRANULARITE_LABELS[g].toLowerCase()})`).join(", ")}.`;
}

/** Le délai de soumission d'un plan de tournée hors bornes : le refus nomme la borne. */
export const REFUS_DELAI_SOUMISSION =
  `Le délai de soumission se compte en jours entiers, de 0 à ${JOURS_AVANT_ECHEANCE_MAX}, avant la fin du mois qui précède la période (15 par défaut).`;

/** Duplique les affectations d'un cycle vers un autre (une ligne déjà présente est laissée telle quelle). */
export async function reporterAffectations(fromCycleId: string, toCycleId: string, userId: string): Promise<number> {
  const src = await prisma.promotionAssignment.findMany({ where: { cycleId: fromCycleId } });
  let copied = 0;
  for (const a of src) {
    await prisma.promotionAssignment.upsert({
      where: { cycleId_repId_productId: { cycleId: toCycleId, repId: a.repId, productId: a.productId } },
      create: { cycleId: toCycleId, repId: a.repId, productId: a.productId, position: a.position, plannedVisits: a.plannedVisits, note: a.note, updatedById: userId },
      update: {},
    });
    copied++;
  }
  return copied;
}

/**
 * LE RÉFÉRENT DOIT PORTER LE RÔLE qui tranche : sans lui, il serait prévenu sans rien pouvoir trancher. `null` = la
 * personne n'existe pas, n'est plus active, ou ne porte pas ce rôle.
 */
export async function referentQuiTranche(userId: string): Promise<{ id: string; name: string } | null> {
  return prisma.user.findFirst({
    where: { id: userId, isActive: true, ...anyRoleFilter([...ROLES_QUI_TRANCHENT] as UserRole[]) },
    select: { id: true, name: true },
  });
}
