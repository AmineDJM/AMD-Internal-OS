import Link from "next/link";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_MARKETING_TABS } from "@/lib/labels";
import { enveloppesGerees, vueDuLot } from "@/lib/budget-marketing/integration-serveur";
import { AssistantIntegration } from "./assistant-integration";
import { LotIntegre } from "./lot-integre";

export const dynamic = "force-dynamic";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING › INTÉGRATION DES DÉPENSES RÉELLES AD & PRO 2026 (maquette « adpro-integration » validée).
 *
 * Sans lot sur l'enveloppe : l'ASSISTANT en quatre étapes — lire le fichier, trouver ou créer chaque demande, les pièces
 * (facultatives à ce stade), vérifier puis valider (double confirmation, écriture d'un bloc).
 * Avec un lot : ce qu'il a fait (30 demandes, pièces manquantes), la liste « Dans la plateforme, absentes du fichier »
 * (garder / sortir, à tout moment) et l'annulation d'un bloc.
 *
 * Porte : le module Budget Marketing pour entrer ; gérer l'enveloppe (gestionnaire, Super Admin) pour agir — tenue par
 * chaque action serveur, jamais par l'écran seul.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function IntegrationAdProPage({ searchParams }: { searchParams: { env?: string } }) {
  const user = await requireModule("BUDGET_MARKETING");
  const [tabs, enveloppes] = await Promise.all([visibleTabs(user, BUDGET_MARKETING_TABS), enveloppesGerees(user)]);
  const env = enveloppes.find((e) => e.id === searchParams.env) ?? enveloppes[0] ?? null;
  const lot = env?.lotActif ? await vueDuLot(user, env.id) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Intégration des dépenses réelles Ad & Pro 2026"
        description="Chaque dépense du fichier rejoint sa demande Ad & Pro, avec ses postes, ses pièces et son budget. Le livre de trésorerie et les ordres de paiement ne sont pas modifiés."
      />
      <ModuleTabs tabs={tabs} />
      {!env ? (
        <EmptyState icon="Wallet" title="Aucune enveloppe à intégrer" description="L'intégration se pose sur une enveloppe Budget Marketing couvrant 2026 que vous gérez (gestionnaire de l'enveloppe ou Super Admin)." />
      ) : (
        <>
          {enveloppes.length > 1 && (
            <nav className="flex flex-wrap gap-2 text-sm" aria-label="Enveloppe">
              {enveloppes.map((e) => (
                <Link key={e.id} href={`?env=${encodeURIComponent(e.id)}`} className={e.id === env.id ? "rounded-full bg-primary px-3 py-1 text-primary-foreground" : "rounded-full border border-border px-3 py-1 hover:bg-secondary"}>
                  {e.nom}{e.lotActif ? " · intégrée" : ""}
                </Link>
              ))}
            </nav>
          )}
          {lot ? <LotIntegre lot={lot} enveloppe={env.nom} /> : <AssistantIntegration envelopeId={env.id} enveloppe={env.nom} />}
        </>
      )}
    </div>
  );
}
