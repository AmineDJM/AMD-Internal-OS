import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { EntitiesManager, type EntityRow } from "./entities-manager";
import { OrphansPanel } from "./orphans-panel";
import { getUnattachedInventory } from "@/lib/queries/unattached";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

/** Gestion des entités (sociétés du groupe) — réservée à l'administration. */
export default async function EntitesPage() {
  const admin = await requireModule("ADMIN");
  if (!userCan(admin, "ADMIN", "CREATE")) redirect("/admin");

  const [companies, byProduct, byEmployee, byDepartment, orphans] = await Promise.all([
    prisma.company.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.regulatoryProduct.groupBy({ by: ["companyId"], _count: true }),
    prisma.employee.groupBy({ by: ["companyId"], _count: true }),
    // Structure : nombre de départements propres à chaque entité.
    prisma.department.groupBy({ by: ["companyId"], _count: true }),
    // Contrepartie de la portée stricte : ce qui n'a pas d'entité doit se VOIR, sinon il
    // disparaît des vues cloisonnées sans que personne ne le remarque.
    getUnattachedInventory(),
  ]);
  const prodCount = new Map(byProduct.map((r) => [r.companyId, r._count]));
  const empCount = new Map(byEmployee.map((r) => [r.companyId, r._count]));
  const deptCount = new Map(byDepartment.map((r) => [r.companyId, r._count]));

  const rows: EntityRow[] = companies.map((c) => ({
    id: c.id,
    name: c.name,
    shortName: c.shortName,
    color: c.color,
    isActive: c.isActive,
    products: prodCount.get(c.id) ?? 0,
    employees: empCount.get(c.id) ?? 0,
    departments: deptCount.get(c.id) ?? 0,
  }));

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Entités (sociétés)"
        description="Les sociétés du groupe (Adventum Pharma, Pharmagène, …). Ce que quelqu'un crée appartient à SON entité, et choisir une entité dans la barre supérieure ne montre QUE celle-là. Tout est dynamique : créez une 3ᵉ entité, renommez, changez la couleur ou désactivez sans toucher au code."
      />
      <EntitiesManager rows={rows} />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Sans entité ({orphans.total})
        </h2>
        <OrphansPanel
          groups={orphans.groups}
          total={orphans.total}
          companies={companies.filter((c) => c.isActive).map((c) => ({ id: c.id, name: c.name }))}
        />
      </section>
    </div>
  );
}
