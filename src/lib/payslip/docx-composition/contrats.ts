/**
 * COMPOSER UN `.docx` — les CONTRATS (police rendue, mesureur, tracés, page composée), le contexte de
 * composition, et le déplacement des tracés.
 */
import { type ProprietesTexte, type ImageDocx, type Rognage, type Bordure, type Etiquette, type Section, type Paragraphe, type Tableau, formaterNombre } from "../docx-lecture";
import type { LigneComposee } from "./lignes";
import type { TableauCompose } from "./tableaux";

// ─────────────────────────── Contrats ───────────────────────────

export interface PoliceRendu {
  /** Le nom sous lequel la police est connue du moteur PDF. */
  cle: string;
  /** Compression horizontale qui rend la chasse de la police d'origine (1 = aucune). */
  echelle: number;
  interligne: number;
  ascent: number;
  /** Police standard du PDF (WinAnsi) — le texte doit y être ramené. */
  standard: boolean;
  /** Variante absente du système : graisse ou pente simulées au tracé. */
  faux: { gras: boolean; italique: boolean };
}

export interface Mesureur {
  police(p: ProprietesTexte): PoliceRendu;
  largeur(police: PoliceRendu, texte: string, taille: number): number;
  nettoyer(police: PoliceRendu, texte: string): string;
}

export interface Abs { ax?: boolean; ay?: boolean }
export type Trace =
  | ({ t: "texte"; x: number; y: number; texte: string; police: PoliceRendu; taille: number; couleur: string; espacement: number; champ?: "PAGE" | "NUMPAGES" } & Abs)
  | ({ t: "image"; x: number; y: number; largeur: number; hauteur: number; image: ImageDocx; rognage: Rognage | null } & Abs)
  | ({ t: "rect"; x: number; y: number; largeur: number; hauteur: number; fond: string | null; trait: { couleur: string; epaisseur: number } | null; forme: "rect" | "roundRect" | "ellipse" } & Abs)
  | ({ t: "ligne"; x1: number; y1: number; x2: number; y2: number; couleur: string; epaisseur: number; style: Bordure["style"] } & Abs)
  | ({ t: "puce"; forme: NonNullable<Etiquette["puce"]>; x: number; y: number; taille: number; couleur: string } & Abs)
  | ({ t: "lien"; x: number; y: number; largeur: number; hauteur: number; url: string } & Abs);

export interface PageComposee {
  largeur: number;
  hauteur: number;
  numero: number;
  formatNumero: string;
  /** Les objets du corps placés DERRIÈRE le texte. */
  derriere: Trace[];
  /** En-tête et pied — sous le corps, comme dans Word. */
  bandes: Trace[];
  corps: Trace[];
  devant: Trace[];
}

/**
 * La géométrie de la page courante. `texte` est la zone de texte EFFECTIVE — repoussée par un
 * en-tête plus haut que la marge : c'est elle, et non la marge déclarée, que Word prend pour
 * « marge » quand il positionne un objet ancré (mesuré : le logo de l'ordre de mission, ancré à
 * −71,6 pt « de la marge », tombe à 36,6 pt du haut de la feuille, soit 108,2 − 71,6).
 */
export interface Geo { largeur: number; hauteur: number; marges: Section["marges"]; texte: { haut: number; bas: number } }

export interface Ctx {
  mes: Mesureur;
  tabDefaut: number;
  geo: Geo;
  paragraphes: WeakMap<Paragraphe, Map<number, LigneComposee[]>>;
  tableaux: WeakMap<Tableau, Map<number, TableauCompose>>;
}

export const NOIR = "000000";
export const borne = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function numeroDePage(n: number, format: string): string {
  return formaterNombre(n, format === "decimal" || !format ? "decimal" : format);
}

// ─────────────────────────── Déplacer des tracés ───────────────────────────

/** Translate des tracés composés « en relatif » ; ceux déjà ABSOLUS sur un axe ne bougent pas sur cet axe. */
export function deplacer(traces: readonly Trace[], dx: number, dy: number, force?: Abs): Trace[] {
  return traces.map((t) => {
    const mx = t.ax ? 0 : dx;
    const my = t.ay ? 0 : dy;
    const flags = force ? { ax: force.ax || t.ax, ay: force.ay || t.ay } : {};
    if (t.t === "ligne") return { ...t, x1: t.x1 + mx, x2: t.x2 + mx, y1: t.y1 + my, y2: t.y2 + my, ...flags };
    return { ...t, x: t.x + mx, y: t.y + my, ...flags } as Trace;
  });
}
