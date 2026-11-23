"use client";

import * as React from "react";
import { Columns3, FilterX, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { PiloteTableur } from "./use-tableur";
import { Survol } from "./survol";

/**
 * LA BARRE D'UNE FEUILLE « COMME EXCEL » — la recherche globale, le compte (« 1 234 lignes
 * (56 filtrées) »), « Effacer tous les filtres » quand un filtre réduit la vue, et le choix des
 * colonnes affichées. Les gestes propres à l'écran (ajouter, importer, exporter…) viennent en
 * `children`, à droite.
 *
 * Le compte est annoncé (`aria-live`) : poser un filtre change la feuille sans bouger le focus,
 * et un lecteur d'écran doit dire ce qu'il reste.
 */
export function BarreTableur({ pilote, placeholder, etiquette = "Rechercher dans toute la feuille", aide, children }: {
  pilote: PiloteTableur;
  placeholder: string;
  /** Le nom du champ de recherche, pour un lecteur d'écran. */
  etiquette?: string;
  /** Un « ⓘ » collé au compte (le mode d'emploi du clavier, par exemple). */
  aide?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-72">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search" enterKeyHint="search" value={pilote.recherche} onChange={(e) => pilote.setRecherche(e.target.value)}
          placeholder={placeholder} aria-label={etiquette} className="w-full pl-8"
        />
      </div>
      <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
        <span aria-live="polite">{pilote.compte}</span>
        {aide}
      </span>
      {pilote.actif && (
        <button
          type="button" onClick={pilote.effacerFiltres}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-primary/40 bg-accent px-2.5 text-xs font-medium text-accent-foreground hover:bg-accent/70 sm:min-h-8"
        >
          <FilterX className="h-3.5 w-3.5" aria-hidden /> Effacer tous les filtres
        </button>
      )}
      <MenuColonnes pilote={pilote} />
      {children && <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">{children}</div>}
    </div>
  );
}

/** AFFICHER / MASQUER DES COLONNES — pour la vue de la personne seulement ; rien n'est enregistré. */
function MenuColonnes({ pilote }: { pilote: PiloteTableur }) {
  const [ouvert, setOuvert] = React.useState(false);
  const ancre = React.useRef<HTMLButtonElement>(null);
  const fermer = React.useCallback(() => setOuvert(false), []);
  const masquables = pilote.colonnes.filter((c) => c.masquable !== false);
  if (masquables.length === 0) return null;
  const nbMasquees = masquables.filter((c) => pilote.masquees.has(c.cle)).length;
  return (
    <>
      <button
        ref={ancre} type="button" onClick={() => setOuvert((v) => !v)} aria-haspopup="dialog" aria-expanded={ouvert}
        className={cn(
          "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-input px-2.5 text-xs font-medium hover:bg-secondary sm:min-h-8",
          nbMasquees > 0 && "border-primary/40 text-primary",
        )}
      >
        <Columns3 className="h-3.5 w-3.5" aria-hidden /> Colonnes{nbMasquees > 0 ? ` (${nbMasquees} masquée${nbMasquees > 1 ? "s" : ""})` : ""}
      </button>
      {ouvert && (
        <Survol ancre={ancre} onFermer={fermer} etiquette="Colonnes affichées" largeur={256}>
          <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">Colonnes affichées</p>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {masquables.map((c) => (
              <li key={c.cle}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-secondary sm:py-1.5">
                  <input
                    type="checkbox" checked={!pilote.masquees.has(c.cle)} onChange={() => pilote.basculerColonne(c.cle)}
                    className="h-4 w-4 rounded border-input"
                  />
                  <span className="truncate">{c.libelle}</span>
                </label>
              </li>
            ))}
          </ul>
          {nbMasquees > 0 && (
            <div className="border-t border-border p-2">
              <button
                type="button" onClick={() => { for (const c of masquables) if (pilote.masquees.has(c.cle)) pilote.basculerColonne(c.cle); }}
                className="w-full rounded-md px-2 py-2 text-left text-xs text-primary hover:bg-secondary sm:py-1.5"
              >
                Tout afficher
              </button>
            </div>
          )}
        </Survol>
      )}
    </>
  );
}
