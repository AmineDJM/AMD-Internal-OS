"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, ChevronDown, Plus, Trash2, Search, Download, X, ExternalLink, Loader2 } from "lucide-react";
import {
  updateBdCell, createBdRange, createBdProduct, deleteBdRange, deleteBdProduct, deleteBdProject,
} from "@/lib/actions/bd-project-actions";
import { BD_PROJECT_STATUS, BD_SOURCING } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { cn, formatCompact, formatNumber } from "@/lib/utils";
import type { BdProjectDTO, BdRangeDTO, BdProductDTO } from "@/lib/queries/bd";

type NumKey =
  | "marketSizeDzd" | "marketSizeUsd" | "unitPrice" | "totalMarketVolume"
  | "investmentY1" | "investmentY2" | "investmentY3" | "revenueY1" | "revenueY2" | "revenueY3";
type TextKey = "dosage" | "form" | "competitors" | "competitorShares" | "competitorVolume" | "competitorPrice" | "comment";

interface DataCol {
  key: NumKey | TextKey | "sourcing";
  label: string;
  width: number;
  type: "text" | "number" | "sourcing";
  agg?: boolean; // somme affichée sur les lignes projet / gamme
}

const DATA_COLS: DataCol[] = [
  { key: "dosage", label: "Dosage", width: 110, type: "text" },
  { key: "form", label: "Forme", width: 120, type: "text" },
  { key: "sourcing", label: "Statut (appro.)", width: 130, type: "sourcing" },
  { key: "marketSizeDzd", label: "Marché (DZD)", width: 150, type: "number", agg: true },
  { key: "marketSizeUsd", label: "Marché (USD)", width: 140, type: "number", agg: true },
  { key: "unitPrice", label: "Prix unitaire", width: 130, type: "number" },
  { key: "totalMarketVolume", label: "Volume marché", width: 140, type: "number", agg: true },
  { key: "competitors", label: "Concurrents", width: 170, type: "text" },
  { key: "competitorShares", label: "Parts concurrents", width: 160, type: "text" },
  { key: "competitorVolume", label: "Volume / concurrent", width: 170, type: "text" },
  { key: "competitorPrice", label: "Prix / concurrent", width: 150, type: "text" },
  { key: "investmentY1", label: "Invest. A1", width: 130, type: "number", agg: true },
  { key: "investmentY2", label: "Invest. A2", width: 130, type: "number", agg: true },
  { key: "investmentY3", label: "Invest. A3", width: 130, type: "number", agg: true },
  { key: "revenueY1", label: "Revenus A1", width: 130, type: "number", agg: true },
  { key: "revenueY2", label: "Revenus A2", width: 130, type: "number", agg: true },
  { key: "revenueY3", label: "Revenus A3", width: 130, type: "number", agg: true },
  { key: "comment", label: "Commentaire", width: 220, type: "text" },
];

// Largeurs des 3 colonnes gelées à gauche.
const W_PROJ = 230;
const W_RANGE = 180;
const W_DCI = 200;
const L_RANGE = W_PROJ;
const L_DCI = W_PROJ + W_RANGE;
const W_STATUS = 180;
const W_ACT = 84;

const SORTS: Record<string, string> = {
  updated: "Tri : récent",
  name: "Tri : projet A→Z",
  status: "Tri : statut",
  revenue: "Tri : revenus 3 ans ↓",
  invest: "Tri : investissement 3 ans ↓",
};

function rev3(p: BdProjectDTO): number {
  let s = 0;
  for (const r of p.ranges) for (const pr of r.products) s += (pr.revenueY1 ?? 0) + (pr.revenueY2 ?? 0) + (pr.revenueY3 ?? 0);
  return s;
}
function inv3(p: BdProjectDTO): number {
  let s = 0;
  for (const r of p.ranges) for (const pr of r.products) s += (pr.investmentY1 ?? 0) + (pr.investmentY2 ?? 0) + (pr.investmentY3 ?? 0);
  return s;
}
function sumKey(products: BdProductDTO[], key: NumKey): number | null {
  let s = 0;
  let any = false;
  for (const p of products) {
    const v = p[key];
    if (v !== null && v !== undefined) { s += v; any = true; }
  }
  return any ? s : null;
}

export function BdStrategicTable({
  projects, canUpdate, canDelete,
}: {
  projects: BdProjectDTO[];
  canUpdate: boolean;
  canDelete: boolean;
}) {
  // Les gestes du tableau (icônes, lignes d'ajout) n'ont pas de place pour parler : un refus part en avis flottant.
  const { run } = useAction({ signalerErreurs: true });
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [sourcingFilter, setSourcingFilter] = React.useState("");
  const [sort, setSort] = React.useState("updated");
  const [openProjects, setOpenProjects] = React.useState<Set<string>>(() => new Set(projects.map((p) => p.id)));
  const [openRanges, setOpenRanges] = React.useState<Set<string>>(() => new Set());
  const [addRangeFor, setAddRangeFor] = React.useState<string | null>(null);
  const [addProductFor, setAddProductFor] = React.useState<string | null>(null);

  const toggleP = (id: string) => setOpenProjects((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleR = (id: string) => setOpenRanges((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Filtrage : recherche (projet/gamme/produit) + statut projet + sourcing produit.
  const q = search.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    const matchProduct = (pr: BdProductDTO) => {
      if (sourcingFilter && pr.sourcing !== sourcingFilter) return false;
      if (!q) return true;
      return [pr.dci, pr.brandName, pr.dosage, pr.form, pr.competitors, pr.comment].some((s) => s.toLowerCase().includes(q));
    };
    let list = projects
      .filter((p) => !statusFilter || p.status === statusFilter)
      .map((p) => {
        const ranges = p.ranges
          .map((r) => {
            const products = r.products.filter(matchProduct);
            const rangeMatches = !q || r.name.toLowerCase().includes(q);
            // garder la gamme si elle matche, ou si elle a des produits qui matchent,
            // ou si pas de filtre produit actif (afficher la structure complète).
            if ((q || sourcingFilter) && products.length === 0 && !rangeMatches) return null;
            return { ...r, products } as BdRangeDTO;
          })
          .filter((r): r is BdRangeDTO => r !== null);
        const projMatches = !q || p.name.toLowerCase().includes(q);
        if ((q || sourcingFilter) && ranges.length === 0 && !projMatches) return null;
        return { ...p, ranges } as BdProjectDTO;
      })
      .filter((p): p is BdProjectDTO => p !== null);

    if (sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "status") list = [...list].sort((a, b) => a.status.localeCompare(b.status));
    else if (sort === "revenue") list = [...list].sort((a, b) => rev3(b) - rev3(a));
    else if (sort === "invest") list = [...list].sort((a, b) => inv3(b) - inv3(a));
    return list;
  }, [projects, q, statusFilter, sourcingFilter, sort]);

  const totalWidth = W_PROJ + W_RANGE + W_DCI + DATA_COLS.reduce((a, c) => a + c.width, 0) + W_STATUS + W_ACT;
  const hasFilter = Boolean(q || statusFilter || sourcingFilter);

  const exportCsv = () => downloadCsv(filtered);

  const submit = (fn: () => Promise<{ ok: boolean; error?: string }>) => run(fn);

  return (
    <div className="space-y-3">
      {/* Barre d'outils */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher projet, gamme, DCI…" className="h-9 w-full pl-8 sm:w-64" />
        </div>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 w-auto min-w-0 flex-1 sm:flex-none">
          <option value="">Tous les statuts</option>
          {Object.entries(BD_PROJECT_STATUS).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
        </Select>
        <Select value={sourcingFilter} onChange={(e) => setSourcingFilter(e.target.value)} className="h-9 w-auto min-w-0 flex-1 sm:flex-none">
          <option value="">Tout sourcing</option>
          {Object.entries(BD_SOURCING).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value)} className="h-9 w-full sm:w-auto">
          {Object.entries(SORTS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        {hasFilter && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setStatusFilter(""); setSourcingFilter(""); }}>
            <X className="h-4 w-4" /> Réinitialiser
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <span className="text-xs text-muted-foreground">{filtered.length} projet{filtered.length > 1 ? "s" : ""}</span>
          <Button variant="outline" size="sm" onClick={() => { setOpenProjects(new Set(filtered.map((p) => p.id))); setOpenRanges(new Set(filtered.flatMap((p) => p.ranges.map((r) => r.id)))); }}>Tout déplier</Button>
          <Button variant="outline" size="sm" onClick={() => { setOpenProjects(new Set()); setOpenRanges(new Set()); }}>Tout replier</Button>
          <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-4 w-4" /> Excel/CSV</Button>
        </div>
      </div>

      {/* Tableau */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="border-collapse text-sm" style={{ minWidth: totalWidth, width: totalWidth }}>
          <thead>
            <tr className="bg-secondary/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <Th sticky left={0} width={W_PROJ} z={30}>Projet</Th>
              <Th sticky left={L_RANGE} width={W_RANGE} z={30}>Gamme</Th>
              <Th sticky left={L_DCI} width={W_DCI} z={30} border>DCI / Produit</Th>
              {DATA_COLS.map((c) => <Th key={c.key} width={c.width} right={c.type === "number"}>{c.label}</Th>)}
              <Th width={W_STATUS}>Statut projet</Th>
              <Th width={W_ACT}></Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={3 + DATA_COLS.length + 2} className="px-4 py-10 text-muted-foreground"><span className="sticky left-4 inline-block">Aucun projet ne correspond.</span></td></tr>
            ) : (
              filtered.map((p) => {
                const pOpen = openProjects.has(p.id);
                const allProducts = p.ranges.flatMap((r) => r.products);
                return (
                  <React.Fragment key={p.id}>
                    {/* Ligne PROJET */}
                    <tr className="border-t border-border bg-secondary/30 font-semibold">
                      <Td sticky left={0} width={W_PROJ} z={20} className="bg-[#eef1f4]">
                        <div className="flex items-center gap-1">
                          <button onClick={() => toggleP(p.id)} aria-label={pOpen ? "Replier le projet" : "Déplier le projet"} className="shrink-0 rounded p-2 hover:bg-black/5 sm:p-0.5">{pOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>
                          <Link href={`/business-development/${p.id}`} className="truncate hover:underline" title={p.name}>{p.name}</Link>
                        </div>
                      </Td>
                      <Td sticky left={L_RANGE} width={W_RANGE} z={20} className="bg-[#eef1f4] text-xs font-normal text-muted-foreground">{p.rangeCount} gamme{p.rangeCount > 1 ? "s" : ""}</Td>
                      <Td sticky left={L_DCI} width={W_DCI} z={20} border className="bg-[#eef1f4] text-xs font-normal text-muted-foreground">{p.productCount} produit{p.productCount > 1 ? "s" : ""}</Td>
                      {DATA_COLS.map((c) => (
                        <Td key={c.key} width={c.width} right={c.type === "number"} className="text-xs text-muted-foreground">
                          {c.agg ? <AggNum value={sumKey(allProducts, c.key as NumKey)} /> : null}
                        </Td>
                      ))}
                      <Td width={W_STATUS}>
                        <StatusSelect kind="project" id={p.id} value={p.status} canUpdate={canUpdate} />
                      </Td>
                      <Td width={W_ACT}>
                        <div className="flex items-center justify-end gap-1">
                          <Link href={`/business-development/${p.id}`} className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1" title="Ouvrir le projet" aria-label="Ouvrir le projet"><ExternalLink className="h-4 w-4" /></Link>
                          {canDelete && <DeleteBtn title="Supprimer le projet, ses gammes et produits ?" onConfirm={() => submit(() => deleteBdProject(fd({ id: p.id })))} />}
                        </div>
                      </Td>
                    </tr>

                    {/* Gammes + produits */}
                    {pOpen && p.ranges.map((r) => {
                      const rOpen = openRanges.has(r.id);
                      return (
                        <React.Fragment key={r.id}>
                          <tr className="border-t border-border/60 bg-muted/20">
                            <Td sticky left={0} width={W_PROJ} z={20} className="bg-[#f6f7f9]" />
                            <Td sticky left={L_RANGE} width={W_RANGE} z={20} className="bg-[#f6f7f9] font-medium">
                              <div className="flex items-center gap-1">
                                <button onClick={() => toggleR(r.id)} aria-label={rOpen ? "Replier la gamme" : "Déplier la gamme"} className="shrink-0 rounded p-2 hover:bg-black/5 sm:p-0.5">{rOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>
                                <span className="truncate" title={r.name}>{r.name}</span>
                              </div>
                            </Td>
                            <Td sticky left={L_DCI} width={W_DCI} z={20} border className="bg-[#f6f7f9] text-xs text-muted-foreground">{r.products.length} produit{r.products.length > 1 ? "s" : ""}</Td>
                            {DATA_COLS.map((c) => (
                              <Td key={c.key} width={c.width} right={c.type === "number"} className="text-xs text-muted-foreground">
                                {c.agg ? <AggNum value={sumKey(r.products, c.key as NumKey)} /> : null}
                              </Td>
                            ))}
                            <Td width={W_STATUS} />
                            <Td width={W_ACT}>
                              {canUpdate && (
                                <div className="flex items-center justify-end gap-1">
                                  <button onClick={() => { if (addProductFor === r.id) { setAddProductFor(null); } else { setAddProductFor(r.id); setOpenRanges((s) => { const n = new Set(s); n.add(r.id); return n; }); } }} className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1" title="Ajouter un produit" aria-label="Ajouter un produit"><Plus className="h-4 w-4" /></button>
                                  {canDelete && <DeleteBtn title="Supprimer cette gamme et ses produits ?" onConfirm={() => submit(() => deleteBdRange(fd({ id: r.id })))} />}
                                </div>
                              )}
                            </Td>
                          </tr>

                          {rOpen && r.products.map((pr) => (
                            <tr key={pr.id} className="border-t border-border/40 hover:bg-secondary/20">
                              <Td sticky left={0} width={W_PROJ} z={10} className="bg-card" />
                              <Td sticky left={L_RANGE} width={W_RANGE} z={10} className="bg-card" />
                              <Td sticky left={L_DCI} width={W_DCI} z={10} border className="bg-card">
                                <EditableCell kind="product" id={pr.id} field="dci" raw={pr.dci} canUpdate={canUpdate} className="font-medium" />
                              </Td>
                              {DATA_COLS.map((c) => (
                                <Td key={c.key} width={c.width} right={c.type === "number"}>
                                  {c.type === "sourcing" ? (
                                    <SourcingSelect id={pr.id} value={pr.sourcing} canUpdate={canUpdate} />
                                  ) : c.type === "number" ? (
                                    <EditableCell kind="product" id={pr.id} field={c.key} raw={pr[c.key as NumKey] === null ? "" : String(pr[c.key as NumKey])} numeric canUpdate={canUpdate}
                                      display={<AggNum value={pr[c.key as NumKey]} />} />
                                  ) : (
                                    <EditableCell kind="product" id={pr.id} field={c.key} raw={pr[c.key as TextKey]} canUpdate={canUpdate} />
                                  )}
                                </Td>
                              ))}
                              <Td width={W_STATUS} className="text-xs text-muted-foreground">—</Td>
                              <Td width={W_ACT}>
                                {canDelete && (
                                  <div className="flex justify-end">
                                    <DeleteBtn title="Supprimer ce produit ?" onConfirm={() => submit(() => deleteBdProduct(fd({ id: pr.id })))} />
                                  </div>
                                )}
                              </Td>
                            </tr>
                          ))}

                          {/* Ajout produit inline */}
                          {rOpen && addProductFor === r.id && (
                            <InlineAddRow colSpan={3 + DATA_COLS.length + 2} placeholder="DCI / nom du produit…"
                              onCancel={() => setAddProductFor(null)}
                              onSubmit={async (name) => { if (await submit(() => createBdProduct(fd({ rangeId: r.id, dci: name })))) setAddProductFor(null); }} />
                          )}
                        </React.Fragment>
                      );
                    })}

                    {/* Ajout gamme inline */}
                    {pOpen && canUpdate && (
                      addRangeFor === p.id ? (
                        <InlineAddRow colSpan={3 + DATA_COLS.length + 2} placeholder="Nom de la gamme…"
                          onCancel={() => setAddRangeFor(null)}
                          onSubmit={async (name) => { if (await submit(() => createBdRange(fd({ projectId: p.id, name })))) { setAddRangeFor(null); } }} />
                      ) : (
                        <tr className="border-t border-border/40">
                          <td colSpan={3 + DATA_COLS.length + 2} className="px-3 py-1.5">
                            <button onClick={() => setAddRangeFor(p.id)} className="sticky left-3 inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0"><Plus className="h-3.5 w-3.5" /> Ajouter une gamme à « {p.name} »</button>
                          </td>
                        </tr>
                      )
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────────── cellules ─────────────────────────────

/**
 * Les trois colonnes gelées font 610 px : au téléphone elles couvriraient tout l'écran et
 * masqueraient les données. Elles ne se figent donc qu'à partir de `sm` ; en dessous, le
 * tableau défile en entier dans son conteneur.
 */
function Th({ children, width, left, sticky, z, border, right }: { children?: React.ReactNode; width: number; left?: number; sticky?: boolean; z?: number; border?: boolean; right?: boolean }) {
  return (
    <th
      className={cn("whitespace-nowrap px-3 py-2 font-medium", sticky && "bg-secondary/60 sm:sticky", border && "border-r border-border", right && "text-right")}
      style={{ width, minWidth: width, left: sticky ? left : undefined, zIndex: z }}
    >
      {children}
    </th>
  );
}

function Td({ children, width, left, sticky, z, border, right, className }: { children?: React.ReactNode; width: number; left?: number; sticky?: boolean; z?: number; border?: boolean; right?: boolean; className?: string }) {
  return (
    <td
      className={cn("px-3 py-1.5 align-middle", sticky && "sm:sticky", border && "border-r border-border", right && "text-right", className)}
      style={{ width, minWidth: width, maxWidth: width, left: sticky ? left : undefined, zIndex: z }}
    >
      {children}
    </td>
  );
}

function AggNum({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/40">—</span>;
  return <span className="tabular-nums" title={formatNumber(value)}>{formatCompact(value)}</span>;
}

function EditableCell({
  kind, id, field, raw, numeric, canUpdate, display, className,
}: {
  kind: "project" | "product";
  id: string;
  field: string;
  raw: string;
  numeric?: boolean;
  canUpdate: boolean;
  display?: React.ReactNode;
  className?: string;
}) {
  const ecrire = useEcrireCellule();
  const [editing, setEditing] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const commit = (next: string) => {
    setEditing(false);
    const v = next.trim();
    if (v === (raw ?? "")) return;
    startTransition(() => ecrire({ kind, id, field, value: v }));
  };

  if (!canUpdate) {
    return <span className={cn("block truncate", className)} title={raw || undefined}>{display ?? (raw || <span className="text-muted-foreground/40">—</span>)}</span>;
  }
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={raw}
        inputMode={numeric ? "decimal" : undefined}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); else if (e.key === "Escape") { setEditing(false); } }}
        className="h-9 w-full rounded border border-ring bg-card px-1.5 text-base outline-none sm:h-7 sm:text-sm"
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className={cn("flex min-h-9 w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left hover:bg-secondary sm:min-h-0", numeric && "justify-end", className)}
      title={raw || "Cliquer pour éditer"}
    >
      {pending && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
      {display ?? (raw || <span className="text-muted-foreground/40">—</span>)}
    </button>
  );
}

/**
 * Écrit une cellule. La cellule n'a pas de place pour parler : un refus part en avis flottant,
 * et le tableau est relu dans tous les cas (comme avant).
 */
function useEcrireCellule() {
  const retours = useRetours();
  const { rafraichir } = useRafraichir();
  return React.useCallback(async (data: Record<string, string>) => {
    try {
      const r = await updateBdCell(fd(data));
      if (!r.ok) retours.erreur(r.error ?? "La modification n'a pas été enregistrée.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    }
    rafraichir();
  }, [retours, rafraichir]);
}

function SourcingSelect({ id, value, canUpdate }: { id: string; value: string; canUpdate: boolean }) {
  const ecrire = useEcrireCellule();
  const [pending, startTransition] = React.useTransition();
  if (!canUpdate) return <span className="text-xs">{BD_SOURCING[value] ?? value}</span>;
  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => { const v = e.target.value; startTransition(() => ecrire({ kind: "product", id, field: "sourcing", value: v })); }}
      className="h-7 w-full rounded border border-input bg-card px-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {Object.entries(BD_SOURCING).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function StatusSelect({ kind, id, value, canUpdate }: { kind: "project"; id: string; value: string; canUpdate: boolean }) {
  const ecrire = useEcrireCellule();
  const [pending, startTransition] = React.useTransition();
  if (!canUpdate) {
    const d = BD_PROJECT_STATUS[value];
    return <Badge tone={d?.tone ?? "neutral"} dot={false}>{d?.label ?? value}</Badge>;
  }
  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => { const v = e.target.value; startTransition(() => ecrire({ kind, id, field: "status", value: v })); }}
      className="h-7 w-full rounded border border-input bg-card px-1 text-xs font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {Object.entries(BD_PROJECT_STATUS).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
    </select>
  );
}

function DeleteBtn({ title, onConfirm }: { title: string; onConfirm: () => void }) {
  const confirmer = useConfirmer();
  return (
    <button onClick={async () => { if (await confirmer(title)) onConfirm(); }} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1" title={title} aria-label={title}>
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

function InlineAddRow({ colSpan, placeholder, onSubmit, onCancel }: { colSpan: number; placeholder: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const go = async () => { if (!name.trim()) return; setSaving(true); await onSubmit(name.trim()); setSaving(false); };
  return (
    <tr className="border-t border-border/40 bg-accent/30">
      <td colSpan={colSpan} className="px-3 py-2">
        {/* Collé à gauche de la zone visible : la ligne fait toute la largeur du tableau, et le
            champ resterait hors écran quand on l'ouvre depuis la colonne d'actions. */}
        <div className="sticky left-3 flex w-fit items-center gap-2">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(); else if (e.key === "Escape") onCancel(); }} placeholder={placeholder} className="h-9 w-48 sm:h-8 sm:w-72" />
          <Button size="sm" onClick={go} disabled={saving || !name.trim()}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Ajouter</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        </div>
      </td>
    </tr>
  );
}

// ───────────────────────────── helpers ─────────────────────────────

function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}

function downloadCsv(projects: BdProjectDTO[]) {
  const headers = [
    "Projet", "Statut projet", "Gamme", "DCI / Produit", "Marque", "Dosage", "Forme", "Statut (appro.)",
    "Marché (DZD)", "Marché (USD)", "Prix unitaire", "Volume marché", "Concurrents", "Parts concurrents",
    "Volume / concurrent", "Prix / concurrent", "Invest. A1", "Invest. A2", "Invest. A3",
    "Revenus A1", "Revenus A2", "Revenus A3", "Commentaire",
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(";")];
  for (const p of projects) {
    const status = BD_PROJECT_STATUS[p.status]?.label ?? p.status;
    for (const r of p.ranges) {
      for (const pr of r.products) {
        lines.push([
          p.name, status, r.name, pr.dci, pr.brandName, pr.dosage, pr.form, BD_SOURCING[pr.sourcing] ?? pr.sourcing,
          pr.marketSizeDzd ?? "", pr.marketSizeUsd ?? "", pr.unitPrice ?? "", pr.totalMarketVolume ?? "",
          pr.competitors, pr.competitorShares, pr.competitorVolume, pr.competitorPrice,
          pr.investmentY1 ?? "", pr.investmentY2 ?? "", pr.investmentY3 ?? "",
          pr.revenueY1 ?? "", pr.revenueY2 ?? "", pr.revenueY3 ?? "", pr.comment,
        ].map(esc).join(";"));
      }
      if (r.products.length === 0) lines.push([p.name, status, r.name].map(esc).join(";"));
    }
    if (p.ranges.length === 0) lines.push([p.name, status].map(esc).join(";"));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `business-development_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
