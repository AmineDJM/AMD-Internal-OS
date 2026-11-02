/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TEXTE LONG DE LA PERSONNE (Direction, 02/11/2026 : « enlève la limite : quand j'envoie des textes trop longs, ça
 * les coupe ») — règle PURE.
 *
 * Un message n'est JAMAIS coupé. Jusqu'à `SEUIL_TEXTE_EN_PIECE` caractères (≈ 57 000 jetons, bien dans la fenêtre du
 * modèle), il part en entier au modèle. Au-delà, il devient une PIÈCE (un `.txt` déposé dans le Drive de la personne),
 * lue par la lecture de documents existante (découpe, résumé par parties) — et le message le DIT : son début, sa taille,
 * le nom de la pièce. Rien ne disparaît en silence.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const SEUIL_TEXTE_EN_PIECE = 200_000;
/** Le début du texte gardé dans le message quand il part en pièce (il situe la demande). */
export const DEBUT_GARDE = 2_000;

export const doitDevenirPiece = (texte: string): boolean => texte.length > SEUIL_TEXTE_EN_PIECE;

/** Le nom de la pièce : « Texte collé — 02-11-2026 14h05 (612 000 caractères).txt ». */
export function nomDuTexte(n: number, quand: Date): string {
  const d = quand.toLocaleString("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    .replace(/\//g, "-").replace(/\s*[,à]\s*/g, " ").replace(":", "h");
  return `Texte collé — ${d} (${n.toLocaleString("fr-FR").replace(/ | /g, " ")} caractères).txt`;
}

/** Ce que le message garde : le début, et la phrase qui dit où est le reste. */
export function messageDuTexteLong(texte: string, nom: string): string {
  const debut = texte.slice(0, DEBUT_GARDE).trimEnd();
  return `${debut}\n\n[Texte trop long pour un message (${texte.length.toLocaleString("fr-FR")} caractères) : il est joint EN ENTIER comme pièce « ${nom} », lue ci-dessous. Rien n'a été coupé.]`;
}

/** Une estimation PRUDENTE des jetons d'un texte (3,5 caractères par jeton, calibré au banc M1). */
export const jetonsDuTexte = (t: string): number => Math.ceil((t ?? "").length / 3.5);
