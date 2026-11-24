import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { clauseCasPvVisibles } from "./acces";
import { STATUTS_PV, estStatutPv, type StatutPv } from "./regles";
import { etatEcheancePv } from "./declaration";
import { lireReglagesPv } from "./reglages";

/**
 * PHARMACOVIGILANCE — les lectures des écrans (Direction, 06/10) : la boîte de Regulatory, « Mes signalements » du KAM,
 * les listes du formulaire. Toute liste passe par `clauseCasPvVisibles` : la même règle que la fiche.
 */

export interface FiltresCasPv {
  statut?: string | null;
  produit?: string | null;
  du?: string | null;
  au?: string | null;
  /** « Mes signalements » : seulement ceux que la personne a signalés. */
  seulementLesMiens?: boolean;
}

export interface LigneCasPv {
  id: string;
  reference: string;
  status: StatutPv;
  productLabel: string;
  institutionName: string;
  occurredOn: Date;
  createdAt: Date;
  severity: string | null;
  reporterId: string;
  reporterName: string;
  /** Le délai de déclaration quand elle reste à faire : son libellé et son ton (rouge le jour J et au-delà). */
  echeance: { libelle: string; ton: "neutral" | "warning" | "danger" } | null;
}

function dateOuNull(s: string | null | undefined, finDeJournee = false): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T${finDeJournee ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function listerCasPv(user: SessionUser, f: FiltresCasPv = {}): Promise<LigneCasPv[]> {
  const et: Prisma.PharmacovigilanceCaseWhereInput[] = [clauseCasPvVisibles(user)];
  if (f.seulementLesMiens) et.push({ reporterId: user.id });
  // « Reçu » compte aussi l'ancienne étape « En analyse » (reprise par la migration du 24/11/2026).
  if (estStatutPv(f.statut)) et.push({ status: f.statut === "RECU" ? { in: ["RECU", "EN_ANALYSE"] } : f.statut });
  const produit = (f.produit ?? "").trim();
  if (produit) et.push({ productLabel: { contains: produit, mode: "insensitive" } });
  const du = dateOuNull(f.du);
  const au = dateOuNull(f.au, true);
  if (du || au) et.push({ occurredOn: { ...(du ? { gte: du } : {}), ...(au ? { lte: au } : {}) } });

  const cas = await prisma.pharmacovigilanceCase.findMany({
    where: { AND: et },
    select: {
      id: true, reference: true, status: true, productLabel: true, institutionName: true, occurredOn: true, createdAt: true, severity: true, reporterId: true,
      dateConnaissance: true, evalGrave: true, declareLe: true,
    },
    orderBy: [{ createdAt: "desc" }],
    take: 500,
  });
  const { delais } = await lireReglagesPv();
  const maintenant = new Date();
  const noms = new Map((await prisma.user.findMany({
    where: { id: { in: [...new Set(cas.map((c) => c.reporterId))] } }, select: { id: true, name: true },
  })).map((u) => [u.id, u.name]));
  return cas.map((c) => {
    const e = etatEcheancePv(c, delais, maintenant);
    return {
      id: c.id, reference: c.reference, status: c.status as StatutPv, productLabel: c.productLabel, institutionName: c.institutionName,
      occurredOn: c.occurredOn, createdAt: c.createdAt, severity: c.severity ?? null, reporterId: c.reporterId,
      reporterName: noms.get(c.reporterId) ?? "—", echeance: e ? { libelle: e.libelle, ton: e.ton } : null,
    };
  });
}

/** Les compteurs par statut, sur tout ce que la personne lit (sans les filtres). */
export async function compteursCasPv(user: SessionUser, seulementLesMiens = false): Promise<Record<(typeof STATUTS_PV)[number], number>> {
  const groupes = await prisma.pharmacovigilanceCase.groupBy({
    by: ["status"],
    where: { AND: [clauseCasPvVisibles(user), ...(seulementLesMiens ? [{ reporterId: user.id }] : [])] },
    _count: { _all: true },
  });
  const r = Object.fromEntries(STATUTS_PV.map((s) => [s, 0])) as Record<(typeof STATUTS_PV)[number], number>;
  for (const g of groupes) {
    const s = g.status === "EN_ANALYSE" ? "RECU" : g.status;
    if (s in r) r[s as (typeof STATUTS_PV)[number]] += g._count._all;
  }
  return r;
}

/** Les produits proposés au KAM : ceux du catalogue des BU actives, les SIENS (affectés) d'abord. */
export async function produitsPourSignalement(userId: string): Promise<{ id: string; nom: string; bu: string | null; mien: boolean }[]> {
  const [produits, affectes] = await Promise.all([
    prisma.promoProduct.findMany({
      where: { isActive: true, OR: [{ businessUnitId: null }, { businessUnit: { isActive: true } }] },
      select: { id: true, name: true, businessUnit: { select: { name: true } } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    prisma.promotionAssignment.findMany({ where: { repId: userId }, select: { productId: true }, distinct: ["productId"] }),
  ]);
  const miens = new Set(affectes.map((a) => a.productId));
  return produits
    .map((p) => ({ id: p.id, nom: p.name, bu: p.businessUnit?.name ?? null, mien: miens.has(p.id) }))
    .sort((a, b) => Number(b.mien) - Number(a.mien) || a.nom.localeCompare(b.nom, "fr"));
}

/** Les établissements de l'annuaire (actifs), pour la recherche du formulaire. */
export async function etablissementsPourSignalement(): Promise<{ id: string; nom: string; lieu: string | null }[]> {
  const rows = await prisma.medicalInstitution.findMany({
    where: { isActive: true },
    select: { id: true, name: true, wilaya: true, city: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({ id: r.id, nom: r.name, lieu: [r.city, r.wilaya].filter(Boolean).join(", ") || null }));
}
