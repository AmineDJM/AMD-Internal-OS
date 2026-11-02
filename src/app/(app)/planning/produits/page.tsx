import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ensureCycle } from "@/lib/actions/sales-planning-actions";
import { getSfeConfig, repCapacity, assignmentEffort, fteFromEffort, resolveRepScope } from "@/lib/sfe";
import { busDuPerimetre, kamsDuPerimetre } from "@/lib/queries/force-de-vente";
import { moisPrecedent, nomDuMois } from "@/lib/force-de-vente/calculs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { EnteteFdv, lireParametres } from "../entete";
import { ForecastGrid } from "../forecast-grid";
import { ProduitsMatrice, ReprendreMoisPrecedent } from "./produits-matrice";

export const dynamic = "force-dynamic";

/**
 * FORCE DE VENTE › PRODUITS (Direction, 07/10 — sans objectifs de ventes pour l'instant) : par BU, la matrice délégué ×
 * produit (P1 / P2 / P3), « Reprendre le mois précédent », et — pour qui configure — les prévisions de la Direction
 * (ETP, couverture, budget par produit), repliées en dessous.
 */
export default async function ProduitsPage(props: { searchParams?: Promise<{ bu?: string; y?: string; m?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("SALES_PLANNING");
  const scope = await resolveRepScope(user);
  const bus = await busDuPerimetre(scope, user.id);
  const { year, month, buId } = lireParametres(searchParams, bus);
  const prec = moisPrecedent(year, month);
  const [cycle, kams] = await Promise.all([ensureCycle(year, month), kamsDuPerimetre(scope, buId)]);
  const repIds = kams.map((k) => k.repId);
  const busVues = bus.filter((b) => !buId || b.id === buId);
  const [produits, affectations] = await Promise.all([
    prisma.promoProduct.findMany({
      where: { isActive: true, OR: [{ businessUnitId: { in: busVues.map((b) => b.id) } }, ...(cycle ? [{ assignments: { some: { cycleId: cycle.id, repId: { in: repIds } } } }] : [])] },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, businessUnitId: true },
    }),
    cycle ? prisma.promotionAssignment.findMany({ where: { cycleId: cycle.id, repId: { in: repIds } }, select: { repId: true, productId: true, position: true, plannedVisits: true } }) : Promise.resolve([]),
  ]);
  // Modifier : qui configure, ou le superviseur de la BU (sa portée est son équipe). Jamais le lecteur ni le KAM.
  const modifiable = scope.canConfigure || scope.mode === "team";

  return (
    <div className="space-y-4">
      <EnteteFdv user={user} scope={scope} bus={bus} chemin="/planning/produits" buId={buId} year={year} month={month} />

      {!cycle ? <p className="surface rounded-xl p-5 text-sm text-muted-foreground">Cycle illisible.</p> : busVues.length === 0 ? (
        <p className="surface rounded-xl p-5 text-sm text-muted-foreground">Aucune BU dans votre périmètre.</p>
      ) : busVues.map((b) => {
        const kamsBu = kams.filter((k) => k.buId === b.id);
        const ids = new Set(kamsBu.map((k) => k.repId));
        const affBu = affectations.filter((a) => ids.has(a.repId));
        const portes = new Set(affBu.map((a) => a.productId));
        const colonnes = produits.filter((p) => p.businessUnitId === b.id || portes.has(p.id));
        return (
          <section key={b.id} className="surface min-w-0 rounded-xl">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
                {busVues.length > 1 ? `${b.nom} · ` : ""}Produits par délégué · {nomDuMois(year, month)}
                <InfoBulle label="À propos des rangs">P1 : le produit principal de la mallette, puis P2 et P3. Le rang guide la visite ; le nombre de visites requis vient de la segmentation.</InfoBulle>
              </h2>
              {scope.canConfigure && <ReprendreMoisPrecedent cycleId={cycle.id} fromYear={prec.y} fromMonth={prec.m} libelle={nomDuMois(prec.y, prec.m)} />}
            </header>
            {kamsBu.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Aucun délégué dans cette BU.</p>
              : colonnes.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Aucun produit actif dans cette BU.</p>
              : (
                <ProduitsMatrice
                  cycleId={cycle.id}
                  kams={kamsBu.map((k) => ({ repId: k.repId, nom: k.nom, secteurNom: k.secteurNom, modifiable }))}
                  produits={colonnes.map((p) => ({ id: p.id, nom: p.name }))}
                  affectations={affBu}
                />
              )}
          </section>
        );
      })}

      {scope.canConfigure && cycle && <Previsions cycleId={cycle.id} year={year} month={month} />}
    </div>
  );
}

/**
 * LES PRÉVISIONS DE LA DIRECTION — l'écran d'avant (ETP cible, couverture, visites, budget par produit), replié sous
 * les produits. L'ETP affecté se lit sur les affectations du cycle, comme avant.
 */
async function Previsions({ cycleId, year, month }: { cycleId: string; year: number; month: number }) {
  const [config, products, forecasts, assignments, profiles] = await Promise.all([
    getSfeConfig(),
    prisma.promoProduct.findMany({
      where: { isActive: true },
      include: { businessUnit: { select: { id: true, name: true, color: true, sortOrder: true } } },
      orderBy: [{ businessUnit: { sortOrder: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.productForecast.findMany({ where: { cycleId } }),
    prisma.promotionAssignment.findMany({ where: { cycleId } }),
    prisma.salesRepProfile.findMany({ select: { repId: true, capDaysPerMonth: true, capVisitsPerDay: true, capFieldPct: true } }),
  ]);
  const fMap = new Map(forecasts.map((f) => [f.productId, f]));
  const profileMap = new Map(profiles.map((p) => [p.repId, p]));
  const assignedFteByProduct = new Map<string, number>();
  for (const a of assignments) {
    const fte = fteFromEffort(assignmentEffort(a.plannedVisits, a.position, config.positionWeights), repCapacity(profileMap.get(a.repId), config));
    assignedFteByProduct.set(a.productId, (assignedFteByProduct.get(a.productId) ?? 0) + fte);
  }
  const rows = products.map((p) => {
    const f = fMap.get(p.id);
    return {
      productId: p.id, productName: p.name, buName: p.businessUnit?.name ?? "Sans BU", buColor: p.businessUnit?.color ?? null,
      targetFte: f ? Number(f.targetFte) : 0, assignedFte: assignedFteByProduct.get(p.id) ?? 0,
      coverageTargetPct: f?.coverageTargetPct ?? null, plannedVisits: f?.plannedVisits ?? null,
      budget: f?.budget != null ? Number(f.budget) : null, note: f?.note ?? null,
    };
  });
  return (
    <details className="surface rounded-xl">
      <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <span className="text-[15px] font-semibold">Prévisions de la Direction</span>
        <span className="text-xs text-muted-foreground">ETP, couverture et budget par produit · {nomDuMois(year, month)}</span>
      </summary>
      <div className="border-t border-border">
        {rows.length === 0
          ? <p className="p-5 text-sm text-muted-foreground">Aucun produit actif : ils s&apos;ajoutent dans Business Units.</p>
          : <ForecastGrid cycleId={cycleId} rows={rows} canEdit />}
      </div>
    </details>
  );
}
