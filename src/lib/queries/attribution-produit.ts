import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { attribuer, type Attribution, type PosteDepense } from "@/modules/finances/partage";

/**
 * L'ATTRIBUTION DES COÛTS D'UN PRODUIT pour une année — lue en base (façade : elle traverse Ad&Pro, BU et produits).
 * Les postes ACCORDÉS de l'année : ceux imputés au produit, et ceux de ses BU imputés à aucun produit (répartis
 * par la règle de l'année). Le calcul et ses catégories sont dans `finance/attribution-produit.ts`.
 */

const dansLAnnee = (annee: number): Prisma.AdProItemWhereInput => ({
  OR: [
    { decidedAt: { gte: new Date(Date.UTC(annee, 0, 1)), lt: new Date(Date.UTC(annee + 1, 0, 1)) } },
    { decidedAt: null, createdAt: { gte: new Date(Date.UTC(annee, 0, 1)), lt: new Date(Date.UTC(annee + 1, 0, 1)) } },
  ],
});

export async function attributionProduit(productId: string, annee: number): Promise<Attribution & { businessUnits: { id: string; name: string; pct: number | null; totalReparti: number }[] }> {
  const bus = await prisma.promoProduct.findMany({ where: { productId, businessUnitId: { not: null } }, select: { businessUnit: { select: { id: true, name: true } } } });
  const buIds = [...new Set(bus.map((b) => b.businessUnit!.id))];
  const parBu: Prisma.AdProItemWhereInput[] = buIds.length ? [
    { sponsoring: { businessUnitId: { in: buIds } } }, { congressNational: { businessUnitId: { in: buIds } } },
    { congressInternational: { businessUnitId: { in: buIds } } }, { event: { businessUnitId: { in: buIds } } },
  ] : [];
  const items = await prisma.adProItem.findMany({
    where: {
      status: "APPROVED", amountGranted: { not: null }, AND: [dansLAnnee(annee)],
      OR: [{ productAllocations: { some: { productId } } }, ...(parBu.length ? [{ productAllocations: { none: {} }, OR: parBu }] : [])],
    },
    select: {
      id: true, label: true, amountGranted: true,
      sponsoring: { select: { businessUnitId: true } }, congressNational: { select: { businessUnitId: true } },
      congressInternational: { select: { businessUnitId: true } }, event: { select: { businessUnitId: true } },
      productAllocations: { select: { productId: true, sharePct: true, amountAllocated: true } },
    },
  });
  const postes: PosteDepense[] = items.map((i) => ({
    itemId: i.id, libelle: i.label, montant: Number(i.amountGranted),
    businessUnitId: i.sponsoring?.businessUnitId ?? i.congressNational?.businessUnitId ?? i.congressInternational?.businessUnitId ?? i.event?.businessUnitId ?? null,
    imputations: i.productAllocations.map((a) => ({ productId: a.productId, pct: a.sharePct === null ? null : Number(a.sharePct), montant: a.amountAllocated === null ? null : Number(a.amountAllocated) })),
  }));
  const regles = await prisma.coutRepartitionBu.findMany({ where: { businessUnitId: { in: buIds }, annee }, select: { businessUnitId: true, productId: true, pct: true } });
  const repartition: Record<string, { pct: number; totalReparti: number }> = {};
  for (const id of buIds) {
    const r = regles.filter((x) => x.businessUnitId === id);
    const mien = r.find((x) => x.productId === productId);
    if (mien) repartition[id] = { pct: Number(mien.pct), totalReparti: r.reduce((s, x) => s + Number(x.pct), 0) };
  }
  const a = attribuer(productId, postes, repartition);
  return {
    ...a,
    businessUnits: bus.map((b) => {
      const r = regles.filter((x) => x.businessUnitId === b.businessUnit!.id);
      return { id: b.businessUnit!.id, name: b.businessUnit!.name, pct: repartition[b.businessUnit!.id]?.pct ?? null, totalReparti: r.reduce((s, x) => s + Number(x.pct), 0) };
    }),
  };
}
