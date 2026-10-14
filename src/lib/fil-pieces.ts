import { refusTeleversement } from "@/lib/files/politique-televersement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES JOINTES D'UN MESSAGE DE FIL — module PUR (aucun import lourd : le navigateur le lit).
 *
 * « Dans toutes les discussions et commentaires des demandes Ad & Pro, on doit pouvoir joindre des
 * pièces jointes (plusieurs) à un message » (Direction, 10/2026).
 *
 * ── PAS DE NOUVEAU MODÈLE ───────────────────────────────────────────────────────────────
 *
 * Un message de fil est un `Comment` (entité + identifiant). Sa pièce jointe est un `Document`
 * rattaché à la MÊME entité, désigné par le message dans `stepKey` (`fil-message:<id>`). D'où :
 *   • la porte de lecture de la pièce (`/api/documents/[id]` → `canAccessEntity` sur l'entité)
 *     est EXACTEMENT celle du fil — qui ne voit pas le dossier n'ouvre pas la pièce ;
 *   • la pièce est aussi une pièce du dossier : elle se retrouve dans ses documents, jamais perdue ;
 *   • aucune migration.
 *
 * Ce module dit seulement la CLÉ (écrite une fois, lue par l'écrivain, la lecture du fil et la
 * suppression d'un message) et ce que le navigateur refuse AVANT d'envoyer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const PREFIXE_PIECE_MESSAGE = "fil-message:" as const;

/** La `stepKey` des pièces jointes d'un message. */
export function clePieceMessage(commentId: string): string {
  return `${PREFIXE_PIECE_MESSAGE}${commentId}`;
}

/** Le message qu'une pièce accompagne, ou `null` si ce n'est pas une pièce de fil. */
export function messageDeLaPiece(stepKey: string | null | undefined): string | null {
  if (!stepKey || !stepKey.startsWith(PREFIXE_PIECE_MESSAGE)) return null;
  const id = stepKey.slice(PREFIXE_PIECE_MESSAGE.length);
  return id.length > 0 ? id : null;
}

/** Les pièces regroupées par message (l'ordre d'entrée est gardé dans chaque groupe). */
export function piecesParMessage<T extends { stepKey: string | null }>(docs: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const d of docs) {
    const m = messageDeLaPiece(d.stepKey);
    if (!m) continue;
    const l = out.get(m);
    if (l) l.push(d);
    else out.set(m, [d]);
  }
  return out;
}

/** Un message se publie s'il dit quelque chose OU s'il porte au moins une pièce. */
export function messageRecevable(body: string | null | undefined, nbPieces: number): boolean {
  return Boolean(body && body.trim().length > 0) || nbPieces > 0;
}

// ───────────────────────────── Le choix de fichiers, avant l'envoi ─────────────────────────────

/** Ce que le navigateur sait d'un fichier choisi — `File` le satisfait. */
export interface FichierChoisi { name: string; size: number; lastModified?: number }

/** Une même pièce choisie deux fois (même nom, même taille, même date) ne part qu'une fois. */
const empreinte = (f: FichierChoisi) => `${f.name}\u0000${f.size}\u0000${f.lastModified ?? 0}`;

/**
 * AJOUTER DES FICHIERS À UNE SÉLECTION — plusieurs dans le même geste, puis d'autres plus tard.
 *
 * Les fichiers refusés (type exécutable, vide, trop lourd pour la limite lue) sont DITS, avec la phrase
 * même du serveur ; les autres rejoignent la sélection, sans doublon. `maxMo` absent (limites non lues) :
 * rien n'est refusé ici, le serveur reste la garde.
 */
export function ajouterAuChoix<F extends FichierChoisi>(
  actuels: readonly F[], nouveaux: readonly F[], maxMo: number | null,
): { fichiers: F[]; refus: { nom: string; raison: string }[] } {
  const vus = new Set(actuels.map(empreinte));
  const fichiers = [...actuels];
  const refus: { nom: string; raison: string }[] = [];
  for (const f of nouveaux) {
    const raison = f.size === 0
      ? "Fichier vide (0 octet)."
      : maxMo != null ? refusTeleversement(f.name, f.size, maxMo) : null;
    if (raison) { refus.push({ nom: f.name, raison }); continue; }
    const e = empreinte(f);
    if (vus.has(e)) continue;
    vus.add(e);
    fichiers.push(f);
  }
  return { fichiers, refus };
}
