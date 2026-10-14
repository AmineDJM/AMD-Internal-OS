import { requireModule } from "@/lib/session";
import { assurerEnveloppeAnnuelle } from "@/lib/budget/enveloppes-pole";
import { canManageEnvelope } from "@/lib/rbac";
import { getEnvelopes, getBudgetOverview } from "@/lib/queries/budget";
import { vueMasseSalariale } from "@/lib/queries/budget-operations";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_OPERATIONS_TABS } from "@/lib/labels";
import { formatCurrency } from "@/lib/utils";
import { resolveBudgetEnvelope } from "@/lib/budget-scope";
import { BudgetContextBar } from "../../budgets/budget-context-bar";
import { CompleterCategories } from "../../budgets/gestes-pole";
import type { ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-2";
const court = (v: number) => (v === 0 ? "—" : formatCurrency(v));

/**
 * BUDGET OPERATIONS & SALES — LA MASSE SALARIALE DE LA FORCE DE VENTE (Direction, 08/10). Le budget de l'année (la
 * catégorie et ses sous-catégories par BU) face à la paie réelle, BU par BU et mois par mois. Des TOTAUX : le détail par
 * personne n'existe que pour qui voit les salaires (`voitLesSalaires`).
 */
export default async function BudgetOperationsMasseSalarialePage({ searchParams }: { searchParams: ParamsBudget }) {
  const user = await requireModule("BUDGET_OPERATIONS");
  // L'enveloppe de l'année existe d'emblée, masse salariale en tête (Direction, 10/2026) : rien à créer avant de saisir.
  await assurerEnveloppeAnnuelle("OPERATIONS", user);
  const opts = { portee: "OPERATIONS" as const };
  const [envelopes, tabs] = await Promise.all([getEnvelopes(user, opts), visibleTabs(user, BUDGET_OPERATIONS_TABS)]);
  const overview = await getBudgetOverview(user, resolveBudgetEnvelope(searchParams.env), null, null, opts);
  const donnees = overview ? await vueMasseSalariale(user, overview) : null;
  const gere = overview ? canManageEnvelope(user, overview.envelope) : false;

  return (
    <div className="space-y-5">
      <PageHeader title="Masse salariale" description="La paie de la force de vente, par BU et par mois, face au budget." />
      <ModuleTabs tabs={tabs} />
      {!overview || !donnees ? (
        <EmptyState icon="Wallet" title="Aucune enveloppe Operations & Sales" description="Aucune enveloppe Operations & Sales ne vous est ouverte." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
            {gere && (!donnees.mere || donnees.busSansBudget > 0) && (
              <CompleterCategories
                envelopeId={overview.envelope.id} domaine="OPERATIONS"
                libelle={donnees.mere ? `Ajouter les BU sans budget (${donnees.busSansBudget})` : "Ajouter la masse salariale"}
              />
            )}
          </div>

          <section className="surface p-4 sm:p-5">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Budget de l&apos;année</dt>
                <dd className="font-medium tabular-nums">{formatCurrency(donnees.vue.total.budget)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Réalisé (paie)</dt>
                <dd className="font-medium tabular-nums">{formatCurrency(donnees.vue.total.total)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Reste</dt>
                <dd className={`font-medium tabular-nums ${donnees.vue.total.budget - donnees.vue.total.total < 0 ? "text-destructive" : "text-success"}`}>
                  {formatCurrency(donnees.vue.total.budget - donnees.vue.total.total)}
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                  Effectif payé
                  <InfoBulle label="À propos : la force de vente">
                    Les KAM (profil actif), les superviseurs de BU, les salariés des sous-départements de BU et de la Direction commerciale.
                    Le réalisé est le coût employeur des bulletins (à défaut le brut). Des totaux seulement : le salaire d&apos;une personne n&apos;apparaît qu&apos;à qui gère les RH.
                  </InfoBulle>
                </dt>
                <dd className="font-medium tabular-nums">{donnees.vue.total.effectif}</dd>
              </div>
            </dl>
          </section>

          <section className="surface min-w-0 overflow-hidden rounded-xl">
            <header className="flex items-center gap-1.5 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Par BU et par mois</h2>
            </header>
            {donnees.vue.groupes.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">Aucune paie de la force de vente sur la période.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[64rem] text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      <th className={TH}>BU</th>
                      <th className={`${TH} text-right`}>Effectif</th>
                      <th className={`${TH} text-right`}>Budget</th>
                      {donnees.vue.mois.map((m) => <th key={m.cle} className={`${TH} text-right`}>{m.libelle}</th>)}
                      <th className={`${TH} text-right`}>Réalisé</th>
                      <th className={`${TH} text-right`}>%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {donnees.vue.groupes.map((g) => (
                      <tr key={g.cle} className="hover:bg-secondary/40">
                        <td className={`${TD} max-w-[14rem] truncate font-medium`}>{g.libelle}</td>
                        <td className={`${TD} text-right tabular-nums`}>{g.effectif}</td>
                        <td className={`${TD} text-right tabular-nums`}>{g.budget === null ? "—" : formatCurrency(g.budget)}</td>
                        {g.parMois.map((v, i) => <td key={donnees.vue.mois[i].cle} className={`${TD} text-right tabular-nums`}>{court(v)}</td>)}
                        <td className={`${TD} text-right font-semibold tabular-nums`}>{formatCurrency(g.total)}</td>
                        <td className={`${TD} text-right tabular-nums ${g.budget && g.total > g.budget ? "text-destructive" : "text-muted-foreground"}`}>
                          {g.budget ? `${Math.round((g.total / g.budget) * 100)} %` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-border font-semibold">
                    <tr>
                      <td className={TD}>Total</td>
                      <td className={`${TD} text-right tabular-nums`}>{donnees.vue.total.effectif}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(donnees.vue.total.budget)}</td>
                      {donnees.vue.total.parMois.map((v, i) => <td key={donnees.vue.mois[i].cle} className={`${TD} text-right tabular-nums`}>{court(v)}</td>)}
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(donnees.vue.total.total)}</td>
                      <td className={`${TD} text-right tabular-nums`}>
                        {donnees.vue.total.budget > 0 ? `${Math.round((donnees.vue.total.total / donnees.vue.total.budget) * 100)} %` : "—"}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
          {(donnees.vue.budgetNonReparti > 0 || donnees.vue.personnesDansLeTotalSeulement > 0) && (
            <p className="text-xs text-muted-foreground">
              {donnees.vue.budgetNonReparti > 0 && <>{formatCurrency(donnees.vue.budgetNonReparti)} de budget non réparti entre les BU. </>}
              {donnees.vue.personnesDansLeTotalSeulement > 0 && <>Une équipe d&apos;une personne n&apos;est comptée que dans le total.</>}
            </p>
          )}

          {donnees.voitLesSalaires && donnees.vue.parPersonne && donnees.vue.parPersonne.length > 0 && (
            <details className="surface min-w-0 overflow-hidden rounded-xl">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Détail par personne <span className="font-normal text-muted-foreground">({donnees.vue.parPersonne.length})</span></summary>
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[64rem] text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      <th className={TH}>Personne</th>
                      <th className={TH}>BU</th>
                      {donnees.vue.mois.map((m) => <th key={m.cle} className={`${TH} text-right`}>{m.libelle}</th>)}
                      <th className={`${TH} text-right`}>Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {donnees.vue.parPersonne.map((p) => (
                      <tr key={p.employeeId}>
                        <td className={`${TD} max-w-[14rem] truncate font-medium`}>{p.nom}</td>
                        <td className={`${TD} max-w-[12rem] truncate`}>{p.groupe}</td>
                        {p.parMois.map((v, i) => <td key={donnees.vue.mois[i].cle} className={`${TD} text-right tabular-nums`}>{court(v)}</td>)}
                        <td className={`${TD} text-right font-semibold tabular-nums`}>{formatCurrency(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
