import { prisma } from "@/lib/prisma";
import { dimensionsDeVisite, type DimensionsVisite } from "../domaine/dimensions";

/**
 * Les LECTURES des dimensions dérivées (L3, L9) — la règle est pure (`domaine/dimensions.ts`) ; ici, seulement ce qu'elle
 * lit : la fiche du médecin et la BU du délégué pour une visite, la table des directions régionales pour une vente PCH.
 */

/** L3 — les dimensions de chaque visite (wilaya du médecin, BU du délégué, société). */
export async function dimensionsDesVisites(ids: readonly string[]): Promise<Map<string, DimensionsVisite>> {
  if (ids.length === 0) return new Map();
  const visites = await prisma.medicalVisit.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, delegateId: true, doctor: { select: { wilayaCode: true, companyId: true } } },
  });
  const delegues = [...new Set(visites.map((v) => v.delegateId).filter((d): d is string => !!d))];
  const profils = await prisma.salesRepProfile.findMany({
    where: { repId: { in: delegues } },
    select: { repId: true, businessUnit: { select: { id: true, companyId: true } } },
  });
  const buDe = new Map(profils.map((p) => [p.repId, p.businessUnit]));
  return new Map(visites.map((v) => [v.id, dimensionsDeVisite({ doctor: v.doctor, buDuDelegue: (v.delegateId && buDe.get(v.delegateId)) || null })]));
}

/** L9 — la table des directions régionales PCH : code → wilayas couvertes (telle que renseignée). */
export async function wilayasParDr(): Promise<Map<string, string[]>> {
  const drs = await prisma.pchDirectionRegionale.findMany({ select: { code: true, wilayas: true } });
  return new Map(drs.map((d) => [d.code.trim().toUpperCase(), d.wilayas]));
}

/** La société d'une BU (pour rattacher un signal de périmètre « BU » à sa société). */
export async function societeDeLaBu(buId: string | null): Promise<string | null> {
  if (!buId) return null;
  return (await prisma.businessUnit.findUnique({ where: { id: buId }, select: { companyId: true } }))?.companyId ?? null;
}

/** La société d'un produit. */
export async function societeDuProduit(productId: string): Promise<string | null> {
  return (await prisma.product.findUnique({ where: { id: productId }, select: { companyId: true } }))?.companyId ?? null;
}
