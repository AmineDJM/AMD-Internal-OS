import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { PREFIXE_PIECE_MESSAGE, piecesParMessage } from "@/lib/fil-pieces";
import { estAssistanteDuPoste } from "./commun";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DISCUSSION D'UN POSTE (Direction, 23/11/2026) — « une discussion sur chaque poste : messages et fichiers, que tout le
 * monde voit et où tout le monde écrit ».
 *
 * ── PAS DE NOUVEAU MODÈLE ───────────────────────────────────────────────────────────────
 *
 * Le fil d'une demande Ad & Pro existe déjà, canonique : un `Comment` sur l'entité, ses pièces des `Document` de la MÊME
 * entité désignés par le message (`lib/fil-pieces`), écrit par UN écrivain (`addAdProComment`), modéré par les actions
 * canoniques (`comment-actions`), lu par `CommentThread`. Un poste est une entité de l'ERP (`AD_PRO_ITEM`) : son fil est
 * ce même fil, attaché au poste. Aucune migration.
 *
 * ── LA PORTE EST CELLE DU POSTE ─────────────────────────────────────────────────────────
 *
 * `loadItem` : qui ouvre la demande (demandeur, Direction Marketing, Finances, DG, Super Admin…) ET l'assistante chargée de
 * la prospection du poste, qui travaille sur lui sans voir la demande. Ce module dit ce que la carte lit, et la porte étroite
 * des fichiers du poste pour cette assistante ; qui PRÉVENIR d'un message vit avec les autres notifications des postes
 * (`prevenirLeFilDuPoste`, `commun.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un message du fil d'un poste, tel que la carte le lit (`CommentThread`). */
export interface MessageDuPoste {
  id: string;
  author: string;
  authorId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  attachments: { id: string; name: string; hasFile: boolean }[];
}

/** LES FILS DES POSTES, en LOT — deux requêtes pour tout l'écran, jamais une par poste. */
export async function filsDesPostes(itemIds: readonly string[]): Promise<Map<string, MessageDuPoste[]>> {
  const res = new Map<string, MessageDuPoste[]>();
  if (itemIds.length === 0) return res;
  const ids = [...itemIds];
  const [messages, pieces] = await Promise.all([
    prisma.comment.findMany({
      where: { entityType: "AD_PRO_ITEM", entityId: { in: ids } },
      select: { id: true, entityId: true, body: true, createdAt: true, editedAt: true, authorId: true, author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.document.findMany({
      where: { entityType: "AD_PRO_ITEM", entityId: { in: ids }, stepKey: { startsWith: PREFIXE_PIECE_MESSAGE } },
      select: { id: true, name: true, fileKey: true, stepKey: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const piecesDe = piecesParMessage(pieces);
  for (const m of messages) {
    const liste = res.get(m.entityId) ?? [];
    liste.push({
      id: m.id, author: m.author?.name ?? "—", authorId: m.authorId, body: m.body,
      createdAt: m.createdAt.toISOString(), editedAt: m.editedAt?.toISOString() ?? null,
      attachments: (piecesDe.get(m.id) ?? []).map((d) => ({ id: d.id, name: d.name, hasFile: Boolean(d.fileKey) })),
    });
    res.set(m.entityId, liste);
  }
  return res;
}

/**
 * LES FICHIERS D'UN POSTE s'ouvrent aussi, EN LECTURE, à l'assistante chargée de sa prospection — qui y travaille sans voir la
 * demande (`loadItem`) et sans les modules Ad & Pro (Direction, 23/11/2026 : « tout ce qu'elle faisait dans Ad & Pro, sur sa
 * page ») : les pièces des messages du fil, le BAT, les photos de la réception, les fichiers joints au poste. Porte ÉTROITE :
 * les `Document` de CE poste (`AD_PRO_ITEM`), jamais ceux de la demande ; ses pièces Legal (devis, BC) ont leur règle
 * jumelle dans `accesAuxPiecesLegalDetaille`.
 */
export async function peutLireFichierDuPosteConfie(
  user: Pick<SessionUser, "id">, doc: { entityType: string; entityId: string },
): Promise<boolean> {
  if (doc.entityType !== "AD_PRO_ITEM") return false;
  return estAssistanteDuPoste(user.id, doc.entityId);
}
