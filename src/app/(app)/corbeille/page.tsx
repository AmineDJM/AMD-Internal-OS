import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { TrashList, type TrashItem } from "@/app/(app)/admin/corbeille/trash-list";
import { DELETABLE_KINDS } from "@/lib/admin-delete-registry";
import { typesDeCorbeillePermis } from "@/lib/suppression/delegation";
import { userCan } from "@/lib/rbac";

export const dynamic = "force-dynamic";

/**
 * LA CORBEILLE DE SES MODULES — pour le directeur des opérations (Direction, 06/10 : « suppression, récupération… des
 * modules qu'il gère »). Il y voit, et RESTAURE, ce qui a été supprimé dans ses modules (ventes, marchés PCH,
 * demandes administratives, stock promotionnel, fournisseurs, demandes Ad & Pro). Détruire pour de bon reste au Super
 * Admin, qui a sa corbeille complète dans l'Administration. La règle est celle de l'action (`corbeillePermise`).
 */
export default async function CorbeilleDesModulesPage() {
  const user = await requireUser();
  if (user.role === "SUPER_ADMIN") redirect("/admin/corbeille");
  // LA CLÉ DE L'ÉCRAN, `CORBEILLE` (24/11/2026) : par défaut le directeur des opérations, réglée ensuite dans la console.
  if (!userCan(user, "CORBEILLE", "VIEW")) redirect("/mon-espace");

  const permis = typesDeCorbeillePermis(user, DELETABLE_KINDS);
  const rows = permis.length
    ? await prisma.deletedRecord.findMany({ where: { purgedAt: null, kind: { in: permis } }, orderBy: { deletedAt: "desc" }, take: 200 })
    : [];
  const acteurs = [...new Set(rows.map((r) => r.deletedById).filter((v): v is string => Boolean(v)))];
  const noms = new Map(
    (acteurs.length ? await prisma.user.findMany({ where: { id: { in: acteurs } }, select: { id: true, name: true } }) : []).map((a) => [a.id, a.name]),
  );
  const items: TrashItem[] = rows.map((r) => ({
    id: r.id, kind: r.kind, label: r.label, name: r.name,
    deletedAt: r.deletedAt.toISOString(),
    deletedBy: r.deletedById ? noms.get(r.deletedById) ?? null : null,
    restoredAt: r.restoredAt?.toISOString() ?? null,
    documents: Array.isArray(r.documents) ? (r.documents as unknown[]).length : 0,
    emportes: lotResume(r.lot),
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Corbeille de mes modules"
        description="Ce qui a été supprimé dans les modules que vous gérez : chaque élément se restaure ici, avec ce qui était parti avec lui. La destruction définitive reste au Super Admin."
      />
      {items.length === 0 ? (
        <EmptyState icon="Trash2" title="Corbeille vide" description="Les éléments supprimés dans vos modules apparaîtront ici, restaurables." />
      ) : (
        <TrashList items={items} peutDetruire={false} />
      )}
    </div>
  );
}

function lotResume(lot: unknown): string[] {
  if (!lot || typeof lot !== "object") return [];
  const resume = (lot as { resume?: unknown }).resume;
  return Array.isArray(resume) ? resume.filter((x): x is string => typeof x === "string") : [];
}
