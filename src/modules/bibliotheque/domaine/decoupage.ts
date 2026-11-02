/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉCOUPAGE EN PASSAGES — ~800 jetons, avec chevauchement (J1).
 *
 * Un passage est l'unité que la recherche classe et cite : assez long pour porter une idée entière
 * (un article de contrat, un paragraphe de rapport), assez court pour qu'un vecteur le résume et
 * qu'un extrait le montre. Le CHEVAUCHEMENT (~15 %) garde ensemble une phrase coupée à la frontière :
 * « la durée de conservation est de » | « 24 mois » se retrouve entière dans le passage suivant.
 *
 * Les jetons sont ESTIMÉS (4 caractères par jeton, la moyenne mesurée de text-embedding-3 sur du
 * français) : un découpage n'a pas besoin du tokeniseur exact, et rester pur le garde testable en
 * millisecondes. Les coupes tombent, par préférence, sur un saut de paragraphe, une fin de phrase,
 * une fin de ligne, puis un blanc — jamais au milieu d'un mot quand on peut l'éviter.
 *
 * Déterministe : le même texte donne les mêmes passages (l'idempotence de l'ingestion en dépend).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CARACTERES_PAR_JETON = 4;
export const JETONS_CIBLE = 800;
export const JETONS_CHEVAUCHEMENT = 120;
/** Au-delà, le texte d'une pièce n'est plus découpé (≈ 1 000 pages) : la fin est dite tronquée. */
export const CARACTERES_MAX_PIECE = 4_000_000;

export interface Passage {
  rang: number;
  texte: string;
  /** Position du début du passage dans le texte (après normalisation des blancs). */
  debut: number;
  jetons: number;
}

export function estimerJetons(texte: string): number {
  return Math.max(1, Math.ceil(texte.length / CARACTERES_PAR_JETON));
}

/** Blancs normalisés (espaces multiples, retours chariot, caractère nul), paragraphes gardés. */
export function normaliserTexte(brut: string): string {
  return (brut ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const COUPES: RegExp[] = [/\n\n/g, /[.!?…»"][ \n]/g, /\n/g, / /g];

/** La meilleure coupe dans [min, max] : la dernière occurrence du séparateur le plus fort. */
function couperVers(texte: string, min: number, max: number): number {
  const fenetre = texte.slice(min, max);
  for (const re of COUPES) {
    let dernier = -1;
    re.lastIndex = 0;
    for (let m = re.exec(fenetre); m; m = re.exec(fenetre)) dernier = m.index + m[0].length;
    if (dernier > 0) return min + dernier;
  }
  return max;
}

export function decouper(
  brut: string,
  opts: { jetonsCible?: number; jetonsChevauchement?: number } = {},
): Passage[] {
  const texte = normaliserTexte(brut).slice(0, CARACTERES_MAX_PIECE);
  if (!texte) return [];
  const cible = Math.max(50, opts.jetonsCible ?? JETONS_CIBLE) * CARACTERES_PAR_JETON;
  const chevauchement = Math.min(cible / 2, Math.max(0, opts.jetonsChevauchement ?? JETONS_CHEVAUCHEMENT) * CARACTERES_PAR_JETON);
  const passages: Passage[] = [];
  let debut = 0;
  while (debut < texte.length) {
    let fin = texte.length;
    if (texte.length - debut > cible) fin = couperVers(texte, debut + Math.floor(cible * 0.6), debut + cible);
    const morceau = texte.slice(debut, fin).trim();
    if (morceau) passages.push({ rang: passages.length, texte: morceau, debut, jetons: estimerJetons(morceau) });
    if (fin >= texte.length) break;
    // Le passage suivant reprend un peu avant la coupe, sur un blanc (pas au milieu d'un mot).
    let suivant = Math.max(debut + 1, fin - chevauchement);
    const blanc = texte.indexOf(" ", suivant);
    if (blanc > 0 && blanc < fin) suivant = blanc + 1;
    debut = suivant;
  }
  return passages;
}
