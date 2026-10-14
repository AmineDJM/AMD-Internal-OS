"use client";

/**
 * BUDGET MARKETING › RÉGLAGES — LES CATÉGORIES (maquette « onglets » validée, Direction 10/2026).
 *
 * Une carte par catégorie de tête, DÉPLIABLE en sous-catégories. Une catégorie COMPREND ses sous-catégories
 * (`cumul-categories.ts`) : la carte l'écrit — « dont X dans les sous-catégories » — et, dépliée, en donne la FORMULE
 * (« = X en propre + sous-cat A + sous-cat B = total »). L'alloué reste celui de la catégorie : une sous-catégorie
 * répartit DANS sa catégorie ; si les sous-catégories répartissent plus que la catégorie, la carte le signale. Une
 * allocation à 0 sur laquelle de l'argent est parti se lit « Sans allocation », pas « — ».
 */

import * as React from "react";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BudgetCategoryView } from "@/lib/queries/budget";
import { LIBELLE_SANTE, arbreCategories, formuleCumul, type CleSante, type NoeudArbre } from "@/lib/budget/marketing-vue";

const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR");

const TON: Record<CleSante, { pill: string; barre: string }> = {
  MAITRISE: { pill: "bg-success/10 text-success", barre: "bg-success" },
  A_SURVEILLER: { pill: "bg-warning/15 text-warning", barre: "bg-warning" },
  DEPASSE: { pill: "bg-destructive/10 text-destructive", barre: "bg-destructive" },
  SANS_ALLOCATION: { pill: "bg-destructive/10 text-destructive", barre: "bg-destructive" },
  AUCUNE: { pill: "bg-secondary text-muted-foreground", barre: "bg-muted-foreground/40" },
};

export function CategoriesMarketing({ categories, canManage, onNew, onEdit, onAddSub, onDelete }: {
  categories: BudgetCategoryView[];
  canManage: boolean;
  onNew: () => void;
  onEdit: (c: BudgetCategoryView) => void;
  onAddSub: (parentId: string) => void;
  onDelete: (c: BudgetCategoryView, n: NoeudArbre) => void;
}) {
  const arbre = React.useMemo(() => arbreCategories(categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, allocated: c.allocated, consumed: c.consumed, committed: c.committed }))), [categories]);
  const parId = React.useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const [ouverts, setOuverts] = React.useState<Set<string>>(() => new Set());
  const avecSous = arbre.filter((n) => n.sous.length > 0);
  const toutOuvert = avecSous.length > 0 && avecSous.every((n) => ouverts.has(n.id));
  const nbSous = categories.length - arbre.length;
  const basculer = (id: string) => setOuverts((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const vue = (id: string) => parId.get(id);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Catégories <span className="font-normal text-muted-foreground">({arbre.length}{nbSous > 0 ? ` · ${nbSous} sous-catégorie${nbSous > 1 ? "s" : ""}` : ""})</span></h2>
        <div className="flex flex-wrap gap-2">
          {avecSous.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setOuverts(toutOuvert ? new Set() : new Set(avecSous.map((n) => n.id)))}>{toutOuvert ? "Tout replier" : "Tout déplier"}</Button>
          )}
          {canManage && <Button size="sm" onClick={onNew}><Plus className="h-4 w-4" /> Nouvelle catégorie</Button>}
        </div>
      </div>
      {arbre.length === 0 ? (
        <p className="surface p-4 text-sm text-muted-foreground">
          Aucune catégorie. {canManage && "Répartissez le budget en créant des catégories (ex. Sponsoring, Événements…), avec si besoin des sous-catégories (ex. Tables rondes)."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {arbre.map((n) => {
            const c = vue(n.id);
            if (!c) return null;
            const ouvert = ouverts.has(n.id);
            const utilise = n.paye + n.engage;
            const dansSous = utilise - (n.payePropre + n.engagePropre);
            const largeur = n.alloue > 0.5 ? Math.min(100, Math.max(0, n.pct)) : utilise > 0.5 ? 100 : 0;
            const f = formuleCumul(n);
            return (
              <div key={n.id} className="surface grid min-w-0 gap-2 rounded-xl p-3 sm:px-4">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                  {n.sous.length > 0 ? (
                    <button type="button" aria-expanded={ouvert} aria-label={`${ouvert ? "Replier" : "Déplier"} ${n.nom}`} onClick={() => basculer(n.id)}
                      className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground">
                      {ouvert ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  ) : null}
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? "#64748b" }} aria-hidden />
                  <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{n.nom}</span>
                  {n.sante !== "AUCUNE" && <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TON[n.sante].pill)}>{LIBELLE_SANTE[n.sante]}</span>}
                  <span className="ml-auto whitespace-nowrap text-sm text-muted-foreground tabular-nums"><b className="text-foreground">{fmt(utilise)}</b> / {fmt(n.alloue)} DZD</span>
                  {canManage && (
                    <span className="flex items-center gap-0.5">
                      <button type="button" onClick={() => onAddSub(n.id)} className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">+ sous-catégorie</button>
                      <button type="button" title="Modifier" aria-label={`Modifier ${n.nom}`} onClick={() => onEdit(c)} className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"><Pencil className="h-4 w-4" /></button>
                      <button type="button" title="Supprimer" aria-label={`Supprimer ${n.nom}`} onClick={() => onDelete(c, n)} className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"><Trash2 className="h-4 w-4" /></button>
                    </span>
                  )}
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden>
                  <div className={cn("h-full rounded-full", TON[n.sante].barre)} style={{ width: `${largeur}%` }} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <span>Reste <b className={cn("tabular-nums", n.reste < 0 ? "text-destructive" : "text-foreground")}>{fmt(n.reste)}</b></span>
                  <span>{n.alloue > 0.5 ? `${Math.round(n.pct)} % utilisé` : "aucune allocation"}</span>
                  <span>payé <b className="tabular-nums text-foreground">{fmt(n.paye)}</b> · engagé <b className="tabular-nums text-foreground">{fmt(n.engage)}</b></span>
                  {n.sous.length > 0 && (
                    <span>
                      <button type="button" className="hover:text-primary hover:underline" onClick={() => basculer(n.id)}>{n.sous.length} sous-catégorie{n.sous.length > 1 ? "s" : ""} comprise{n.sous.length > 1 ? "s" : ""}</button>
                      {" "}· dont <b className="tabular-nums text-foreground">{fmt(dansSous)}</b> dans les sous-catégories{n.sousAlloue > 0.5 ? ` · ${fmt(n.sousAlloue)} réparti` : ""}
                    </span>
                  )}
                </div>
                {n.surRepartie && (
                  <p className="text-xs text-destructive" role="alert">Les sous-catégories répartissent {fmt(n.sousAlloue - n.alloue)} DZD de plus que l&apos;allocation de « {n.nom} ».</p>
                )}
                {n.sous.length > 0 && ouvert && (
                  <div className="grid gap-1.5 border-l-2 border-border pl-3">
                    {n.sous.map((s) => {
                      const cs = vue(s.id);
                      const u = s.paye + s.engage;
                      return (
                        <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,15rem)_auto]">
                          <span className="flex min-w-0 items-center gap-1.5"><span className="text-xs text-muted-foreground" aria-hidden>›</span><span className="h-2.5 w-2.5 shrink-0 rounded-full opacity-60" style={{ backgroundColor: cs?.color ?? c.color ?? "#94a3b8" }} aria-hidden /><span className="[overflow-wrap:anywhere]">{s.nom}</span></span>
                          <span className="relative col-span-2 h-2 rounded-full bg-secondary sm:col-span-1" aria-hidden>
                            <span className={cn("absolute inset-y-0 left-0 rounded-full", TON[s.sante].barre)} style={{ width: `${s.alloue > 0.5 ? Math.min(100, s.pct) : 0}%` }} />
                          </span>
                          <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums sm:text-right">{fmt(u)}{s.alloue > 0.5 ? ` / ${fmt(s.alloue)}` : " · sur l'allocation de la catégorie"}</span>
                          {canManage && cs ? (
                            <span className="row-start-1 col-start-2 flex items-center gap-0.5 sm:row-auto sm:col-auto">
                              <button type="button" title="Modifier" aria-label={`Modifier ${s.nom}`} onClick={() => onEdit(cs)} className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1"><Pencil className="h-3.5 w-3.5" /></button>
                              <button type="button" title="Supprimer" aria-label={`Supprimer ${s.nom}`} onClick={() => onDelete(cs, s)} className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"><Trash2 className="h-3.5 w-3.5" /></button>
                            </span>
                          ) : <span className="hidden sm:block" />}
                        </div>
                      );
                    })}
                    <p className="rounded-lg border border-border bg-secondary/50 px-2.5 py-2 text-xs tabular-nums [overflow-wrap:anywhere]">
                      <b>{n.nom}</b> = {fmt(f.propre)} en propre{f.termes.map((t) => <React.Fragment key={t.nom}> + {fmt(t.montant)} <span className="text-muted-foreground">({t.nom})</span></React.Fragment>)} = <b>{fmt(f.total)} DZD</b>
                      <span className="block text-muted-foreground">payé + engagé · le total de l&apos;enveloppe ne compte chaque dépense qu&apos;une fois</span>
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
