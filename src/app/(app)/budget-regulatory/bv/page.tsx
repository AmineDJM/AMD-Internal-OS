import Link from "next/link";
import { requireModule } from "@/lib/session";
import { canManageEnvelope } from "@/lib/rbac";
import { getEnvelopes, getBudgetOverview } from "@/lib/queries/budget";
import { vueBvParDossier } from "@/lib/queries/budget-regulatory";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_REGULATORY_TABS } from "@/lib/labels";
import { formatCurrency, formatDate } from "@/lib/utils";
import { resolveBudgetEnvelope } from "@/lib/budget-scope";
import type { CelluleBv, StatutBv } from "@/lib/budget-regulatory/bv";
import { BudgetContextBar } from "../../budgets/budget-context-bar";
import { CompleterCategories, SaisirBv, RangerBv } from "../../budgets/gestes-pole";
import type { ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-2";

const STATUT: Record<StatutBv, { libelle: string; ton: string }> = {
  PAYE: { libelle: "Payé", ton: "text-success" },
  DEMANDE: { libelle: "Demandé", ton: "text-warning" },
  PAYE_SANS_MONTANT: { libelle: "Payé · montant non saisi", ton: "text-muted-foreground" },
  A_VENIR: { libelle: "—", ton: "text-muted-foreground" },
};

function Montant({ c }: { c: CelluleBv }) {
  const m = c.paye + c.demande;
  return <>{m > 0 ? formatCurrency(m) : "—"}</>;
}

/**
 * BUDGET REGULATORY — LES BV PAR DOSSIER (Direction, 08/10). Chaque dossier d'enregistrement, son BV 25 % et son BV 75 %
 * (montant, statut, date), et le 75 % encore attendu — face aux deux catégories BV de l'enveloppe.
 */
export default async function BudgetRegulatoryBvPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_REGULATORY");
  const opts = { portee: "REGULATORY" as const };
  const [envelopes, tabs] = await Promise.all([getEnvelopes(user, opts), visibleTabs(user, BUDGET_REGULATORY_TABS)]);
  const overview = await getBudgetOverview(user, await resolveBudgetEnvelope(searchParams.env), null, null, opts);
  const vue = overview ? await vueBvParDossier(user, overview) : null;
  const gere = overview ? canManageEnvelope(user, overview.envelope) : false;

  return (
    <div className="space-y-5">
      <PageHeader title="BV par dossier" description="Les bons de versement 25 % et 75 %, dossier par dossier.">
        {overview && vue && gere && (vue.categories.bv25 || vue.categories.bv75) && <SaisirBv envelopeId={overview.envelope.id} dossiers={vue.dossiers} />}
      </PageHeader>
      <ModuleTabs tabs={tabs} />
      {!overview || !vue ? (
        <EmptyState icon="Wallet" title="Aucune enveloppe Regulatory" description="Aucune enveloppe Regulatory ne vous est ouverte." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
            {gere && (!vue.categories.bv25 || !vue.categories.bv75) && (
              <CompleterCategories envelopeId={overview.envelope.id} domaine="REGULATORY" libelle="Ajouter les catégories BV 25 % / 75 %" />
            )}
          </div>

          <Synthese vue={vue} />

          <section className="surface min-w-0 overflow-hidden rounded-xl">
            <header className="flex items-center gap-1.5 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Dossiers <span className="font-normal text-muted-foreground">({vue.lignes.length})</span></h2>
              <InfoBulle label="À propos : BV par dossier">
                BV 25 % : demandé en préparation, avant la présoumission. BV 75 % : demandé après l&apos;étude des modules 3-4-5, payé avant le dépôt.
                Un BV se demande depuis l&apos;étape du dossier ; il naît rangé dans la catégorie de sa part. « Ranger » y met un BV payé ou demandé ailleurs.
                « 75 % à venir » : trois fois le 25 % connu, tant que le 75 % n&apos;est pas demandé.
              </InfoBulle>
            </header>
            {vue.lignes.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">Aucun BV sur la période.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[62rem] text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      <th className={TH}>Dossier</th>
                      <th className={`${TH} text-right`}>BV 25 %</th>
                      <th className={TH}>Statut</th>
                      <th className={TH}>Le</th>
                      <th className={`${TH} text-right`}>BV 75 %</th>
                      <th className={TH}>Statut</th>
                      <th className={TH}>Le</th>
                      <th className={`${TH} text-right`}>75 % à venir</th>
                      {gere && <th className={TH}><span className="sr-only">Ranger</span></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {vue.lignes.map((l) => {
                      const aRanger = [...l.bv25.aImputer, ...l.bv75.aImputer];
                      return (
                        <tr key={l.dossierId} className="hover:bg-secondary/40">
                          <td className={`${TD} max-w-[18rem] truncate font-medium`}>
                            {vue.lienDossiers
                              ? <Link href={`/regulatory/${l.dossierId}`} className="text-primary hover:underline">{l.reference}</Link>
                              : l.reference}
                            <span className="ml-1.5 font-normal text-muted-foreground">{l.nom ?? l.dci}</span>
                          </td>
                          <td className={`${TD} text-right tabular-nums`}><Montant c={l.bv25} /></td>
                          <td className={`${TD} ${STATUT[l.bv25.statut].ton}`}>{STATUT[l.bv25.statut].libelle}</td>
                          <td className={TD}>{l.bv25.date ? formatDate(l.bv25.date) : "—"}</td>
                          <td className={`${TD} text-right tabular-nums`}><Montant c={l.bv75} /></td>
                          <td className={`${TD} ${STATUT[l.bv75.statut].ton}`}>{STATUT[l.bv75.statut].libelle}</td>
                          <td className={TD}>{l.bv75.date ? formatDate(l.bv75.date) : "—"}</td>
                          <td className={`${TD} text-right tabular-nums text-muted-foreground`}>{l.prevision75 > 0 ? formatCurrency(l.prevision75) : "—"}</td>
                          {gere && (
                            <td className={TD}>
                              <span className="flex flex-wrap gap-1">
                                {aRanger.map((a) => <RangerBv key={a.orderId} envelopeId={overview.envelope.id} orderId={a.orderId} paye={a.paye} />)}
                              </span>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t border-border font-semibold">
                    <tr>
                      <td className={TD}>Total</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(vue.lignes.reduce((a, l) => a + l.bv25.paye + l.bv25.demande, 0))}</td>
                      <td className={TD} colSpan={2} />
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(vue.lignes.reduce((a, l) => a + l.bv75.paye + l.bv75.demande, 0))}</td>
                      <td className={TD} colSpan={2} />
                      <td className={`${TD} text-right tabular-nums`}>{formatCurrency(vue.totaux.prevision75)}</td>
                      {gere && <td className={TD} />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
          {vue.saisiesSansDossier > 0 && (
            <p className="text-xs text-muted-foreground">
              {formatCurrency(vue.saisiesSansDossier)} de BV saisis sans dossier : comptés dans les catégories, absents du tableau.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Synthese({ vue }: { vue: NonNullable<Awaited<ReturnType<typeof vueBvParDossier>>> }) {
  const b25 = vue.categories.bv25;
  const b75 = vue.categories.bv75;
  const budget = (b25?.allocated ?? 0) + (b75?.allocated ?? 0);
  const consomme = (b25?.consumed ?? 0) + (b75?.consumed ?? 0);
  const reste = budget - consomme - vue.totaux.demande - vue.totaux.prevision75;
  const Case = ({ titre, valeur, sous, ton = "" }: { titre: string; valeur: number; sous?: string; ton?: string }) => (
    <div>
      <dt className="text-xs text-muted-foreground">{titre}</dt>
      <dd className={`font-medium tabular-nums ${ton}`}>{formatCurrency(valeur)}</dd>
      {sous && <dd className="text-xs text-muted-foreground tabular-nums">{sous}</dd>}
    </div>
  );
  return (
    <section className="surface p-4 sm:p-5">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-5">
        <Case titre="BV 25 % — budget" valeur={b25?.allocated ?? 0} sous={`consommé ${formatCurrency(b25?.consumed ?? 0)}`} />
        <Case titre="BV 75 % — budget" valeur={b75?.allocated ?? 0} sous={`consommé ${formatCurrency(b75?.consumed ?? 0)}`} />
        <Case titre="Demandé, non réglé" valeur={vue.totaux.demande} />
        <Case titre="75 % à venir (estimé)" valeur={vue.totaux.prevision75} />
        <Case titre="Reste après prévision" valeur={reste} ton={reste < 0 ? "text-destructive" : "text-success"} />
      </dl>
    </section>
  );
}
