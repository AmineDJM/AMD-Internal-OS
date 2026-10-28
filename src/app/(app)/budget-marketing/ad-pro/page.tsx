import { requireModule } from "@/lib/session";
import { getEnvelopes, getBudgetOverview } from "@/lib/queries/budget";
import { demandesAdProDeLEnveloppe } from "@/lib/queries/budget-marketing";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { resolveBudgetEnvelope } from "@/lib/budget-scope";
import { arbreCategories } from "@/lib/budget/marketing-vue";
import { filtresDemandesDepuis, regrouperParDemande, type InfoLotDemande } from "@/lib/budget-marketing/demandes-vue";
import { vueDuLot } from "@/lib/budget-marketing/integration-serveur";
import { contexteIntegration, ongletsBudgetMarketing } from "@/lib/budget-marketing/onglets";
import { BudgetContextBar } from "../../budgets/budget-context-bar";
import type { ParamsBudget } from "../../budgets/vues-budget";
import { DemandesAdPro, type CategorieFiltre } from "./demandes-adpro";

export const dynamic = "force-dynamic";

/**
 * BUDGET MARKETING — LES DEMANDES Ad & Pro QUI CONSOMMENT L'ENVELOPPE (maquette « onglets » validée, Direction 10/2026).
 *
 * UNE LIGNE PAR DEMANDE, ses postes et leur imputation dessous ; tuiles, filtres (statut dont « pièces manquantes »,
 * catégorie sous-catégories comprises, origine, recherche) tenus dans l'adresse ; la fiche en panneau latéral. Les postes
 * sont lus par `demandesAdProDeLEnveloppe` (règle d'intégration comprise), regroupés par `budget-marketing/demandes-vue.ts` ;
 * les pièces attendues / manquantes viennent du lot d'intégration 2026 de l'enveloppe (`vueDuLot`).
 */
export default async function BudgetMarketingAdProPage(
  props: { searchParams: Promise<ParamsBudget & { cat?: string; statut?: string; origine?: string; q?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_MARKETING");
  const opts = { portee: "MARKETING" as const };
  const envelopes = await getEnvelopes(user, opts);
  const overview = await getBudgetOverview(user, await resolveBudgetEnvelope(searchParams.env), null, null, opts);
  const lot = overview?.integration ? await vueDuLot(user, overview.envelope.id) : null;
  const tabs = await ongletsBudgetMarketing(user, await contexteIntegration(user, overview?.envelope.id ?? await resolveBudgetEnvelope(searchParams.env), overview ? { envelopeId: overview.envelope.id, lot } : undefined));

  const lignes = overview ? await demandesAdProDeLEnveloppe(overview.categories) : [];
  const infoLot: Record<string, InfoLotDemande> = {};
  for (const d of lot?.demandes ?? []) {
    infoLot[`${d.type}:${d.demandeId}`] = { mode: d.mode, lignes: d.lignes.length ? d.lignes : [d.ligne], attendues: d.attendues, manquantes: d.manquantes, demandeurAffiche: d.demandeurAffiche };
  }
  const demandes = regrouperParDemande(lignes, infoLot);
  // Le sélecteur : chaque catégorie de tête, puis ses sous-catégories (« › Symposium »).
  const categories: CategorieFiltre[] = overview
    ? arbreCategories(overview.categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, allocated: c.allocated, consumed: c.consumed, committed: c.committed })))
      .flatMap((t) => [{ id: t.id, nom: t.nom, parentId: null, sous: t.sous.length }, ...t.sous.map((s) => ({ id: s.id, nom: s.nom, parentId: t.id, sous: 0 }))])
    : [];
  const initiaux = filtresDemandesDepuis(searchParams, categories);

  return (
    <div className="space-y-5">
      <PageHeader title="Demandes Ad & Pro" description="Ce qui consomme l'enveloppe, demande par demande." />
      <ModuleTabs tabs={tabs} />
      {!overview ? (
        <EmptyState icon="Wallet" title="Aucune enveloppe marketing" description="Aucune enveloppe marketing ne vous est ouverte." />
      ) : (
        <>
          <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
          <DemandesAdPro key={overview.envelope.id} demandes={demandes} categories={categories} initiaux={initiaux} envelopeId={overview.envelope.id} />
        </>
      )}
    </div>
  );
}
