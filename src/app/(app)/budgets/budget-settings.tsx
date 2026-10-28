"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { deleteBudgetCategory } from "@/lib/actions/budget-envelope-actions";
import type { BudgetOverview, BudgetCategoryView } from "@/lib/queries/budget";
import { useRun, CategoryCard, CategorySheet, EnvelopeSheet, BudgetTotalSheet } from "./budget-forms";
import { EnveloppePoleSheet, type RattachementOptions } from "./enveloppe-marketing-forms";
import type { DomainePole } from "@/lib/budget/domaines";
import { cumulerSousCategories } from "@/lib/budget/cumul-categories";
import { partRepartie } from "@/lib/budget/marketing-vue";
import { CategoriesMarketing } from "./categories-marketing";
import { FenetreConfirmation, type Confirmation } from "./fenetre-confirmation";

interface BudgetTotalInfo { mode: "FIXED" | "FLEXIBLE"; value: number; fixed: number }
type UserOpt = { id: string; name: string };

/** Budget d'un pôle (Marketing, Regulatory, Operations) : le tiroir court du pôle remplace celui du Super Admin. */
export interface VariantePole { domaine: DomainePole; options: RattachementOptions; canEdit: boolean; canDelete: boolean; rattachement: string | null }

/**
 * BUDGETS — écran « RÉGLAGES ». Tout ce qui se PARAMÈTRE, au même endroit.
 *
 * Avant, ces réglages étaient éparpillés dans la barre du haut de l'écran principal
 * (« Régler », « Enveloppe », « Nouvelle catégorie »), au milieu de la lecture des chiffres.
 * Ils sont désormais réunis ici : on ne tombe plus par accident sur un bouton qui modifie
 * la structure du budget alors qu'on voulait juste le consulter.
 */
export function BudgetSettings({
  overview, canManage, canManageAccess, budgetTotal, users, marketing, bandeau,
}: {
  overview: BudgetOverview;
  canManage: boolean;
  canManageAccess: boolean;
  budgetTotal: BudgetTotalInfo;
  users: UserOpt[];
  /** Écran d'un budget de pôle : tiroir court, pas de budget total « toutes enveloppes ». */
  marketing?: VariantePole;
  /** Une enveloppe tenue ailleurs (le budget d'un pôle) : le mot qui le dit, à la place du bouton « Modifier ». */
  bandeau?: React.ReactNode;
}) {
  const peutModifier = marketing ? marketing.canEdit : canManageAccess && !bandeau;
  const router = useRouter();
  const { run, err: erreurGeste } = useRun();
  const [editEnv, setEditEnv] = React.useState(false);
  const [totalSheet, setTotalSheet] = React.useState(false);
  const [catSheet, setCatSheet] = React.useState<{ cat?: BudgetCategoryView; parentId?: string } | null>(null);
  const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null);
  // BUDGET MARKETING (maquette « onglets ») : cartes dépliables, formule du cumul, part répartie en tête, suppression
  // confirmée dans une fenêtre.
  const estMarketing = marketing?.domaine === "MARKETING";

  // Chaque catégorie AFFICHÉE comprend ses sous-catégories (consommé, engagé, reste, santé) ;
  // la requête, elle, rend la part propre de chaque nœud — le total d'enveloppe n'est pas doublé.
  const cumul = cumulerSousCategories(overview.categories);
  const cumulee = (c: BudgetCategoryView): BudgetCategoryView => ({ ...c, ...(cumul.get(c.id) ?? {}) });
  const topCats = overview.categories.filter((c) => c.parentId === null);
  const subsByParent = new Map<string, BudgetCategoryView[]>();
  for (const c of overview.categories) {
    if (c.parentId) subsByParent.set(c.parentId, [...(subsByParent.get(c.parentId) ?? []), cumulee(c)]);
  }
  const topCatOptions = topCats.map((c) => ({ id: c.id, name: c.name }));
  const part = partRepartie(overview.envelope.total, topCats.map((c) => ({ alloue: c.allocated })));
  const repartition = estMarketing
    ? { total: overview.envelope.total, categories: overview.categories.map((c) => ({ id: c.id, parentId: c.parentId, alloue: c.allocated, nom: c.name })) }
    : undefined;

  const demanderSuppression = (cat: BudgetCategoryView, n: { paye: number; engage: number; sous: unknown[] }) => setConfirmation({
    titre: `Supprimer « ${cat.name} » ?`,
    danger: true,
    corps: `${n.sous.length ? `Ses ${n.sous.length} sous-catégorie${n.sous.length > 1 ? "s seront aussi supprimées" : " sera aussi supprimée"}. ` : ""}${n.paye > 0.5
      ? `Les ${formatCurrency(n.paye)} qui y sont imputés repasseront en « à imputer » et remonteront dans « À traiter ».`
      : "Aucune dépense n'y est imputée."}`,
    bouton: "Supprimer",
    ok: async () => { const fd = new FormData(); fd.set("id", cat.id); await run(() => deleteBudgetCategory(fd)); },
  });

  const deleteCat = (cat: BudgetCategoryView) => {
    const fd = new FormData(); fd.set("id", cat.id);
    void run(() => deleteBudgetCategory(fd), undefined, {
      confirmer: `Supprimer « ${cat.name} » ?${cat.parentId === null ? " Ses sous-catégories seront aussi supprimées." : ""} Les écritures de trésorerie repasseront en « à imputer » ; une catégorie qui porte des dépenses budgétaires ne se supprime pas.`,
    });
  };

  return (
    <div className="space-y-5">
      {/* L'enveloppe elle-même */}
      <section className="surface space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">L&apos;enveloppe</h2>
          <Badge tone={overview.envelope.isActive ? "success" : "neutral"} dot={false}>
            {overview.envelope.isActive ? "Active" : "Archivée"}
          </Badge>
          {bandeau && <span className="ml-auto text-xs text-muted-foreground">{bandeau}</span>}
          {peutModifier && (
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditEnv(true)}>
              <Pencil className="h-4 w-4" /> Modifier
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">Montant</dt><dd className="font-medium tabular-nums">{formatCurrency(overview.envelope.total)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Période</dt><dd className="font-medium">{formatDate(overview.envelope.periodStart)} → {formatDate(overview.envelope.periodEnd)}</dd></div>
          {estMarketing ? (
            <div>
              <dt className="text-xs text-muted-foreground">Réparti en catégories</dt>
              <dd className="font-medium tabular-nums">
                {formatCurrency(part.reparti)} · {Math.round(part.pct)} %
                {part.depassement > 0.5
                  ? <span className="ml-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">dépasse de {formatCurrency(part.depassement)}</span>
                  : part.nonReparti > 0.5 ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{formatCurrency(part.nonReparti)} non répartis</span> : null}
              </dd>
            </div>
          ) : marketing ? (
            <div><dt className="text-xs text-muted-foreground">BU · produit</dt><dd className="font-medium">{marketing.rattachement ?? "—"}</dd></div>
          ) : (
            <div><dt className="text-xs text-muted-foreground">Accès ouverts</dt><dd className="font-medium">{overview.envelope.accessRoles.length + overview.envelope.accessUserIds.length || "—"}</dd></div>
          )}
        </dl>
        {estMarketing && (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-secondary" role="img" aria-label={`Part répartie : ${Math.round(part.pct)} %`}>
              <div className={part.depassement > 0.5 ? "h-full rounded-full bg-destructive" : "h-full rounded-full bg-primary"} style={{ width: `${Math.min(100, part.pct)}%` }} />
            </div>
            {marketing?.rattachement && <p className="text-xs text-muted-foreground">BU · produit : {marketing.rattachement}</p>}
          </>
        )}
        {overview.envelope.notes && <p className="border-t border-border pt-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">{overview.envelope.notes}</p>}
      </section>

      {/* Budget total au-dessus des enveloppes — réglage rare, donc discret. */}
      {canManageAccess && !marketing && (
        <section className="surface flex flex-wrap items-center gap-3 p-3 sm:p-4">
          <div>
            <p className="text-xs text-muted-foreground">Budget total, toutes enveloppes confondues</p>
            <p className="text-lg font-semibold tabular-nums">{formatCurrency(budgetTotal.value)}</p>
          </div>
          <Badge tone={budgetTotal.mode === "FIXED" ? "purple" : "neutral"} dot={false}>
            {budgetTotal.mode === "FIXED" ? "Montant figé" : "Somme des enveloppes"}
          </Badge>
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setTotalSheet(true)}>
            <SlidersHorizontal className="h-3.5 w-3.5" /> Régler
          </Button>
        </section>
      )}

      {estMarketing && erreurGeste && <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{erreurGeste}</p>}
      {estMarketing && (
        <CategoriesMarketing
          categories={overview.categories}
          canManage={canManage}
          onNew={() => setCatSheet({})}
          onEdit={(cat) => setCatSheet({ cat })}
          onAddSub={(parentId) => setCatSheet({ parentId })}
          onDelete={demanderSuppression}
        />
      )}

      {/* Répartition en catégories */}
      {!estMarketing && <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Catégories <span className="font-normal text-muted-foreground">({overview.categories.length})</span></h2>
          {canManage && <Button size="sm" onClick={() => setCatSheet({})}><Plus className="h-4 w-4" /> Nouvelle catégorie</Button>}
        </div>
        {topCats.length === 0 ? (
          <p className="surface p-4 text-sm text-muted-foreground">
            Aucune catégorie. {canManage && "Répartissez le budget en créant des catégories (ex. Promotion, Congrès, Logistique…), avec si besoin des sous-catégories (ex. Table ronde)."}
          </p>
        ) : (
          <div className="space-y-2">
            {topCats.map((c) => (
              <CategoryCard
                key={c.id}
                c={cumulee(c)}
                propre={c.consumed}
                subs={subsByParent.get(c.id) ?? []}
                canManage={canManage}
                onEdit={(cat) => setCatSheet({ cat })}
                onDelete={deleteCat}
                onAddSub={() => setCatSheet({ parentId: c.id })}
              />
            ))}
          </div>
        )}
      </section>}

      {editEnv && (marketing
        ? <EnveloppePoleSheet domaine={marketing.domaine} envelope={overview.envelope} options={marketing.options} canDelete={marketing.canDelete} onClose={() => setEditEnv(false)} />
        : <EnvelopeSheet envelope={overview.envelope} users={users} onClose={() => setEditEnv(false)} onDeleted={() => router.push("/budgets")} canDelete={canManageAccess} />)}
      {catSheet && <CategorySheet envelopeId={overview.envelope.id} cat={catSheet.cat} defaultParentId={catSheet.parentId} parentOptions={topCatOptions} onClose={() => setCatSheet(null)} repartition={repartition} />}
      {confirmation && <FenetreConfirmation c={confirmation} occupe={false} onFermer={() => setConfirmation(null)} />}
      {totalSheet && <BudgetTotalSheet info={budgetTotal} onClose={() => setTotalSheet(false)} />}
    </div>
  );
}
