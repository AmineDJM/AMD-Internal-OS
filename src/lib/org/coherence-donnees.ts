import { prisma } from "@/lib/prisma";
import { controlerCoherence, superviseurPropose, kamsHorsLigne, type Coherence } from "./coherence";
import type { DepartmentNodeLite, EmployeeNode } from "@/modules/rh/partage";

/**
 * LES TABLES DU CONTRÔLE DE COHÉRENCE — chargées une fois, passées au module pur (`coherence.ts`). Lecture seule.
 */

export interface DonneesOrganigramme {
  departements: (DepartmentNodeLite & { name: string; companyId: string | null })[];
  employes: (EmployeeNode & { department: string | null })[];
  comptes: { id: string; name: string; departmentId: string | null; isActive: boolean }[];
  bus: { id: string; name: string; departmentId: string | null; supervisorId: string | null; kamUserIds: string[]; isActive: boolean }[];
}

export async function chargerOrganigramme(): Promise<DonneesOrganigramme> {
  const [departements, employes, comptes, bus, profils] = await Promise.all([
    prisma.department.findMany({ select: { id: true, name: true, parentId: true, headId: true, deputyId: true, companyId: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ select: { id: true, fullName: true, userId: true, managerId: true, departmentId: true, isActive: true, department: true }, orderBy: { fullName: "asc" } }),
    prisma.user.findMany({ select: { id: true, name: true, departmentId: true, isActive: true } }),
    prisma.businessUnit.findMany({ select: { id: true, name: true, departmentId: true, supervisorId: true, isActive: true }, orderBy: { name: "asc" } }),
    prisma.salesRepProfile.findMany({ where: { businessUnitId: { not: null }, isActive: true }, select: { repId: true, businessUnitId: true } }),
  ]);
  return {
    departements,
    employes,
    comptes,
    bus: bus.map((b) => ({ ...b, kamUserIds: profils.filter((p) => p.businessUnitId === b.id).map((p) => p.repId) })),
  };
}

export async function chargerCoherence(): Promise<{ coherence: Coherence; donnees: DonneesOrganigramme }> {
  const donnees = await chargerOrganigramme();
  return { coherence: controlerCoherence(donnees), donnees };
}

/** Ce que l'organigramme dit de chaque BU : le superviseur proposé et les KAM hors de sa ligne hiérarchique. */
export function lectureBuParOrganigramme(d: DonneesOrganigramme): Record<string, { propose: string | null; horsLigne: string[] }> {
  const nom = new Map(d.employes.filter((e) => e.userId).map((e) => [e.userId as string, e.fullName]));
  const out: Record<string, { propose: string | null; horsLigne: string[] }> = {};
  for (const bu of d.bus) {
    out[bu.id] = {
      propose: superviseurPropose(bu, d.departements, d.employes),
      horsLigne: bu.supervisorId ? kamsHorsLigne(bu.supervisorId, bu.kamUserIds, d.employes, d.departements).map((id) => nom.get(id) ?? id) : [],
    };
  }
  return out;
}
