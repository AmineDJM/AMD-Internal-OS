import type { Prisma } from "@prisma/client";
import { resolveManager, type DepartmentNodeLite, type EmployeeNode } from "./reporting-line";

/**
 * ═════════════════════════════════════════════════════════════════
 * LA FILE DES CONGÉS DU N+1 — ce que la file MONTRE, l'action l'ACCEPTE (§118.196, lot E1 — audit 360°, M08).
 *
 * La file de « Mon espace » ne regardait que le N+1 ENREGISTRÉ à la soumission, et elle lisait les
 * 200 premiers congés en attente de TOUTE la base avant de filtrer. Deux trous : un salarié muté
 * d'une équipe à l'autre envoyait sa demande chez son ancien responsable, que l'action accepte
 * encore, mais le NOUVEAU — que l'action accepte aussi — ne la voyait nulle part ; et dans une base
 * chargée, la demande d'un responsable pouvait tomber hors des 200 avant même qu'on la juge.
 *
 * La file réunit donc le N+1 enregistré ET le N+1 ACTUEL (l'organigramme d'aujourd'hui, la même
 * cascade que partout : `resolveManager`), et le filtre part dans la requête. Le PREMIER rang
 * seulement : l'action laisse aussi trancher toute la chaîne au-dessus (`leaveDecider`), mais
 * montrer chaque congé à chaque échelon noierait les directions sous des demandes qui ne les
 * attendent pas — le N+2 garde le geste, depuis la fiche, sans que la file le sollicite.
 *
 * Module sans base : la requête et la règle de lecture se testent sans rien semer.
 * ═════════════════════════════════════════════════════════════════
 */

/** Les fiches salarié de ceux au nom de qui je signe (moi, et l'absent que je remplace). */
export function fichesDesSignataires(signataires: ReadonlySet<string>, employees: readonly EmployeeNode[]): string[] {
  return employees.filter((e) => e.userId !== null && signataires.has(e.userId)).map((e) => e.id);
}

/** Les salariés ACTIFS dont le N+1 d'aujourd'hui est l'un de ceux au nom de qui je signe. */
export function salariesDontJeSuisLeN1(
  signataires: ReadonlySet<string>,
  employees: readonly EmployeeNode[],
  departments: readonly DepartmentNodeLite[],
): string[] {
  const out: string[] = [];
  for (const e of employees) {
    if (!e.isActive) continue;
    const n1 = resolveManager(e.id, employees, departments);
    if (n1?.userId && signataires.has(n1.userId)) out.push(e.id);
  }
  return out;
}

/**
 * La clause de la file : la direction voit tout ce qui attend (elle tranche à toute marche) ; les
 * RH, la marche RH ; le responsable, la marche du N+1 pour ses salariés — enregistrés ou actuels.
 * `null` quand rien ne peut attendre cette personne : on ne lance pas une requête pour rien.
 */
export function clauseFileConges(a: {
  isDg: boolean;
  isHr: boolean;
  fichesSignataires: readonly string[];
  salariesRattaches: readonly string[];
  /** Les comptes au nom de qui je signe — une marche REMONTÉE jusqu'à moi m'attend, à toute profondeur (Direction, 06/10). */
  signataires?: readonly string[];
}): Prisma.LeaveRequestWhereInput | null {
  const base: Prisma.LeaveRequestWhereInput = { status: "PENDING", stage: { not: "DONE" } };
  if (a.isDg) return base;
  const ou: Prisma.LeaveRequestWhereInput[] = [];
  if (a.isHr) ou.push({ stage: "HR" });
  if (a.fichesSignataires.length > 0) ou.push({ stage: "MANAGER", managerId: { in: [...a.fichesSignataires] } });
  if (a.salariesRattaches.length > 0) ou.push({ stage: "MANAGER", employeeId: { in: [...a.salariesRattaches] } });
  if (a.signataires && a.signataires.length > 0) ou.push({ stage: "MANAGER", currentApproverId: { in: [...a.signataires] } });
  if (a.signataires && a.signataires.length > 0) ou.push({ stage: "MANAGER", currentApproverId: { in: [...a.signataires] } });
  return ou.length === 0 ? null : { AND: [base, { OR: ou }] };
}
