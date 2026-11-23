"use client";

import * as React from "react";
import {
  SELECTION_VIDE, cliquer, glisser, deplacer, borner, clesSelection, estSelectionnee, estVide, taille,
  versTsv, lignesSelectionnees, deCle,
  type Selection, type Coord, type Direction,
} from "@/lib/grille/selection";

/**
 * LE BRANCHEMENT D'UNE FEUILLE SUR LA SÉLECTION — souris, clavier, presse-papiers.
 *
 * Le MODÈLE vit dans `lib/grille/selection.ts` (pur, testé) ; ce crochet ne fait que traduire
 * des événements DOM en appels de ce modèle, et rendre les attributs que chaque cellule et le
 * conteneur doivent porter. Deux feuilles (praticiens, établissements) l'emploient tel quel :
 * la sémantique d'un Maj-clic ne doit pas dépendre de la table où l'on clique.
 *
 * ── LE CONTRAT AVEC LA FEUILLE ──────────────────────────────────────────────────────────────
 *
 *   - la feuille rend chaque cellule avec `propsCellule(r, c)` et son conteneur avec
 *     `propsConteneur` (focusable : c'est lui qui reçoit le clavier) ;
 *   - un clic SÉLECTIONNE ; un double-clic, Entrée, F2 ou une frappe imprimable demandent
 *     l'ÉDITION (`onEditer`) — la feuille décide comment elle édite (saisie, menu) ;
 *   - un second clic sur la seule cellule sélectionnée édite aussi : sur un écran tactile, le
 *     double-clic n'existe pas vraiment ;
 *   - tant qu'une cellule est en édition (`editionActive`), la sélection n'écoute plus le clavier
 *     ni la souris : le champ de saisie est le seul maître à bord.
 *
 * Ctrl/Cmd+C copie la sélection en TSV — ce qu'Excel et Google Sheets collent en cellules.
 */

export interface OptionsSelectionGrille {
  lignes: number;
  colonnes: number;
  /** La valeur AFFICHÉE d'une cellule, pour la copie. */
  valeur: (r: number, c: number) => string;
  /** Demande d'édition d'une cellule ; `initial` porte la frappe qui l'a déclenchée, le cas échéant. */
  onEditer?: (coord: Coord, initial?: string) => void;
  /** Vrai pendant qu'une cellule est en édition : la sélection se tait. */
  editionActive?: boolean;
  /**
   * OUVRIR LA LIGNE (sa fiche) — Ctrl+Entrée toujours, et Entrée seule quand la feuille ne s'édite
   * pas : en lecture, Entrée n'a rien d'autre à faire (recette du 23/11, « comme Excel »).
   */
  onOuvrir?: (coord: Coord) => void;
}

export interface PropsCellule {
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseEnter: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  "data-selected"?: "true";
  "aria-selected"?: boolean;
  /** `r:c` — pour ramener à l'écran la cellule active quand on la déplace au clavier. */
  "data-coord": string;
}

const TOUCHE_DIRECTION: Record<string, Direction> = {
  ArrowUp: "haut", ArrowDown: "bas", ArrowLeft: "gauche", ArrowRight: "droite",
};

export function useSelectionGrille(opts: OptionsSelectionGrille) {
  const { lignes, colonnes, valeur, onEditer, editionActive = false, onOuvrir } = opts;
  const [sel, setSel] = React.useState<Selection>(SELECTION_VIDE);
  const conteneurRef = React.useRef<HTMLDivElement>(null);
  const bornes = React.useMemo(() => ({ lignes, colonnes }), [lignes, colonnes]);

  // La feuille a changé de taille (filtre, ligne supprimée) : on ramène la sélection dedans.
  React.useEffect(() => { setSel((s) => borner(s, bornes)); }, [bornes]);

  const focaliser = React.useCallback(() => { conteneurRef.current?.focus({ preventScroll: true }); }, []);

  // La cellule active reste À L'ÉCRAN quand on la déplace AU CLAVIER (flèches, Tab, Début/Fin) dans
  // une feuille qui défile dans son cadre — comme dans un tableur, la vue suit le curseur. Un clic ou
  // Ctrl+A ne déplacent pas la vue.
  const suivre = React.useRef(false);
  const fr = sel.focus?.r;
  const fc = sel.focus?.c;
  React.useEffect(() => {
    if (!suivre.current || fr === undefined || fc === undefined) return;
    suivre.current = false;
    conteneurRef.current?.querySelector<HTMLElement>(`[data-coord="${fr}:${fc}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [fr, fc]);

  const vider = React.useCallback(() => setSel(SELECTION_VIDE), []);

  const copier = React.useCallback(async (): Promise<boolean> => {
    const texte = versTsv(sel, valeur);
    if (!texte) return false;
    try {
      await navigator.clipboard.writeText(texte);
      return true;
    } catch {
      return false;
    }
  }, [sel, valeur]);

  const propsCellule = React.useCallback((r: number, c: number): PropsCellule => {
    const selectionnee = estSelectionnee(sel, r, c);
    return {
      onMouseDown: (e) => {
        if (e.button !== 0 || editionActive) return;
        // Pas de sélection de texte en glissant, et le clavier reste au conteneur.
        e.preventDefault();
        focaliser();
        const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
        // Second clic sur la SEULE cellule sélectionnée : on édite (le geste tactile du double-clic).
        if (!mods.shift && !mods.ctrl && selectionnee && taille(sel) === 1 && onEditer) {
          onEditer({ r, c });
          return;
        }
        setSel((s) => cliquer(s, { r, c }, mods));
      },
      onMouseEnter: (e) => {
        if (editionActive || e.buttons !== 1) return;
        setSel((s) => glisser(s, { r, c }));
      },
      onDoubleClick: (e) => {
        if (editionActive || !onEditer) return;
        e.preventDefault();
        onEditer({ r, c });
      },
      "data-coord": `${r}:${c}`,
      ...(selectionnee ? { "data-selected": "true" as const, "aria-selected": true } : {}),
    };
  }, [sel, editionActive, onEditer, focaliser]);

  const onKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (editionActive) return;
    // Une frappe dans un champ enfant (case à cocher, bouton) n'est pas un geste de feuille.
    const cible = e.target as HTMLElement | null;
    if (cible && cible !== e.currentTarget && /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(cible.tagName)) return;

    const dir = TOUCHE_DIRECTION[e.key];
    if (dir) {
      e.preventDefault();
      suivre.current = true;
      setSel((s) => deplacer(s, dir, bornes, { shift: e.shiftKey }));
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      suivre.current = true;
      setSel((s) => deplacer(s, e.shiftKey ? "gauche" : "droite", bornes));
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); vider(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      void copier();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      if (lignes > 0 && colonnes > 0) {
        setSel({ figees: [], ancre: { r: 0, c: 0 }, focus: { r: lignes - 1, c: colonnes - 1 } });
      }
      return;
    }
    // DÉBUT / FIN : première et dernière colonne de la ligne ; avec Ctrl, première et dernière cellule de la feuille.
    if ((e.key === "Home" || e.key === "End") && lignes > 0 && colonnes > 0) {
      e.preventDefault();
      const debut = e.key === "Home";
      suivre.current = true;
      const ctrl = e.ctrlKey || e.metaKey;
      setSel((s) => {
        const r = ctrl ? (debut ? 0 : lignes - 1) : (s.focus?.r ?? 0);
        const cible = { r, c: debut ? 0 : colonnes - 1 };
        return { figees: [], ancre: cible, focus: cible };
      });
      return;
    }
    if (!sel.focus) return;
    if (e.key === "Enter" && onOuvrir && (e.ctrlKey || e.metaKey || !onEditer)) {
      e.preventDefault();
      onOuvrir(sel.focus);
      return;
    }
    if (!onEditer) return;
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      onEditer(sel.focus);
      return;
    }
    // Une frappe imprimable REMPLACE le contenu de la cellule, comme dans un tableur.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onEditer(sel.focus, e.key);
    }
  }, [editionActive, bornes, vider, copier, onEditer, onOuvrir, sel.focus, lignes, colonnes]);

  const propsConteneur = React.useMemo(() => ({
    ref: conteneurRef,
    tabIndex: 0,
    onKeyDown,
    role: "grid" as const,
    "aria-multiselectable": true as const,
  }), [onKeyDown]);

  const cles = React.useMemo(() => clesSelection(sel), [sel]);
  const cellules = React.useMemo(
    () => [...cles].map(deCle).filter((c): c is Coord => c !== null),
    [cles],
  );

  return {
    selection: sel,
    setSelection: setSel,
    vide: estVide(sel),
    nombre: cles.size,
    /** Les cellules sélectionnées, en coordonnées de grille. */
    cellules,
    /** Les lignes touchées, triées. */
    lignes: lignesSelectionnees(sel),
    estSelectionnee: (r: number, c: number) => estSelectionnee(sel, r, c),
    propsCellule,
    propsConteneur,
    /** Après une édition : reprendre la main au clavier et, si demandé, passer à la cellule suivante. */
    apresEdition: (suite?: Direction) => {
      focaliser();
      if (!suite) return;
      suivre.current = true;
      setSel((s) => deplacer(s, suite, bornes));
    },
    copier,
    vider,
  };
}
