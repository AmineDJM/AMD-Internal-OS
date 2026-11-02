import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { ongletsEspace } from "@/lib/queries/mes-taches";
import { chargerBilanKpi } from "@/lib/kpi/service";
import { BilanKpiVue } from "@/components/kpi/bilan-kpi";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mon bilan — AMD Internal OS" };

/**
 * MON BILAN (KPI sans code, Direction 08/10 : « bilan en continu ») — mes KPI de la période, calculés en continu par
 * la plateforme, ma revue quand elle est signée, mes déclarations. Lecture seule, sauf « Déclarer » (avec la pièce).
 */
export default async function MonBilanPage(props: { searchParams?: Promise<{ periode?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("KPI");
  const [bilan, onglets] = await Promise.all([chargerBilanKpi(user, user.id, searchParams?.periode ?? null), ongletsEspace(user)]);

  return (
    <div className="space-y-5">
      <PageHeader title="Mon bilan" description={bilan ? bilan.periode.libelle : undefined} />
      <ModuleTabs tabs={onglets} />
      {!bilan || bilan.kpis.length === 0 ? (
        <EmptyState icon="Target" title="Aucun KPI ne vous est encore affecté" description="Votre responsable ou le modèle de votre rôle les définit." />
      ) : (
        <BilanKpiVue userId={user.id} bilanInitial={bilan} />
      )}
    </div>
  );
}
