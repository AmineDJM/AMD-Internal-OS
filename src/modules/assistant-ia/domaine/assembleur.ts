import { termes } from "./selection-outils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSEMBLEUR DE CONTEXTE (lot J4, décision 0018) — règle PURE.
 *
 * Quatre couches peuvent nourrir un tour : (a) le carnet d'un travail (J2, lu par ses étapes) ; (b) la conversation
 * — les derniers échanges mot pour mot et le RÉSUMÉ ROULANT de ce qui précède ; (c) la mémoire personnelle ;
 * (d) la connaissance de l'entreprise (Bibliothèque, faits confirmés — par des OUTILS, à la demande).
 *
 * L'assembleur choisit, pour CETTE question, ce qui entre dans une ENVELOPPE DE JETONS FIXE : rien ne grossit avec
 * l'âge de la conversation ni le nombre de souvenirs. Ce qui est obligatoire passe d'abord (s'il tient) ; le reste
 * par priorité, puis par pertinence pour la question ; un morceau qui ne tient pas est écarté ENTIER (jamais coupé
 * au milieu d'une phrase).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Approximation déterministe, la même que la couche de contexte : ~4 caractères par jeton pour le français. */
export const estimerJetons = (t: string): number => (t ? Math.ceil(t.length / 4) : 0);

/** Les enveloppes d'un tour (jetons). La conversation la plus longue tient dans la même enveloppe que la première. */
export const ENVELOPPES = {
  /** Mémoire personnelle : les souvenirs les plus pertinents pour la question. */
  memoire: 500,
  /** Résumé roulant de la conversation antérieure. */
  resume: 700,
  /** Échanges mot pour mot (les plus récents d'abord). */
  historique: 3_500,
} as const;

export interface Morceau {
  cle: string;
  texte: string;
  /** Plus haut = plus important. */
  priorite: number;
  obligatoire?: boolean;
}

export interface Assemblage<T extends Morceau = Morceau> {
  gardes: T[];
  ecartes: string[];
  jetons: number;
}

/** Remplit l'enveloppe : obligatoires, puis par priorité décroissante (ordre d'entrée à priorité égale). */
export function assembler<T extends Morceau>(morceaux: readonly T[], enveloppe: number): Assemblage<T> {
  const ordre = morceaux.map((m, i) => ({ m, i })).sort((a, b) =>
    Number(!!b.m.obligatoire) - Number(!!a.m.obligatoire) || b.m.priorite - a.m.priorite || a.i - b.i);
  let jetons = 0;
  const gardesIdx: number[] = [];
  const ecartes: string[] = [];
  for (const { m, i } of ordre) {
    const j = estimerJetons(m.texte);
    if (jetons + j <= enveloppe) { jetons += j; gardesIdx.push(i); } else ecartes.push(m.cle);
  }
  // Les gardés reprennent leur ordre d'entrée : le texte assemblé se lit dans l'ordre où il a été donné.
  return { gardes: gardesIdx.sort((a, b) => a - b).map((i) => morceaux[i]), ecartes, jetons };
}

/** La pertinence d'un texte pour une question : les racines partagées. */
export function pertinence(texte: string, question: string): number {
  const q = new Set(termes(question));
  if (!q.size) return 0;
  return [...new Set(termes(texte))].filter((m) => q.has(m)).length;
}

/**
 * LES SOUVENIRS d'une personne (du plus récent au plus ancien) pour CETTE question : les pertinents d'abord, les plus
 * récents ensuite, dans l'enveloppe.
 */
export function souvenirsPourQuestion(souvenirs: readonly string[], question: string, enveloppe: number = ENVELOPPES.memoire): string[] {
  const morceaux = souvenirs.map((texte, i) => ({ cle: `m${i}`, texte, priorite: pertinence(texte, question) * 1000 - i }));
  return assembler(morceaux, enveloppe).gardes.map((m) => m.texte);
}

/**
 * L'HISTORIQUE DANS SON ENVELOPPE : les échanges les plus RÉCENTS, par paires question → réponse ; un échange qui ne
 * tient pas entier arrête la remontée (on ne saute pas un échange pour en garder un plus vieux).
 */
export function historiqueDansEnveloppe<T extends { role: "user" | "assistant"; content: string }>(tours: readonly T[], enveloppe: number = ENVELOPPES.historique): T[] {
  let jetons = 0;
  let debut = tours.length;
  for (let i = tours.length - 1; i >= 0; i--) {
    const j = estimerJetons(tours[i].content);
    if (jetons + j > enveloppe) break;
    jetons += j;
    debut = i;
  }
  // Jamais une réponse orpheline en tête : le modèle lirait une réponse sans sa question.
  while (debut < tours.length && tours[debut].role === "assistant") debut += 1;
  return tours.slice(debut);
}
