import Link from "next/link";
import { cumulerSousCategories } from "@/lib/budget/cumul-categories";
import { ArrowRight, Download } from "lucide-react";
import type { CurrentUser } from "@/lib/session";
import { canManageEnvelopes, canManageEnvelope, canGovernPoleEnvelope, hasGlobalView, peutBudgetDuPole, userCan } from "@/lib/rbac";
import { canOpenModule } from "@/lib/modules-visibility";
import { prisma } from "@/lib/prisma";
import { getEnvelopes, getBudgetOverview, getEnvelopesGrandTotal, type BudgetOverview } from "@/lib/queries/budget";
import { depensesPostesMarketing } from "@/lib/queries/budget-marketing-depenses";
import { horsPostesAdPro, TITRE_DEJA_IMPUTE_HORS_POSTES } from "@/lib/budget-marketing/depenses-autres";
import { rapprochementDesAImputer } from "@/lib/budget-marketing/rapprochement-serveur";
import { libelleRattachement, optionsRattachement } from "@/lib/queries/budget-marketing";
import { getAppSettings } from "@/lib/settings";
import { getMyCompanies } from "@/lib/company";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_TABS, BUDGET_MARKETING_TABS, BUDGET_REGULATORY_TABS, BUDGET_OPERATIONS_TABS, type NavTab } from "@/lib/labels";
import { Donut } from "@/components/charts/donut";
import { Trend } from "@/components/charts/trend";
import { Bars, Meter } from "@/components/charts/bars";
import { foldTail } from "@/components/charts/palette";
import { formatCurrency } from "@/lib/utils";
import { resolveBudgetEnvelope } from "@/lib/budget-scope";
import { DOMAINES, poleDe, type DomainePole, type PorteeBudget } from "@/lib/budget/domaines";
import { ecrituresDeLaForceDeVente } from "@/lib/queries/budget-operations";
import { BudgetContextBar } from "./budget-context-bar";
import { BudgetExpenses } from "./budget-expenses";
import { AlerteAImputer } from "./alerte-a-imputer";
import { DepensesMarketing } from "./depenses-marketing";
import { BudgetSettings } from "./budget-settings";
import { CreateEnvelopeButton } from "./budget-forms";
import { NouvelleEnveloppePole } from "./enveloppe-marketing-forms";
import { VueEnsembleRegulatory } from "./vue-regulatory";
import { VueEnsembleMarketing } from "./vue-marketing";
import { SurlignerCible } from "@/components/shared/surligner-cible";
import { contexteIntegration, ongletsBudgetMarketing } from "@/lib/budget-marketing/onglets";
import { vueDuLot, type VueLot } from "@/lib/budget-marketing/integration-serveur";
import { ancreCategorieBudget } from "@/lib/chemins/budgets";

/**
 * LES ÉCRANS DES BUDGETS, POUR QUATRE PORTÉES (Budget Marketing, puis Budget Regulatory et Budget Operations & Sales,
 * Direction 08/10).
 *
 * Budgets (`/budgets`) lit toutes les enveloppes visibles ; chaque module de pôle (`/budget-marketing`,
 * `/budget-regulatory`, `/budget-operations`) les seules enveloppes de son `domaine`. Ce sont les MÊMES écrans et les
 * MÊMES requêtes, avec une portée — jamais une copie : un chiffre corrigé ici l'est là-bas. Dans Budgets, une enveloppe
 * de pôle se lit mais ne se règle plus : elle dit où elle se gère.
 */

export type ParamsBudget = {
  env?: string; from?: string; to?: string;
  /** Ancre de la ligne dont parle une notification (`categorie-budget-<id>`) : elle vient sous les yeux et s'entoure. */
  cible?: string;
};

interface Config { portee: PorteeBudget; base: string; titre: string }

const configDuPole = (pole: DomainePole): Config => ({ portee: pole, base: DOMAINES[pole].chemin, titre: DOMAINES[pole].titre });

export const CONFIG_BUDGETS: Config = { portee: "TOUT", base: "/budgets", titre: "Budgets" };
export const CONFIG_BUDGET_MARKETING: Config = configDuPole("MARKETING");
export const CONFIG_BUDGET_REGULATORY: Config = configDuPole("REGULATORY");
export const CONFIG_BUDGET_OPERATIONS: Config = configDuPole("OPERATIONS");

const periode = (sp: ParamsBudget) => ({
  from: sp.from ? new Date(sp.from) : null,
  to: sp.to ? new Date(sp.to) : null,
});

const ONGLETS: Record<PorteeBudget, NavTab[]> = {
  TOUT: BUDGET_TABS,
  MARKETING: BUDGET_MARKETING_TABS,
  REGULATORY: BUDGET_REGULATORY_TABS,
  OPERATIONS: BUDGET_OPERATIONS_TABS,
};
/**
 * Les onglets d'une portée. BUDGET MARKETING ajoute « Intégration 2026 » à qui gère une enveloppe 2026, avec le nombre
 * d'éléments à décider sur l'enveloppe regardée (`budget-marketing/onglets.ts`) ; `lotConnu` évite de relire un lot.
 */
async function ongletsDe(user: CurrentUser, c: Config, envIdVu: string | null = null, lotConnu?: { envelopeId: string; lot: VueLot | null }) {
  if (c.portee !== "MARKETING") return visibleTabs(user, ONGLETS[c.portee]);
  return ongletsBudgetMarketing(user, await contexteIntegration(user, envIdVu, lotConnu));
}
const poleDeLaConfig = (c: Config): DomainePole | null => (c.portee === "TOUT" ? null : c.portee);

/** Dans Budgets : le mot qui dit qu'une enveloppe se gère dans le budget de son pôle (lien si la personne y a accès). */
export function GerePar({ user, domaine }: { user: CurrentUser; domaine: DomainePole }) {
  const d = DOMAINES[domaine];
  return peutBudgetDuPole(user, domaine, "VIEW")
    ? <Link href={d.chemin} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">Géré par {d.gestionnaire} <ArrowRight className="h-3 w-3" /> {d.titre}</Link>
    : <span>Géré par {d.gestionnaire}</span>;
}

// ───────────────────────────── Vue d'ensemble ─────────────────────────────

export async function VueEnsembleBudget({ user, searchParams, config }: { user: CurrentUser; searchParams: ParamsBudget; config: Config }) {
  const opts = { portee: config.portee };
  const [envelopes, grandTotal] = await Promise.all([
    getEnvelopes(user, opts),
    getEnvelopesGrandTotal(user, opts),
  ]);
  const { from, to } = periode(searchParams);
  const overview = await getBudgetOverview(user, await resolveBudgetEnvelope(searchParams.env), from, to, opts);
  const pole = poleDeLaConfig(config);
  // Budget Marketing : le lot d'intégration de l'enveloppe regardée (« À traiter », onglet Intégration) — lu une fois.
  const lot = pole === "MARKETING" && overview?.integration ? await vueDuLot(user, overview.envelope.id) : null;
  const tabs = await ongletsDe(user, config, overview?.envelope.id ?? await resolveBudgetEnvelope(searchParams.env), overview ? { envelopeId: overview.envelope.id, lot } : undefined);
  const description = pole ? DOMAINES[pole].description : "Où en est votre budget, en un coup d'œil.";

  if (!overview) {
    return (
      <div className="space-y-5">
        <PageHeader title={config.titre} description={description} />
        <ModuleTabs tabs={tabs} />
        <EmptyState
          icon="Wallet"
          title={pole ? `Aucune enveloppe ${DOMAINES[pole].court}` : "Aucune enveloppe budgétaire"}
          description={pole
            ? (canGovernPoleEnvelope(user, pole, "CREATE") ? "Créez-la depuis l'onglet Réglages." : `Aucune enveloppe ${DOMAINES[pole].court} ne vous est ouverte.`)
            : canManageEnvelopes(user)
              ? "Créez une enveloppe depuis l'onglet Réglages : un budget total pour une période, que vous répartirez ensuite en catégories."
              : "Aucune enveloppe ne vous est ouverte pour le moment."}
        />
      </div>
    );
  }

  // « Les imputer » mène à l'onglet Dépenses de Budgets, le seul où la liste « À imputer » se travaille.
  const lienAImputer = pole ? await lienAImputerBudgets(user, overview.envelope.id) : `${config.base}/depenses?env=${overview.envelope.id}`;

  // BUDGET REGULATORY a sa vue d'ensemble allégée (Direction, 09/10) ; les autres portées gardent celle-ci, inchangée.
  if (pole === "REGULATORY") {
    return (
      <>
        <SurlignerCible ids={[searchParams.cible]} />
        <VueEnsembleRegulatory
          user={user} base={config.base} titre={config.titre} overview={overview} envelopes={envelopes} tabs={tabs} lienAImputer={lienAImputer}
          exportHref={`/api/budgets/export?env=${overview.envelope.id}&from=${overview.period.from.slice(0, 10)}&to=${overview.period.to.slice(0, 10)}&portee=regulatory`}
        />
      </>
    );
  }

  // BUDGET MARKETING a sa vue d'ensemble refaite (maquette validée, Direction 10/2026) : un disponible, « À traiter »,
  // six graphiques filtrables et exportables, le tableau par catégorie et la réallocation.
  if (pole === "MARKETING") {
    return (
      <>
        <SurlignerCible ids={[searchParams.cible]} />
        <VueEnsembleMarketing user={user} base={config.base} titre={config.titre} description={description} overview={overview} envelopes={envelopes} tabs={tabs} lot={lot} />
      </>
    );
  }

  const t = overview.totals;
  const topCats =overview.categories.filter((c) => c.parentId === null);
  const gPct = grandTotal.total > 0 ? Math.round((grandTotal.consumed / grandTotal.total) * 100) : 0;
  // Camembert : comment le budget est RÉPARTI (au plus 6 parts — au-delà, l'œil ne compare plus).
  const allocSlices = foldTail(topCats.map((c) => ({ label: c.name, value: c.allocated })));
  // Barres : où en est CHAQUE catégorie (statut, pas identité).
  // Une catégorie comprend ses sous-catégories (`budget/cumul-categories.ts`).
  const cumul = cumulerSousCategories(overview.categories);
  const barRows = topCats
    .map((c) => ({ ...c, consumed: cumul.get(c.id)?.consumed ?? c.consumed }))
    .filter((c) => c.allocated > 0 || c.consumed > 0)
    .sort((a, b) => b.consumed - a.consumed)
    .map((c) => ({ id: ancreCategorieBudget(c.id), label: c.name, budget: c.allocated, consumed: c.consumed }));
  // Camembert de tête : plusieurs enveloppes → comment le budget global se répartit entre elles.
  const envSlices = grandTotal.count > 1
    ? foldTail(grandTotal.items.filter((e) => e.total > 0).map((e) => ({ label: e.name, value: e.total })))
    : [];
  const trendPoints = overview.monthly.map((m) => ({ label: m.label, value: m.cumulative, expected: m.expected }));
  const exportHref = `/api/budgets/export?env=${overview.envelope.id}&from=${overview.period.from.slice(0, 10)}&to=${overview.period.to.slice(0, 10)}${pole ? `&portee=${pole.toLowerCase()}` : ""}`;

  return (
    <div className="space-y-5">
      <SurlignerCible ids={[searchParams.cible]} />
      <PageHeader title={config.titre} description={description}>
        <a
          href={exportHref}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-secondary sm:min-h-0 sm:px-2.5"
          title="Exporter en Excel"
        >
          <Download className="h-4 w-4" /> Excel
        </a>
      </PageHeader>
      <ModuleTabs tabs={tabs} />

      {/*
        LA VUE GLOBALE, TOUJOURS EN TÊTE — toutes enveloppes (de la portée) confondues. Elle reste affichée même
        lorsqu'il n'y a qu'une seule enveloppe — le jour où une deuxième apparaît, le total change tout seul.
      */}
      <section className="surface p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <div>
            <p className="text-sm text-muted-foreground">
              {pole ? `Budget ${DOMAINES[pole].court}` : "Budget global"} — {grandTotal.count} enveloppe{grandTotal.count > 1 ? "s" : ""}
            </p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{formatCurrency(grandTotal.total)}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Consommé <strong className="text-foreground tabular-nums">{formatCurrency(grandTotal.consumed)}</strong> ({gPct} %) ·
            reste <strong className={`tabular-nums ${grandTotal.remaining < 0 ? "text-destructive" : "text-success"}`}>{formatCurrency(grandTotal.remaining)}</strong>
          </p>
        </div>
        <div className="mt-4">
          <Meter value={grandTotal.consumed} limit={grandTotal.total} format={formatCurrency} />
        </div>
        {grandTotal.items.length > 0 && (
          <ul className="mt-4 divide-y divide-border border-t border-border">
            {grandTotal.items.map((e) => {
              const pct = e.total > 0 ? Math.round((e.consumed / e.total) * 100) : 0;
              const poleDeE = poleDe(e);
              return (
                <li key={e.id}>
                  <Link
                    href={`${config.base}?env=${e.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2.5 text-sm transition-colors hover:bg-secondary/60"
                  >
                    <span className={`min-w-0 flex-1 truncate font-medium ${e.id === overview.envelope.id ? "text-primary" : ""}`}>
                      {e.name}
                      {!e.isActive && <span className="ml-2 text-xs font-normal text-muted-foreground">(clôturée)</span>}
                      {!pole && poleDeE && <span className="ml-2 text-xs font-normal text-muted-foreground">· {DOMAINES[poleDeE].etiquette}</span>}
                    </span>
                    <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatCurrency(e.consumed)} / {formatCurrency(e.total)}</span>
                    <span className={`w-12 shrink-0 text-right tabular-nums ${e.remaining < 0 ? "text-destructive" : "text-muted-foreground"}`}>{pct} %</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
        {!pole && poleDe(overview.envelope) && <span className="text-xs text-muted-foreground"><GerePar user={user} domaine={poleDe(overview.envelope)!} /></span>}
      </div>

      {/* LE chiffre : ce qui reste. Puis la jauge, puis les montants de contexte. */}
      <section className="surface p-4 sm:p-5">
        <p className="text-sm text-muted-foreground">Il vous reste</p>
        <p className={`mt-1 text-3xl font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-5xl ${t.remaining < 0 ? "text-destructive" : ""}`}>
          {formatCurrency(t.remaining)}
        </p>
        <div className="mt-4 max-w-xl">
          <Meter value={t.consumed} limit={t.total} format={formatCurrency} />
        </div>
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t sm:gap-x-8 border-border pt-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Budget de l&apos;enveloppe</dt>
            <dd className="font-medium tabular-nums">{formatCurrency(t.total)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Consommé</dt>
            <dd className="font-medium tabular-nums">{formatCurrency(t.consumed)}</dd>
          </div>
          {(t.committed > 0 || pole) && (
            <div>
              <dt className="text-xs text-muted-foreground">Engagé (non encore réglé)</dt>
              <dd className="font-medium tabular-nums">{formatCurrency(t.committed)}</dd>
            </div>
          )}
          {pole && (
            <div>
              <dt className="text-xs text-muted-foreground">Disponible</dt>
              <dd className={`font-medium tabular-nums ${t.total - t.consumed - t.committed < 0 ? "text-destructive" : ""}`}>{formatCurrency(t.total - t.consumed - t.committed)}</dd>
            </div>
          )}
          {t.unallocated !== 0 && (
            <div>
              <dt className="text-xs text-muted-foreground">Non réparti en catégories</dt>
              <dd className={`font-medium tabular-nums ${t.unallocated < 0 ? "text-destructive" : ""}`}>{formatCurrency(t.unallocated)}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* Une seule alerte, actionnable, plutôt qu'une section de liste dépliée — l'imputation se fait dans Budgets. */}
      {overview.unattributed.total > 0 && (
        <AlerteAImputer href={lienAImputer} total={overview.unattributed.total} action="Les imputer" className="py-3">
          de dépenses ne sont rattachées à aucune catégorie — elles faussent la lecture ci-dessus.
        </AlerteAImputer>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="surface space-y-3 p-3 sm:p-4">
          <h2 className="text-sm font-semibold">Comment le budget est réparti</h2>
          {allocSlices.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Le budget n&apos;est pas encore réparti en catégories.
            </p>
          ) : (
            <Donut
              slices={allocSlices}
              total={t.total}
              centerLabel="réparti"
              centerValue={formatCurrency(t.allocated)}
              format={formatCurrency}
            />
          )}
        </section>

        <section className="surface space-y-3 p-3 sm:p-4">
          <h2 className="text-sm font-semibold">Consommation dans le temps</h2>
          <Trend points={trendPoints} format={formatCurrency} />
        </section>
      </div>

      {barRows.length > 0 && (
        <section className="surface space-y-4 p-3 sm:p-4">
          <h2 className="text-sm font-semibold">Où en est chaque catégorie</h2>
          <Bars rows={barRows} format={formatCurrency} />
        </section>
      )}

      {/* Le poids relatif des enveloppes — les chiffres sont déjà en tête, ici c'est la forme. */}
      {envSlices.length > 0 && (
        <section className="surface space-y-3 p-3 sm:p-4">
          <h2 className="text-sm font-semibold">Répartition entre les enveloppes</h2>
          <Donut
            slices={envSlices}
            total={grandTotal.total}
            centerLabel="budget cumulé"
            centerValue={formatCurrency(grandTotal.total)}
            format={formatCurrency}
          />
        </section>
      )}
    </div>
  );
}

// ───────────────────────────── Dépenses ─────────────────────────────

/**
 * « À IMPUTER » NE SE TRAVAILLE QUE DANS BUDGETS (Direction, 19/10/2026 : « ça doit être que dans le module Budgets, par
 * Budget Marketing etc. ») — onglet Dépenses, l'enveloppe choisie, ses catégories dans « Imputer à… ». Un budget de pôle
 * n'en montre que le compte, avec le lien vers cette enveloppe dans Budgets — ou rien de cliquable si la personne n'y
 * entre pas. `null` : pas de lien.
 */
export async function lienAImputerBudgets(user: CurrentUser, envelopeId: string): Promise<string | null> {
  if (!userCan(user, "BUDGETS", "VIEW")) return null;
  const { hiddenModules } = await getAppSettings();
  if (!canOpenModule("BUDGETS", hiddenModules, { isSuperAdmin: user.role === "SUPER_ADMIN" })) return null;
  return `/budgets/depenses?env=${envelopeId}`;
}

/**
 * La liste « À imputer » d'UNE enveloppe : sans les écritures que le Rapprochement Ad & Pro a rattachées à une demande
 * (preuve de paiement d'un poste déjà au budget — retirées, et de leur total) ; celles dites « pas Ad & Pro » et, sur une
 * enveloppe Operations & Sales, ce que la force de vente a demandé portent leur étiquette. Rien n'est imputé ici.
 */
async function aImputerDeLEnveloppe(overview: BudgetOverview) {
  const rapp = await rapprochementDesAImputer(overview.envelope.id, new Date(overview.period.from), new Date(overview.period.to), overview.envelope.companyId);
  const unattributed: BudgetOverview["unattributed"] = {
    total: Math.max(0, overview.unattributed.total - rapp.total),
    count: Math.max(0, overview.unattributed.count - rapp.nombre),
    transactions: overview.unattributed.transactions.filter((t) => !rapp.rattachees.has(t.id)),
  };
  const forceDeVente = poleDe(overview.envelope) === "OPERATIONS"
    ? await ecrituresDeLaForceDeVente(unattributed.transactions.map((t) => t.id))
    : new Set<string>();
  const marques: Record<string, string> = { ...rapp.pasAdPro, ...Object.fromEntries([...forceDeVente].map((id) => [id, "Force de vente"])) };
  const note = rapp.nombre > 0 ? `${rapp.nombre} écriture${rapp.nombre > 1 ? "s" : ""} rattachée${rapp.nombre > 1 ? "s" : ""} à une demande Ad & Pro par le Rapprochement (preuve de paiement d'un poste déjà au budget) : retirée${rapp.nombre > 1 ? "s" : ""} de cette liste.` : null;
  return { unattributed, marques, note };
}

export async function VueDepensesBudget({ user, searchParams, config }: { user: CurrentUser; searchParams: ParamsBudget; config: Config }) {
  const opts = { portee: config.portee };
  const [envelopes, societes] = await Promise.all([getEnvelopes(user, opts), getMyCompanies(user.id)]);
  const { from, to } = periode(searchParams);
  const overview = await getBudgetOverview(user, await resolveBudgetEnvelope(searchParams.env), from, to, opts);
  const tabs = await ongletsDe(user, config, overview?.envelope.id ?? await resolveBudgetEnvelope(searchParams.env));

  const canManageContent = overview ? canManageEnvelope(user, overview.envelope) : canManageEnvelopes(user);
  const canAttribute = hasGlobalView(user.role) || canManageContent;
  // Dans Budgets, une enveloppe de pôle se lit : ses lignes budgétaires se tiennent dans le budget de son pôle.
  const poleTenant = config.portee === "TOUT" && overview !== null ? poleDe(overview.envelope) : null;
  const tenueAilleurs = poleTenant !== null;
  const aImputer = overview ? await aImputerDeLEnveloppe(overview) : null;
  // Hors de Budgets, « À imputer » n'est qu'un compte et un lien (`lienAImputerBudgets`).
  const renvoiAImputer = config.portee !== "TOUT" && overview && aImputer
    ? { href: await lienAImputerBudgets(user, overview.envelope.id), total: aImputer.unattributed.total, count: aImputer.unattributed.count }
    : undefined;

  // BUDGET MARKETING (maquette validée, 10/2026) : les postes Ad & Pro à BC signé — à imputer, engagés, consommés, payés,
  // annulés — puis, dans une seconde section, les autres dépenses de l'enveloppe (lignes budgétaires, déjà imputé…).
  if (config.portee === "MARKETING" && overview && aImputer) {
    const { donnees, ecritures } = await depensesPostesMarketing(user, overview);
    // « Déjà imputé » ne relit pas le tableau des postes (Direction, 14/10/2026) : ni les postes Historique 2026, ni les
    // écritures réglées par l'ordre d'un poste — seulement les dépenses HORS postes (`budget-marketing/depenses-autres.ts`).
    const horsPostes = horsPostesAdPro(overview.attributed.transactions, ecritures);
    const autres: BudgetOverview = {
      ...overview,
      unattributed: aImputer.unattributed,
      attributed: { count: horsPostes.length, transactions: horsPostes },
    };
    return (
      <div className="space-y-5">
        <PageHeader
          title={config.titre}
          description="Une dépense devient engagée quand la Direction Marketing l'impute à un budget, après signature du ou des bons de commande. Elle devient consommée quand on confirme l'avoir reçue, puis payée par les Finances. L'imputation se change à tout moment."
        />
        <ModuleTabs tabs={tabs} />
        <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
        <DepensesMarketing donnees={donnees} annee={overview.envelope.periodStart.slice(0, 4)} enveloppe={overview.envelope.name} />
        <section className="space-y-3" aria-label="Les autres dépenses de l'enveloppe">
          <div>
            <h2 className="text-base font-semibold">Autres dépenses de l&apos;enveloppe</h2>
            <p className="text-sm text-muted-foreground">Lignes budgétaires et dépenses déjà imputées hors postes Ad &amp; Pro — les postes, historiques compris, sont dans le tableau ci-dessus.</p>
          </div>
          <BudgetExpenses
            overview={autres}
            canAttribute={canAttribute}
            canEditLines={canAttribute}
            canDelete={user.role === "SUPER_ADMIN"}
            societes={societes.map((s) => ({ id: s.id, nom: s.shortName || s.name }))}
            titreImpute={TITRE_DEJA_IMPUTE_HORS_POSTES}
            renvoiAImputer={renvoiAImputer}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Dépenses" description="Rattachez chaque dépense à une catégorie — c'est ce qui rend la vue d'ensemble juste." />
      <ModuleTabs tabs={tabs} />
      {!overview ? (
        <EmptyState icon="Wallet" title="Aucune enveloppe budgétaire" description="Aucune enveloppe ne vous est ouverte pour le moment." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
            {poleTenant && <span className="text-xs text-muted-foreground"><GerePar user={user} domaine={poleTenant} /></span>}
          </div>
          <BudgetExpenses
            overview={aImputer ? { ...overview, unattributed: aImputer.unattributed } : overview}
            canAttribute={canAttribute}
            canEditLines={canAttribute && !tenueAilleurs}
            canDelete={user.role === "SUPER_ADMIN"}
            societes={societes.map((s) => ({ id: s.id, nom: s.shortName || s.name }))}
            marques={aImputer?.marques}
            noteAImputer={aImputer?.note}
            renvoiAImputer={renvoiAImputer}
          />
        </>
      )}
    </div>
  );
}

// ───────────────────────────── Réglages ─────────────────────────────

export async function VueReglagesBudget({ user, searchParams, config }: { user: CurrentUser; searchParams: ParamsBudget; config: Config }) {
  const opts = { portee: config.portee };
  const pole = poleDeLaConfig(config);
  // GOUVERNANCE des accès (créer/modifier/supprimer une enveloppe générale, régler ses listes d'accès et le budget
  // total) : prérogative Super Admin. Une enveloppe de pôle se gouverne aussi par le module de budget de son pôle.
  const canManageAccess = canManageEnvelopes(user);

  const [envelopes, settings, users, rattachements] = await Promise.all([
    getEnvelopes(user, opts),
    getAppSettings(),
    canManageAccess && !pole
      ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([] as { id: string; name: string }[]),
    pole ? optionsRattachement() : Promise.resolve(null),
  ]);
  const { from, to } = periode(searchParams);
  const overview = await getBudgetOverview(user, await resolveBudgetEnvelope(searchParams.env), from, to, opts);
  const tabs = await ongletsDe(user, config, overview?.envelope.id ?? await resolveBudgetEnvelope(searchParams.env));
  const poleTenant = !pole && overview !== null ? poleDe(overview.envelope) : null;
  const tenueAilleurs = poleTenant !== null;

  // GESTION du CONTENU de l'enveloppe affichée : gouverneur global, délégué sur CETTE enveloppe, ou — enveloppe de
  // pôle — le droit « Modifier » du budget de ce pôle. Dans Budgets, une enveloppe de pôle ne se règle pas.
  const canManageContent = tenueAilleurs ? false : overview ? canManageEnvelope(user, overview.envelope) : canManageAccess;

  const flexibleTotal = envelopes.filter((e) => e.isActive).reduce((s, e) => s + e.total, 0);
  const budgetTotal = {
    mode: settings.budgetTotalMode,
    value: settings.budgetTotalMode === "FIXED" ? settings.budgetFixedTotal : flexibleTotal,
    fixed: settings.budgetFixedTotal,
  };
  const peutCreer = pole ? canGovernPoleEnvelope(user, pole, "CREATE") : canManageAccess;
  const variante = pole && overview && rattachements
    ? {
        domaine: pole,
        options: rattachements,
        canEdit: canGovernPoleEnvelope(user, pole, "UPDATE", overview.envelope),
        canDelete: canGovernPoleEnvelope(user, pole, "DELETE", overview.envelope),
        rattachement: await libelleRattachement(overview.envelope),
      }
    : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title={pole ? `Réglages du budget ${DOMAINES[pole].court}` : "Réglages du budget"}
        description={pole ? "L'enveloppe et sa répartition en catégories." : "L'enveloppe, sa répartition en catégories, et le budget total au-dessus des enveloppes."}
      >
        {peutCreer && (pole && rattachements ? <NouvelleEnveloppePole domaine={pole} options={rattachements} /> : <CreateEnvelopeButton users={users} />)}
      </PageHeader>
      <ModuleTabs tabs={tabs} />
      {!overview ? (
        <EmptyState
          icon="Wallet"
          title={pole ? `Aucune enveloppe ${DOMAINES[pole].court}` : "Aucune enveloppe budgétaire"}
          description={peutCreer ? "Créez une enveloppe : un budget pour une période, que vous répartirez ensuite en catégories." : "Aucune enveloppe ne vous est ouverte pour le moment."}
        />
      ) : (
        <>
          <BudgetContextBar envelopes={envelopes} currentId={overview.envelope.id} from={overview.period.from} to={overview.period.to} />
          <BudgetSettings
            overview={overview}
            canManage={canManageContent}
            canManageAccess={canManageAccess}
            budgetTotal={budgetTotal}
            users={users}
            marketing={variante}
            bandeau={poleTenant ? <GerePar user={user} domaine={poleTenant} /> : undefined}
          />
        </>
      )}
    </div>
  );
}
