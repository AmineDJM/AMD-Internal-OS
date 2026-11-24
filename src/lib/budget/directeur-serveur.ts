import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { departementsDiriges } from "@/modules/rh/api";
import {
  cleDuBudget, dirigeLeBudget, domaineDuDepartement, type DepartementDuDirecteur, type EnveloppeDeBudget, type LigneDAutreEnveloppe,
} from "./budget-du-directeur";

/**
 * LE BUDGET D'UN DIRECTEUR, LU EN BASE — la règle est `budget-du-directeur.ts` ; ici, les départements qu'il dirige
 * (organigramme, `@/modules/rh/api`) avec le pôle que la campagne leur a fixé, et les enveloppes d'un même budget.
 */

/** Les départements dirigés, chacun avec le pôle dont il tient le budget. */
export async function departementsDuDirecteur(userId: string): Promise<DepartementDuDirecteur[]> {
  const deps = await departementsDiriges(userId);
  if (deps.length === 0) return [];
  // Le pôle fixé par la DERNIÈRE campagne du département (réglable), sinon celui que son nom dit.
  const propositions = await prisma.budgetProposal.findMany({
    where: { departmentId: { in: deps.map((d) => d.id) } },
    orderBy: { createdAt: "desc" },
    select: { departmentId: true, domaine: true },
  });
  const domaineDe = new Map<string, string>();
  for (const p of propositions) if (p.departmentId && !domaineDe.has(p.departmentId)) domaineDe.set(p.departmentId, p.domaine);
  return deps.map((d) => ({ id: d.id, companyId: d.companyId, domaine: domaineDuDepartement(d, domaineDe.get(d.id)) }));
}

const CHAMPS = { id: true, name: true, domaine: true, companyId: true, periodStart: true, totalAmount: true } as const;

/** Une enveloppe lue pour la règle : son département de campagne compris. */
export async function enveloppeDeBudget(envelopeId: string): Promise<(EnveloppeDeBudget & { name: string; total: number }) | null> {
  const [e, prop] = await Promise.all([
    prisma.budgetEnvelope.findUnique({ where: { id: envelopeId }, select: CHAMPS }),
    prisma.budgetProposal.findUnique({ where: { envelopeId }, select: { departmentId: true } }),
  ]);
  if (!e) return null;
  return { id: e.id, name: e.name, domaine: e.domaine, companyId: e.companyId, periodStart: e.periodStart, total: toNumber(e.totalAmount), departementCampagneId: prop?.departmentId ?? null };
}

/** Cette personne est-elle le directeur du budget de cette enveloppe ? */
export async function estDirecteurDuBudget(userId: string, e: EnveloppeDeBudget): Promise<boolean> {
  return dirigeLeBudget(e, await departementsDuDirecteur(userId));
}

/**
 * LES CATÉGORIES DE TÊTE DES AUTRES ENVELOPPES DU MÊME BUDGET — la liste « Vers » du panneau Réallouer, pour le directeur
 * de ce budget et le Super Admin. Rien pour les autres : ils réallouent dans l'enveloppe qu'ils gèrent, comme hier.
 */
export async function droitsDeReallocation(user: { id: string; role: string }, envelopeId: string): Promise<{ directeur: boolean; autres: LigneDAutreEnveloppe[] }> {
  const env = await enveloppeDeBudget(envelopeId);
  if (!env) return { directeur: false, autres: [] };
  const directeur = await estDirecteurDuBudget(user.id, env);
  if (!directeur && user.role !== "SUPER_ADMIN") return { directeur: false, autres: [] };
  const cle = cleDuBudget(env);
  if (cle.startsWith("ENV:")) return { directeur, autres: [] };
  const voisines = await prisma.budgetEnvelope.findMany({
    where: { id: { not: env.id }, companyId: env.companyId, isActive: true },
    select: { ...CHAMPS, categories: { where: { parentId: null }, select: { id: true, name: true, allocated: true }, orderBy: { name: "asc" } } },
  });
  const props = voisines.length
    ? await prisma.budgetProposal.findMany({ where: { envelopeId: { in: voisines.map((v) => v.id) } }, select: { envelopeId: true, departmentId: true } })
    : [];
  const depDe = new Map(props.map((p) => [p.envelopeId, p.departmentId]));
  const autres = voisines
    .filter((v) => cleDuBudget({ ...v, departementCampagneId: depDe.get(v.id) ?? null }) === cle)
    .flatMap((v) => v.categories.map((c) => ({ id: c.id, nom: c.name, envelopeId: v.id, enveloppe: v.name, alloue: toNumber(c.allocated) })));
  return { directeur, autres };
}
