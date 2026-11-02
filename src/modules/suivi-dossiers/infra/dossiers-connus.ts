import { prisma } from "@/lib/prisma";
import { hasGlobalView, scopeDossiers } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { DossierConnu, PrioriteDossier, StatutDossier } from "../domaine/maj-lot";

/** Les dossiers que la personne VOIT (portée du module), et ceux qu'elle peut modifier (créateur, responsable, Direction). */
export async function dossiersConnus(user: CurrentUser): Promise<DossierConnu[]> {
  const ds = await prisma.dossier.findMany({
    where: scopeDossiers(user), take: 2_000, orderBy: { updatedAt: "desc" },
    select: { id: true, reference: true, title: true, status: true, dueDate: true, priority: true, createdById: true, assignedToId: true },
  });
  return ds.map((d) => ({
    id: d.id, reference: d.reference, title: d.title, status: d.status as StatutDossier, dueDate: d.dueDate ? d.dueDate.toISOString().slice(0, 10) : null,
    priority: d.priority as PrioriteDossier, modifiable: hasGlobalView(user.role) || d.createdById === user.id || d.assignedToId === user.id,
  }));
}
