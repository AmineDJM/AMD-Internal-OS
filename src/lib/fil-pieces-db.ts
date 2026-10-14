import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteFileByKey } from "@/lib/storage";
import { clePieceMessage } from "@/lib/fil-pieces";

/**
 * LES PIÈCES JOINTES D'UN MESSAGE DE FIL SUPPRIMÉ (`lib/fil-pieces`) — elles partent avec lui.
 *
 * Hors du fichier d'actions pour la raison de `ad-pro/fil.ts` (§118.150 g) : une action qui écrit deux
 * modèles dans son propre corps ne laisse plus la dérivation des contrats dire ce que désigne son `id`
 * (le message). Bornées à l'entité du message : une clé ne désigne rien hors de son dossier.
 *
 * Appelée APRÈS la suppression du message : un échec ici laisse au pire une pièce parmi les documents du
 * dossier — visible, jamais un message qui pointerait sur un fichier effacé. Rend le nombre de pièces parties.
 */
export async function supprimerPiecesDuMessage(m: { id: string; entityType: EntityType; entityId: string }): Promise<number> {
  const pieces = await prisma.document.findMany({
    where: { entityType: m.entityType, entityId: m.entityId, stepKey: clePieceMessage(m.id) },
    select: { id: true, fileKey: true },
  });
  if (pieces.length === 0) return 0;
  await prisma.document.deleteMany({ where: { id: { in: pieces.map((p) => p.id) } } });
  for (const p of pieces) if (p.fileKey) await deleteFileByKey(p.fileKey).catch(() => undefined);
  return pieces.length;
}
