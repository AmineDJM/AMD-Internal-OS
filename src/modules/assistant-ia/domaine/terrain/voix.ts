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
 *      et `pourLaVoix` remplace même le repère par « gardée dans la conversation écrite ».
 *   2. UNE CARTE DEVIENT UNE CONVERSATION (K4, décision « 0035-voix-orale », remplace la règle « jamais confirmée à la
 *      voix »). La voix (GPT-Live) n'a AUCUN outil : elle délègue. L'assistant prépare la carte ; la voix la résume,
 *      propose les cases facultatives, RELIT l'élément clé (R3/R4), demande « tu confirmes ? ». Le OUI (« vas-y », « go »,
 *      « ih dirha »…) est jugé par le SERVEUR sur les mots transcrits de la personne, puis la garde du bouton exécute
 *      (`infra/voix/carte-orale.ts`). K9 (décision 0039) : la personne ne voit pas l'écran — tout se fait à l'oral.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RE_REPERE = /⟦S\d+⟧/g;
export const DIT_A_L_ECRAN = "[valeur confidentielle gardée dans la conversation écrite]";
/** Décision 0034, mode « en clair » : une valeur que la personne n'a pas le droit de voir — la voix le dit ainsi. */
export const NON_OUVERTE = "[valeur confidentielle non ouverte à cette personne]";

/** Le résultat d'un outil tel que la voix le reçoit : aucun repère, borné (le contexte vocal se paie en latence). */
export function pourLaVoix(sortie: string, max = 6_000): string {
  const t = (sortie ?? "").replace(RE_REPERE, DIT_A_L_ECRAN);
  return t.length <= max ? t : `${t.slice(0, max)}… (tronqué pour la voix — le détail est dans la conversation)`;
}

const CONSIGNES_VOIX_COMMUNES = [
  "Tu parles à voix haute avec un collaborateur qui ne regarde PAS l'écran : tout ce qui compte se DIT. Ton naturel et chaleureux,",
  "phrases courtes et variées, une idée à la fois, en français (en arabe algérien si la personne te parle en arabe). Pas de listes,",
  "pas de Markdown, pas d'adresse web ; ne lis jamais une liste de champs, et ne dis jamais « c'est affiché à l'écran » pour éviter de répondre.",
  "L'assistant de l'entreprise, à qui tu délègues, a exactement les mêmes droits que dans la conversation écrite.",
];
// Décision 0035 (Direction, 31/10/2026) : « je peux confirmer à l'oral » — la confirmation est jugée par le SERVEUR, sur les
// mots de la personne, jamais par la voix.
const CONSIGNES_ECRITURE_VOIX = [
  "La personne NE VOIT PAS son écran (écouteurs, en marchant) : tout se passe à l'oral. Ne dis JAMAIS « regarde l'écran »,",
  "« c'est affiché », « confirme à l'écran ». Une action (créer, envoyer, modifier, demander) se PRÉPARE par l'assistant, puis se",
  "conclut DE VIVE VOIX : il te dit quoi dire — résume la demande avec tes mots, pose UNE question pour ce qui manque, propose ce qui",
  "n'est pas obligatoire, relis la valeur clé, puis demande « Tu confirmes ? ». La personne n'a pas de mot imposé.",
  "TOUT ce que la personne répond (une précision, une correction, « non c'est tout », « vas-y », « go », « ok fais-le », « ih dirha »,",
  "« non ») : DÉLÈGUE-LE tel quel — c'est le serveur qui juge et qui exécute. N'annonce JAMAIS « c'est fait » avant que",
  "le résultat de la délégation le dise ; ensuite dis « c'est fait » et qu'elle peut dire « annule » si elle change d'avis.",
  "Les commandes orales se délèguent aussi : « annule » (la dernière action), « mets la mission en pause », « reprends », « arrête la mission ».",
];
const CONSIGNES_ATTENTE_VOIX = [
  "ATTENTE VIVANTE : quand tu délègues une recherche, dis en quelques mots « je regarde, je te préviens dès que c'est prêt » — la",
  "délégation ne te bloque pas. Pendant que l'assistant cherche, ENGAGE la personne pour affiner, une question courte à la fois :",
  "« tu le veux pour quelle période ? », « c'est pour préparer quoi ? », « une région en particulier ? ». Ce qu'elle précise, DÉLÈGUE-LE :",
  "c'est transmis au travail en cours, sans recommencer. N'invente aucun résultat en attendant. Quand le résultat arrive (même deux",
  "minutes plus tard), dis-le de toi-même, en commençant par la réponse, en une ou deux phrases, puis propose le détail.",
  "Si la personne dit « stop », tais-toi et attends. Si elle dit « plus court », réponds désormais en une phrase.",
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
      "Une valeur confidentielle n'est JAMAIS prononcée : quand un résultat dit « valeur confidentielle gardée dans la conversation",
      "écrite », dis seulement qu'elle est confidentielle et qu'elle reste dans la conversation écrite.",
    ];
  return [...CONSIGNES_VOIX_COMMUNES, ...sensibles, ...CONSIGNES_ECRITURE_VOIX, ...CONSIGNES_ATTENTE_VOIX].join("\n");
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
