import Link from "next/link";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { resolveBudgetEnvelope } from "@/lib/budget-scope";
import { contexteIntegration, ongletsBudgetMarketing } from "@/lib/budget-marketing/onglets";
import { AssistantIntegration } from "./assistant-integration";
import { LotIntegre, type FiltreLot } from "./lot-integre";

export const dynamic = "force-dynamic";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING › INTÉGRATION 2026 — un ONGLET du module (maquette « onglets » validée, Direction 10/2026), réservé à
 * qui gère l'enveloppe, avec le nombre d'éléments « absents du fichier » à décider (`budget-marketing/onglets.ts`).
 *
 * Sans lot sur l'enveloppe : l'ASSISTANT en quatre étapes — lire le fichier, trouver ou créer chaque demande, les pièces
 * (facultatives à ce stade), vérifier puis valider (double confirmation, écriture d'un bloc). Une fois le lot validé, la
 * page bascule d'elle-même sur le LOT : suivi des pièces (filtre « pièces manquantes », `?filtre=manquantes`), chaque
 * demande en panneau, « Dans la plateforme, absentes du fichier » (`#absentes`, garder / sortir à tout moment) et
 * l'annulation d'un bloc, repliée. Une annulation ramène l'assistant.
 *
 * Porte : le module Budget Marketing pour entrer ; gérer l'enveloppe (gestionnaire, Super Admin) pour la voir et agir —
 * tenue par chaque action serveur, jamais par l'écran seul.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function IntegrationAdProPage(props: { searchParams: Promise<{ env?: string; filtre?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_MARKETING");
  const ctx = await contexteIntegration(user, await resolveBudgetEnvelope(searchParams.env));
  const tabs = await ongletsBudgetMarketing(user, ctx);
  const env = ctx.enveloppe;
  const lot = ctx.lot;
  const filtre: FiltreLot = searchParams.filtre === "manquantes" ? "MANQUANTES" : searchParams.filtre === "completes" ? "COMPLETES" : "TOUT";

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
          {ctx.gerees.length > 1 && (
            <nav className="flex flex-wrap gap-2 text-sm" aria-label="Enveloppe">
              {ctx.gerees.map((e) => (
                <Link key={e.id} href={`?env=${encodeURIComponent(e.id)}`} className={e.id === env.id ? "rounded-full bg-primary px-3 py-1 text-primary-foreground" : "rounded-full border border-border px-3 py-1 hover:bg-secondary"}>
                  {e.nom}{e.lotActif ? " · intégrée" : ""}
                </Link>
              ))}
            </nav>
          )}
          {lot && (
            // LE RAPPROCHEMENT (Direction, 14/10/2026) : dépenses hors postes et pièces de la plateforme → demandes du lot.
            <Link href={`/budget-marketing/integration/rapprochement?env=${encodeURIComponent(env.id)}`} className="surface flex flex-wrap items-center gap-2 rounded-xl px-4 py-3 text-sm hover:bg-secondary">
              <span className="font-semibold">Rapprochement assisté par Luna</span>
              <span className="min-w-0 flex-1 text-muted-foreground">Dépenses hors postes, écritures à imputer et pièces de la plateforme (Legal, Ad &amp; Pro, Drive…) proposées pour chaque demande — rattachées après validation.</span>
              <span className="text-primary">Ouvrir →</span>
            </Link>
          )}
          {lot ? <LotIntegre key={lot.id} lot={lot} enveloppe={env.nom} filtreInitial={filtre} /> : <AssistantIntegration envelopeId={env.id} enveloppe={env.nom} />}
        </>
      )}
    </div>
  );
}
