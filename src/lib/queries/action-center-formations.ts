import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency } from "@/lib/utils";
import { arriveeALaMarche } from "@/lib/approval-chain";
import { lienFormation } from "@/lib/chemins/formations";
import { societesOuJAutoriseLesFormations } from "@/modules/rh/api";
import type { ActionItem } from "./action-center";

/**
 * « AUJOURD'HUI » — LES FORMATIONS À AUTORISER (Super Admin, 24/11/2026). Le Directeur des opérations autorise toutes les
 * formations de SES sociétés, réglementaires comprises (`societesOuJAutoriseLesFormations`, la règle de l'action) ; une
 * formation restée « chez le DG » avant la décision attend désormais ici (`etapeDeFormation`). Sa propre demande n'y est
 * pas : on ne s'autorise pas soi-même.
 */
export async function lignesFormationsAAutoriser(userId: string): Promise<ActionItem[]> {
  const societes = await societesOuJAutoriseLesFormations(userId);
  if (societes.length === 0) return [];
  const ids = societes.filter((c): c is string => c !== null);
  const formations = await prisma.training.findMany({
    where: {
      status: "PENDING", stage: { in: ["OPERATIONS", "DG"] }, NOT: { requesterId: userId },
      OR: [...(ids.length ? [{ companyId: { in: ids } }] : []), ...(societes.includes(null) ? [{ companyId: null }] : [])],
    },
    select: { id: true, title: true, reference: true, amount: true, hrDecidedAt: true, managerDecidedAt: true, createdAt: true, requester: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  return formations.map((f) => ({
    key: `formation-ops-${f.id}`, objet: `TRAINING:${f.id}`, title: f.title,
    subtitle: [f.reference, toNumber(f.amount) > 0 ? formatCurrency(toNumber(f.amount)) : null].filter(Boolean).join(" · "),
    module: "Formations", href: lienFormation(f.id), kind: "validation" as const, priority: null,
    deadline: null, depuis: arriveeALaMarche("OPERATIONS", { creeLe: f.createdAt, n1DecideLe: f.managerDecidedAt, rhDecideLe: f.hrDecidedAt }).toISOString(),
    owner: f.requester?.name ?? "", statusLabel: "À autoriser", statusTone: "warning" as const,
  }));
}
