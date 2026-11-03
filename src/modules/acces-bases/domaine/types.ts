/**
 * L'ACCÈS PAR BASE (lots D1-D5, décision 0057) — les types purs.
 * Une « base » est une famille de tables métier du catalogue (`catalogue.genere.ts`, généré depuis
 * `scripts/bases-de-donnees/`). Aucun import : lisible partout, navigateur compris.
 */

export type Sensibilite = "public-interne" | "restreint" | "confidentiel" | "secret";

export interface BaseCatalogue {
  cle: string;
  nom: string;
  nature: "metier" | "technique";
  sensibilite: Sensibilite;
  /** Les modules RBAC qui y mènent (clés de `MODULES`). */
  modules: readonly string[];
  /** Le geste qu'exige la lecture quand ce n'est pas `VIEW` (la paie : RH en modification). */
  lectureExige?: string;
  /** Les familles de l'assistant IA qui la couvrent. */
  famillesIa: readonly string[];
  /** Les modèles Prisma (noms PascalCase) de la base. */
  tables: readonly string[];
}

/** Le niveau d'un réglage. « NORMAL » n'est jamais stocké : c'est l'absence de réglage en vigueur. */
export type NiveauBase = "NORMAL" | "LECTURE_SEULE" | "FERMEE" | "OUVERTE";
export type NiveauStocke = Exclude<NiveauBase, "NORMAL">;

/** Un réglage tel qu'enregistré (`AccesBase`), réduit à ce que la règle lit. */
export interface ReglageBase {
  id: string;
  base: string;
  userId: string | null;
  role: string | null;
  niveau: NiveauStocke;
  ecriture: boolean;
  du: Date;
  au: Date | null;
  revoqueLe: Date | null;
  /** Le motif (cité au journal quand une ouverture nominative montre une valeur sensible — S1). */
  motif?: string;
}

/** D'où vient le niveau d'une base pour une personne. */
export type SourceNiveau = "personne" | "role" | "defaut";

export interface NiveauResolu {
  niveau: NiveauBase;
  /** Pour OUVERTE : l'écriture est-elle aussi accordée ? */
  ecriture: boolean;
  source: SourceNiveau;
  reglageId: string | null;
}

/** Ce que les modules donnent déjà sur une base (au moins un module ouvert en lecture / en écriture). */
export interface DroitModules {
  lecture: boolean;
  ecriture: boolean;
}

/** Le droit effectif sur une base : modules ET niveau de base. */
export interface DroitBase {
  lecture: boolean;
  ecriture: boolean;
  niveau: NiveauBase;
  source: SourceNiveau;
  /** Une phrase qui dit pourquoi (console « Qui voit cette base ? », refus clair). */
  chemin: string;
}
