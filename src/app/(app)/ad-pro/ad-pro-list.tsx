"use client";

import * as React from "react";
import { FilterX, Search, SlidersHorizontal, X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { kindSpec } from "@/modules/ad-pro/partage";
import {
  FILTRES_VIDES, filtrer, filtresActifs, nombreDeFiltresRanges, pastillesEtat, pastillesNature, trier, triSuivant,
  type ColonneTri, type FiltresListe, type LigneAdPro, type Tri,
} from "./liste";
import { CarteDemande, EnteteTriable, LigneDemande } from "./ligne-demande";

/**
 * LE TABLEAU DES DEMANDES AD & PRO — une barre d'outils compacte, puis le tableau.
 *
 *   • les pastilles d'ÉTAT, « À vous » en tête — elles remplacent les tuiles-compteurs : même chiffre, cliquable ;
 *   • la recherche instantanée (objet, référence, médecin ou bénéficiaire, demandeur) ;
 *   • « Filtres » range les filtres de colonne d'avant (référence, objet, bénéficiaire, demandeur, montant, date) :
 *     aucun n'a disparu, ils ne prennent plus de place tant qu'on ne les ouvre pas ;
 *   • les pastilles de NATURE, avec leur compte, qui suit les autres filtres.
 *
 * Ce qui attend la personne connectée remonte en tête et se voit (`trier`). Au téléphone, chaque demande est une
 * carte — pas de défilement de côté. Les règles sont dans `liste.ts` (testé) ; ce fichier dessine.
 */

const pastille = "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 sm:min-h-8";
const pastilleOn = "border-primary bg-primary text-primary-foreground shadow-sm";
const pastilleOff = "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground";
const compteur = (on: boolean) => cn("rounded-full px-1.5 text-[11px] tabular-nums", on ? "bg-primary-foreground/20" : "bg-secondary text-secondary-foreground");
/** Police ≥ 16 px au téléphone : iOS ne zoome pas sur le champ. */
const champ = "h-10 w-full rounded-lg border border-input bg-background px-3 text-base outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm";

export function AdProList({ rows, maintenant }: {
  rows: LigneAdPro[];
  /** L'heure du rendu SERVEUR : « depuis 3 j » se lit sur la même minute au serveur et au navigateur. */
  maintenant: number;
}) {
  const [f, setF] = React.useState<FiltresListe>(FILTRES_VIDES);
  const [tri, setTri] = React.useState<Tri | null>(null);
  const [panneau, setPanneau] = React.useState(false);
  const recherche = React.useRef<HTMLInputElement>(null);
  // La frappe reste fluide sur deux cents lignes : le tableau suit la recherche un battement après.
  const q = React.useDeferredValue(f.q);
  const filtres = React.useMemo(() => ({ ...f, q }), [f, q]);

  const visibles = React.useMemo(() => trier(filtrer(rows, filtres), tri), [rows, filtres, tri]);
  const etats = React.useMemo(() => pastillesEtat(rows, filtres), [rows, filtres]);
  const toutes = React.useMemo(() => filtrer(rows, { ...filtres, etat: "" }).length, [rows, filtres]);
  const natures = React.useMemo(() => pastillesNature(rows, filtres), [rows, filtres]);
  const nRanges = nombreDeFiltresRanges(f);
  const actif = filtresActifs(f) || tri !== null;

  const poser = <K extends keyof FiltresListe>(k: K, v: FiltresListe[K]) => setF((p) => ({ ...p, [k]: v }));
  const champDe = (k: keyof FiltresListe) => ({
    value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => poser(k, e.target.value as never),
  });
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
      <section aria-label="Rechercher et filtrer" className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-3 shadow-sm sm:p-4">
        {/* L'ÉTAT — « À vous » d'abord : ce qu'on vient chercher en ouvrant l'écran. */}
        <div role="group" aria-label="État" className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={!f.etat} onClick={() => poser("etat", "")} className={cn(pastille, !f.etat ? pastilleOn : pastilleOff)}>
            Toutes <span className={compteur(!f.etat)}>{toutes}</span>
          </button>
          {etats.map((p) => {
            const on = f.etat === p.cle;
            const aVous = p.cle === "A_VOUS";
            return (
              <button
                key={p.cle} type="button" aria-pressed={on}
                onClick={() => poser("etat", on ? "" : p.cle)}
                className={cn(pastille, on ? pastilleOn : pastilleOff, aVous && !on && "border-primary/40 text-primary")}
              >
                {aVous && <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-primary-foreground" : "bg-primary")} />}
                {p.label} <span className={compteur(on)}>{p.n}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
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
          <div className="flex items-center gap-2">
            <button
              type="button" aria-expanded={panneau} aria-controls="filtres-ad-pro" onClick={() => setPanneau((o) => !o)}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9",
                panneau || nRanges > 0 ? "border-primary/50 bg-accent text-accent-foreground" : "border-input bg-background hover:bg-secondary",
              )}
            >
              <SlidersHorizontal aria-hidden className="h-4 w-4" /> Filtres
              {nRanges > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] tabular-nums text-primary-foreground">{nRanges}</span>}
            </button>
            {actif && (
              <button
                type="button" onClick={effacer}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9"
              >
                <FilterX aria-hidden className="h-4 w-4" /> Tout effacer
              </button>
            )}
          </div>
        </div>

        {panneau && (
          <div id="filtres-ad-pro" className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-secondary/40 p-3 motion-safe:animate-fade-in xs:grid-cols-2 lg:grid-cols-3">
            <Champ label="Référence"><input {...champDe("reference")} className={champ} /></Champ>
            <Champ label="Objet"><input {...champDe("title")} className={champ} /></Champ>
            <Champ label="Bénéficiaire"><input {...champDe("beneficiary")} className={champ} /></Champ>
            <Champ label="Demandeur"><input {...champDe("requester")} className={champ} /></Champ>
            <Champ label="Montant minimum (DZD)"><input {...champDe("minAmount")} inputMode="numeric" className={champ} /></Champ>
            <Champ label="Déposée à partir du"><input {...champDe("dateFrom")} type="date" className={champ} /></Champ>
            {/* Au téléphone, pas d'en-têtes de colonne : le tri se choisit ici. */}
            <Champ label="Trier par" className="md:hidden">
              <select
                value={tri ? `${tri.col}:${tri.sens}` : ""}
                onChange={(e) => { const [col, sens] = e.target.value.split(":"); setTri(col ? { col: col as ColonneTri, sens: sens as Tri["sens"] } : null); }}
                className={champ}
              >
                <option value="">Ce qui attend d&apos;abord</option>
                <option value="depot:desc">Les plus récentes</option>
                <option value="montant:desc">Montant décroissant</option>
                <option value="echeance:asc">Échéance la plus proche</option>
                <option value="objet:asc">Objet (A → Z)</option>
              </select>
            </Champ>
          </div>
        )}

        {/* LA NATURE — une pastille par nature présente ; un clic isole, un second rend tout. */}
        {natures.length > 1 && (
          <div role="group" aria-label="Nature" className="flex flex-wrap gap-1.5 border-t border-border pt-3">
            {natures.map((p) => {
              const on = f.kind === p.cle;
              return (
                <button
                  key={p.cle} type="button" aria-pressed={on}
                  onClick={() => poser("kind", on ? "" : p.cle)}
                  className={cn(pastille, on ? pastilleOn : pastilleOff, !on && p.n === 0 && "opacity-60")}
                >
                  <Icon name={kindSpec(p.cle)?.icon ?? "CircleEllipsis"} aria-hidden className={cn("h-3.5 w-3.5", !on && "text-primary/80")} />
                  {p.label} <span className={compteur(on)}>{p.n}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <p aria-live="polite" className="px-1 text-xs text-muted-foreground">
        {visibles.length === rows.length
          ? `${rows.length} demande${rows.length > 1 ? "s" : ""}`
          : `${visibles.length} sur ${rows.length} demande${rows.length > 1 ? "s" : ""}`}
      </p>

      {visibles.length === 0 ? (
        <div className="rounded-[var(--radius)] border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          Aucune demande ne correspond.{" "}
          <button type="button" onClick={effacer} className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Effacer les filtres
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

function Champ({ label, className, children }: { label: string; className?: string; children: React.ReactElement<{ id?: string }> }) {
  const id = React.useId();
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      {React.cloneElement(children, { id })}
    </div>
  );
}
