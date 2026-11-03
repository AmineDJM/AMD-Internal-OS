import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { regulatoryLockWhere, userCan, type SessionUser } from "@/lib/rbac";
import { clauseCommercialises, clauseProduitAuCatalogue } from "@/lib/queries/produits-360";
import { etapeCycle } from "@/lib/products/fiche-360";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VUE `produits` DE LA PRIMITIVE `lire` — les lignes, sous LA portée de l'écran Produits 360 (lot I3, décision 0065).
 *
 * Portée : `clauseProduitAuCatalogue` (un dossier non verrouillé, ou Super Admin) — la clause de l'écran, pas une copie.
 * Les dossiers lus sont ceux que la personne voit (`regulatoryLockWhere`). Deux champs CALCULÉS par les règles de l'ERP,
 * jamais par le modèle : `commercialise` = la clause de l'onglet « Commercialisés » (`clauseCommercialises`, réutilisée,
 * AU2 §3.4 point 1) et `etape` = `etapeCycle` (la frise, règle de la Direction du 06/10). L'AIRE THÉRAPEUTIQUE se lit sur
 * les dossiers (`therapeuticSegments`, `therapeuticClass`) — jamais sur le nom de la BU, qui est un faux ami (la BU
 * « Infectiologie / Hématologie » porte un anticoagulant).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LigneProduit {
  id: string; nom: string; code: string; dci: string; forme: string | null; societe: string | null;
  etape: string; commercialise: boolean; aires: string[]; classes: string[]; marques: string[]; dossiers: string[];
  statutsDossiers: string[]; bu: string[]; actif: boolean; lien: string;
}

/** LA PORTÉE de l'écran Produits 360 : le module ouvert, puis la clause du catalogue. `null` : la vue est fermée. */
export function porteeProduits(user: SessionUser): Prisma.ProductWhereInput | null {
  return userCan(user, "PRODUCTS", "VIEW") ? clauseProduitAuCatalogue(user) : null;
}

export async function lignesProduits(user: SessionUser, portee: Prisma.ProductWhereInput, limite = 2_000): Promise<LigneProduit[]> {
  const lock = regulatoryLockWhere(user);
  const [produits, commercialises] = await Promise.all([
    prisma.product.findMany({
      where: portee,
      orderBy: [{ isActive: "desc" }, { canonicalName: "asc" }],
      take: limite,
      select: {
        id: true, code: true, canonicalName: true, dci: true, form: true, lifecycle: true, isActive: true,
        company: { select: { shortName: true, name: true } },
        promoProfiles: { select: { businessUnit: { select: { name: true } } } },
        regulatoryProfiles: { where: lock, select: { status: true, reference: true, brandName: true, therapeuticSegments: true, therapeuticClass: true } },
      },
    }),
    prisma.product.findMany({ where: { AND: [portee, clauseCommercialises(user)] }, select: { id: true }, take: limite }),
  ]);
  const vendus = new Set(commercialises.map((p) => p.id));
  const uniques = (xs: (string | null | undefined)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))];
  return produits.map((p) => ({
    id: p.id, nom: p.canonicalName, code: p.code, dci: p.dci, forme: p.form, societe: p.company?.shortName ?? p.company?.name ?? null,
    etape: etapeCycle({ lifecycle: p.lifecycle, isActive: p.isActive, statutsDossiers: p.regulatoryProfiles.map((r) => r.status) }),
    commercialise: vendus.has(p.id),
    aires: uniques(p.regulatoryProfiles.flatMap((r) => r.therapeuticSegments)),
    classes: uniques(p.regulatoryProfiles.map((r) => r.therapeuticClass)),
    marques: uniques(p.regulatoryProfiles.map((r) => r.brandName)),
    dossiers: uniques(p.regulatoryProfiles.map((r) => r.reference)),
    statutsDossiers: uniques(p.regulatoryProfiles.map((r) => r.status)),
    bu: uniques(p.promoProfiles.map((x) => x.businessUnit?.name)),
    actif: p.isActive,
    lien: `/produits/${p.id}`,
  }));
}
