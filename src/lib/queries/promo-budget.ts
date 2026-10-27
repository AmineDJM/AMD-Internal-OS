import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { engageDuDossierPromo, type BcDuDossierPromo } from "@/lib/promo-material/budget";

/**
 * LA DÉPENSE D'UN DOSSIER DE MATÉRIEL PROMOTIONNEL, lue en lot (point 21, 27/10) — derrière `promo-material/budget.ts`.
 *
 *   • ses BC : les pièces Legal `PURCHASE_ORDER` du dossier (nées de la fabrique, `sourceType = PROMO_MATERIAL`, ou
 *     désignées par un devis du dossier), vivantes ; signé ⇔ `signedAt` posé ;
 *   • ses ordres FOURNISSEUR : ceux de ses factures (pièces `INVOICE` du dossier ou chaînées à ses BC), le bordereau
 *     et le règlement de l'ancien parcours (`paymentOrderId`, `settlementOrderId`), et tout ordre né du dossier.
 */

export interface DossierPourDepense {
  id: string;
  paymentOrderId: string | null;
  settlementOrderId: string | null;
}

export interface OrdrePromoLu {
  id: string;
  montant: number;
  statut: string;
  budgetCategoryId: string | null;
  transactionId: string | null;
}

export interface DepensePromoLue {
  bcs: BcDuDossierPromo[];
  ordres: OrdrePromoLu[];
  engage: number;
}

export async function depensesDesDossiersPromo(dossiers: readonly DossierPourDepense[]): Promise<Map<string, DepensePromoLue>> {
  const out = new Map<string, DepensePromoLue>();
  if (dossiers.length === 0) return out;
  const ids = dossiers.map((d) => d.id);
  const devis = await prisma.promoQuote.findMany({ where: { promoMaterialId: { in: ids }, purchaseOrderId: { not: null } }, select: { promoMaterialId: true, purchaseOrderId: true } });
  const bcDesDevis = devis.map((d) => d.purchaseOrderId).filter((x): x is string => Boolean(x));
  const bcs = await prisma.legalDocument.findMany({
    where: {
      kind: "PURCHASE_ORDER", status: { not: "CANCELLED" }, cancelledAt: null,
      OR: [{ sourceType: "PROMO_MATERIAL", sourceId: { in: ids } }, ...(bcDesDevis.length ? [{ id: { in: bcDesDevis } }] : [])],
    },
    select: { id: true, sourceType: true, sourceId: true, amount: true, signedAt: true },
  });
  const dossierDuDevisBc = new Map(devis.map((d) => [d.purchaseOrderId as string, d.promoMaterialId]));
  const dossierDuBc = new Map(bcs.map((b) => [b.id, (b.sourceType === "PROMO_MATERIAL" ? b.sourceId : null) ?? dossierDuDevisBc.get(b.id) ?? null]));
  const factures = await prisma.legalDocument.findMany({
    where: {
      kind: "INVOICE", status: { not: "CANCELLED" }, expenseOrderId: { not: null },
      OR: [{ sourceType: "PROMO_MATERIAL", sourceId: { in: ids } }, ...(bcs.length ? [{ chainFromId: { in: bcs.map((b) => b.id) } }] : [])],
    },
    select: { sourceType: true, sourceId: true, chainFromId: true, expenseOrderId: true },
  });
  const dossierDeLOrdre = new Map<string, string>();
  for (const f of factures) {
    const d = (f.sourceType === "PROMO_MATERIAL" ? f.sourceId : null) ?? (f.chainFromId ? dossierDuBc.get(f.chainFromId) : null);
    if (d && f.expenseOrderId) dossierDeLOrdre.set(f.expenseOrderId, d);
  }
  for (const d of dossiers) {
    if (d.paymentOrderId) dossierDeLOrdre.set(d.paymentOrderId, d.id);
    if (d.settlementOrderId) dossierDeLOrdre.set(d.settlementOrderId, d.id);
  }
  const ordres = await prisma.expenseOrder.findMany({
    where: {
      category: "FOURNISSEUR",
      OR: [
        ...(dossierDeLOrdre.size ? [{ id: { in: [...dossierDeLOrdre.keys()] } }] : []),
        { sourceType: "PROMO_MATERIAL" as const, sourceId: { in: ids } },
      ],
    },
    select: { id: true, amount: true, status: true, budgetCategoryId: true, transactionId: true, sourceType: true, sourceId: true },
  });
  for (const d of dossiers) {
    const sesBcs = bcs.filter((b) => dossierDuBc.get(b.id) === d.id)
      .map((b) => ({ montant: b.amount == null ? null : toNumber(b.amount), signe: b.signedAt !== null }));
    const sesOrdres = ordres
      .filter((o) => dossierDeLOrdre.get(o.id) === d.id || (o.sourceType === "PROMO_MATERIAL" && o.sourceId === d.id))
      .map((o) => ({ id: o.id, montant: toNumber(o.amount), statut: o.status, budgetCategoryId: o.budgetCategoryId, transactionId: o.transactionId }));
    out.set(d.id, { bcs: sesBcs, ordres: sesOrdres, engage: engageDuDossierPromo({ bcs: sesBcs, ordres: sesOrdres }) });
  }
  return out;
}

/**
 * LE BUDGET DU DOSSIER DE MATÉRIEL PROMOTIONNEL d'une pièce Legal (facture du dossier, ou chaînée à l'un de ses BC) —
 * pour que l'ordre né de cette pièce, par quelque porte qu'il parte (fiche du dossier ou fiche Legal), porte la
 * catégorie imputée. `null` hors matériel promotionnel, ou tant que la Direction Marketing n'a rien imputé.
 */
export async function budgetPromoDeLaPiece(p: { sourceType: string | null; sourceId: string | null; chainFromId?: string | null }): Promise<string | null> {
  let dossierId = p.sourceType === "PROMO_MATERIAL" ? p.sourceId : null;
  if (!dossierId && p.chainFromId) {
    const bc = await prisma.legalDocument.findUnique({ where: { id: p.chainFromId }, select: { sourceType: true, sourceId: true } });
    dossierId = bc?.sourceType === "PROMO_MATERIAL" ? bc.sourceId : null;
    if (!dossierId) dossierId = (await prisma.promoQuote.findFirst({ where: { purchaseOrderId: p.chainFromId }, select: { promoMaterialId: true } }))?.promoMaterialId ?? null;
  }
  if (!dossierId) return null;
  return (await prisma.promoMaterial.findUnique({ where: { id: dossierId }, select: { budgetCategoryId: true } }))?.budgetCategoryId ?? null;
}
