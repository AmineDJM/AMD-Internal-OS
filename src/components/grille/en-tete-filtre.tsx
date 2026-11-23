"use client";

import * as React from "react";
import { ArrowDown, ArrowDownAZ, ArrowDownZA, ArrowUp, ChevronDown, Filter, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { VIDE, filtreDesCoches, plier, type ValeurDistincte } from "@/lib/grille/filtres";
import { LARGEUR_MIN, type ColonneTableur, type PiloteTableur } from "./use-tableur";
import { Survol } from "./survol";

/**
 * L'EN-TÊTE D'UNE COLONNE, COMME DANS EXCEL — le nom (un clic trie), le bouton ▾ du filtre
 * automatique, et la poignée qui règle la largeur en glissant.
 *
 * Un en-tête FILTRÉ se voit : son bouton passe en plein (entonnoir) et la colonne se teinte. Sans
 * cela, une feuille qui ne montre que 12 lignes sur 1 200 ressemble à une feuille de 12 lignes —
 * c'est le premier « il manque des médecins ! » de la recette.
 *
 * La cellule rend son propre `<th>` (avec `aria-sort`) : la table qui l'emploie ne lui passe que
 * ses classes de placement (collée en haut, figée à gauche).
 */
export function CelluleEnTete({ colonne, pilote, className, style, titre }: {
  colonne: ColonneTableur;
  pilote: PiloteTableur;
  className?: string;
  style?: React.CSSProperties;
  titre?: string;
}) {
  const { cle, libelle } = colonne;
  const [ouvert, setOuvert] = React.useState(false);
  const ancre = React.useRef<HTMLButtonElement>(null);
  const filtre = pilote.filtres[cle] !== undefined;
  const sens = pilote.tri?.cle === cle ? pilote.tri.sens : null;
  const fermer = React.useCallback(() => setOuvert(false), []);

  return (
    <th
      scope="col"
      aria-sort={sens === "asc" ? "ascending" : sens === "desc" ? "descending" : "none"}
      className={cn("relative select-none whitespace-nowrap p-0 text-left align-middle text-xs font-semibold", className, filtre && "bg-accent text-accent-foreground")}
      style={style}
      title={titre}
    >
      <div className="flex min-h-9 items-center gap-0.5 pl-2 pr-1.5 sm:min-h-8">
        <button
          type="button" onClick={() => pilote.basculerTri(cle)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded py-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={`Trier par « ${libelle} » (un clic : A→Z, deux : Z→A, trois : ordre d'origine)`}
        >
          <span className="truncate">{libelle}</span>
          {sens === "asc" && <ArrowUp className="h-3 w-3 shrink-0" aria-hidden />}
          {sens === "desc" && <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />}
        </button>
        <button
          ref={ancre} type="button" onClick={() => setOuvert((v) => !v)}
          aria-haspopup="dialog" aria-expanded={ouvert}
          aria-label={filtre ? `Filtre de « ${libelle} » (actif)` : `Filtrer « ${libelle} »`}
          title={filtre ? "Filtre actif — modifier" : "Filtrer cette colonne"}
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border text-muted-foreground sm:h-5 sm:w-5",
            filtre ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border/70 bg-card hover:border-primary/60 hover:text-foreground",
          )}
        >
          {filtre ? <Filter className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </div>
      <PoigneeLargeur libelle={libelle} largeur={pilote.largeur(cle)} onLargeur={(px) => pilote.redimensionner(cle, px)} defaut={colonne.largeur} />
      {ouvert && (
        <Survol ancre={ancre} onFermer={fermer} etiquette={`Filtre de la colonne « ${libelle} »`}>
          <FiltreColonne colonne={colonne} pilote={pilote} onFermer={fermer} />
        </Survol>
      )}
    </th>
  );
}

/** Au-delà, la liste se tait et demande d'affiner : 3 000 noms en cases à cocher ne se lisent pas. */
const MAX_AFFICHEES = 400;

const libelleValeur = (v: string) => (v === VIDE ? "(Vides)" : v);

/**
 * LE FILTRE AUTOMATIQUE D'UNE COLONNE — trier, chercher, cocher, OK.
 *
 * La liste est prise à l'OUVERTURE (les valeurs que les autres filtres laissent) et ne bouge plus
 * pendant qu'on coche. Comme dans Excel, une recherche tapée dans la liste coche tous ses
 * résultats, et OK ne garde alors QUE les résultats cochés.
 */
function FiltreColonne({ colonne, pilote, onFermer }: { colonne: ColonneTableur; pilote: PiloteTableur; onFermer: () => void }) {
  const { cle, libelle } = colonne;
  // La liste est FIGÉE à l'ouverture : elle ne se réordonne pas sous le doigt pendant qu'on coche.
  const [valeurs] = React.useState<ValeurDistincte[]>(() => pilote.valeursDe(cle));
  const toutes = React.useMemo(() => valeurs.map((v) => v.valeur), [valeurs]);
  const actuel = pilote.filtres[cle];
  const [cochees, setCochees] = React.useState<Set<string>>(() => new Set(actuel ? toutes.filter((v) => actuel.includes(v)) : toutes));
  const [q, setQ] = React.useState("");
  const aiguille = plier(q);
  const chercher = React.useCallback((texte: string) => {
    const a = plier(texte);
    return a ? valeurs.filter((v) => plier(libelleValeur(v.valeur)).includes(a)) : valeurs;
  }, [valeurs]);
  const resultats = React.useMemo(() => chercher(q), [chercher, q]);
  // En recherche, les cases sont celles des RÉSULTATS — toutes cochées à chaque nouvelle frappe.
  const [cocheesQ, setCocheesQ] = React.useState<Set<string>>(new Set());
  const taper = (texte: string) => { setQ(texte); setCocheesQ(new Set(chercher(texte).map((v) => v.valeur))); };
  const actives = aiguille ? cocheesQ : cochees;
  const setActives = aiguille ? setCocheesQ : setCochees;

  const nbCochees = resultats.filter((v) => actives.has(v.valeur)).length;
  const tout = nbCochees === resultats.length && resultats.length > 0;
  const toutRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (toutRef.current) toutRef.current.indeterminate = nbCochees > 0 && !tout;
  }, [nbCochees, tout]);

  const basculer = (v: string) => setActives((s) => {
    const n = new Set(s);
    if (n.has(v)) n.delete(v); else n.add(v);
    return n;
  });
  const basculerTout = () => setActives((s) => {
    const n = new Set(s);
    for (const v of resultats) { if (tout) n.delete(v.valeur); else n.add(v.valeur); }
    return n;
  });

  const valider = () => {
    if (nbCochees === 0) return;
    const retenues = aiguille ? new Set(resultats.filter((v) => cocheesQ.has(v.valeur)).map((v) => v.valeur)) : cochees;
    pilote.filtrer(cle, filtreDesCoches(toutes, retenues));
    onFermer();
  };
  const trier = (s: "asc" | "desc") => { pilote.trier(cle, s); onFermer(); };
  const sens = pilote.tri?.cle === cle ? pilote.tri.sens : null;
  const classeTri = "flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-secondary sm:py-1.5";

  return (
    <>
      <div className="shrink-0 border-b border-border p-1.5">
        <button type="button" onClick={() => trier("asc")} aria-pressed={sens === "asc"} className={cn(classeTri, sens === "asc" && "font-semibold text-primary")}>
          <ArrowDownAZ className="h-4 w-4" aria-hidden /> Trier de A à Z
        </button>
        <button type="button" onClick={() => trier("desc")} aria-pressed={sens === "desc"} className={cn(classeTri, sens === "desc" && "font-semibold text-primary")}>
          <ArrowDownZA className="h-4 w-4" aria-hidden /> Trier de Z à A
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            data-autofocus type="search" value={q} onChange={(e) => taper(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); valider(); } }}
            placeholder="Rechercher" aria-label={`Rechercher dans les valeurs de « ${libelle} »`}
            className="h-9 w-full rounded-md border border-input bg-background pl-7 pr-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-8"
          />
        </div>
        <div className="max-h-64 min-h-[4rem] flex-1 overflow-y-auto rounded-md border border-border py-1">
          {resultats.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Aucune valeur ne correspond.</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 font-medium hover:bg-secondary sm:py-1">
                <input ref={toutRef} type="checkbox" checked={tout} onChange={basculerTout} className="h-4 w-4 rounded border-input" />
                {aiguille ? "(Sélectionner tous les résultats)" : "(Tout sélectionner)"}
              </label>
              <ul>
                {resultats.slice(0, MAX_AFFICHEES).map((v) => (
                  <li key={v.valeur}>
                    <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-secondary sm:py-1">
                      <input type="checkbox" checked={actives.has(v.valeur)} onChange={() => basculer(v.valeur)} className="h-4 w-4 shrink-0 rounded border-input" />
                      <span className={cn("min-w-0 flex-1 truncate", v.valeur === VIDE && "italic text-muted-foreground")}>{libelleValeur(v.valeur)}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{v.nombre}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {resultats.length > MAX_AFFICHEES && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  … et {resultats.length - MAX_AFFICHEES} autres valeurs : tapez dans « Rechercher » pour les voir.
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border p-2">
        <button
          type="button" disabled={actuel === undefined}
          onClick={() => { pilote.filtrer(cle, null); onFermer(); }}
          className="rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 sm:py-1.5"
        >
          Effacer
        </button>
        <button type="button" onClick={onFermer} className="ml-auto rounded-md border border-input px-3 py-2 text-xs hover:bg-secondary sm:py-1.5">
          Annuler
        </button>
        <button
          type="button" onClick={valider} disabled={nbCochees === 0}
          className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:py-1.5"
        >
          OK
        </button>
      </div>
    </>
  );
}

/**
 * LA POIGNÉE DE LARGEUR — glisser le bord droit de l'en-tête, comme dans Excel ; double-clic : la
 * largeur d'origine. Au clavier, ← et → (Maj : par 64 px).
 */
function PoigneeLargeur({ libelle, largeur, onLargeur, defaut }: { libelle: string; largeur: number; onLargeur: (px: number) => void; defaut: number }) {
  const depart = React.useRef<{ x: number; w: number } | null>(null);
  return (
    <span
      role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={`Largeur de la colonne « ${libelle} »`} aria-valuenow={largeur} aria-valuemin={LARGEUR_MIN}
      title="Glisser pour élargir — double-clic : largeur d'origine"
      onPointerDown={(e) => {
        e.preventDefault(); e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        depart.current = { x: e.clientX, w: largeur };
      }}
      onPointerMove={(e) => { if (depart.current) onLargeur(depart.current.w + e.clientX - depart.current.x); }}
      onPointerUp={(e) => { depart.current = null; e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { depart.current = null; }}
      onDoubleClick={() => onLargeur(defaut)}
      onKeyDown={(e) => {
        // Aucune frappe ici n'est un geste de la feuille (Tab compris : la feuille le prendrait pour « cellule suivante »).
        e.stopPropagation();
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const pas = e.shiftKey ? 64 : 16;
        onLargeur(largeur + (e.key === "ArrowRight" ? pas : -pas));
      }}
      className="absolute right-0 top-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize touch-none outline-none hover:bg-primary/40 focus-visible:bg-primary/60"
    />
  );
}
