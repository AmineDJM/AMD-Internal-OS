import Link from "next/link";
import { requireModule } from "@/lib/session";
import { getEnvelopes, getBudgetOverview } from "@/lib/queries/budget";
import { demandesAdProDeLEnveloppe } from "@/lib/queries/budget-marketing";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_MARKETING_TABS } from "@/lib/labels";
import { formatCurrency } from "@/lib/utils";
import { resolveBudgetEnvelope } from "@/lib/budget-scope";
import { BudgetContextBar } from "../../budgets/budget-context-bar";
import type { ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-2";

/**
 * BUDGET MARKETING — LES DEMANDES Ad & Pro QUI CONSOMMENT L'ENVELOPPE. Chaque poste accordé rangé dans une catégorie de
 * l'enveloppe, avec sa demande, son montant accordé, ce qui est engagé (ordre émis, non payé) et réglé.
 */
export default async function BudgetMarketingAdProPage({ searchParams }: { searchParams: ParamsBudget & { cat?: string } }) {
  const user = await requireModule("BUDGET_MARKETING");
  const opts = { portee: "MARKETING" as const };
  const [envelopes, tabs] = await Promise.all([getEnvelopes(user, opts), visibleTabs(user, BUDGET_MARKETING_TABS)]);
  const overview = await getBudgetOverview(user, resolveBudgetEnvelope(searchParams.env), null, null, opts);
  // « Voir les N demandes » d'une catégorie (vue d'ensemble) : la catégorie et ses sous-catégories seulement.
  const filtre = overview && searchParams.cat ? overview.categories.find((c) => c.id === searchParams.cat) ?? null : null;
  const categories = overview ? (filtre ? overview.categories.filter((c) => c.id === filtre.id || c.parentId === filtre.id) : overview.categories) : [];
  const lignes = overview ? await demandesAdProDeLEnveloppe(categories) : [];
  const somme = (k: "accorde" | "engage" | "regle") => lignes.reduce((a, l) => a + l[k], 0);

  return (
    <div className="space-y-5">
      <PageHeader title="Demandes Ad & Pro" description="Ce qui consomme l'enveloppe, demande par demande." />
      <ModuleTabs tabs={tabs} />
      {!overview ? (
        <EmptyState icon="Wallet" title="Aucune enveloppe marketing" description="Aucune enveloppe marketing ne vous est ouverte." />
      ) : (
        <>
          <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
          <section className="surface min-w-0 overflow-hidden rounded-xl">
            <header className="flex items-center gap-1.5 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">{filtre ? <>Postes rangés dans « {filtre.name} »</> : <>Postes rangés dans l&apos;enveloppe</>} <span className="font-normal text-muted-foreground">({lignes.length})</span></h2>
              {filtre && <Link href={`?env=${encodeURIComponent(overview.envelope.id)}`} className="text-xs text-primary hover:underline">Toutes les catégories</Link>}
              <InfoBulle label="À propos : postes Ad & Pro">
                Un poste Ad &amp; Pro accordé est rangé dans une catégorie de l&apos;enveloppe. Engagé = ordre de dépense émis, pas encore payé ; réglé = payé par les Finances.
              </InfoBulle>
            </header>
            {lignes.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">Aucun poste Ad &amp; Pro n&apos;est encore rangé dans cette enveloppe.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      <th className={TH}>Demande</th>
                      <th className={TH}>Nature</th>
                      <th className={TH}>Poste</th>
                      <th className={TH}>Catégorie</th>
                      <th className={TH}>Statut</th>
                      <th className={`${TH} text-right`}>Accordé</th>
                      <th className={`${TH} text-right`}>Engagé</th>
                      <th className={`${TH} text-right`}>Réglé</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {lignes.map((l) => (
                      <tr key={l.id} className="hover:bg-secondary/40">
                        <td className={`${TD} max-w-[18rem] truncate font-medium`}>
                          {l.href ? <Link href={l.href} className="text-primary hover:underline">{l.demande}</Link> : l.demande}
                        </td>
                        <td className={TD}>{l.nature}</td>
                        <td className={`${TD} max-w-[14rem] truncate`}>{l.poste}</td>
                        <td className={TD}>{l.categorie}</td>
                        <td className={TD}>{l.historique ? <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">Historique 2026{l.historique.ligne ? ` · L${l.historique.ligne}` : ""}</span> : l.statut}</td>
                        <td className={`${TD} text-right tabular-nums`}>{formatCurrency(l.accorde)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{l.engage ? formatCurrency(l.engage) : "—"}</td>
                        <td className={`${TD} text-right tabular-nums`}>{l.regle ? formatCurrency(l.regle) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-border font-semibold">
                    <tr>
                      <td className={TD} colSpan={5}>Total</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(somme("accorde"))}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(somme("engage"))}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(somme("regle"))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
