"use client";

import * as React from "react";
import {
  filtrerEtTrier, valeursDistinctes, avecFiltre, triSuivant, libelleCompte, plier,
  type Acces, type Filtres, type Tri, type Sens, type ValeurDistincte,
} from "@/lib/grille/filtres";

/**
 * L'ÉTAT D'UNE FEUILLE « COMME EXCEL » — recherche, filtres automatiques, tri, colonnes masquées,
 * largeurs. Le MODÈLE est pur et testé (`lib/grille/filtres.ts`) ; ce crochet ne fait que tenir
 * l'état et rendre la vue. L'en-tête (`CelluleEnTete`), la barre (`BarreTableur`) et la table
 * générique (`Tableur`) le lisent tous trois : une feuille qui a son propre quadrillage (sélection
 * de cellules, édition en place) s'en sert sans changer de table.
 *
 * Rien n'est mémorisé dans le navigateur : un filtre oublié d'une visite à l'autre fait croire à
 * une fiche disparue, et l'état d'une feuille n'a pas à survivre à la personne qui la regarde.
 */

export interface ColonneTableur {
  cle: string;
  libelle: string;
  /** Largeur de départ, en pixels. */
  largeur: number;
  /** Faux : la colonne ne se masque pas (la colonne qui nomme la ligne). */
  masquable?: boolean;
}

/** Ce que l'en-tête et la barre lisent d'une feuille — sans connaître le type de ses lignes. */
export interface PiloteTableur {
  colonnes: readonly ColonneTableur[];
  recherche: string;
  setRecherche: (q: string) => void;
  filtres: Filtres;
  /** Pose (ou retire, avec `null`) le filtre d'une colonne. */
  filtrer: (cle: string, retenues: readonly string[] | null) => void;
  /** Les valeurs que la liste d'une colonne propose : celles que les AUTRES filtres laissent. */
  valeursDe: (cle: string) => ValeurDistincte[];
  tri: Tri | null;
  trier: (cle: string, sens: Sens | null) => void;
  basculerTri: (cle: string) => void;
  masquees: ReadonlySet<string>;
  basculerColonne: (cle: string) => void;
  largeur: (cle: string) => number;
  redimensionner: (cle: string, px: number) => void;
  /** Un filtre de colonne ou une recherche réduit-il la vue ? */
  actif: boolean;
  effacerFiltres: () => void;
  total: number;
  /** « 1 234 lignes (56 filtrées) ». */
  compte: string;
}

export const LARGEUR_MIN = 48;

export function useTableur<T>({ lignes, colonnes, acces, texteLigne }: {
  lignes: readonly T[];
  colonnes: readonly ColonneTableur[];
  /** La valeur AFFICHÉE d'une cellule — stable (`useCallback`), sinon tout se recalcule à chaque rendu. */
  acces: Acces<T>;
  /** Le texte sur lequel porte la recherche globale ; par défaut, toutes les colonnes. */
  texteLigne?: (ligne: T) => string;
}): PiloteTableur & { visibles: T[]; colonnesVisibles: ColonneTableur[] } {
  const [recherche, setRecherche] = React.useState("");
  const [filtresBruts, setFiltres] = React.useState<Filtres>({});
  const [tri, setTri] = React.useState<Tri | null>(null);
  const [masquees, setMasquees] = React.useState<ReadonlySet<string>>(() => new Set());
  const [largeurs, setLargeurs] = React.useState<Readonly<Record<string, number>>>({});

  // Une colonne qui disparaît (colonnes sur mesure d'un autre annuaire) emporte son filtre : un
  // filtre sur une colonne qu'on ne voit plus viderait la feuille sans rien montrer.
  const cles = colonnes.map((c) => c.cle).join("\u0001");
  const filtres = React.useMemo<Filtres>(() => {
    const connues = new Set(cles.split("\u0001"));
    const out: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(filtresBruts)) if (connues.has(k)) out[k] = v;
    return out;
  }, [filtresBruts, cles]);
  const triEffectif = tri && cles.split("\u0001").includes(tri.cle) ? tri : null;

  const bottes = React.useMemo(
    () => lignes.map((l) => plier(texteLigne ? texteLigne(l) : colonnes.map((c) => acces(l, c.cle)).join(" "))),
    [lignes, colonnes, acces, texteLigne],
  );

  const visibles = React.useMemo(
    () => filtrerEtTrier(lignes, { recherche, filtres, tri: triEffectif }, acces, bottes),
    [lignes, recherche, filtres, triEffectif, acces, bottes],
  );

  const valeursDe = React.useCallback(
    (cle: string) => valeursDistinctes(filtrerEtTrier(lignes, { recherche, filtres, tri: null }, acces, bottes, cle), cle, acces),
    [lignes, recherche, filtres, acces, bottes],
  );

  const filtrer = React.useCallback((cle: string, retenues: readonly string[] | null) => {
    setFiltres((f) => avecFiltre(f, cle, retenues));
  }, []);

  const basculerColonne = React.useCallback((cle: string) => {
    setMasquees((m) => {
      const n = new Set(m);
      if (n.has(cle)) n.delete(cle); else n.add(cle);
      return n;
    });
  }, []);

  const parCle = React.useMemo(() => new Map(colonnes.map((c) => [c.cle, c])), [colonnes]);
  const largeur = React.useCallback((cle: string) => largeurs[cle] ?? parCle.get(cle)?.largeur ?? 120, [largeurs, parCle]);
  const redimensionner = React.useCallback((cle: string, px: number) => {
    setLargeurs((l) => ({ ...l, [cle]: Math.max(LARGEUR_MIN, Math.round(px)) }));
  }, []);

  const actif = Object.keys(filtres).length > 0 || plier(recherche) !== "";
  const colonnesVisibles = React.useMemo(() => colonnes.filter((c) => !masquees.has(c.cle)), [colonnes, masquees]);

  return {
    colonnes, colonnesVisibles, visibles,
    recherche, setRecherche,
    filtres, filtrer, valeursDe,
    tri: triEffectif,
    trier: (cle, sens) => setTri(sens ? { cle, sens } : null),
    basculerTri: (cle) => setTri((t) => triSuivant(t, cle)),
    masquees, basculerColonne,
    largeur, redimensionner,
    actif,
    effacerFiltres: () => { setFiltres({}); setRecherche(""); },
    total: lignes.length,
    compte: libelleCompte(lignes.length, visibles.length, actif),
  };
}
