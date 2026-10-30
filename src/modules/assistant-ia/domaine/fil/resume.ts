/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉSUMÉ ROULANT DU FIL (lot J4, couche (b) de la mémoire — décision 0018). Règle PURE.
 *
 * Avant : les 16 derniers tours, mot pour mot, et rien au-delà — une conversation de 30 échanges avait oublié son
 * début, et chaque tour renvoyait jusqu'à 16 messages entiers. Désormais :
 *
 *   • les DERNIERS échanges restent mot pour mot (`VERBATIM_ECHANGES`) ;
 *   • ce qui précède est RÉSUMÉ, gardé sur le fil, et régénéré par le modèle « rapide » quand assez d'échanges sont
 *     sortis de la fenêtre (`SEUIL_ECHANGES`) — jamais à chaque tour ;
 *   • le résumé dit jusqu'où il va (`jusquA`, la date de la dernière question couverte) : relancer la compaction
 *     sans échange nouveau ne fait RIEN (idempotence) ;
 *   • aucune valeur sensible : le texte confié au modèle a passé le filtre (les valeurs révélées redeviennent
 *     « [confidentiel] », un IBAN, un salaire sont masqués), et le résumé rendu le repasse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Échanges (question + réponse) gardés mot pour mot. */
export const VERBATIM_ECHANGES = 4;
/** Échanges sortis de la fenêtre avant de résumer : on ne paie pas un résumé à chaque tour. */
export const SEUIL_ECHANGES = 3;
/** Le résumé reste court : il entre dans l'enveloppe du tour (`assembleur.ts`). */
export const RESUME_MAX_CARACTERES = 2_400;

export interface TourResumable {
  role: "user" | "assistant";
  content: string;
  /** La date de la QUESTION de l'échange (la réponse porte celle de sa question). */
  quand: Date;
}

/** Ce qui suit le résumé : les échanges dont la question est postérieure à `jusquA`. */
export function apresLeResume<T extends TourResumable>(tours: readonly T[], jusquA: Date | null): T[] {
  return jusquA ? tours.filter((t) => t.quand.getTime() > jusquA.getTime()) : [...tours];
}

/** Les questions distinctes, dans l'ordre. */
const questions = (tours: readonly TourResumable[]) => [...new Set(tours.map((t) => t.quand.getTime()))];

/**
 * FAUT-IL RÉSUMER ? Oui si, après le résumé actuel, plus de `VERBATIM + SEUIL` échanges sont là : les plus anciens
 * (tous sauf les `VERBATIM` derniers) passent au résumé. Rend `null` sinon — rien à faire, et rien ne change.
 */
export function aCompacter<T extends TourResumable>(
  tours: readonly T[], jusquA: Date | null, o: { verbatim?: number; seuil?: number } = {},
): { aResumer: T[]; jusquA: Date } | null {
  const verbatim = o.verbatim ?? VERBATIM_ECHANGES;
  const seuil = o.seuil ?? SEUIL_ECHANGES;
  const restants = apresLeResume(tours, jusquA);
  const q = questions(restants);
  if (q.length <= verbatim + seuil) return null;
  const limite = q[q.length - verbatim - 1];
  return { aResumer: restants.filter((t) => t.quand.getTime() <= limite), jusquA: new Date(limite) };
}

export const CONSIGNE_RESUME = [
  "Tu tiens le RÉSUMÉ d'une conversation entre une personne et l'assistant interne d'Adventum Pharma.",
  "On te donne le résumé précédent (s'il existe) et les échanges suivants. Rends UN résumé à jour, en français, en 10 puces au plus :",
  "ce que la personne a demandé, ce qui a été trouvé ou préparé (références, noms, dates, montants non confidentiels), ce qui reste en suspens, ses préférences exprimées.",
  "N'écris JAMAIS une rémunération, une coordonnée bancaire ni un numéro de pièce d'identité : écris « [confidentiel] ». Garde tels quels les repères ⟦S1⟧ et « [confidentiel] » du texte.",
  "Pas de phrase d'introduction, pas de conclusion : les puces seulement.",
].join("\n");

/** Le texte confié au modèle rapide — déjà filtré par l'appelant. */
export function texteAResumer(precedent: string | null, tours: readonly TourResumable[]): string {
  const echanges = tours.map((t) => `${t.role === "user" ? "PERSONNE" : "ASSISTANT"} : ${t.content.replace(/\s+/g, " ").trim().slice(0, 1_500)}`);
  return `${precedent ? `RÉSUMÉ PRÉCÉDENT :\n${precedent}\n\n` : ""}ÉCHANGES À INTÉGRER :\n${echanges.join("\n")}`;
}

/** Le résumé gardé : borné, sans ligne vide — le filtre de confidentialité est appliqué par l'appelant. */
export function borner(texte: string): string {
  const t = texte.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n");
  return t.length <= RESUME_MAX_CARACTERES ? t : `${t.slice(0, RESUME_MAX_CARACTERES).replace(/\n[^\n]*$/, "")}\n…`;
}

/** La section du contexte qui porte le résumé — dans la partie VARIABLE de la consigne. */
export const sectionResume = (resume: string | null | undefined): string | null =>
  resume?.trim() ? `### CONVERSATION ANTÉRIEURE (résumé des échanges plus anciens que ceux qui suivent)\n${resume.trim()}` : null;
