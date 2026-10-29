"use client";

import * as React from "react";

import { Plus, Trash2, Loader2, Sparkles, BarChart3, ChevronDown, ChevronRight } from "lucide-react";
import {
  addResearchRow, updateResearchRow, deleteResearchRow,
  addResearchPlayer, updateResearchPlayer, deleteResearchPlayer, prefillResearchRow,
} from "@/lib/actions/market-research-actions";
import type { ResearchRowDTO } from "@/lib/queries/market-research";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

const STATUS_LABEL: Record<string, string> = { IMPORT: "Importation", MANUFACTURING: "Fabrication" };
const STATUS_COLOR: Record<string, string> = { IMPORT: "#f59e0b", MANUFACTURING: "#0ea5e9" };
// 16 px au téléphone : en dessous, iOS zoome sur le champ à chaque saisie.
const inp = "h-9 w-full rounded-md border border-input bg-background px-2 text-base focus:border-primary focus:outline-none sm:h-8 sm:text-sm";
const nOrNull = (s: string) => { const t = s.trim(); if (!t) return ""; return t; };

export function ResearchTable({ researchId, rows, canEdit, dciOptions = [] }: { researchId: string; rows: ResearchRowDTO[]; canEdit: boolean; dciOptions?: string[] }) {
  const { rafraichir } = useRafraichir();
  // Les cellules et icônes du tableau n'ont pas de place pour parler : un refus part en avis flottant.
  const retours = useRetours();
  const [busy, setBusy] = React.useState(false);

  async function run(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, refresh = true) {
    setBusy(true);
    try {
      const r = await action(fd);
      if (!r.ok) { retours.erreur(r.error ?? "La modification n'a pas été enregistrée."); return; }
      if (refresh) rafraichir();
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  const th = "whitespace-nowrap px-2 py-2 text-left text-xs font-medium text-muted-foreground";

  return (
    <div className="space-y-3 p-3">
      {/* Menu déroulant des DCI normalisés de la nomenclature (saisie assistée du produit). */}
      <datalist id="dci-nomenclature">{dciOptions.map((d) => <option key={d} value={d} />)}</datalist>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              <th className={`${th} w-8`}>N</th>
              <th className={`${th} w-40`}>Classe thérapeutique</th>
              <th className={`${th} w-44`}>Produit</th>
              <th className={`${th} w-28`}>Marché (volume)</th>
              <th className={`${th} w-28`}>Marché ($)</th>
              <th className={`${th} w-24`}>Prix/boîte $</th>
              <th className={`${th} w-14`}>Acteurs</th>
              <th className={`${th} min-w-[320px]`}>Acteurs & parts de marché (Import / Fabrication)</th>
              <th className={`${th} w-40`}>Commentaires</th>
              <th className={`${th} w-8`}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-4 text-muted-foreground sm:text-center"><span className="sticky left-3 inline-block">Aucune molécule. {canEdit && "Ajoutez une ligne ci-dessous."}</span></td></tr>
            )}
            {rows.map((row, i) => (
              <RowEditor key={row.id} researchId={researchId} row={row} index={i + 1} canEdit={canEdit} onStruct={rafraichir} busy={busy} run={run} />
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <button
          type="button"
          disabled={busy}
          onClick={() => { const fd = new FormData(); fd.set("researchId", researchId); run(addResearchRow, fd); }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter une molécule
        </button>
      )}
    </div>
  );
}

function RowEditor({
  researchId, row, index, canEdit, run, busy,
}: {
  researchId: string; row: ResearchRowDTO; index: number; canEdit: boolean; onStruct: () => void; busy: boolean;
  run: (a: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, refresh?: boolean) => void;
}) {
  const confirmer = useConfirmer();
  const [s, setS] = React.useState({
    therapeuticClass: row.therapeuticClass ?? "",
    product: row.product,
    marketVolume: row.marketVolume != null ? String(row.marketVolume) : "",
    marketValueUsd: row.marketValueUsd != null ? String(row.marketValueUsd) : "",
    avgPricePerBoxUsd: row.avgPricePerBoxUsd != null ? String(row.avgPricePerBoxUsd) : "",
    comment: row.comment ?? "",
  });
  const [open, setOpen] = React.useState(false);

  function saveRow() {
    const fd = new FormData();
    fd.set("id", row.id); fd.set("researchId", researchId);
    fd.set("therapeuticClass", s.therapeuticClass); fd.set("product", s.product);
    fd.set("marketVolume", nOrNull(s.marketVolume)); fd.set("marketValueUsd", nOrNull(s.marketValueUsd));
    fd.set("avgPricePerBoxUsd", nOrNull(s.avgPricePerBoxUsd)); fd.set("comment", s.comment);
    run(updateResearchRow, fd, false);
  }
  const ro = (v: string) => <span>{v || "—"}</span>;
  const cell = "border-b border-border/60 px-1.5 py-1 align-top";

  const shares = row.players.map((p) => ({ name: p.name, value: p.marketShareValue ?? 0, status: p.status }));
  const totalShare = shares.reduce((sum, x) => sum + x.value, 0);

  return (
    <>
    <tr className="hover:bg-secondary/20">
      <td className={`${cell} text-center text-xs text-muted-foreground`}>{index}</td>
      <td className={cell}>{canEdit ? <input className={inp} value={s.therapeuticClass} onChange={(e) => setS({ ...s, therapeuticClass: e.target.value })} onBlur={saveRow} /> : ro(s.therapeuticClass)}</td>
      <td className={cell}>{canEdit ? <input className={inp} list="dci-nomenclature" value={s.product} onChange={(e) => setS({ ...s, product: e.target.value })} onBlur={saveRow} placeholder="DCI (nomenclature)…" /> : ro(s.product)}</td>
      <td className={cell}>{canEdit ? <input inputMode="decimal" className={inp} value={s.marketVolume} onChange={(e) => setS({ ...s, marketVolume: e.target.value })} onBlur={saveRow} /> : ro(s.marketVolume)}</td>
      <td className={cell}>{canEdit ? <input inputMode="decimal" className={inp} value={s.marketValueUsd} onChange={(e) => setS({ ...s, marketValueUsd: e.target.value })} onBlur={saveRow} /> : ro(s.marketValueUsd)}</td>
      <td className={cell}>{canEdit ? <input inputMode="decimal" className={inp} value={s.avgPricePerBoxUsd} onChange={(e) => setS({ ...s, avgPricePerBoxUsd: e.target.value })} onBlur={saveRow} /> : ro(s.avgPricePerBoxUsd)}</td>
      <td className={`${cell} text-center font-medium`}>{row.players.length}</td>
      <td className={cell}>
        <div className="space-y-1">
          {row.players.map((p) => <PlayerEditor key={p.id} researchId={researchId} player={p} canEdit={canEdit} run={run} />)}
          {canEdit && (
            <button type="button" disabled={busy} onClick={() => { const fd = new FormData(); fd.set("rowId", row.id); fd.set("researchId", researchId); run(addResearchPlayer, fd); }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-2 text-xs text-primary hover:bg-primary/10 sm:py-0.5"><Plus className="h-3 w-3" /> Acteur</button>
          )}
        </div>
      </td>
      <td className={cell}>{canEdit ? <input className={inp} value={s.comment} onChange={(e) => setS({ ...s, comment: e.target.value })} onBlur={saveRow} /> : ro(s.comment)}</td>
      <td className={`${cell} text-center`}>
        <div className="flex flex-col items-center gap-0.5">
          <button type="button" onClick={() => setOpen((o) => !o)} title="Voir plus de détails" aria-label="Voir plus de détails" className="rounded p-2 text-muted-foreground hover:bg-secondary sm:p-1">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          {canEdit && (
            <button type="button" title="Pré-remplir depuis l'intelligence marché (Pharmatool)" onClick={() => { const fd = new FormData(); fd.set("id", row.id); fd.set("researchId", researchId); run(prefillResearchRow, fd); }} aria-label="Pré-remplir depuis l'intelligence marché" className="rounded p-2 text-primary hover:bg-primary/10 sm:p-1"><Sparkles className="h-3.5 w-3.5" /></button>
          )}
          {canEdit && (
            <button type="button" onClick={async () => { if (await confirmer(`Supprimer « ${s.product} » ?`)) { const fd = new FormData(); fd.set("id", row.id); fd.set("researchId", researchId); run(deleteResearchRow, fd); } }}
              aria-label={`Supprimer ${s.product}`} className="rounded p-2 text-destructive hover:bg-destructive/10 sm:p-1"><Trash2 className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </td>
    </tr>
    {open && (
      <tr className="bg-secondary/20">
        <td colSpan={10} className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><BarChart3 className="h-3.5 w-3.5" /> Parts de marché — {s.product}</div>
          {shares.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Aucun acteur. Ajoutez des acteurs ou utilisez le pré-remplissage marché.</p>
          ) : (
            <div className="mt-2 max-w-2xl space-y-1.5">
              {shares.map((sh, k) => {
                const pct = totalShare > 0 ? Math.round((sh.value / totalShare) * 100) : 0;
                return (
                  <div key={k} className="flex items-center gap-2 text-sm">
                    <span className="w-40 shrink-0 truncate" title={sh.name}>{sh.name}</span>
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: sh.status ? STATUS_COLOR[sh.status] : "#94a3b8" }} />
                    </div>
                    <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{pct}%</span>
                    {sh.status && <span className="w-20 shrink-0 text-[0.6875rem] text-muted-foreground">{STATUS_LABEL[sh.status]}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </td>
      </tr>
    )}
    </>
  );
}

function PlayerEditor({
  researchId, player, canEdit, run,
}: {
  researchId: string; player: ResearchRowDTO["players"][number]; canEdit: boolean;
  run: (a: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, refresh?: boolean) => void;
}) {
  const [p, setP] = React.useState({ name: player.name, marketShareValue: player.marketShareValue != null ? String(player.marketShareValue) : "", status: player.status ?? "" });
  function save() {
    const fd = new FormData();
    fd.set("id", player.id); fd.set("researchId", researchId);
    fd.set("name", p.name); fd.set("marketShareValue", nOrNull(p.marketShareValue)); fd.set("status", p.status);
    run(updateResearchPlayer, fd, false);
  }
  if (!canEdit) {
    return <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="font-medium">{p.name}</span>{p.marketShareValue && <span className="text-muted-foreground">· {p.marketShareValue}</span>}{p.status && <span className="rounded bg-secondary px-1 text-[0.6875rem]">{STATUS_LABEL[p.status]}</span>}</div>;
  }
  const mini = "h-9 rounded-md border border-input bg-background px-1.5 text-base focus:border-primary focus:outline-none sm:h-7 sm:text-xs";
  return (
    <div className="flex items-center gap-1">
      <input className={`${mini} min-w-0 flex-1`} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} onBlur={save} placeholder="Acteur" />
      <input className={`${mini} w-20`} inputMode="decimal" value={p.marketShareValue} onChange={(e) => setP({ ...p, marketShareValue: e.target.value })} onBlur={save} placeholder="part" />
      <select className={`${mini} w-24`} value={p.status} onChange={(e) => { const status = e.target.value; setP({ ...p, status }); const fd = new FormData(); fd.set("id", player.id); fd.set("researchId", researchId); fd.set("name", p.name); fd.set("marketShareValue", nOrNull(p.marketShareValue)); fd.set("status", status); run(updateResearchPlayer, fd, false); }}>
        <option value="">— statut —</option>
        <option value="IMPORT">Importation</option>
        <option value="MANUFACTURING">Fabrication</option>
      </select>
      <button type="button" onClick={() => { const fd = new FormData(); fd.set("id", player.id); fd.set("researchId", researchId); run(deleteResearchPlayer, fd); }} aria-label="Supprimer l'acteur" className="shrink-0 rounded p-2 text-destructive hover:bg-destructive/10 sm:p-0.5"><Trash2 className="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button>
    </div>
  );
}
