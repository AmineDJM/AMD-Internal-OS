"use client";

import * as React from "react";
import { Split } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { ancrePoste } from "@/lib/chemins/ad-pro";
import { resumeRepartition } from "../../domaine/poste-etapes";
import type { ItemRow } from "../items-panel";
import { montantDuPoste, ouEnEstLePoste, titreDuPoste, type DroitsDesPostes } from "./resume-poste";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DES POSTES (maquette « Fiche Ad & Pro » validée, 24/11/2026) — Poste · Où il en est · Montant · Ouvrir.
 *
 * « Ouvrir » déplie la CARTE COMPLÈTE du poste sous sa ligne (`PosteCarte`, montée par le panneau : menu « ⋯ », chaîne
 * devis → BC → facture → paiement, parcours agence, discussion) — rien n'est retiré, seulement replié. La ligne du poste qui
 * attend la personne qui regarde est surlignée, sa phrase dit « chez vous ».
 *
 * L'ancre du poste (`#poste-…`, celle des notifications) est portée par la ligne quand elle est fermée, par la carte quand
 * elle est ouverte : jamais deux éléments du même identifiant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function TableauDesPostes({ groupes, droits, deplies, basculer, carte }: {
  groupes: { cle: string; repartitionId: string | null; items: ItemRow[] }[];
  droits: DroitsDesPostes;
  deplies: ReadonlySet<string>;
  basculer: (id: string) => void;
  /** La carte complète d'un poste (un `<li>`), telle que le panneau la monte. */
  carte: (it: ItemRow) => React.ReactNode;
}) {
  const ligne = (it: ItemRow) => {
    const l = ouEnEstLePoste(it, droits);
    const ouvert = deplies.has(it.id);
    const { titre, nature } = titreDuPoste(it);
    const montant = montantDuPoste(it);
    return (
      <React.Fragment key={it.id}>
        <tr id={ouvert ? undefined : ancrePoste(it.id)} className={cn("scroll-mt-20 border-t border-border/70 align-top", l.aVous && "bg-primary/5")}>
          <td className="px-3 py-2.5">
            <p className="font-medium [overflow-wrap:anywhere]">{titre}</p>
            {nature && <p className="text-xs text-muted-foreground">{nature}</p>}
            {/* Au téléphone, la colonne « Où il en est » se replie sous le nom. */}
            <p className={cn("mt-0.5 text-xs sm:hidden", l.aVous ? "font-medium text-primary" : "text-muted-foreground")}>{l.phrase}</p>
          </td>
          <td className={cn("hidden px-3 py-2.5 sm:table-cell", l.aVous ? "font-medium text-primary" : "text-muted-foreground")} title={l.detail ?? undefined}>
            {l.phrase}
          </td>
          <td className={cn("whitespace-nowrap px-3 py-2.5 text-right tabular-nums", montant == null && "text-muted-foreground")}>
            {montant != null ? formatCurrency(montant) : "—"}
          </td>
          <td className="px-3 py-2.5 text-right">
            <button
              type="button" onClick={() => basculer(it.id)} aria-expanded={ouvert}
              aria-label={`${ouvert ? "Fermer" : "Ouvrir"} — ${it.label}`}
              className="inline-flex min-h-9 items-center rounded px-1 text-sm font-medium text-primary hover:underline sm:min-h-0"
            >
              {ouvert ? "Fermer" : "Ouvrir"}
            </button>
          </td>
        </tr>
        {ouvert && (
          <tr>
            <td colSpan={4} className="bg-secondary/20 p-2 sm:p-3">
              <ul>{carte(it)}</ul>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">Poste</th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">Où il en est</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Montant</th>
            <th scope="col" className="px-3 py-2"><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody>
          {groupes.map((g) => {
            if (!g.repartitionId) return ligne(g.items[0]!);
            // Un sponsoring indirect réparti par nature : ses postes ensemble, sous leur total.
            const r = resumeRepartition(g.items);
            return (
              <React.Fragment key={g.cle}>
                <tr className="border-t border-border/70 bg-secondary/20">
                  <td colSpan={4} className="px-3 py-2 text-xs">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Split className="h-3.5 w-3.5 text-muted-foreground" />
                      <strong>Sponsoring indirect</strong>
                      <span className="tabular-nums text-muted-foreground">{formatCurrency(r.total)}</span>
                      <span className="text-muted-foreground">
                        · {r.natures} nature{r.natures > 1 ? "s" : ""}{r.postes > r.natures ? ` · ${r.postes} postes` : ""}
                      </span>
                    </span>
                  </td>
                </tr>
                {g.items.map(ligne)}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
