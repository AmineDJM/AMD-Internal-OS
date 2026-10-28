/**
 * PRISE EN CHARGE — les DEVIS : les cases d'une catégorie, le chiffrage (devise, conversion au taux figé), les devis
 * rivaux et retenus, le conflit de couverture (une case n'est jamais couverte par deux devis acceptés), la réserve
 * d'un devis qu'on accepte, son rattachement à l'ordre ou son refus, et la demande de BC.
 *
 * Sorti de `actions/care-actions.ts` (lot V4). L'émission de l'ordre (`createExpenseOrder`), les gardes et le
 * journal restent dans les actions.
 */
import type { CareQuoteStatus, CareServiceKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { quoteConflicts } from "@/lib/care";
import { casesDeLaCategorie, deviseDuDevis, montantLisible, versDzd, TAUX_USD_DZD_DEFAUT } from "@/lib/care-fiches";
import { sansBloquer } from "@/lib/journal";
import { SPEC, parentWhere, tauxDe, type Scope } from "./demande";
import { CELL_FICHE_SELECT, fichesDeLaDemande, versCellRow } from "./fiches";

/** EN MODE « DE GROUPE », un devis couvre une CATÉGORIE pour tout le monde : les cases se déduisent. */
export async function casesDeLaCategorieDemandee(scope: Scope, requestId: string, categorie: CareServiceKind): Promise<string[]> {
  const personnes = await prisma.careBeneficiary.findMany({
    where: parentWhere(scope, requestId),
    select: { status: true, cells: { where: { kind: "SERVICE", serviceKind: categorie }, select: CELL_FICHE_SELECT } },
  });
  return casesDeLaCategorie(personnes.map((p) => ({ status: p.status, cells: p.cells.map(versCellRow) })), categorie);
}

/**
 * LE CHIFFRAGE D'UN DEVIS : la devise de saisie (celle des postes couverts, sauf si l'appelant la DIT) et le montant en
 * dinars. Un montant DIT en dollars se convertit au taux figé de la demande — 240 au national, qui n'en porte pas.
 */
export function chiffrerLeDevis(
  scope: Scope, req: { usdDzdRate: unknown } | null, deviseBrute: string | null, saisi: boolean,
  couvertes: { serviceKind: CareServiceKind | null }[], montant: number,
): { ok: true; devise: { ok: true; devise: "DZD" | "USD" }; amountDzd: number | null } | { ok: false; error: string } {
  const deviseDite: "DZD" | "USD" | null = deviseBrute === "DZD" || deviseBrute === "USD" ? deviseBrute : null;
  const devise = deviseDite && saisi
    ? ({ ok: true, devise: deviseDite } as const)
    : saisi ? deviseDuDevis(scope, couvertes.map((c) => c.serviceKind)) : ({ ok: true, devise: "DZD" } as const);
  if (!devise.ok) return { ok: false, error: devise.error };
  // Un montant DIT en dollars se convertit au taux figé de la demande — 240 au national, qui n'en porte pas.
  const taux = tauxDe(scope, req) ?? (deviseDite === "USD" ? TAUX_USD_DZD_DEFAUT : null);
  const amountDzd = versDzd(montant, devise.devise, taux);
  return { ok: true, devise, amountDzd };
}

/** Les autres devis RETENUS qui couvrent les mêmes postes (au plus une proposition retenue par poste). */
export async function devisRivaux(scope: Scope, requestId: string, id: string, cellIds: string[]) {
  return prisma.careQuote.findMany({
    where: { ...parentWhere(scope, requestId), id: { not: id }, status: "PENDING", retainedAt: { not: null }, cells: { some: { cellId: { in: cellIds } } } },
    select: { id: true, supplier: true, bcRequestedAt: true },
  });
}

/** Ce devis retenu, à la place de ses rivaux (dont le BC n'est pas demandé) — ensemble. */
export async function retenirALaPlace(id: string, rivaux: { id: string }[], retainedById: string): Promise<void> {
  await prisma.$transaction([
    prisma.careQuote.updateMany({ where: { id: { in: rivaux.map((r) => r.id) }, bcRequestedAt: null }, data: { retainedAt: null, retainedById: null } }),
    prisma.careQuote.update({ where: { id }, data: { retainedAt: new Date(), retainedById } }),
  ]);
}

/** Le devis à trancher, et les cases qu'il couvre. */
export async function devisATrancher(id: string) {
  return prisma.careQuote.findUnique({
    where: { id },
    select: {
      id: true, supplier: true, amountDzd: true, status: true, expenseOrderId: true, amount: true, currency: true, retainedAt: true,
      decidedById: true, decidedAt: true,
      congressNationalId: true, congressInternationalId: true,
      cells: { select: { cellId: true } },
    },
  });
}

/** ⚠️ Une case déjà couverte par un devis accepté ne l'est pas une seconde fois. `null` = aucun conflit. */
export async function conflitDeCouverture(
  scope: Scope, requestId: string, id: string, amountDzd: unknown, cellIds: string[],
): Promise<string | null> {
  const others = await prisma.careQuote.findMany({
    where: { ...parentWhere(scope, requestId), id: { not: id } },
    select: { id: true, status: true, amountDzd: true, cells: { select: { cellId: true } } },
  });
  const conflicts = quoteConflicts(
    { id, status: "PENDING", amountDzd: toNumber(amountDzd), cellIds },
    others.map((o) => ({ id: o.id, status: o.status, amountDzd: toNumber(o.amountDzd), cellIds: o.cells.map((c) => c.cellId) })),
  );
  if (conflicts.length > 0) {
    const labels = await prisma.careCell.findMany({ where: { id: { in: conflicts.map((c) => c.cellId) } }, select: { label: true } });
    return `Déjà couvert par un devis accepté : ${labels.map((l) => l.label).join(", ")}. Refusez d'abord l'autre devis.`;
  }
  return null;
}

/** Ce qu'on a lu du devis avant de le réserver. */
interface DevisLu { id: string; status: CareQuoteStatus; decidedAt: Date | null; decidedById: string | null }

/** LE DEVIS SE RÉSERVE d'abord, sur l'état lu (§118.151) : seul le gagnant émet l'ordre. `false` = un autre est passé. */
export async function reserverLeDevis(quote: DevisLu, decidedById: string): Promise<boolean> {
  const reserve = await prisma.careQuote.updateMany({
    where: { id: quote.id, expenseOrderId: null, status: quote.status, decidedAt: quote.decidedAt },
    data: { status: "ACCEPTED", decidedById, decidedAt: new Date() },
  });
  return reserve.count > 0;
}

/** Un échec de l'émission rend la réserve : le devis retrouve l'état lu. */
export function rendreLaReserveDuDevis(quote: DevisLu) {
  return prisma.careQuote.updateMany({
    where: { id: quote.id, expenseOrderId: null, status: "ACCEPTED" },
    data: { status: quote.status, decidedById: quote.decidedById, decidedAt: quote.decidedAt },
  }).catch(sansBloquer("care-actions.rendreLaReserve.careQuote"));
}

/** L'ordre né, rattaché au devis ; les cases couvertes deviennent réglées et portent leur part de la dépense. */
export async function rattacherLOrdre(id: string, cellIds: string[], orderId: string, decidedById: string): Promise<void> {
  await prisma.$transaction([
    prisma.careQuote.update({
      where: { id },
      data: { status: "ACCEPTED", decidedById, decidedAt: new Date(), expenseOrderId: orderId },
    }),
    // Les cases couvertes deviennent réglées et portent leur part de la dépense.
    prisma.careCell.updateMany({
      where: { id: { in: cellIds } },
      data: { status: "SETTLED", quoteId: id, expenseOrderId: orderId },
    }),
  ]);
}

/** Le devis refusé ; ses cases redeviennent « demandées » : il faut un autre devis. */
export async function refuserLeDevis(id: string, cellIds: string[], decidedById: string, note: string | null): Promise<void> {
  await prisma.$transaction([
    prisma.careQuote.update({ where: { id }, data: { status: "REJECTED", decidedById, decidedAt: new Date(), note } }),
    // Les cases redeviennent « demandées » : il faut un autre devis.
    prisma.careCell.updateMany({ where: { id: { in: cellIds }, status: "PROVIDED" }, data: { status: "REQUESTED" } }),
  ]);
}

/** Les devis RETENUS en attente de BC (`voulus` restreint à ceux d'une fiche). */
export async function devisRetenus(scope: Scope, requestId: string, voulus: string[]) {
  return prisma.careQuote.findMany({
    where: { ...parentWhere(scope, requestId), status: "PENDING", retainedAt: { not: null }, bcRequestedAt: null, ...(voulus.length ? { id: { in: voulus } } : {}) },
    select: { id: true, supplier: true, reference: true, amount: true, currency: true, amountDzd: true, cells: { select: { cellId: true, cell: { select: { label: true, beneficiaryId: true } } } } },
    orderBy: { createdAt: "asc" },
  });
}

/** LA DEMANDE DE BC écrite à l'assistante : chaque devis retenu, ce qu'il couvre et pour qui, et le total. */
export async function demandeDeBc(
  scope: Scope, requestId: string, retenus: Awaited<ReturnType<typeof devisRetenus>>, note: string | null,
): Promise<{ total: number; corps: string }> {
  const fiches = await fichesDeLaDemande(scope, requestId);
  const nomDe = new Map(fiches.map((f) => [f.id, f.nom]));
  const liste = retenus.map((q) => {
    const qui = [...new Set(q.cells.map((c) => nomDe.get(c.cell.beneficiaryId) ?? "?"))];
    const montant = q.amount != null && q.currency === "USD"
      ? `${montantLisible(toNumber(q.amount), "USD")} = ${montantLisible(toNumber(q.amountDzd))}`
      : montantLisible(toNumber(q.amountDzd));
    return `• ${q.supplier}${q.reference ? ` (${q.reference})` : ""} — ${montant} — ${[...new Set(q.cells.map((c) => c.cell.label))].join(", ")} — ${qui.join(", ")}`;
  });
  const total = retenus.reduce((s, q) => s + toNumber(q.amountDzd), 0);
  const corps = [
    `Devis retenus (${retenus.length}) — total ${montantLisible(Math.round(total * 100) / 100)} :`,
    ...liste,
    ...(note ? [`Note : ${note}`] : []),
    `Fiche de la demande : ${SPEC[scope].path}/${requestId}`,
  ].join("\n");
  return { total, corps };
}

/** Chaque devis retenu est marqué « BC demandé » : son choix ne change plus. */
export async function marquerBcDemande(retenus: { id: string }[], bcRequestedById: string): Promise<{ count: number }> {
  return prisma.careQuote.updateMany({
    where: { id: { in: retenus.map((q) => q.id) }, status: "PENDING", bcRequestedAt: null },
    data: { bcRequestedAt: new Date(), bcRequestedById },
  });
}
