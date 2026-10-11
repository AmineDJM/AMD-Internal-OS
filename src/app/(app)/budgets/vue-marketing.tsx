import type { CurrentUser } from "@/lib/session";
import { canManageEnvelope } from "@/lib/rbac";
import type { BudgetEnvelopeOption, BudgetOverview } from "@/lib/queries/budget";
import { rapportMarketing } from "@/lib/queries/budget-marketing-rapport";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs, type ModuleTab } from "@/components/shared/module-tabs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { dinar, disponible, pctPeriodeEcoulee, pourcent, rythme } from "@/lib/budget/marketing-vue";
import { BudgetContextBar } from "./budget-context-bar";
import { TableauMarketing } from "./marketing-tableau";

/**
 * BUDGET MARKETING — LA VUE D'ENSEMBLE (maquette validée par la Direction, 10/2026).
 *
 * UNE lecture de l'enveloppe en tête — le DISPONIBLE (enveloppe − payé − engagé), son rythme face à l'année, et une
 * seule barre payé / engagé / disponible avec le repère du jour — là où le même 77 % et le même reste s'affichaient
 * trois fois. Puis ce qui demande une décision, les filtres et leurs exports, six graphiques et le tableau par
 * catégorie (`marketing-tableau.tsx`). Montants arrondis au dinar.
 */

const dzd = (n: number) => `${dinar(n).toLocaleString("fr-FR")} DZD`;
const nb = (n: number) => dinar(n).toLocaleString("fr-FR");
const jourCourt = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

export async function VueEnsembleMarketing({ user, base, titre, description, overview, envelopes, tabs }: {
  user: CurrentUser;
  base: string;
  titre: string;
  description: string;
  overview: BudgetOverview;
  envelopes: BudgetEnvelopeOption[];
  tabs: ModuleTab[];
}) {
  const { rapport } = await rapportMarketing(user, overview);
  const t = overview.totals;
  const dispo = disponible(t.total, t.consumed, t.committed);
  const maintenant = new Date();
  const ecoule = pctPeriodeEcoulee(new Date(overview.envelope.periodStart), new Date(overview.envelope.periodEnd), maintenant);
  const utilise = pourcent(t.consumed + t.committed, t.total);
  const r = rythme(utilise, ecoule);
  const largeur = (v: number) => `${Math.min(100, Math.max(0, pourcent(v, t.total)))}%`;
  const env = overview.envelope.id;
  const q = `env=${encodeURIComponent(env)}`;
  const exportBase = `/api/budgets/marketing/export?${q}&from=${overview.period.from.slice(0, 10)}&to=${overview.period.to.slice(0, 10)}`;
  const pill = r.cle === "AU_RYTHME" ? "bg-success/10 text-success" : r.cle === "EN_AVANCE" ? "bg-warning/15 text-warning" : "bg-primary/10 text-primary";

  return (
    <div className="space-y-5">
      <PageHeader title={titre} description={description} />
      <ModuleTabs tabs={tabs} />
      <BudgetContextBar envelopes={envelopes} currentId={env} from={overview.period.from} to={overview.period.to} />

      {/* ── UNE SEULE LECTURE DE L'ENVELOPPE ─────────────────────────── */}
      <section className="surface min-w-0 rounded-xl">
        <div className="grid grid-cols-1 items-end gap-3 px-4 pb-1 pt-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              Disponible
              <InfoBulle label="À propos du disponible" align="left">Enveloppe − payé − engagé. Engagé = bons de commande émis et ordres de dépense pas encore payés.</InfoBulle>
            </p>
            <p className={`text-3xl font-bold tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-4xl ${dispo < 0 ? "text-destructive" : ""}`}>{dzd(dispo)}</p>
            <p className="text-sm text-muted-foreground">sur {dzd(t.total)}</p>
          </div>
          <div className="text-sm md:text-right">
            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${pill}`}>{r.libelle}</span>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">{Math.round(utilise)} % utilisé · {Math.round(ecoule)} % de l&apos;année écoulée</p>
          </div>
        </div>
        <div className="relative mx-4 mb-2 mt-7 flex h-3.5 rounded-full bg-muted sm:mx-5" role="img" aria-label={`Payé ${Math.round(pourcent(t.consumed, t.total))} %, engagé ${Math.round(pourcent(t.committed, t.total))} %, disponible ${Math.round(pourcent(Math.max(0, dispo), t.total))} %`}>
          <span className="h-full rounded-l-full bg-primary" style={{ width: largeur(t.consumed) }} />
          <span className="h-full bg-primary/40" style={{ width: largeur(Math.min(t.committed, Math.max(0, t.total - t.consumed))) }} />
          <span className="absolute -bottom-1 -top-1 w-0.5 bg-foreground" style={{ left: `${ecoule}%` }}>
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted-foreground">{jourCourt(maintenant)}</span>
          </span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 px-4 pb-4 pt-1 text-sm sm:px-5">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" />Payé <b className="tabular-nums">{nb(t.consumed)}</b></span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-primary/40" />Engagé, pas encore payé <b className="tabular-nums">{nb(t.committed)}</b></span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-muted ring-1 ring-border" />Disponible <b className={`tabular-nums ${dispo < 0 ? "text-destructive" : ""}`}>{nb(dispo)}</b></span>
        </div>
      </section>

      <TableauMarketing
        donnees={{
          enveloppe: rapport.enveloppe, categories: rapport.categories, sansCategorie: rapport.sansCategorie, faits: rapport.faits,
          engagements: rapport.engagements, demandes: rapport.demandes, moisEnveloppe: rapport.moisEnveloppe, n1: rapport.n1,
        }}
        reallocations={rapport.reallocations}
        pctEcoule={ecoule}
        peutReallouer={canManageEnvelope(user, overview.envelope)}
        liens={{ depenses: `${base}/depenses?${q}`, reglages: `${base}/reglages?${q}`, demandes: `${base}/ad-pro?${q}`, export: exportBase }}
      />
    </div>
  );
}
