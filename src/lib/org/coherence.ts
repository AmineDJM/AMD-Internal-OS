import { managementChainOf, type DepartmentNodeLite, type EmployeeNode } from "@/modules/rh/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORGANIGRAMME, SEULE SOURCE — LE CONTRÔLE DE COHÉRENCE (Direction, 10/2026, maquette validée).
 *
 * Sociétés → départements (responsable, adjoint) → personnes (poste, N+1) : on le modifie à UN endroit. Tout ce qui
 * redit la même chose ailleurs (le département du compte, le libellé texte de la fiche, le rattachement d'une BU, son
 * superviseur) doit le suivre ; ce module dit ce qui le CONTREDIT aujourd'hui, pour le corriger d'un clic.
 *
 * Module PUR (aucune base) : l'appelant charge les tables (`coherence-donnees.ts`) et les passe telles quelles.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DepartementCoherence extends DepartmentNodeLite { name: string }
export interface EmployeCoherence extends EmployeeNode { department: string | null }
export interface CompteCoherence { id: string; name: string; departmentId: string | null; isActive: boolean }
export interface BuCoherence { id: string; name: string; departmentId: string | null; supervisorId: string | null; kamUserIds: readonly string[]; isActive: boolean }

export interface Coherence {
  /** Comptes dont le département diffère de celui de leur fiche salarié. */
  comptesDivergents: { userId: string; nom: string; employeeId: string; compte: string | null; fiche: string | null }[];
  /** Fiches dont le libellé texte ne dit pas le département structuré. */
  libellesPerimes: { employeeId: string; nom: string; libelle: string | null; attendu: string }[];
  buSansDepartement: { buId: string; nom: string }[];
  departementsSansResponsable: { departmentId: string; nom: string; membres: number }[];
  /** Superviseurs de BU absents de la ligne hiérarchique d'au moins un de leurs KAM. */
  superviseursHorsLigne: { buId: string; nom: string; superviseurId: string; kamsHorsLigne: string[]; propose: string | null }[];
  employesSansDepartement: { employeeId: string; nom: string }[];
}

/** Le compte (utilisateur) que l'organigramme propose comme superviseur d'une BU : le responsable de son département, à défaut l'adjoint. */
export function superviseurPropose(
  bu: { departmentId: string | null },
  departements: readonly DepartmentNodeLite[],
  employes: readonly EmployeeNode[],
): string | null {
  if (!bu.departmentId) return null;
  const d = departements.find((x) => x.id === bu.departmentId);
  if (!d) return null;
  for (const id of [d.headId, d.deputyId]) {
    const e = id ? employes.find((x) => x.id === id && x.isActive) : undefined;
    if (e?.userId) return e.userId;
  }
  return null;
}

/**
 * LES KAM DONT LE SUPERVISEUR N'EST PAS DANS LA LIGNE HIÉRARCHIQUE (`managementChainOf`, la même cascade que les
 * circuits). Un KAM ou un superviseur sans fiche salarié ne se vérifie pas : on ne l'accuse pas.
 */
export function kamsHorsLigne(
  superviseurUserId: string,
  kamUserIds: readonly string[],
  employes: readonly EmployeeNode[],
  departements: readonly DepartmentNodeLite[],
): string[] {
  const parUser = new Map(employes.filter((e) => e.userId).map((e) => [e.userId as string, e]));
  const sup = parUser.get(superviseurUserId);
  if (!sup) return [];
  const hors: string[] = [];
  for (const kamId of kamUserIds) {
    if (kamId === superviseurUserId) continue;
    const kam = parUser.get(kamId);
    if (!kam || !kam.isActive) continue;
    const chaine = managementChainOf(kam.id, employes, departements);
    if (!chaine.some((m) => m.employeeId === sup.id)) hors.push(kamId);
  }
  return hors;
}

export function controlerCoherence(input: {
  departements: readonly DepartementCoherence[];
  employes: readonly EmployeCoherence[];
  comptes: readonly CompteCoherence[];
  bus: readonly BuCoherence[];
}): Coherence {
  const nomDept = new Map(input.departements.map((d) => [d.id, d.name]));
  const comptes = new Map(input.comptes.map((c) => [c.id, c]));
  const actifs = input.employes.filter((e) => e.isActive);
  const nomEmploye = new Map(input.employes.map((e) => [e.userId ?? `#${e.id}`, e.fullName]));

  const comptesDivergents: Coherence["comptesDivergents"] = [];
  for (const e of input.employes) {
    if (!e.userId) continue;
    const c = comptes.get(e.userId);
    if (!c || c.departmentId === e.departmentId) continue;
    comptesDivergents.push({
      userId: c.id, nom: e.fullName, employeeId: e.id,
      compte: c.departmentId ? nomDept.get(c.departmentId) ?? "département supprimé" : null,
      fiche: e.departmentId ? nomDept.get(e.departmentId) ?? null : null,
    });
  }

  const libellesPerimes: Coherence["libellesPerimes"] = [];
  for (const e of input.employes) {
    const attendu = e.departmentId ? nomDept.get(e.departmentId) : undefined;
    if (attendu !== undefined && e.department !== attendu) libellesPerimes.push({ employeeId: e.id, nom: e.fullName, libelle: e.department, attendu });
  }

  const membres = new Map<string, number>();
  for (const e of actifs) if (e.departmentId) membres.set(e.departmentId, (membres.get(e.departmentId) ?? 0) + 1);
  const actifParId = new Map(actifs.map((e) => [e.id, e]));

  const superviseursHorsLigne: Coherence["superviseursHorsLigne"] = [];
  for (const bu of input.bus) {
    if (!bu.isActive || !bu.supervisorId) continue;
    const hors = kamsHorsLigne(bu.supervisorId, bu.kamUserIds, input.employes, input.departements);
    if (hors.length === 0) continue;
    const propose = superviseurPropose(bu, input.departements, input.employes);
    superviseursHorsLigne.push({
      buId: bu.id, nom: bu.name, superviseurId: bu.supervisorId,
      kamsHorsLigne: hors.map((id) => nomEmploye.get(id) ?? id),
      propose: propose && propose !== bu.supervisorId ? propose : null,
    });
  }

  return {
    comptesDivergents,
    libellesPerimes,
    buSansDepartement: input.bus.filter((b) => b.isActive && !b.departmentId).map((b) => ({ buId: b.id, nom: b.name })),
    departementsSansResponsable: input.departements
      // Un responsable désigné mais SORTI (fiche inactive) ne tient plus le département.
      .filter((d) => !(d.headId && actifParId.has(d.headId)))
      .map((d) => ({ departmentId: d.id, nom: d.name, membres: membres.get(d.id) ?? 0 })),
    superviseursHorsLigne,
    employesSansDepartement: actifs.filter((e) => !e.departmentId).map((e) => ({ employeeId: e.id, nom: e.fullName })),
  };
}

/** Le nombre total de points à corriger (le badge du panneau). */
export function totalIncoherences(c: Coherence): number {
  return c.comptesDivergents.length + c.libellesPerimes.length + c.buSansDepartement.length
    + c.departementsSansResponsable.length + c.superviseursHorsLigne.length + c.employesSansDepartement.length;
}
