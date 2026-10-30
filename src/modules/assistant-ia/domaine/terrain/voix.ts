/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX TEMPS RÉEL DE L'ASSISTANT IA (lot J13, décision 0025) — les RÈGLES, zéro import.
 *
 * La conversation vocale prend les MÊMES outils, sous les MÊMES droits et les MÊMES repères que le texte.
 * Deux choses changent, parce qu'on ne reprend pas une parole :
 *
 *   1. UNE VALEUR SENSIBLE N'EST JAMAIS LUE À VOIX HAUTE. Le modèle vocal ne reçoit que des repères (comme le
 *      texte), et `pourLaVoix` remplace même le repère par « affichée à l'écran » : il ne peut ni la dire, ni
 *      dire un jeton illisible. L'écran, lui, montre la valeur à qui a le droit de la voir (le révélateur).
 *   2. UNE ÉCRITURE NE SE CONFIRME JAMAIS À LA VOIX. Un outil d'écriture prépare une CARTE ; la carte
 *      s'affiche à l'écran et ne s'exécute que d'un clic (R3/R4 : ressaisie comprise). Aucun outil de
 *      confirmation n'est offert à la session vocale, et la route d'outils refuse tout nom qui en serait un.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RE_REPERE = /⟦S\d+⟧/g;
export const DIT_A_L_ECRAN = "[valeur confidentielle affichée à l'écran]";

/** Le résultat d'un outil tel que la voix le reçoit : aucun repère, borné (le contexte vocal se paie en latence). */
export function pourLaVoix(sortie: string, max = 6_000): string {
  const t = (sortie ?? "").replace(RE_REPERE, DIT_A_L_ECRAN);
  return t.length <= max ? t : `${t.slice(0, max)}… (tronqué pour la voix — le détail est à l'écran)`;
}

/** Les noms qu'une session vocale ne peut JAMAIS appeler : tout ce qui confirme, exécute, signe. */
const INTERDITS_A_LA_VOIX = /(confirm|execut|valider|signer|approuv|payer)/i;
export const outilInterditALaVoix = (nom: string): boolean => INTERDITS_A_LA_VOIX.test(nom);

export const CONSIGNES_VOIX = [
  "Tu parles à voix haute avec un collaborateur, souvent en déplacement : phrases courtes, une idée à la fois, en français",
  "(réponds en arabe algérien si la personne te parle en arabe). Pas de listes, pas de Markdown, pas d'adresse web.",
  "Tu as les mêmes outils et exactement les mêmes droits que dans la conversation écrite ; consulte-les au lieu de deviner.",
  "Une valeur confidentielle n'est JAMAIS prononcée : quand un outil rend « valeur confidentielle affichée à l'écran »,",
  "dis seulement qu'elle est affichée à l'écran.",
  "Une écriture (créer, envoyer, modifier, demander) se PRÉPARE : l'outil affiche une carte à l'écran. Dis « la carte est",
  "affichée, confirmez-la à l'écran ». Ne dis JAMAIS qu'une action est faite, et n'accepte jamais un « oui » oral comme",
  "confirmation : seul le bouton de la carte exécute.",
].join("\n");

/** Le p50 (médiane) d'une série de latences en ms — `null` sans mesure. */
export function mediane(mesures: number[]): number | null {
  const v = mesures.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

/** La cible du lot : la réponse vocale commence en 1,5 s au plus (p50), mesurée de la fin de la parole au premier son. */
export const CIBLE_LATENCE_VOCALE_MS = 1_500;
