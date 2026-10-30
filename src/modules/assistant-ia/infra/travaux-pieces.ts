import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getManagerOfUser } from "@/lib/departments";
import { droitsSurDocument } from "@/platform/ia/artifact/ports";
import type { PieceTravail, PortPiecesTravail } from "@/lib/missions/travaux/persona";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UNE DÉLÉGATION (J8, décision 0023) — sous les droits du Drive, relus à chaque appel.
 *
 * VOIR : `droitsSurDocument` (la même règle que l'écran du Drive et que l'Atelier). PARTAGER : une ligne
 * `DriveShare` en LECTURE, jamais par-dessus un droit existant (`skipDuplicates` : un VIEW ne remplace pas un
 * EDIT), ni au propriétaire — et chaque partage est à l'audit : qui a ouvert quelle pièce à qui, et pourquoi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const PIECES_TRAVAUX: PortPiecesTravail = {
  async visibles(userId, nodeIds) {
    const ids = [...new Set(nodeIds)].slice(0, 20);
    if (ids.length === 0) return [];
    const noeuds = await prisma.driveNode.findMany({ where: { id: { in: ids }, isTrashed: false }, select: { id: true, name: true } });
    const out: PieceTravail[] = [];
    for (const n of noeuds) if ((await droitsSurDocument(userId, n.id)).voir) out.push({ nodeId: n.id, nom: n.name });
    return out;
  },

  async partager(nodeIds, userId, parId) {
    const ids = [...new Set(nodeIds)];
    if (ids.length === 0) return;
    const noeuds = await prisma.driveNode.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, ownerId: true } });
    const cibles = noeuds.filter((n) => n.ownerId !== userId);
    if (cibles.length === 0) return;
    await prisma.driveShare.createMany({ data: cibles.map((n) => ({ nodeId: n.id, userId, access: "VIEW" as const })), skipDuplicates: true });
    const nom = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? userId;
    await recordAudit({
      actorId: parId, action: "UPDATE", module: "Assistant IA — travaux", field: "Partage d'une demande",
      newValue: cibles.map((n) => n.name).join(", ").slice(0, 500),
      summary: `Pièce(s) partagée(s) en lecture avec ${nom} par une demande de travail : ${cibles.map((n) => n.name).join(", ")}`.slice(0, 500),
    });
  },
};

/** Le N+1 d'un compte (organigramme) — l'escalade d'une attente. `null` = aucun responsable connu. */
export async function responsableDe(userId: string): Promise<string | null> {
  const m = await getManagerOfUser(userId).catch(() => null);
  return m?.userId && m.userId !== userId ? m.userId : null;
}
