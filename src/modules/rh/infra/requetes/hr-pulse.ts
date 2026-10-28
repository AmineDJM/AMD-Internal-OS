import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import { toNumber } from "@/lib/utils";

/**
 * LE POULS RH — les questions qu'on se pose vraiment tous les matins, et auxquelles le module
 * ne répondait pas : **qui est absent aujourd'hui ?**, **qui revient bientôt ?**, **quelle
 * période d'essai se termine ?**
 *
 * Le module savait déjà lister les demandes à traiter et l'effectif. Il ne savait pas dire
 * l'état de l'équipe *maintenant* — c'est pourtant ce qu'on demande à un service RH quand on
 * cherche quelqu'un, qu'on planifie une réunion ou qu'on répartit une charge.
 *
 * Tout est borné à l'entité sélectionnée (`companyScopedWhere`) comme le reste du module.
 */

export interface AbsenceRow {
  employeeId: string;
  employee: string;
  position: string | null;
  department: string | null;
  type: string;
  startDate: string;
  endDate: string;
  /** Jours restants avant le retour (0 = revient demain). */
  daysLeft: number;
}

export interface UpcomingAbsence {
  employeeId: string;
  employee: string;
  type: string;
  startDate: string;
  endDate: string;
  /** Jours avant le départ. */
  inDays: number;
}

export interface DeadlineRow {
  employeeId: string;
  employee: string;
  kind: "TRIAL" | "CONTRACT";
  date: string;
  inDays: number;
}

export interface HrPulse {
  /** Absents AUJOURD'HUI (congé approuvé couvrant la date du jour). */
  absentToday: AbsenceRow[];
  /** Départs en congé dans les 14 prochains jours. */
  upcoming: UpcomingAbsence[];
  /** Périodes d'essai et contrats qui arrivent à terme (≤ 60 jours). */
  deadlines: DeadlineRow[];
  /** Effectif actif par département, du plus fourni au moins fourni. */
  headcount: { label: string; count: number }[];
  /** Soldes de congés : total restant, et qui en a le plus (risque de report). */
  leaveBalance: { totalDays: number; heaviest: { employee: string; days: number }[] };
  /** Effectif actif au moment du calcul (base des pourcentages). */
  activeCount: number;
}

const DAY = 86_400_000;
const days = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY);

/** Minuit (heure locale) — pour comparer des jours, pas des instants. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function getHrPulse(userId: string): Promise<HrPulse> {
  const today = startOfToday();
  const in14 = new Date(today.getTime() + 14 * DAY);
  const in60 = new Date(today.getTime() + 60 * DAY);

  const [onLeave, upcomingLeaves, employees] = await Promise.all([
    // Absents aujourd'hui : congé APPROUVÉ dont la période couvre le jour même.
    prisma.leaveRequest.findMany({
      where: { status: "APPROVED", startDate: { lte: today }, endDate: { gte: today } },
      include: { employee: { select: { id: true, fullName: true, position: true, department: true, companyId: true } } },
      orderBy: { endDate: "asc" },
    }),
    prisma.leaveRequest.findMany({
      where: { status: "APPROVED", startDate: { gt: today, lte: in14 } },
      include: { employee: { select: { id: true, fullName: true, companyId: true } } },
      orderBy: { startDate: "asc" },
    }),
    prisma.employee.findMany({
      where: await companyScopedWhere(userId, { isActive: true }),
      select: {
        id: true, fullName: true, department: true,
        leaveBalanceDays: true, trialEnd: true, trialRenewalEnd: true, contractEnd: true,
      },
      orderBy: { fullName: "asc" },
    }),
  ]);

  // Les congés ne portent pas d'entité : on les rattache via l'employé, qui, lui, en a une.
  const scoped = new Set(employees.map((e) => e.id));

  const absentToday: AbsenceRow[] = onLeave
    .filter((l) => scoped.has(l.employee.id))
    .map((l) => ({
      employeeId: l.employee.id,
      employee: l.employee.fullName,
      position: l.employee.position,
      department: l.employee.department,
      type: l.type,
      startDate: l.startDate.toISOString(),
      endDate: l.endDate.toISOString(),
      daysLeft: Math.max(0, days(today, l.endDate)),
    }));

  const upcoming: UpcomingAbsence[] = upcomingLeaves
    .filter((l) => scoped.has(l.employee.id))
    .map((l) => ({
      employeeId: l.employee.id,
      employee: l.employee.fullName,
      type: l.type,
      startDate: l.startDate.toISOString(),
      endDate: l.endDate.toISOString(),
      inDays: Math.max(0, days(today, l.startDate)),
    }));

  // Échéances : fin de période d'essai (la RENOUVELÉE prime) et fin de contrat.
  const deadlines: DeadlineRow[] = [];
  for (const e of employees) {
    const trial = e.trialRenewalEnd ?? e.trialEnd;
    if (trial && trial >= today && trial <= in60) {
      deadlines.push({ employeeId: e.id, employee: e.fullName, kind: "TRIAL", date: trial.toISOString(), inDays: days(today, trial) });
    }
    if (e.contractEnd && e.contractEnd >= today && e.contractEnd <= in60) {
      deadlines.push({ employeeId: e.id, employee: e.fullName, kind: "CONTRACT", date: e.contractEnd.toISOString(), inDays: days(today, e.contractEnd) });
    }
  }
  deadlines.sort((a, b) => a.inDays - b.inDays);

  const byDept = new Map<string, number>();
  for (const e of employees) {
    const key = e.department?.trim() || "Non affecté";
    byDept.set(key, (byDept.get(key) ?? 0) + 1);
  }

  const balances = employees
    .map((e) => ({ employee: e.fullName, days: toNumber(e.leaveBalanceDays) }))
    .sort((a, b) => b.days - a.days);

  return {
    absentToday,
    upcoming,
    deadlines,
    headcount: [...byDept.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    leaveBalance: {
      totalDays: balances.reduce((s, b) => s + b.days, 0),
      heaviest: balances.filter((b) => b.days > 0).slice(0, 5),
    },
    activeCount: employees.length,
  };
}
