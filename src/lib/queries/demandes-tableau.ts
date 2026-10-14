import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { FAITS_VIDES, montantEstimeDesChamps, type FaitsMontant } from "@/lib/secretariat/bureau";
import { etapeBCAttendue, lireDevisNatif, totauxDesLignes } from "@/lib/secretariat/devis-natif";
import { nombreDePieces } from "@/lib/secretariat/pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FAITS D'UNE DEMANDE, LUS EN LOT — pour le tableau du bureau ET pour la fiche.
 *
 * Le montant (`montantDeLaDemande`), le nombre de pièces, le BC qu'on attend, les devis à retenir :
 * chaque fait est lu à SA source — l'accord du N+1, les BC et factures du registre, les ordres de
 * dépense, l'imputation aux moyens généraux, le dossier de matériel promotionnel, les devis natifs.
 * Huit requêtes pour tout le tableau, jamais une par ligne (§118.102b).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FaitsDeDemande {
  faits: FaitsMontant;
  nbPieces: number;
  /** L'étape du BC en route qu'on attend (`etapeBCAttendue`) — `null` : aucun. */
  bc: ReturnType<typeof etapeBCAttendue>;
  /** Des devis sont retranscrits et aucune ligne n'est encore retenue, ni aucun BC émis. */
  devisARetenir: boolean;
}

const somme = (vals: (number | null | undefined)[]): number | null => {
  const v = vals.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0);
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
};

export async function faitsDesDemandes(demandes: readonly { id: string; fields: unknown }[]): Promise<Map<string, FaitsDeDemande>> {
  const res = new Map<string, FaitsDeDemande>();
  const ids = demandes.map((d) => d.id);
  if (ids.length === 0) return res;
  const [pieces, devis, ordres, imputations, accords, fichiers, promos] = await Promise.all([
    prisma.legalDocument.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: { in: ids } }, select: { id: true, sourceId: true, kind: true, status: true, amount: true } }),
    prisma.legalDocument.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: { in: ids }, kind: "QUOTE", status: { not: "CANCELLED" } }, select: { sourceId: true, custom: true } }),
    prisma.expenseOrder.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: { in: ids }, status: { not: "CANCELLED" } }, select: { sourceId: true, status: true, amount: true } }),
    prisma.departmentBudgetExpense.findMany({ where: { adminRequestId: { in: ids } }, select: { adminRequestId: true, amount: true } }),
    prisma.adminApproval.findMany({ where: { requestId: { in: ids }, status: "APPROVED", amount: { not: null } }, select: { requestId: true, amount: true, decidedAt: true }, orderBy: { decidedAt: "desc" } }),
    prisma.document.groupBy({ by: ["entityId"], where: { entityType: "ADMIN_REQUEST", entityId: { in: ids } }, _count: { _all: true } }),
    prisma.promoMaterial.findMany({ where: { adminRequestId: { in: ids } }, select: { adminRequestId: true, chosenAmount: true, amount: true } }),
  ]);
  const bcsVivants = pieces.filter((p) => p.kind === "PURCHASE_ORDER" && p.status !== "CANCELLED");
  const etats = await etatsDesBC(bcsVivants.map((b) => b.id));

  for (const d of demandes) {
    const siennes = pieces.filter((p) => p.sourceId === d.id);
    const vivantes = siennes.filter((p) => p.status !== "CANCELLED");
    const sesDevis = devis.filter((q) => q.sourceId === d.id).map((q) => lireDevisNatif(q.custom)).filter((x) => x !== null);
    const retenues = sesDevis.flatMap((n) => n!.lignes.filter((l) => l.retenue));
    const promo = promos.find((p) => p.adminRequestId === d.id);
    const promoMontant = promo ? (promo.chosenAmount != null ? toNumber(promo.chosenAmount) : promo.amount != null ? toNumber(promo.amount) : null) : null;
    const sesOrdres = ordres.filter((o) => o.sourceId === d.id);
    const accord = accords.find((a) => a.requestId === d.id);
    const faits: FaitsMontant = {
      ...FAITS_VIDES,
      estime: montantEstimeDesChamps(d.fields),
      devisRetenu: retenues.length ? totauxDesLignes(retenues).ttc : promoMontant,
      valide: accord?.amount != null ? toNumber(accord.amount) : null,
      engage: somme(vivantes.filter((p) => p.kind === "PURCHASE_ORDER").map((p) => (p.amount != null ? toNumber(p.amount) : null))),
      facture: somme(vivantes.filter((p) => p.kind === "INVOICE").map((p) => (p.amount != null ? toNumber(p.amount) : null))),
      paye: somme(sesOrdres.filter((o) => o.status === "PAID").map((o) => toNumber(o.amount))),
      enAttentePaiement: somme(sesOrdres.filter((o) => o.status !== "PAID").map((o) => toNumber(o.amount))),
      impute: somme(imputations.filter((i) => i.adminRequestId === d.id).map((i) => toNumber(i.amount))),
    };
    const sesBC = bcsVivants.filter((b) => b.sourceId === d.id).map((b) => etats.get(b.id)).filter((e) => e !== undefined);
    res.set(d.id, {
      faits,
      nbPieces: nombreDePieces({ registre: siennes.length, fichiers: fichiers.find((f) => f.entityId === d.id)?._count._all ?? 0 }),
      bc: etapeBCAttendue(sesBC.map((e) => ({ etape: e!.etape, annule: e!.annule }))),
      devisARetenir: sesDevis.some((n) => n!.lignes.length > 0) && retenues.length === 0 && siennes.every((p) => p.kind !== "PURCHASE_ORDER"),
    });
  }
  return res;
}
