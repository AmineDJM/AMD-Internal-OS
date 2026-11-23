"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useTableur, type ColonneTableur } from "./use-tableur";
import { CelluleEnTete } from "./en-tete-filtre";
import { BarreTableur } from "./barre-tableur";

/**
 * LA FEUILLE EN LECTURE, COMME DANS EXCEL — pour un annuaire qui se CONSULTE (les gestes d'écriture
 * passent par les actions de la ligne). Les feuilles qui s'éditent en place (praticiens,
 * établissements) gardent leur propre quadrillage et branchent les mêmes pièces : `useTableur`,
 * `CelluleEnTete`, `BarreTableur`.
 *
 *   - en-tête COLLÉ en haut et première colonne FIGÉE à gauche : la feuille défile dans son cadre,
 *     jamais la page de côté (au téléphone, on la fait glisser au doigt) ;
 *   - lignes serrées, une sur deux teintée, la ligne survolée surlignée ;
 *   - filtre automatique, tri, largeur et affichage des colonnes : voir `CelluleEnTete` ;
 *   - au clavier, la feuille se parcourt comme un tableur : flèches, Début/Fin (Ctrl : première et
 *     dernière ligne), Page préc./suiv. ; ENTRÉE (ou un double-clic) OUVRE la ligne.
 */

export interface ColonneDeTableur<T> extends ColonneTableur {
  /** La valeur AFFICHÉE — celle que l'on filtre, trie et cherche. */
  valeur: (ligne: T) => string;
  /** Le rendu de la cellule, quand il n'est pas le texte seul (lien, pastille). */
  rendu?: (ligne: T) => React.ReactNode;
  alignement?: "droite";
}

interface Pos { r: number; c: number }

export function Tableur<T>({
  lignes, colonnes, cleLigne, onOuvrir, actions, placeholder, vide, barre, estAttenuee,
}: {
  lignes: readonly T[];
  colonnes: readonly ColonneDeTableur<T>[];
  cleLigne: (ligne: T) => string;
  /** Entrée ou double-clic sur une ligne. */
  onOuvrir?: (ligne: T) => void;
  /** Les gestes d'une ligne (modifier, retirer), dans la dernière colonne. */
  actions?: (ligne: T) => React.ReactNode;
  placeholder: string;
  /** Ce que dit une feuille sans aucune ligne. */
  vide: string;
  /** Les gestes de l'écran, à droite de la barre (ajouter, exporter…). */
  barre?: React.ReactNode;
  /** Une ligne à montrer en retrait (inactive). */
  estAttenuee?: (ligne: T) => boolean;
}) {
  const parCle = React.useMemo(() => new Map(colonnes.map((c) => [c.cle, c])), [colonnes]);
  const acces = React.useCallback((l: T, cle: string) => parCle.get(cle)?.valeur(l) ?? "", [parCle]);
  const t = useTableur({ lignes, colonnes, acces });
  const cols = t.colonnesVisibles.map((c) => parCle.get(c.cle)!).filter(Boolean);
  const visibles = t.visibles;

  const tableRef = React.useRef<HTMLTableElement>(null);
  const [pos, setPos] = React.useState<Pos>({ r: 0, c: 0 });
  const focusDemande = React.useRef(false);
  const r0 = Math.min(pos.r, Math.max(0, visibles.length - 1));
  const c0 = Math.min(pos.c, Math.max(0, cols.length - 1));

  React.useEffect(() => {
    if (!focusDemande.current) return;
    focusDemande.current = false;
    tableRef.current?.querySelector<HTMLElement>(`[data-cellule="${r0}:${c0}"]`)?.focus();
  }, [r0, c0]);

  const aller = (r: number, c: number) => {
    focusDemande.current = true;
    setPos({ r: Math.max(0, Math.min(visibles.length - 1, r)), c: Math.max(0, Math.min(cols.length - 1, c)) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cible = e.target as HTMLElement;
    if (!cible.dataset.cellule) return; // une frappe dans un bouton de ligne n'est pas un geste de feuille
    const ctrl = e.ctrlKey || e.metaKey;
    const coups: Record<string, () => void> = {
      ArrowUp: () => aller(r0 - 1, c0),
      ArrowDown: () => aller(r0 + 1, c0),
      ArrowLeft: () => aller(r0, c0 - 1),
      ArrowRight: () => aller(r0, c0 + 1),
      Home: () => aller(ctrl ? 0 : r0, 0),
      End: () => aller(ctrl ? visibles.length - 1 : r0, cols.length - 1),
      PageUp: () => aller(r0 - 15, c0),
      PageDown: () => aller(r0 + 15, c0),
      Enter: () => { const l = visibles[r0]; if (l && onOuvrir) onOuvrir(l); },
    };
    const coup = coups[e.key];
    if (!coup) return;
    e.preventDefault();
    coup();
  };

  const largeurTotale = cols.reduce((s, c) => s + t.largeur(c.cle), 0) + (actions ? 96 : 0);
  const fond = (i: number) => (i % 2 === 1 ? "bg-muted" : "bg-card");

  return (
    <div className="space-y-2">
      <BarreTableur pilote={t} placeholder={placeholder}>{barre}</BarreTableur>
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
        <table
          ref={tableRef} role="grid" aria-rowcount={visibles.length + 1} aria-colcount={cols.length}
          className="min-w-full table-fixed border-separate border-spacing-0 text-[13px]" style={{ width: largeurTotale }}
          onKeyDown={onKeyDown}
        >
          <colgroup>
            {cols.map((c) => <col key={c.cle} style={{ width: t.largeur(c.cle) }} />)}
            {actions && <col style={{ width: 96 }} />}
          </colgroup>
          <thead>
            <tr>
              {cols.map((c, j) => (
                <CelluleEnTete
                  key={c.cle} colonne={c} pilote={t}
                  className={cn(
                    "sticky top-0 border-b border-r border-border bg-secondary text-muted-foreground",
                    j === 0 ? "left-0 z-30" : "z-20",
                    c.alignement === "droite" && "text-right",
                  )}
                />
              ))}
              {actions && <th scope="col" className="sticky top-0 z-20 border-b border-border bg-secondary"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 && (
              <tr>
                <td colSpan={cols.length + (actions ? 1 : 0)} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {lignes.length === 0 ? vide : "Aucune ligne ne correspond aux filtres."}
                </td>
              </tr>
            )}
            {visibles.map((l, i) => (
              <tr key={cleLigne(l)} aria-rowindex={i + 2} className={cn("group", estAttenuee?.(l) && "text-muted-foreground")}>
                {cols.map((c, j) => {
                  const actif = i === r0 && j === c0;
                  return (
                    <td
                      key={c.cle} role="gridcell" tabIndex={actif ? 0 : -1} data-cellule={`${i}:${j}`}
                      onFocus={() => { if (!actif) setPos({ r: i, c: j }); }}
                      onDoubleClick={() => onOuvrir?.(l)}
                      className={cn(
                        "truncate border-b border-r border-border px-2 py-1 leading-5 outline-none group-hover:bg-accent focus:shadow-[inset_0_0_0_2px_hsl(var(--primary))]",
                        fond(i),
                        j === 0 && "sticky left-0 z-10 font-medium",
                        c.alignement === "droite" && "text-right tabular-nums",
                      )}
                      title={c.valeur(l) || undefined}
                    >
                      {c.rendu ? c.rendu(l) : c.valeur(l) || <span className="text-muted-foreground/40">—</span>}
                    </td>
                  );
                })}
                {actions && (
                  <td className={cn("border-b border-border px-1 py-0.5 group-hover:bg-accent", fond(i))}>
                    <span className="flex items-center justify-end gap-0.5">{actions(l)}</span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
