/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHIERS D'UNE PIÈCE DE PRISE EN CHARGE — module PUR, zéro import (le navigateur le lit).
 *
 * « L'upload du passeport doit accepter PLUSIEURS pièces jointes (recto/verso, plusieurs pages,
 * visa…) » (Direction, 10/2026). Une case PIÈCE (`CareCell` de nature DOCUMENT) porte UN fichier
 * principal (`documentId`, ce que lisent le livret et la réservation) ; ses fichiers sont TOUS les
 * `Document` de la demande que la case désigne (`stepKey` = la case) — le dépôt les a toujours
 * rangés ainsi, aucune migration.
 *
 * La règle : une pièce est REÇUE dès qu'elle a au moins un fichier, et de nouveau ATTENDUE quand
 * le dernier est retiré. Le fichier principal reste celui qu'il était tant qu'il existe ; sinon,
 * le plus ancien des fichiers restants prend sa place.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FichierPiece { id: string; name: string; hasFile: boolean }

/** Les fichiers d'une case PIÈCE, parmi les documents de la demande : ceux qu'elle désigne, et son principal. */
export function fichiersDeLaCase<T extends { id: string; stepKey: string | null }>(
  cell: { id: string; documentId: string | null }, docs: readonly T[],
): T[] {
  return docs.filter((d) => d.stepKey === cell.id || d.id === cell.documentId);
}

/**
 * L'ÉTAT D'UNE CASE APRÈS LE RETRAIT D'UN DE SES FICHIERS. `restants` : les fichiers qui demeurent, du plus
 * ancien au plus récent (sans celui qu'on retire).
 */
export function etatApresRetrait(
  cell: { documentId: string | null }, retire: string, restants: readonly string[],
): { status: "REQUESTED" | "PROVIDED"; documentId: string | null } {
  const vivants = restants.filter((id) => id !== retire);
  if (vivants.length === 0) return { status: "REQUESTED", documentId: null };
  const garde = cell.documentId && cell.documentId !== retire && vivants.includes(cell.documentId) ? cell.documentId : vivants[0]!;
  return { status: "PROVIDED", documentId: garde };
}

/** Le fichier principal après un dépôt : l'actuel s'il existe toujours, sinon le premier déposé. */
export function principalApresDepot(actuel: string | null, actuelExiste: boolean, deposes: readonly string[]): string | null {
  return actuel && actuelExiste ? actuel : deposes[0] ?? null;
}

/** Ce que l'écran dit d'un dépôt de plusieurs fichiers. */
export function phraseDepot(label: string, n: number): string {
  return n > 1 ? `${label} : ${n} fichiers joints.` : `${label} reçue.`;
}
