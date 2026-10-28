/**
 * PRISE EN CHARGE — la SUITE de la demande : l'état du dossier pour les Finances (personnes, avancement, devis), la
 * fin posée une seule fois, et les postes de groupe (créés, une personne exclue ou réincluse).
 *
 * Sorti de `actions/care-actions.ts` (lot V4). Les gardes, les notifications et le journal restent dans les actions.
 */
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { careProgress, financeReadiness } from "@/lib/care";
import { versDzd, type deviseDuPoste, type PosteLu, type TypePoste } from "@/lib/care-fiches";
import { nameOf, parentWhere, tauxDe, type Scope } from "./demande";

/** LE DOSSIER EST-IL COMPLET ? Les personnes, leur avancement, et les devis — ce que les Finances doivent recevoir. */
export async function etatPourLesFinances(scope: Scope, requestId: string) {
  const beneficiaries = await prisma.careBeneficiary.findMany({
    where: parentWhere(scope, requestId),
    select: {
      status: true, doctorId: true, firstName: true, lastName: true,
      cells: { select: { kind: true, status: true, label: true, amountDzd: true } },
    },
  });
  const quotes = await prisma.careQuote.findMany({
    where: parentWhere(scope, requestId),
    select: { id: true, status: true, amountDzd: true, cells: { select: { cellId: true } } },
  });

  const rows = await Promise.all(
    beneficiaries.map(async (b) => ({
      status: b.status,
      name: await nameOf(b),
      progress: careProgress(b.cells.map((c) => ({ ...c, amountDzd: c.amountDzd != null ? toNumber(c.amountDzd) : null }))),
    })),
  );
  const readiness = financeReadiness(
    rows,
    quotes.map((q) => ({ id: q.id, status: q.status, amountDzd: toNumber(q.amountDzd), cellIds: q.cells.map((c) => c.cellId) })),
  );
  return { rows, readiness };
}

/** « Réalisée », posée sous condition : deux clics simultanés ne posent pas deux fois la même fin. */
export async function poserLaFin(scope: Scope, requestId: string, updatedById: string): Promise<{ count: number }> {
  const data = { requestStatus: "COMPLETED" as const, status: "COMPLETED" as const, updatedById };
  // Écriture CONDITIONNELLE : deux clics simultanés ne posent pas deux fois la même fin.
  return scope === "NATIONAL"
    ? await prisma.congressNational.updateMany({ where: { id: requestId, requestStatus: "APPROVED" }, data })
    : await prisma.congressInternational.updateMany({ where: { id: requestId, requestStatus: "APPROVED" }, data });
}

/** Un poste de groupe créé à la suite des autres, montant par personne converti au taux figé de la demande. */
export async function creerPosteGroupe(
  scope: Scope, requestId: string, req: { usdDzdRate: unknown } | null,
  type: TypePoste, poste: PosteLu, devise: ReturnType<typeof deviseDuPoste>, acteurId: string,
): Promise<{ id: string; label: string }> {
  const last = await prisma.careGroupPoste.findFirst({ where: parentWhere(scope, requestId), orderBy: { position: "desc" }, select: { position: true } });
  return prisma.careGroupPoste.create({
    data: {
      ...parentWhere(scope, requestId),
      serviceKind: type.serviceKind, label: poste.label ?? type.libelle, notes: poste.notes, date: poste.dateStart,
      timeStart: poste.timeStart, address: poste.address,
      unitAmount: poste.amount, currency: devise, unitAmountDzd: versDzd(poste.amount, devise, tauxDe(scope, req)),
      position: (last?.position ?? 0) + 1, createdById: acteurId, updatedById: acteurId,
    },
    select: { id: true, label: true },
  });
}

/** EXCLURE ou réinclure UNE personne d'un poste de groupe, sans toucher aux autres. */
export async function exclureOuReinclure(
  g: { id: string; excludedBeneficiaryIds: string[] }, qui: string, exclure: boolean, updatedById: string,
): Promise<void> {
  const liste = new Set(g.excludedBeneficiaryIds);
  if (exclure) liste.add(qui); else liste.delete(qui);
  await prisma.careGroupPoste.update({ where: { id: g.id }, data: { excludedBeneficiaryIds: [...liste], updatedById } });
}
