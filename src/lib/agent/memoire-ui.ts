/**
 * LA MÉMOIRE PERSONNELLE DE L'ASSISTANT IA — la part PURE (types, libellés, bornes), sans aucun
 * import : l'écran (navigateur) et le serveur la lisent tous deux. Le module serveur
 * (`memoire.ts`) la réexporte.
 */

/** Les sortes de souvenirs qu'une personne peut confier — un sous-ensemble lisible des types d'Adam. */
export const SORTES_MEMOIRE = ["ORGANIZATIONAL_CONTEXT", "USER_PREFERENCE", "WORKING_STYLE", "ENTITY_ALIAS", "TERMINOLOGY"] as const;
export type SorteMemoire = (typeof SORTES_MEMOIRE)[number];

export const LIBELLE_SORTE: Record<SorteMemoire, string> = {
  ORGANIZATIONAL_CONTEXT: "Mon contexte (société, service, produits)",
  USER_PREFERENCE: "Préférence",
  WORKING_STYLE: "Habitude de travail",
  ENTITY_ALIAS: "Raccourci (alias)",
  TERMINOLOGY: "Vocabulaire",
};

export const estSorteMemoire = (v: unknown): v is SorteMemoire =>
  typeof v === "string" && (SORTES_MEMOIRE as readonly string[]).includes(v);

/** Bornes : une phrase, pas un document ; une mémoire, pas un entrepôt. */
export const MEMOIRE_MAX_CARACTERES = 400;
export const MEMOIRE_MAX_ELEMENTS = 200;

export interface ElementMemoire {
  id: string;
  sorte: SorteMemoire | string;
  contenu: string;
  modifieLe: string;
}

/** Une mémoire proposée par l'assistant, en attente de la confirmation de la personne. */
export interface MemoireProposee {
  contenu: string;
  sorte: SorteMemoire;
}
