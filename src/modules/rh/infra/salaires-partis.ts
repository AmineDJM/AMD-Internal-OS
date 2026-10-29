import { prisma } from "@/lib/prisma";
import { etatVirement, etatSalaire, virementCouvre, saisiAvantLeCentre } from "@/modules/finances/partage";
import { instantDuCentreDePaie } from "@/modules/finances/api";
import type { SalaireParti } from "../domaine/rattachement-paie";

/**
 * CE QUI EST DÉJÀ PARTI d'une paie, salarié par salarié — lu sur chaque salaire payé, par la MÊME
 * règle que l'écran et l'envoi. Une seule lecture pour « rattacher à une entité » et pour changer
 * l'entité d'une fiche : deux copies finiraient par ne pas voir les mêmes salaires partis (§118.5).
 * Module serveur ordinaire : il LIT seulement, et reçoit des identifiants que l'appelant a déjà
 * autorisés.
 */
export async function chargerSalairesPartis(ids: string[]): Promise<{
  partisParSalarie: Map<string, SalaireParti[]>;
  saisisParSalarie: Map<string, number>;
}> {
  const depuisLeCentre = await instantDuCentreDePaie();
  const lignes = await prisma.payrollEntry.findMany({
    where: { employeeId: { in: ids }, status: "PAID" },
    select: {
      employeeId: true, year: true, month: true, status: true, transactionId: true, budgetTransferredAt: true,
      paidDate: true, createdAt: true,
      payrollWire: { select: { companyId: true, paidAt: true, expenseOrder: { select: { reference: true, status: true, centralStatus: true } } } },
    },
  });
  const idsEcritures = lignes.map((l) => l.transactionId).filter((v): v is string => Boolean(v));
  const ecritures = idsEcritures.length
    ? await prisma.financeTransaction.findMany({ where: { id: { in: idsEcritures } }, select: { id: true, companyId: true, reference: true } })
    : [];
  const ecritureParId = new Map(ecritures.map((e) => [e.id, e]));
  const partisParSalarie = new Map<string, SalaireParti[]>();
  const saisisParSalarie = new Map<string, number>();
  for (const l of lignes) {
    const virement = l.payrollWire ? etatVirement({ paidAt: l.payrollWire.paidAt, ordre: l.payrollWire.expenseOrder }) : null;
    const etat = etatSalaire({
      status: l.status, transactionId: l.transactionId, budgetTransferredAt: l.budgetTransferredAt,
      virement, avantLeCentre: saisiAvantLeCentre(l, depuisLeCentre),
    });
    if (etat === "SAISI") { saisisParSalarie.set(l.employeeId, (saisisParSalarie.get(l.employeeId) ?? 0) + 1); continue; }
    if (etat !== "ENVOYE" && etat !== "VIRE") continue;
    let parti: SalaireParti;
    if (l.payrollWire && virement && virementCouvre(virement)) {
      parti = { year: l.year, month: l.month, companyId: l.payrollWire.companyId, reference: l.payrollWire.expenseOrder?.reference ?? null };
    } else if (l.transactionId) {
      const e = ecritureParId.get(l.transactionId);
      parti = { year: l.year, month: l.month, companyId: e?.companyId ?? null, reference: e?.reference ?? null };
    } else {
      parti = { year: l.year, month: l.month, companyId: null, reference: null };
    }
    partisParSalarie.set(l.employeeId, [...(partisParSalarie.get(l.employeeId) ?? []), parti]);
  }
  return { partisParSalarie, saisisParSalarie };
}
