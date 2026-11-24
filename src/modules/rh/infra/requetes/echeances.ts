import { prisma } from "@/lib/prisma";
import { resolveManager } from "../../domaine/reporting-line";
import { aujourdhuiAlger, minuitUtc } from "../../domaine/absences";
import { echeancesDeLaFiche } from "../../domaine/echeances";

/**
 * LES ÉCHÉANCES RH DANS « AUJOURD'HUI » (échéances intégrées, 24/11/2026) : fin de contrat, fin de période d'essai,
 * visite médicale du travail — de chaque fiche ACTIVE. Responsables : qui peut modifier le module RH, et le N+1 réel
 * du salarié (la cascade des congés : manager explicite, puis responsable du département, puis du parent).
 *
 * La forme rendue est celle d'une `Echeance` (`lib/echeances/regles.ts`) : le registre la branche, le module n'importe
 * rien de la file.
 */
export async function lireEcheancesRh({ maintenant, jusquau }: { maintenant: Date; jusquau: Date }) {
  const fiches = await prisma.employee.findMany({
    where: {
      isActive: true,
      OR: [
        { contractEnd: { lte: jusquau } },
        { trialEnd: { lte: jusquau } },
        { trialRenewalEnd: { lte: jusquau } },
        { prochaineVisiteMedicale: { lte: jusquau } },
      ],
    },
    select: {
      id: true, fullName: true, position: true, companyId: true, contractType: true, contractEnd: true,
      trialEnd: true, trialRenewed: true, trialRenewalEnd: true, prochaineVisiteMedicale: true,
    },
  });
  if (fiches.length === 0) return [];
  const debutDuJour = minuitUtc(aujourdhuiAlger(maintenant));
  // La ligne hiérarchique, lue une fois pour toutes les fiches (mêmes tables que `departments.loadReportingLine`).
  const [employees, departments] = await Promise.all([
    prisma.employee.findMany({ select: { id: true, fullName: true, userId: true, managerId: true, departmentId: true, isActive: true } }),
    prisma.department.findMany({ select: { id: true, parentId: true, headId: true, deputyId: true } }),
  ]);
  return fiches.flatMap((f) => {
    const echeances = echeancesDeLaFiche(f, debutDuJour, jusquau);
    if (echeances.length === 0) return [];
    const n1 = resolveManager(f.id, employees, departments)?.userId ?? null;
    return echeances.map((e) => ({
      source: `rh.${e.genre}`, id: f.id, module: "Ressources humaines",
      libelle: e.libelle, detail: f.position, date: e.date,
      href: `/rh/${f.id}`, liste: "/rh", companyId: f.companyId,
      responsables: n1 ? [n1] : [], droit: { module: "RH", action: "UPDATE" as const },
    }));
  });
}
