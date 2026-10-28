import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { normalizeYear } from "@/lib/department-budget";
import { toNumber, formatCurrency } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiCard } from "@/components/shared/kpi-card";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_TABS } from "@/lib/labels";
import { buBudgetView, consumptionPct, buBudgetNotice, type BuBudgetLine } from "@/lib/sfe/bu-department";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * LE BUDGET PAR GAMME — et son consolidé, qui n'est que leur somme.
 *
 * ── LA QUESTION QU'IL RÉPOND ────────────────────────────────────────────────────────────────
 *
 * « Combien l'oncologie a-t-elle dépensé cette année ? » n'avait pas de réponse. Les prises en
 * charge, congrès et matériels promotionnels d'une gamme tombaient dans un total commercial
 * indistinct, et l'on reconstituait le chiffre à la main, dans un tableur, en filtrant sur des
 * noms de produits.
 *
 * ── POURQUOI IL NE CALCULE PRESQUE RIEN ─────────────────────────────────────────────────────
 *
 * Parce qu'une Business Unit est un SOUS-DÉPARTEMENT : son enveloppe et ses dépenses sont celles
 * de son département, tenues par le module qui les tient déjà. Cet écran ne fait que les LIRE
 * gamme par gamme et les additionner. Le consolidé est la somme des lignes affichées — jamais un
 * chiffre lu ailleurs : deux sources pour un total et son détail divergent au premier écart de
 * périmètre, et l'on passe une matinée à chercher laquelle a raison.
 *
 * Une gamme SANS sous-département apparaît quand même, à zéro et signalée. La masquer ferait
 * croire que toutes les gammes sont budgétées — et c'est justement celle-là qu'il faut rattacher.
 */
export default async function BusinessUnitBudgetsPage({ searchParams }: { searchParams: { year?: string } }) {
  const user = await requireUser();
  if (!userCan(user, "BUDGETS", "VIEW")) notFound();
  const year = normalizeYear(searchParams.year);

  const tabs = await visibleTabs(user, BUDGET_TABS);
  const bus = await prisma.businessUnit.findMany({
    where: { isActive: true },
    select: { id: true, name: true, color: true, departmentId: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const departmentIds = bus.map((b) => b.departmentId).filter((v): v is string => Boolean(v));

  // L'ENVELOPPE ET LES DÉPENSES DE CHAQUE GAMME — lues sur son département, en deux agrégats.
  // Interroger gamme par gamme ferait autant d'allers en base que de Business Units, pour une
  // page qui en affiche la liste entière.
  const [enveloppes, depenses, adPro] = await Promise.all([
    departmentIds.length > 0
      ? prisma.departmentBudget.groupBy({
          by: ["departmentId"], where: { departmentId: { in: departmentIds }, year }, _sum: { amount: true },
        })
      : Promise.resolve([] as { departmentId: string; _sum: { amount: unknown } }[]),
    departmentIds.length > 0
      ? prisma.departmentBudgetExpense.groupBy({
          by: ["departmentId"], where: { departmentId: { in: departmentIds }, year }, _sum: { amount: true },
        })
      : Promise.resolve([] as { departmentId: string; _sum: { amount: unknown } }[]),
    // CE QUE LES DEMANDES Ad & Pro ONT ENGAGÉ, gamme par gamme. Elles ne passent pas toutes par une
    // dépense de département : c'est le rattachement de la demande qui les rend comptables ici.
    prisma.promoMaterial.groupBy({
      by: ["businessUnitId"],
      where: { businessUnitId: { in: bus.map((b) => b.id) } },
      _sum: { amount: true },
    }).catch(sansBloquer("business-units-page.BusinessUnitBudgetsPage.promoMaterial", [] as { businessUnitId: string | null; _sum: { amount: unknown } }[])),
  ]);

  const enveloppeParDep = new Map(enveloppes.map((e) => [e.departmentId, toNumber(e._sum.amount ?? 0)]));
  const depenseParDep = new Map(depenses.map((e) => [e.departmentId, toNumber(e._sum.amount ?? 0)]));
  const adProParBu = new Map(
    adPro.filter((a) => a.businessUnitId).map((a) => [a.businessUnitId as string, toNumber(a._sum.amount ?? 0)]),
  );

  const lines: BuBudgetLine[] = bus.map((b) => ({
    businessUnitId: b.id,
    label: b.name,
    allocated: b.departmentId ? enveloppeParDep.get(b.departmentId) ?? 0 : 0,
    spent: (b.departmentId ? depenseParDep.get(b.departmentId) ?? 0 : 0) + (adProParBu.get(b.id) ?? 0),
    attached: Boolean(b.departmentId),
  }));
  const view = buBudgetView(lines);
  const notice = buBudgetNotice(view);
  const couleurParBu = new Map(bus.map((b) => [b.id, b.color]));

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Budget par Business Unit — ${year}`}
        description="Chaque gamme est un sous-département de la Direction commerciale : son enveloppe, ses dépenses et sa masse salariale se lisent là où celles de tous les départements se tiennent. Le consolidé n'est que la somme des gammes."
      />
      <ModuleTabs tabs={tabs} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Gammes" value={view.lines.length} icon="Layers" />
        <KpiCard label="Enveloppe consolidée" value={formatCurrency(view.totalAllocated)} icon="Wallet" tone="info" />
        <KpiCard label="Consommé" value={formatCurrency(view.totalSpent)} icon="Coins" tone={view.totalSpent > view.totalAllocated ? "danger" : "default"} />
        <KpiCard label="Sans budget" value={view.unattached} icon="AlertTriangle" tone={view.unattached > 0 ? "warning" : "default"} />
      </div>

      {notice && (
        <p className="rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
          {notice} Le budget d&apos;une gamme s&apos;ouvre depuis{" "}
          <Link href="/business-units" className="font-medium text-primary hover:underline">Business Units</Link>.
        </p>
      )}

      {view.lines.length === 0 ? (
        <EmptyState
          icon="Layers"
          title="Aucune Business Unit"
          description="Créez vos gammes dans Business Units : chacune deviendra un sous-département de la Direction commerciale, avec son budget Ad & Pro et sa masse salariale."
        />
      ) : (
        // Une ligne par gamme : au téléphone, chaque gamme devient une carte (intitulés repris de l'en-tête),
        // le consolidé une dernière carte aux intitulés écrits à la main — le pied n'est pas étiqueté d'office.
        <div className="surface overflow-hidden">
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead>Gamme</TableHead>
                <TableHead className="text-right">Enveloppe</TableHead>
                <TableHead className="text-right">Consommé</TableHead>
                <TableHead className="text-right">Reste</TableHead>
                <TableHead className="text-right">Taux</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.lines.map((l) => {
                const pct = consumptionPct(l);
                const couleur = couleurParBu.get(l.businessUnitId);
                return (
                  <TableRow key={l.businessUnitId}>
                    <TableCell data-sans-etiquette>
                      <span className="flex flex-wrap items-center gap-2">
                        {couleur && <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: couleur }} />}
                        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{l.label}</span>
                        {/* SANS SOUS-DÉPARTEMENT, LA GAMME NE COMPTE NULLE PART — et c'est dit
                            sur SA ligne, là où l'on peut agir, pas seulement dans un total. */}
                        {!l.attached && <span className="rounded bg-warning/20 px-2 py-0.5 text-[0.6875rem] text-warning">budget non ouvert</span>}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">{l.attached ? formatCurrency(l.allocated) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">{l.attached ? formatCurrency(l.spent) : "—"}</TableCell>
                    <TableCell className={`whitespace-nowrap text-right ${l.attached && l.spent > l.allocated ? "text-destructive" : ""}`}>
                      {l.attached ? formatCurrency(l.allocated - l.spent) : "—"}
                    </TableCell>
                    <TableCell className={`whitespace-nowrap text-right ${pct != null && pct > 100 ? "font-semibold text-destructive" : ""}`}>
                      {pct != null ? `${pct} %` : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <tfoot className="border-t border-border bg-secondary/30">
              <TableRow>
                <TableCell className="font-semibold" data-sans-etiquette>Consolidé</TableCell>
                <TableCell label="Enveloppe" className="whitespace-nowrap text-right font-semibold">{formatCurrency(view.totalAllocated)}</TableCell>
                <TableCell label="Consommé" className="whitespace-nowrap text-right font-semibold">{formatCurrency(view.totalSpent)}</TableCell>
                <TableCell label="Reste" className="whitespace-nowrap text-right font-semibold">{formatCurrency(view.totalAllocated - view.totalSpent)}</TableCell>
                <TableCell />
              </TableRow>
            </tfoot>
          </Table>
        </div>
      )}
    </div>
  );
}
