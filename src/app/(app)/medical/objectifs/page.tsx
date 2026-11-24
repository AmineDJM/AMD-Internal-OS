import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { loadMyFieldDay } from "@/lib/queries/my-field-day";
import { loadJourneeDuDelegue } from "@/lib/queries/tour-schedule";
import { chargerBilanKpi } from "@/lib/kpi/service";
import { ligneDeChiffres } from "@/lib/sfe/journee-visite";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { Tuile } from "@/components/shared/tuile";
import { BilanKpiVue } from "@/components/kpi/bilan-kpi";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mes objectifs — Visite médicale — AMD Internal OS" };

/**
 * « MES OBJECTIFS » (interface du délégué, maquette VALIDÉE le 24/11/2026) — sans jargon, deux sources qui existent déjà :
 *   • le compteur du MOIS que le superviseur suit (le plan validé, `ligneDeChiffres` — le même que le pilotage) et la
 *     couverture du panel ;
 *   • ses KPI, calculés en continu par la plateforme (`chargerBilanKpi`, l'écran de « Mon bilan ») : chaque carte dit
 *     ce qu'elle compte et d'où vient la cible.
 */
export default async function MesObjectifsPage(props: { searchParams?: Promise<{ periode?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const aiguillage = await aiguillerVisite(user);
  if (aiguillage.destination !== "JOURNEE") redirect(aiguillage.chemin);

  const maintenant = new Date();
  const voitKpi = userCan(user, "KPI", "VIEW");
  const [day, edt, bilan, tabs] = await Promise.all([
    loadMyFieldDay(user.id, maintenant),
    loadJourneeDuDelegue(user, maintenant),
    voitKpi ? chargerBilanKpi(user, user.id, searchParams?.periode ?? null) : Promise.resolve(null),
    visibleTabs(user, MEDICAL_TABS),
  ]);
  const mois = ligneDeChiffres(edt.avancementDuMois, day.progress);
  const nomDuMois = maintenant.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Mes objectifs" description={bilan ? bilan.periode.libelle : nomDuMois.charAt(0).toUpperCase() + nomDuMois.slice(1)} />
      <ModuleTabs tabs={tabs} />

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Tuile
          label={mois.sur !== null ? "Visites du plan ce mois" : "Visites ce mois"}
          valeur={mois.sur !== null ? `${mois.fait} / ${mois.sur}` : mois.fait}
          ton={mois.sur !== null && mois.pct >= 90 ? "ok" : "defaut"}
          contexte={mois.sousTexte.filter((t) => !t.includes("% du panel")).join(" · ") || undefined}
        />
        <Tuile
          label="Médecins du panel vus ce mois"
          valeur={`${day.progress.covered} / ${day.progress.panelSize}`}
          ton={day.progress.coveragePct >= 80 ? "ok" : "alerte"}
          contexte={`${day.progress.coveragePct} % du panel`}
        />
      </div>

      {!voitKpi ? null : !bilan || bilan.kpis.length === 0 ? (
        <EmptyState icon="Target" title="Aucun KPI ne vous est encore affecté" description="Votre superviseur ou le modèle de votre rôle les définit." />
      ) : (
        <BilanKpiVue userId={user.id} bilanInitial={bilan} />
      )}
    </div>
  );
}
