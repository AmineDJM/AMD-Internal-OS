import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { platformScope, getMyCompanies, companyOptions } from "@/lib/company";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { EVENTS_TABS } from "@/lib/labels";
import { consultingCreateFields, isOverdue } from "@/modules/ad-pro/partage";
import { createConsultingContract } from "@/lib/actions/consulting-actions";
import { ContractsTable } from "@/components/consulting/contracts-table";

export const dynamic = "force-dynamic";

/**
 * CONSULTING — les engagements pris avec des prestataires.
 *
 * Un contrat n'est pas une demande qu'on approuve puis qu'on oublie : c'est une relation qui
 * court dans le temps. La liste répond donc à trois questions, et dans cet ordre : lesquels sont
 * ACTIFS, lesquels ARRIVENT À TERME, et combien ils nous engagent.
 */
export default async function ConsultingPage() {
  const user = await requireModule("CONSULTING");
  const canCreate = userCan(user, "CONSULTING", "CREATE");

  const [contracts, companies, businessUnits] = await Promise.all([
    // LE PÔLE AD & PRO SEULEMENT (§118.150) — un contrat passé aux RH se lit dans RH › Consultants.
    // La clause se COMPOSE avec la portée de la plateforme, jamais par étalement : deux objets qui
    // porteraient la même clé perdraient le premier en silence (§118.133).
    prisma.consultingContract.findMany({
      where: { AND: [await platformScope(user.id), { pole: "AD_PRO" }] },
      orderBy: { createdAt: "desc" },
      include: { company: { select: { name: true } }, tasks: { select: { doneAt: true } } },
    }),
    getMyCompanies(user.id),
      // LES GAMMES ACTIVES — c'est le budget Ad&Pro de l'une d'elles que la demande engage.
    prisma.businessUnit.findMany({
      where: { isActive: true }, select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
]);

  const active = contracts.filter((c) => c.status === "ACTIVE");
  const awaiting = contracts.filter((c) => c.status === "AWAITING_VALIDATION");
  const overdue = contracts.filter((c) => isOverdue(c));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Consulting"
        description="Les contrats passés avec des consultants et des cabinets : mission, rémunération, durée, tâches attendues et pièces signées."
      >
        {canCreate && (
          <CreateRecordButton
            autoOpenParam="new"
            label="Nouveau contrat"
            title="Nouveau contrat de consulting"
            description="Un contrat a deux parties : indiquez le prestataire, ce qu'il doit livrer, et à quelles conditions."
            action={createConsultingContract}
            redirectBase="/consulting"
            fields={consultingCreateFields({ companies: companyOptions(companies), businessUnits })}
          />
        )}
      </PageHeader>

      <ModuleTabs tabs={EVENTS_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Contrats" value={contracts.length} icon="Handshake" />
        <KpiCard label="Actifs" value={active.length} icon="CircleCheck" tone="success" />
        <KpiCard label="En cours de validation" value={awaiting.length} icon="Hourglass" tone={awaiting.length > 0 ? "warning" : "default"} />
        {/* Le terme dépassé se SIGNALE : une échéance d'un jour se prolonge souvent d'un avenant,
            et un logiciel qui clôt de lui-même la relation oblige à la rouvrir. */}
        <KpiCard label="Terme dépassé" value={overdue.length} icon="CalendarX" tone={overdue.length > 0 ? "danger" : "default"} />
      </div>

      {contracts.length === 0 ? (
        <EmptyState
          icon="Handshake"
          title="Aucun contrat de consulting"
          description={canCreate ? "Créez un contrat pour suivre la mission, la rémunération et ce qui reste à livrer." : "Les contrats apparaîtront ici."}
        />
      ) : (
        <ContractsTable contracts={contracts} />
      )}
    </div>
  );
}
