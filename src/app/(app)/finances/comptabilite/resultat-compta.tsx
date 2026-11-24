"use client";

import * as React from "react";
import Link from "next/link";
import type { DonneesComptabilite } from "@/modules/finances/api";
import { libelleMoisLong } from "@/modules/finances/partage";
import { FINANCE_CATEGORY } from "@/lib/labels";
import { cn, formatCurrency } from "@/lib/utils";

const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const signe = (r: number) => `${r >= 0 ? "+ " : "− "}${formatCurrency(Math.abs(r))}`;

/**
 * L'ONGLET « RÉSULTAT » — l'année en cours, mois par mois (recettes, dépenses, résultat), calculée au serveur depuis les
 * écritures réglées (`resultatParMois` : la paie dans son mois de paie). Un clic sur un mois ouvre son détail par
 * catégorie, et ses listes de recettes et de dépenses.
 */
export function ResultatCompta({ resultat, lienMois }: {
  resultat: DonneesComptabilite["resultat"];
  lienMois: (mois: string, vue: "dep" | "rec") => string;
}) {
  const lignes = resultat.donnees.lignes;
  const [choisi, setChoisi] = React.useState(lignes[lignes.length - 1]?.mois ?? "");
  const detail = lignes.find((l) => l.mois === choisi) ?? null;
  const dernier = lignes[lignes.length - 1]?.mois;
  const t = resultat.donnees.total;
  const grille = "grid grid-cols-[minmax(150px,1fr)_160px_160px_160px] gap-x-3";

  return (
    <>
      <section aria-label="Résultat mensuel" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div className={cn(grille, "bg-muted/50 px-[18px] py-2.5 text-xs font-semibold text-muted-foreground")}>
              <span>Mois · {resultat.annee}</span><span className="text-right">Recettes</span><span className="text-right">Dépenses</span><span className="text-right">Résultat</span>
            </div>
            <ul>
              {lignes.map((m) => {
                const sel = m.mois === choisi;
                return (
                  <li key={m.mois} className="border-t border-border/60">
                    <button
                      type="button" onClick={() => setChoisi(m.mois)} aria-pressed={sel}
                      className={cn(grille, "w-full items-center px-[18px] py-[11px] text-left text-sm tabular-nums", sel ? "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]" : "hover:bg-secondary/60")}
                    >
                      <span className="font-semibold">{MOIS[Number(m.mois.slice(5, 7)) - 1]}{m.mois === dernier ? " · en cours" : ""}</span>
                      <span className="text-right text-success">{formatCurrency(m.recettes)}</span>
                      <span className="text-right">{formatCurrency(m.depenses)}</span>
                      <span className={cn("text-right font-semibold", m.resultat >= 0 ? "text-success" : "text-destructive")}>{signe(m.resultat)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className={cn(grille, "border-t-2 border-border bg-muted/50 px-[18px] py-3 text-sm font-bold tabular-nums")}>
              <span>Cumul {resultat.annee}</span>
              <span className="text-right text-success">{formatCurrency(t.recettes)}</span>
              <span className="text-right">{formatCurrency(t.depenses)}</span>
              <span className={cn("text-right", t.resultat >= 0 ? "text-success" : "text-destructive")}>{signe(t.resultat)}</span>
            </div>
          </div>
        </div>
      </section>

      {detail && (
        <section aria-labelledby="detail-mois" className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-[18px]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="detail-mois" className="text-[17px] font-bold">{libelleMoisLong(detail.mois)}</h2>
            <span className={cn("text-[15px] font-bold", detail.resultat >= 0 ? "text-success" : "text-destructive")}>Résultat {signe(detail.resultat)}</span>
          </div>
          <div className="flex flex-wrap gap-5">
            {([
              ["rec", "Recettes", detail.recettes, detail.parCategorie.recettes, "text-success", "Voir les recettes du mois →"],
              ["dep", "Dépenses", detail.depenses, detail.parCategorie.depenses, "text-muted-foreground", "Voir les dépenses du mois →"],
            ] as const).map(([vue, titre, total, cats, ton, voir]) => (
              <div key={vue} className="flex flex-[1_1_260px] flex-col gap-1.5">
                <h3 className={cn("text-xs font-semibold uppercase tracking-wide", ton)}>{titre} · {formatCurrency(total)}</h3>
                {cats.length === 0 && <p className="py-1.5 text-sm text-muted-foreground">Aucune {vue === "rec" ? "recette" : "dépense"} réglée ce mois-ci.</p>}
                {cats.map((c) => (
                  <div key={c.categorie} className="flex justify-between gap-2 border-b border-border/60 py-1.5 text-sm">
                    <span>{FINANCE_CATEGORY[c.categorie] ?? c.categorie}</span><strong className="tabular-nums">{formatCurrency(c.montant)}</strong>
                  </div>
                ))}
                <Link href={lienMois(detail.mois, vue)} scroll={false} className="mt-1 self-start text-sm font-semibold text-primary">{voir}</Link>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
