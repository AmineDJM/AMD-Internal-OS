"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FILTRES_VIDES, filtrer, trier, triSuivant,
  type ColonneTri, type FiltresListe, type LigneAdPro, type Tri,
} from "./liste";
import { CarteDemande, EnteteTriable, LigneDemande } from "./ligne-demande";

/**
 * LE TABLEAU DES DEMANDES AD & PRO — la recherche, puis le tableau.
 *
 *   • la recherche instantanée (objet, référence, médecin ou bénéficiaire, demandeur) — la seule barre (Super Admin,
 *     25/11/2026 : pas de double emploi avec les onglets de nature du haut de page) ;
 *   • le tri par en-tête de colonne.
 *
 * Ce qui attend la personne connectée remonte en tête et se voit (`trier`). Au téléphone, chaque demande est une
 * carte — pas de défilement de côté. Les règles sont dans `liste.ts` (testé) ; ce fichier dessine.
 */

/** Police ≥ 16 px au téléphone : iOS ne zoome pas sur le champ. */
const champ = "h-10 w-full rounded-lg border border-input bg-background px-3 text-base outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm";

export function AdProList({ rows, maintenant }: {
  rows: LigneAdPro[];
  /** L'heure du rendu SERVEUR : « depuis 3 j » se lit sur la même minute au serveur et au navigateur. */
  maintenant: number;
}) {
  const [f, setF] = React.useState<FiltresListe>(FILTRES_VIDES);
  const [tri, setTri] = React.useState<Tri | null>(null);
  const recherche = React.useRef<HTMLInputElement>(null);
  // La frappe reste fluide sur deux cents lignes : le tableau suit la recherche un battement après.
  const q = React.useDeferredValue(f.q);
  const filtres = React.useMemo(() => ({ ...f, q }), [f, q]);

  const visibles = React.useMemo(() => trier(filtrer(rows, filtres), tri), [rows, filtres, tri]);

  const poser = <K extends keyof FiltresListe>(k: K, v: FiltresListe[K]) => setF((p) => ({ ...p, [k]: v }));
  const trierPar = (col: ColonneTri) => setTri((t) => triSuivant(t, col));
  const effacer = () => { setF(FILTRES_VIDES); setTri(null); };

  // « / » amène à la recherche — sauf quand on est déjà en train d'écrire.
  React.useEffect(() => {
    const surTouche = (e: KeyboardEvent) => {
      const cible = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (cible && (cible.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(cible.tagName))) return;
      e.preventDefault();
      recherche.current?.focus();
    };
    window.addEventListener("keydown", surTouche);
    return () => window.removeEventListener("keydown", surTouche);
  }, []);

  return (
    <div className="space-y-3">
      {/* UNE SEULE BARRE (Super Admin, 25/11/2026) : la recherche. La nature se choisit par les onglets du haut de la page —
          plus de pastilles d'état ni de nature en double, plus de filtres de colonne. Le tri par en-tête de colonne reste. */}
      <div className="relative min-w-0">
        <label htmlFor="recherche-ad-pro" className="sr-only">Rechercher une demande</label>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={recherche} id="recherche-ad-pro" type="search" autoComplete="off"
          value={f.q} onChange={(e) => poser("q", e.target.value)}
          placeholder="Objet, médecin, demandeur, référence…"
          className={cn(champ, "pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden")}
        />
        {f.q && (
          <button
            type="button" onClick={() => { poser("q", ""); recherche.current?.focus(); }}
            aria-label="Effacer la recherche"
            className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        )}
      </div>

      <p aria-live="polite" className="px-1 text-xs text-muted-foreground">
        {visibles.length === rows.length
          ? `${rows.length} demande${rows.length > 1 ? "s" : ""}`
          : `${visibles.length} sur ${rows.length} demande${rows.length > 1 ? "s" : ""}`}
      </p>

      {visibles.length === 0 ? (
        <div className="rounded-[var(--radius)] border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          Aucune demande ne correspond à la recherche.{" "}
          <button type="button" onClick={effacer} className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Effacer la recherche
          </button>
        </div>
      ) : (
        <>
          {/* BUREAU — l'en-tête reste visible : le tableau défile dans son cadre. */}
          <div className="hidden overflow-auto rounded-[var(--radius)] border border-border bg-card shadow-sm md:block md:max-h-[calc(100dvh-var(--app-chrome-top)-15rem)] md:min-h-[16rem]">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Demandes Ad &amp; Pro — un clic sur un en-tête trie la colonne</caption>
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
                <tr className="text-left text-xs text-muted-foreground">
                  <EnteteTriable col="nature" tri={tri} onTri={trierPar} className="pl-4">Nature</EnteteTriable>
                  <EnteteTriable col="objet" tri={tri} onTri={trierPar}>Objet</EnteteTriable>
                  <EnteteTriable col="demandeur" tri={tri} onTri={trierPar} className="hidden lg:table-cell">Demandeur</EnteteTriable>
                  <EnteteTriable col="montant" tri={tri} onTri={trierPar} align="right">Montant</EnteteTriable>
                  <EnteteTriable col="etat" tri={tri} onTri={trierPar}>État</EnteteTriable>
                  <EnteteTriable col="echeance" tri={tri} onTri={trierPar} className="hidden xl:table-cell">Échéance</EnteteTriable>
                  <th scope="col" className="w-10 border-b border-border px-2 py-2.5"><span className="sr-only">Partager</span></th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((r) => <LigneDemande key={`${r.kind}-${r.id}`} r={r} maintenant={maintenant} />)}
              </tbody>
            </table>
          </div>

          {/* TÉLÉPHONE — une carte par demande, rien ne déborde. */}
          <ul className="space-y-2 md:hidden">
            {visibles.map((r) => <CarteDemande key={`${r.kind}-${r.id}`} r={r} maintenant={maintenant} />)}
          </ul>
        </>
      )}
    </div>
  );
}
