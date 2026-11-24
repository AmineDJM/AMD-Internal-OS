import { prisma } from "@/lib/prisma";
import { getManagerOfUser } from "@/lib/departments";
import { reviseurDuPlan } from "@/lib/sfe/tournee";

/**
 * L'ÉQUIPE D'UN DÉLÉGUÉ, LUE UNE FOIS — le superviseur de sa Business Unit et son N+1 d'organigramme : les deux
 * personnes que la règle du plan de tournée (`reviseurDuPlan`) connaît. La relecture des rapports, l'alerte de
 * pharmacovigilance et le signalement rattaché à une visite lisent la même équipe que la validation du plan.
 */
export async function equipeDuDelegue(repId: string): Promise<{ superviseurBuId: string | null; managerRhId: string | null }> {
  const [profil, manager] = await Promise.all([
    prisma.salesRepProfile.findUnique({ where: { repId }, select: { businessUnit: { select: { supervisorId: true } } } }),
    getManagerOfUser(repId),
  ]);
  return { superviseurBuId: profil?.businessUnit?.supervisorId ?? null, managerRhId: manager?.userId ?? null };
}

/** Qui encadre ce délégué : le superviseur de sa BU, sinon son N+1 — jamais lui-même (`reviseurDuPlan`). */
export async function encadrantDuDelegue(repId: string): Promise<string | null> {
  return reviseurDuPlan({ repId, ...(await equipeDuDelegue(repId)) })?.id ?? null;
}
