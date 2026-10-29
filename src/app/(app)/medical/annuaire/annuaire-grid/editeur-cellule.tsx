"use client";

/**
 * L'ANNUAIRE — l'éditeur d'une cellule, rendu seulement pendant l'édition.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { type ColonneVue, type GroupeOptions, SPECIALTY_LIST_ID } from "./colonnes";

// ── L'ÉDITEUR D'UNE CELLULE : rendu seulement pendant l'édition. ──
export function EditeurCellule({
  col, valeur, initial, groupes, onCommit, onCancel,
}: {
  col: ColonneVue;
  valeur: string;
  initial?: string;
  /** Les choix d'une cellule de LIEN, calculés pour sa ligne. */
  groupes?: GroupeOptions[];
  onCommit: (next: string, suite?: "bas" | "droite" | "gauche") => void;
  onCancel: () => void;
}) {
  const ref = React.useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  // UNE SEULE ISSUE PAR ÉDITION. Entrée valide puis l'éditeur se démonte, et le navigateur envoie
  // encore un `blur` : sans ce verrou, la même valeur partirait deux fois — et Échap, qui annule,
  // serait suivi d'un blur qui VALIDE ce qu'on venait d'annuler.
  const fini = React.useRef(false);
  const commit = (next: string, suite?: "bas" | "droite" | "gauche") => {
    if (fini.current) return;
    fini.current = true;
    onCommit(next, suite);
  };
  const cancel = () => {
    if (fini.current) return;
    fini.current = true;
    onCancel();
  };
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Une frappe qui a ouvert l'édition remplace le contenu : le curseur se met à la fin.
    if (el instanceof HTMLInputElement && el.type !== "date") {
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch { /* type non textuel */ }
    }
  }, []);

  const classes = "w-full min-w-[6rem] select-text rounded bg-card px-2 py-1.5 text-sm outline-none ring-2 ring-ring";

  if (col.editor === "reference") {
    return (
      <select
        ref={ref as React.RefObject<HTMLSelectElement>}
        defaultValue={valeur}
        aria-label={col.header}
        className={cn(classes, "cursor-pointer")}
        onChange={(e) => commit(e.target.value)}
        onBlur={cancel}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); cancel(); }
          if (e.key === "Enter") { e.preventDefault(); commit((e.target as HTMLSelectElement).value, "bas"); }
          if (e.key === "Tab") { e.preventDefault(); commit((e.target as HTMLSelectElement).value, e.shiftKey ? "gauche" : "droite"); }
        }}
      >
        {(groupes ?? []).map((g, i) => (g.label
          ? <optgroup key={i} label={g.label}>{g.options.map((o) => <option key={`${i}-${o.value}`} value={o.value}>{o.label}</option>)}</optgroup>
          : g.options.map((o) => <option key={`${i}-${o.value}`} value={o.value}>{o.label}</option>)))}
      </select>
    );
  }

  if (col.editor === "select") {
    return (
      <select
        ref={ref as React.RefObject<HTMLSelectElement>}
        defaultValue={valeur}
        className={cn(classes, "cursor-pointer")}
        onChange={(e) => commit(e.target.value)}
        onBlur={cancel}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); cancel(); }
          if (e.key === "Enter") { e.preventDefault(); commit((e.target as HTMLSelectElement).value, "bas"); }
          if (e.key === "Tab") { e.preventDefault(); commit((e.target as HTMLSelectElement).value, e.shiftKey ? "gauche" : "droite"); }
        }}
      >
        {(col.field === "wilaya" || col.custom) && <option value="">—</option>}
        {(col.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      type={col.editor === "date" ? "date" : "text"}
      inputMode={col.editor === "number" ? "decimal" : undefined}
      defaultValue={initial ?? valeur}
      list={col.suggest ? SPECIALTY_LIST_ID : undefined}
      className={classes}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        const el = e.target as HTMLInputElement;
        if (e.key === "Enter") { e.preventDefault(); commit(el.value, "bas"); }
        else if (e.key === "Tab") { e.preventDefault(); commit(el.value, e.shiftKey ? "gauche" : "droite"); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      }}
    />
  );
}
