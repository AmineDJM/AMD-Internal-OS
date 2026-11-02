import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getCongressList, getAdProCreateData } from "@/modules/ad-pro/api";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { EVENTS_TABS } from "@/lib/labels";
import { CongressRequestButton } from "../congress-international/congress-request-form";
import { CongressTable } from "../congress-international/congress-table";

export const dynamic = "force-dynamic";

export default async function CongressNationalPage() {
  const user = await requireModule("CONGRESS_NATIONAL");
  const canCreate = userCan(user, "CONGRESS_NATIONAL", "CREATE");

  // LES RÉFÉRENTIELS DU FORMULAIRE viennent du chargeur COMMUN du pôle Ad & Pro : médecins,
  // produits promouvables, spécialités, gammes. `getCongressFormData` n'en lisait que deux et
  // redonnait sa propre version des médecins — deux lectures du même fait, dont une plus
  // pauvre (§118.5). Chargés SEULEMENT si la personne peut créer : un écran en lecture seule
  // n'ouvre aucun formulaire.
  const [rows, form] = await Promise.all([
    getCongressList("NATIONAL", user),
    canCreate ? getAdProCreateData(user.id, ["CONGRESS_NATIONAL"]) : Promise.resolve(null),
  ]);

  const pending = rows.filter((r) => ["AWAITING_PRELIMINARY", "PRELIMINARY_APPROVED", "AWAITING_FINAL"].includes(r.requestStatus)).length;
  const approved = rows.filter((r) => r.requestStatus === "APPROVED" || r.requestStatus === "COMPLETED").length;

  return (
    <div className="space-y-5">
      <PageHeader title="Prises en charge Nationales" description="Prise en charge de participants à un événement en Algérie — congrès, séminaire, table ronde, webinaire. Validation préliminaire, analyse Direction Marketing, décision de la Direction.">
        {canCreate && form && (
          <CongressRequestButton national doctors={form.doctors} users={form.users}
            products={form.products} specialties={form.specialties} specialtiesHeritees={form.specialtiesHeritees}
            businessUnits={form.businessUnits} businessUnitDeduite={form.businessUnitDeduite} />
        )}
      </PageHeader>

      <ModuleTabs tabs={EVENTS_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Demandes" value={rows.length} icon="MapPin" />
        <KpiCard label="En cours" value={pending} icon="Hourglass" tone={pending > 0 ? "warning" : "default"} />
        <KpiCard label="Pris en charge" value={approved} icon="CheckCircle2" tone="success" />
        <KpiCard label="Refusées" value={rows.filter((r) => r.requestStatus === "REJECTED").length} icon="XCircle" />
      </div>

      <CongressTable rows={rows} basePath="/congress-national" showType />
    </div>
  );
}
