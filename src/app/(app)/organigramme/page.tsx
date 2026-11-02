import Link from "next/link";
import { redirect } from "next/navigation";
import { UserPlus } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { platformScope, getCompanyScope, getMyCompanies, companyLabel } from "@/lib/company";
import { canViewOrgChart, canEditOrgChart } from "@/lib/org-chart-access";
import { userCan } from "@/lib/rbac";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { OrgNode } from "../admin/organigramme/org-chart-editor";
import { OrgWorkspace } from "../admin/organigramme/org-workspace";
import { PageHeader } from "@/components/shared/page-header";
import { chargerCoherence } from "@/lib/org/coherence-donnees";
import { CoherencePanel } from "./coherence-panel";

export const metadata = { title: "Organigramme — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * ORGANIGRAMME — page OUVERTE (hors console d'administration). Le Super Admin y réorganise ;
 * les rôles et personnes qu'il a autorisés (Administration → Réglages) la CONSULTENT, par entité
 * ou sur le groupe entier. Les RH, qui tiennent la structure à jour, n'ont plus à passer par lui.
 */
export default async function OrganigrammePage() {
  const user = await requireUser();
  const settings = await getAppSettings();
  if (!canViewOrgChart(user, settings)) redirect("/mon-espace");
  const canEdit = canEditOrgChart(user);

  // L'ORGANIGRAMME SUIT L'ENTITÉ SÉLECTIONNÉE en haut de l'écran. Il montrait jusqu'ici tout le
  // groupe quelle que soit la société active : on regardait « Pharmagène » et on lisait la
  // hiérarchie d'Adventum. La portée est VALIDÉE contre les droits (le cookie est une demande,
  // pas une autorisation) et laisse passer les personnes NON RATTACHÉES — un employé sans
  // entité doit apparaître quelque part, sinon il n'apparaît nulle part.
  const scope = await platformScope(user.id);
  const activeCompanyId = await getCompanyScope();
  const companies = await getMyCompanies(user.id);
  const activeCompany = activeCompanyId ? companies.find((c) => c.id === activeCompanyId) : null;
  const scopeLabel = activeCompany ? companyLabel(activeCompany) : "Toutes les entités";

  const employees = await prisma.employee.findMany({
    where: { AND: [{ isActive: true }, scope] },
    select: {
      id: true, fullName: true, position: true, department: true, managerId: true, orgX: true, orgY: true,
      // Département STRUCTURÉ (source de vérité) ; le champ texte n'est qu'un cache de secours.
      departmentRef: { select: { name: true } },
      company: { select: { name: true, shortName: true, color: true } },
    },
    orderBy: { fullName: "asc" },
  });
  const nodes: OrgNode[] = employees.map((e) => ({
    id: e.id,
    fullName: e.fullName,
    position: e.position,
    department: e.departmentRef?.name ?? e.department,
    managerId: e.managerId,
    entity: e.company?.shortName ?? e.company?.name ?? null,
    color: e.company?.color ?? null,
    orgX: e.orgX,
    orgY: e.orgY,
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Organigramme"
        description={
          canEdit
            ? "Hiérarchie de l'entreprise — branchée sur Ressources humaines. Réarrangez qui rapporte à qui et ajustez les postes ; les personnes se créent dans RH."
            : "Hiérarchie de l'entreprise, en consultation. Les rattachements et les postes se règlent dans l'administration."
        }
      >
        {userCan(user, "EMPLOYEES", "VIEW") && (
          <Link href="/rh"><Button variant="outline"><UserPlus className="h-4 w-4" /> Employés (RH)</Button></Link>
        )}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Structure hiérarchique — {scopeLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          <OrgWorkspace nodes={nodes} canEdit={canEdit} scopeLabel={scopeLabel} />
        </CardContent>
      </Card>

      {/* L'ORGANIGRAMME, SEULE SOURCE — ce qui le contredit, corrigé d'un clic (Super Admin). */}
      {user.role === "SUPER_ADMIN" && <Coherence />}
    </div>
  );
}

async function Coherence() {
  const { coherence, donnees } = await chargerCoherence();
  const nomsComptes = Object.fromEntries(donnees.comptes.map((c) => [c.id, c.name]));
  return (
    <CoherencePanel
      coherence={coherence}
      departements={donnees.departements.map((d) => ({ id: d.id, name: d.name }))}
      employes={donnees.employes.filter((e) => e.isActive).map((e) => ({ id: e.id, name: e.fullName, departmentId: e.departmentId }))}
      nomsComptes={nomsComptes}
    />
  );
}
