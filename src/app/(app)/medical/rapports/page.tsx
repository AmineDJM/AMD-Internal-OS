import Link from "next/link";
import { BarChart3, Filter, ShieldAlert } from "lucide-react";
import { requireModule } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { canViewFieldReportsOverview } from "@/lib/queries/field-reports";
import { chargerListeRapports, lireFiltresRapports } from "@/lib/queries/rapports-terrain-liste";
import { signaleDesCasPv, voitTousLesCasPv } from "@/lib/pharmacovigilance/acces";
import { CHEMIN_APERCU_RAPPORTS, CHEMIN_PV_KAM, CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { ListeRapports } from "./liste-rapports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rapports — AMD Internal OS" };

/**
 * L'ONGLET « RAPPORTS » DE LA PROMOTION MÉDICALE (Direction, 07/10) — « juste la liste des rapports ».
 *
 * Le KAM FAIT ses rapports depuis son planning (Plan de tournée : il touche le praticien ; « Faire un rapport » au-dessus
 * de la grille ; « Pharmacovigilance » à côté). Ici, on les LIT : un tableau, des filtres, une feuille par rapport.
 *
 * La GARDE est le module `FIELD_REPORTS`, celui de l'ancienne entrée « Rapports terrain » : la console d'administration
 * règle toujours qui voit cet onglet. Ce que chacun y lit vient des règles d'hier (`chargerListeRapports`).
 */
export default async function RapportsPage(
  props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("FIELD_REPORTS");
  const filtres = lireFiltresRapports(searchParams);
  const [liste, settings, onglets] = await Promise.all([
    chargerListeRapports(user, filtres),
    getAppSettings(),
    visibleTabs(user, MEDICAL_TABS),
  ]);
  const analyse = canViewFieldReportsOverview(user, settings.fieldReportsOverviewRoles);
  const signalements = signaleDesCasPv(user) || voitTousLesCasPv(user);
  const filtre = Boolean(searchParams && Object.values(searchParams).some((v) => v));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Rapports">
        {signalements && (
          <Link href={CHEMIN_PV_KAM} className="inline-flex min-h-10 items-center gap-1.5 text-sm text-primary hover:underline sm:min-h-8">
            <ShieldAlert className="h-4 w-4" /> Mes signalements
          </Link>
        )}
        {analyse && (
          <Link href={CHEMIN_APERCU_RAPPORTS} className="inline-flex min-h-10 items-center gap-1.5 text-sm text-primary hover:underline sm:min-h-8">
            <BarChart3 className="h-4 w-4" /> Analyse
          </Link>
        )}
      </PageHeader>
      <ModuleTabs tabs={onglets} />

      <form method="get" className="surface grid grid-cols-2 gap-3 p-3 lg:flex lg:flex-wrap lg:items-end">
        <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
          Du
          <Input type="date" name="du" defaultValue={liste.filtres.du} />
        </label>
        <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
          Au
          <Input type="date" name="au" defaultValue={liste.filtres.au} />
        </label>
        {liste.toutVoir && (
          <>
            <label className="min-w-0 space-y-1 text-xs text-muted-foreground lg:w-48">
              Délégué
              <Select name="delegue" defaultValue={liste.filtres.delegue}>
                <option value="">Tous</option>
                {liste.delegues.map((d) => <option key={d.id} value={d.id}>{d.nom}</option>)}
              </Select>
            </label>
            <label className="min-w-0 space-y-1 text-xs text-muted-foreground lg:w-44">
              BU
              <Select name="bu" defaultValue={liste.filtres.bu}>
                <option value="">Toutes</option>
                {liste.bus.map((b) => <option key={b.id} value={b.id}>{b.nom}</option>)}
              </Select>
            </label>
          </>
        )}
        <label className="col-span-2 min-w-0 space-y-1 text-xs text-muted-foreground lg:flex-1">
          Recherche
          <Input type="search" name="q" defaultValue={liste.filtres.q} placeholder="Praticien, établissement, produit…" enterKeyHint="search" />
        </label>
        <div className="col-span-2 flex items-center gap-2 lg:col-span-1">
          <Button type="submit" size="sm" className="h-10 flex-1 lg:h-9 lg:flex-none"><Filter className="h-3.5 w-3.5" /> Filtrer</Button>
          {filtre && <Link href={CHEMIN_RAPPORTS_TERRAIN} className="inline-flex items-center px-2 text-sm text-primary hover:underline">Effacer</Link>}
        </div>
      </form>

      <section className="space-y-2">
        <h2 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {liste.toutVoir
            ? (liste.filtres.delegue ? `Rapports de ${liste.delegues.find((d) => d.id === liste.filtres.delegue)?.nom ?? "ce délégué"}` : "Tous les rapports")
            : "Mes rapports"} ({liste.lignes.length})
          <InfoBulle label="Ce que la liste contient" align="left" className="normal-case tracking-normal">
            Les visites rapportées (planifiées ou hors plan), les comptes rendus vocaux sans visite
            {signalements ? " et les signalements de pharmacovigilance" : ""}. Les rapports se font depuis le Plan de tournée.
          </InfoBulle>
        </h2>
        {liste.tronquee && (
          <p className="text-xs text-warning">Liste limitée aux plus récents — resserrez la période.</p>
        )}
        <ListeRapports lignes={liste.lignes} avecDelegue={liste.toutVoir} />
      </section>
    </div>
  );
}
