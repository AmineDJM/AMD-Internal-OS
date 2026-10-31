/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX TEMPS RÉEL DE L'ASSISTANT IA (lot J13, décision 0025) — les RÈGLES, zéro import.
 *
 * La conversation vocale prend les MÊMES outils, sous les MÊMES droits et les MÊMES repères que le texte.
 * Deux choses changent, parce qu'on ne reprend pas une parole :
 *
 *   1. UNE VALEUR SENSIBLE SUIT LE MODE DE LA CONSOLE (décision 0034). « En clair » (défaut, Direction 31/10/2026) :
 *      la voix PRONONCE ce que la personne a le droit de voir — l'assistant ne lui rend que cela (même juge que
 *      l'écran). « Masquées » (décision 0012) : jamais lue à voix haute — le modèle vocal ne reçoit que des repères,
 *      et `pourLaVoix` remplace même le repère par « affichée à l'écran ».
 *   2. UNE ÉCRITURE NE SE CONFIRME JAMAIS À LA VOIX. La voix (GPT-Live) n'a AUCUN outil : elle délègue à l'assistant,
 *      qui ne fait que préparer une CARTE ; la carte s'affiche à l'écran et ne s'exécute que d'un clic (R3/R4 :
 *      ressaisie comprise). Un « oui » dit n'atteint aucune porte d'exécution.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RE_REPERE = /⟦S\d+⟧/g;
export const DIT_A_L_ECRAN = "[valeur confidentielle affichée à l'écran]";
/** Décision 0034, mode « en clair » : une valeur que la personne n'a pas le droit de voir — la voix le dit ainsi. */
export const NON_OUVERTE = "[valeur confidentielle non ouverte à cette personne]";

/** Le résultat d'un outil tel que la voix le reçoit : aucun repère, borné (le contexte vocal se paie en latence). */
export function pourLaVoix(sortie: string, max = 6_000): string {
  const t = (sortie ?? "").replace(RE_REPERE, DIT_A_L_ECRAN);
  return t.length <= max ? t : `${t.slice(0, max)}… (tronqué pour la voix — le détail est à l'écran)`;
}

const CONSIGNES_VOIX_COMMUNES = [
  "Tu parles à voix haute avec un collaborateur, souvent en déplacement : phrases courtes, une idée à la fois, en français",
  "(réponds en arabe algérien si la personne te parle en arabe). Pas de listes, pas de Markdown, pas d'adresse web.",
  "L'assistant de l'entreprise, à qui tu délègues, a exactement les mêmes droits que dans la conversation écrite.",
];
const CONSIGNES_ECRITURE_VOIX = [
  "Une écriture (créer, envoyer, modifier, demander) se PRÉPARE : l'assistant affiche une carte à l'écran. Dis « la carte est",
  "affichée, confirmez-la à l'écran ». Ne dis JAMAIS qu'une action est faite, et n'accepte jamais un « oui » oral comme",
  "confirmation : seul le bouton de la carte exécute.",
];

/**
 * LES CONSIGNES DE LA VOIX SELON LE MODE (décision 0034). En clair (défaut) : la voix PRONONCE une valeur sensible que
 * l'assistant lui rend (la personne a le droit de la voir — l'assistant ne rend que celles-là). Masquées : jamais.
 */
export function consignesVoix(enClair: boolean): string {
  const sensibles = enClair
    ? [
      "Une valeur confidentielle (salaire, IBAN, RIB, numéro de pièce d'identité) que l'assistant te rend en clair, la personne a le",
      "droit de la connaître : DIS-LA quand elle la demande (un montant en toutes lettres, un IBAN par groupes de quatre). Quand un",
      "résultat dit « valeur confidentielle non ouverte à cette personne », dis qu'elle ne lui est pas ouverte.",
    ]
    : [
      "Une valeur confidentielle n'est JAMAIS prononcée : quand un résultat dit « valeur confidentielle affichée à l'écran »,",
      "dis seulement qu'elle est affichée à l'écran.",
    ];
  return [...CONSIGNES_VOIX_COMMUNES, ...sensibles, ...CONSIGNES_ECRITURE_VOIX].join("\n");
}


/** Le p50 (médiane) d'une série de latences en ms — `null` sans mesure. */
export function mediane(mesures: number[]): number | null {
  const v = mesures.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

/** La cible du lot : la réponse vocale commence en 1,5 s au plus (p50), mesurée de la fin de la parole au premier son. */
export const CIBLE_LATENCE_VOCALE_MS = 1_500;
