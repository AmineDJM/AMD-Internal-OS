/**
 * LIRE UN `.docx` — LE MODÈLE : ce que la lecture rend et ce que la composition consomme (blocs,
 * paragraphes, fragments, tableaux, dessins, sections). Des types, rien d'autre.
 */

// ─────────────────────────── Le modèle ───────────────────────────

export interface Bordure {
  epaisseurPt: number;
  couleur: string;
  style: "simple" | "double" | "pointille" | "tirets";
  /** `w:space` : l'air entre le filet et le texte (bordures de paragraphe), en points. */
  espacePt: number;
}

export interface ProprietesTexte {
  /** Le nom de police tel que Word l'utilise (thème résolu) : « Calibri », « Times New Roman »… */
  police: string;
  taillePt: number;
  gras: boolean;
  italique: boolean;
  souligne: "simple" | "double" | null;
  barre: boolean;
  /** Hexadécimal sans dièse ; `null` = automatique (noir). */
  couleur: string | null;
  surlignage: string | null;
  fond: string | null;
  majuscules: boolean;
  petitesMajuscules: boolean;
  position: "normal" | "exposant" | "indice";
  masque: boolean;
  espacementPt: number;
  lien: string | null;
}

export interface Tabulation {
  pos: number;
  type: "left" | "center" | "right" | "decimal" | "bar" | "clear";
  points: "dot" | "hyphen" | "underscore" | "middleDot" | null;
}

export interface ProprietesParagraphe {
  alignement: "left" | "center" | "right" | "justify";
  retraitGauche: number;
  retraitDroit: number;
  /** Positif : retrait de première ligne ; négatif : retrait suspendu. */
  retraitPremiere: number;
  avant: number;
  apres: number;
  avantAuto: boolean;
  apresAuto: boolean;
  interligne: { regle: "auto" | "exact" | "atLeast"; valeur: number };
  tabulations: Tabulation[];
  garderAvecSuivant: boolean;
  garderLignes: boolean;
  sautAvant: boolean;
  veuves: boolean;
  espacementContextuel: boolean;
  fond: string | null;
  bordures: { haut: Bordure | null; bas: Bordure | null; gauche: Bordure | null; droite: Bordure | null };
  styleId: string | null;
}

export interface Rognage { gauche: number; haut: number; droite: number; bas: number }

/** Ce qu'un dessin contient, en points, relativement au coin haut-gauche de son cadre. */
export type ElementGraphique =
  | { type: "image"; x: number; y: number; largeur: number; hauteur: number; image: ImageDocx; rognage: Rognage | null }
  | {
      type: "forme";
      x: number; y: number; largeur: number; hauteur: number;
      geometrie: "rect" | "roundRect" | "ellipse" | "ligne";
      fond: string | null;
      trait: { couleur: string; epaisseur: number } | null;
      retourneH: boolean;
      retourneV: boolean;
      texte: { blocs: Bloc[]; marges: { gauche: number; haut: number; droite: number; bas: number }; ancrageV: "haut" | "centre" | "bas" } | null;
    };

export interface ImageDocx { cle: string; octets: Buffer }

export type Inline =
  | { k: "texte"; texte: string; p: ProprietesTexte }
  | { k: "tab"; p: ProprietesTexte }
  | { k: "ptab"; alignement: "left" | "center" | "right"; p: ProprietesTexte }
  | { k: "saut"; type: "ligne" | "page" | "colonne"; p: ProprietesTexte }
  | { k: "dessin"; largeur: number; hauteur: number; contenu: ElementGraphique[]; p: ProprietesTexte }
  | { k: "champ"; code: "PAGE" | "NUMPAGES"; repli: string; p: ProprietesTexte };

export interface PositionAncre {
  /** `page`, `margin`, `column`, `character`, `leftMargin`, `rightMargin`, `paragraph`, `line`, `topMargin`, `bottomMargin`… */
  rel: string;
  decalage: number | null;
  align: string | null;
  pct: number | null;
}

export interface Ancre {
  largeur: number;
  hauteur: number;
  h: PositionAncre;
  v: PositionAncre;
  derriere: boolean;
  habillage: "none" | "square" | "tight" | "through" | "topAndBottom";
  contenu: ElementGraphique[];
}

export interface Etiquette {
  texte: string;
  p: ProprietesTexte;
  puce: "disque" | "cercle" | "carre" | "losange" | "fleche" | null;
  suffixe: "tab" | "space" | "nothing";
  /** La puce vient d'une police Symbol / Wingdings : ses métriques (plus hautes) font la ligne. */
  symbole: boolean;
}

export interface Paragraphe {
  type: "paragraphe";
  pp: ProprietesParagraphe;
  /** Les propriétés de la MARQUE de paragraphe : la hauteur d'un paragraphe vide, de la dernière ligne. */
  marque: ProprietesTexte;
  contenu: Inline[];
  ancres: Ancre[];
  etiquette: Etiquette | null;
}

export interface Cellule {
  blocs: Bloc[];
  colonne: number;
  span: number;
  fusionV: "debut" | "suite" | null;
  fond: string | null;
  bordures: { haut: Bordure | null; bas: Bordure | null; gauche: Bordure | null; droite: Bordure | null };
  alignV: "haut" | "centre" | "bas";
  marges: { gauche: number; haut: number; droite: number; bas: number };
}

export interface Rangee {
  cellules: Cellule[];
  hauteur: { valeur: number; regle: "atLeast" | "exact" } | null;
  entete: boolean;
}

export interface Tableau {
  type: "tableau";
  grille: number[];
  alignement: "left" | "center" | "right";
  retrait: number;
  rangees: Rangee[];
}

export type Bloc = Paragraphe | Tableau;

export interface Bande { blocs: Bloc[] }

export interface Section {
  largeur: number;
  hauteur: number;
  marges: { haut: number; bas: number; gauche: number; droite: number; entete: number; pied: number };
  /** Marge haute « exacte » (négative dans Word) : l'en-tête ne repousse pas le corps. */
  hautExact: boolean;
  basExact: boolean;
  entetes: { defaut?: Bande | null; premiere?: Bande | null; paire?: Bande | null };
  pieds: { defaut?: Bande | null; premiere?: Bande | null; paire?: Bande | null };
  titrePage: boolean;
  type: "nextPage" | "continuous" | "evenPage" | "oddPage";
  debutNumero: number | null;
  formatNumero: string;
  colonnes: number;
}

export interface DocumentDocx {
  sections: { section: Section; blocs: Bloc[] }[];
  tabDefaut: number;
  pairesImpaires: boolean;
  /** Ce qui a été rencontré sans pouvoir être restitué — pour le dire, jamais pour le taire. */
  ignores: Set<string>;
}
