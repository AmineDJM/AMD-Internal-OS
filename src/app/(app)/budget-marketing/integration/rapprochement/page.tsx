import Link from "next/link";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { resolveBudgetEnvelope } from "@/lib/budget-scope";
import { contexteIntegration, ongletsBudgetMarketing } from "@/lib/budget-marketing/onglets";
import { vueRapprochement } from "@/lib/budget-marketing/rapprochement-serveur";
import { EcranRapprochement } from "./ecran-rapprochement";

export const dynamic = "force-dynamic";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING › INTÉGRATION 2026 › RAPPROCHEMENT (Direction, 14/10/2026 : « ce qui a déjà été intégré au budget,
 * dans les demandes Ad & Pro ; chercher bien profond dans tous nos fichiers et les faire matcher, avec Luna »).
 *
 * Réservé à qui gère l'enveloppe du lot (les mêmes gardes que l'intégration, relues par chaque geste). Sans lot validé,
 * la page renvoie à l'assistant d'intégration — jamais de donnée d'exemple.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function RapprochementPage(props: { searchParams: Promise<{ env?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_MARKETING");
  const ctx = await contexteIntegration(user, await resolveBudgetEnvelope(searchParams.env));
  const tabs = await ongletsBudgetMarketing(user, ctx);
  const env = ctx.enveloppe;
  const vue = env?.lotActif ? await vueRapprochement(user, env.id) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Rapprochement Ad & Pro"
        description="Les dépenses hors postes et les pièces de la plateforme, rapprochées des demandes intégrées — proposées par le moteur et Luna, rattachées seulement après votre validation. Le livre de trésorerie et les ordres ne sont jamais modifiés."
      />
      <ModuleTabs tabs={tabs} />
      <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Intégration 2026">
        <Link href={env ? `/budget-marketing/integration?env=${encodeURIComponent(env.id)}` : "/budget-marketing/integration"} className="rounded-full border border-border px-3 py-1 hover:bg-secondary">← Le lot intégré</Link>
        {ctx.gerees.length > 1 && ctx.gerees.map((e) => (
          <Link key={e.id} href={`?env=${encodeURIComponent(e.id)}`} className={e.id === env?.id ? "rounded-full bg-primary px-3 py-1 text-primary-foreground" : "rounded-full border border-border px-3 py-1 hover:bg-secondary"}>
            {e.nom}{e.lotActif ? " · intégrée" : ""}
          </Link>
        ))}
      </nav>
      {!env ? (
        <EmptyState icon="Wallet" title="Aucune enveloppe à rapprocher" description="Le rapprochement porte sur une enveloppe Budget Marketing couvrant 2026 que vous gérez (gestionnaire de l'enveloppe ou Super Admin)." />
      ) : !vue ? (
        <EmptyState icon="Wallet" title="Aucun lot intégré sur cette enveloppe" description="Le rapprochement s'appuie sur les demandes du lot d'intégration 2026 : validez d'abord l'intégration du fichier « Dépenses AP »." />
      ) : (
        <EcranRapprochement vue={vue} />
      )}
    </div>
  );
}
