import type { VizDonnees, VizType, WorkspaceAction } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BLOC « ANALYSE » (lot K1, décision 0031) — un tableau, ses graphiques et leur calcul, COMPOSÉS PAR LE CODE.
 *
 * Le modèle n'écrit aucun chiffre de ce bloc : il nomme une source et des étapes, le moteur du socle
 * (`platform/ia/analyse/`) calcule, et ce bloc porte le résultat tel quel — valeurs typées (un nombre reste
 * un nombre : le tri, le filtre et les totaux se font sur des nombres), formats d'affichage (DZD, %),
 * graphiques choisis et vérifiés (`recommanderGraphique`, `verifierGraphique`), et le JOURNAL du calcul
 * (sources, étapes, formules, ce qui a été ignoré) que l'écran montre sous « Comment c'est calculé ».
 *
 * Types purs, zéro import de valeur : le rendu client (`ecrans/blocks/analyse.tsx`) les importe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Comment une colonne s'affiche — et s'exporte (format Excel). */
export type FormatColonne = "texte" | "nombre" | "entier" | "dzd" | "pourcent" | "date";
export const FORMATS_COLONNE: readonly FormatColonne[] = ["texte", "nombre", "entier", "dzd", "pourcent", "date"];

export interface ColonneAnalyse { cle: string; libelle: string; format: FormatColonne }
export type CelluleAnalyse = string | number | null;

/** Un graphique de l'analyse : la même forme qu'un bloc `viz`, sans les métadonnées du fil. */
export interface GraphiqueAnalyse {
  titre: string;
  type: VizType;
  donnees: VizDonnees;
  unite?: string | null;
  axeYdepartZero?: boolean;
  raison?: string | null;
  alertes?: string[];
  note?: string | null;
}

/** Une étape du calcul, dite en clair : l'opération, sa formule, les lignes avant / après. */
export interface EtapeCalcul { op: string; formule: string; avant: number; apres: number; note?: string }

/** Un résultat qui n'est pas une ligne (tendance, scénario) — sa valeur est calculée, son libellé aussi. */
export interface ResultatCalcul { libelle: string; valeur: string }

export interface JournalCalcul {
  /** D'où viennent les lignes : la lecture, le fichier (feuille), la requête. */
  sources: string[];
  etapes: EtapeCalcul[];
  resultats: ResultatCalcul[];
  /** Ce qui n'a PAS été compté, et pourquoi — un total qui saute trois lignes sans le dire est faux. */
  ignores: string[];
  /** Les étapes refusées par le moteur (colonne absente, opération inconnue). */
  refusees: string[];
  /** Les colonnes masquées (confidentielles) : ni lues par le modèle, ni calculées. */
  masquees: string[];
  /** Le moteur qui a calculé (« opérations fermées du socle », « JavaScript isolé »…). */
  moteur: string;
  /** ISO. */
  calculeLe: string;
}

export interface BlocAnalyseForme {
  kind: "analyse";
  title: string;
  /** La source dite en une ligne (méta de la carte). */
  source: string;
  colonnes: ColonneAnalyse[];
  /** Les lignes affichées (bornées à `ANALYSE_LIGNES_MAX`), dans l'ordre du calcul. */
  lignes: CelluleAnalyse[][];
  /** Le nombre de lignes du résultat complet. */
  total: number;
  /** Les totaux du résultat COMPLET, calculés par le code (null : la colonne ne s'additionne pas). */
  totaux: (number | null)[] | null;
  graphiques: GraphiqueAnalyse[];
  journal: JournalCalcul;
  /** Le classeur déposé au Drive, s'il a été demandé. */
  classeur?: { nom: string; href: string } | null;
  /** L'adresse qui fabrique le classeur Excel des lignes affichées (export d'un clic) — absente : export CSV seul. */
  exportExcel?: string | null;
  actions?: WorkspaceAction[];
}

/** Lignes montrées dans la conversation : au-delà, c'est le classeur (Drive) qui porte tout. */
export const ANALYSE_LIGNES_MAX = 200;
export const ANALYSE_COLONNES_MAX = 12;
export const ANALYSE_GRAPHIQUES_MAX = 2;

/** Les formes de graphique qu'une analyse sait produire (le reste de `VIZ_TYPES` n'est pas tabulaire). */
export const GRAPHIQUES_ANALYSE = [
  "barres", "barres_groupees", "barres_empilees", "courbe", "aires", "secteurs", "anneau", "nuage", "heatmap", "cascade", "histogramme",
] as const;
export type GraphiqueDemande = (typeof GRAPHIQUES_ANALYSE)[number];

/** Une forme demandée → la forme du protocole (barres groupées = barres multi-séries, anneau = secteurs, dessinés en anneau). */
export const FORME_PROTOCOLE: Readonly<Record<GraphiqueDemande, VizType>> = {
  barres: "barres", barres_groupees: "barres", barres_empilees: "barres_empilees", courbe: "courbe", aires: "aires",
  secteurs: "secteurs", anneau: "secteurs", nuage: "nuage", heatmap: "heatmap", cascade: "cascade", histogramme: "histogramme",
};
