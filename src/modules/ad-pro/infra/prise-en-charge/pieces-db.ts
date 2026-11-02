import type { CareCellStatus, EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteFileByKey } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { validateAttachments } from "@/lib/attach-files";
import { persistUploadedDocument } from "@/lib/documents";
import { etatApresRetrait, principalApresDepot } from "../../domaine/prise-en-charge/pieces";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHIERS D'UNE PIÈCE DE PRISE EN CHARGE — les écritures (voir `lib/care-pieces` pour la règle).
 *
 * Hors du fichier d'actions (§118.150 g, comme `ad-pro/fil.ts`) : déposer ou retirer touche DEUX
 * modèles (le `Document` et la case) ; écrit ici, l'`id` de l'action garde son modèle.
 * Les gardes (qui, quelle demande, quel état) restent dans l'action : ce module n'en décide rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface CasePiece { id: string; label: string; status: CareCellStatus; documentId: string | null }
interface Cible { entityType: EntityType; entityId: string }

/** L'état de la case a bougé pendant l'écriture (validée, sans objet) : rien n'est retiré. */
class EtatChange extends Error {}

/**
 * DÉPOSER UN OU PLUSIEURS FICHIERS SUR UNE PIÈCE — recto, verso, pages, visa : tout en un geste.
 *
 * Tout le lot est contrôlé AVANT d'écrire (type, vide, taille — les limites des réglages) : un refus dit
 * chaque fichier fautif et rien n'est enregistré. Puis chaque fichier devient un `Document` de la demande
 * désigné par la case ; la case passe « reçue » (son principal reste le sien s'il existe encore).
 */
export async function deposerFichiersSurLaPiece(
  userId: string, cell: CasePiece, cible: Cible, brut: File[],
): Promise<{ ok: true; ids: string[]; echecs: string[] } | { ok: false; error: string }> {
  const refus = await validateAttachments(brut);
  if (refus) return { ok: false, error: refus };
  // Un champ fichier laissé vide envoie un fichier sans octet ni vrai nom : ce n'est pas une pièce.
  const fichiers = brut.filter((f) => f.size > 0);
  if (fichiers.length === 0) return { ok: false, error: "Aucun fichier sélectionné." };

  const maxUploadMb = (await getAppSettings()).maxUploadMb;
  const ids: string[] = [];
  const echecs: string[] = [];
  for (const file of fichiers) {
    const r = await persistUploadedDocument(userId, {
      ...cible, category: "ID_DOCUMENT", confidentiality: "INTERNAL", stepKey: cell.id, file, maxUploadMb,
    });
    if (r.ok && r.documentId) ids.push(r.documentId);
    else echecs.push(`« ${file.name} » : ${r.error ?? "non enregistré"}`);
  }
  if (ids.length === 0) return { ok: false, error: echecs.join(" ") || "Le fichier n'a pas pu être enregistré." };

  const actuelExiste = cell.documentId ? (await prisma.document.count({ where: { id: cell.documentId } })) > 0 : false;
  const pose = await prisma.careCell.updateMany({
    where: { id: cell.id, status: { in: ["REQUESTED", "PROVIDED"] } },
    data: { status: "PROVIDED", documentId: principalApresDepot(cell.documentId, actuelExiste, ids) },
  });
  if (pose.count === 0) {
    // L'état a changé entre-temps (validée, sans objet) : les fichiers ne restent pas orphelins.
    const docs = await prisma.document.findMany({ where: { id: { in: ids } }, select: { fileKey: true } });
    await prisma.document.deleteMany({ where: { id: { in: ids } } }).catch(sansBloquer("care-pieces-db.deposerFichiersSurLaPiece.document"));
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(sansBloquer("care-pieces-db.deposerFichiersSurLaPiece.deleteFileByKey"));
    return { ok: false, error: `L'état de « ${cell.label} » vient de changer : rechargez la fiche.` };
  }
  return { ok: true, ids, echecs };
}

/**
 * RETIRER UN FICHIER D'UNE PIÈCE. Le dernier retiré, la pièce redevient ATTENDUE (le statut « passeport
 * manquant » revient) ; sinon elle reste reçue, et son principal passe au plus ancien restant si c'était lui.
 */
export async function retirerFichierDeLaPiece(
  cell: CasePiece, documentId: string, cible: Cible,
): Promise<{ ok: true; restants: number } | { ok: false; error: string }> {
  let fileKey: string | null = null;
  let restants = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const autres = await tx.document.findMany({
        where: { ...cible, stepKey: cell.id, id: { not: documentId } }, select: { id: true }, orderBy: { createdAt: "asc" },
      });
      const ids = autres.map((d) => d.id);
      // Un principal d'avant, rangé ailleurs que sous la case, compte encore s'il existe.
      if (cell.documentId && cell.documentId !== documentId && !ids.includes(cell.documentId)
        && (await tx.document.count({ where: { id: cell.documentId } })) > 0) ids.unshift(cell.documentId);
      restants = ids.length;
      const maj = await tx.careCell.updateMany({
        where: { id: cell.id, status: { in: ["REQUESTED", "PROVIDED"] } },
        data: etatApresRetrait(cell, documentId, ids),
      });
      if (maj.count === 0) throw new EtatChange();
      fileKey = (await tx.document.delete({ where: { id: documentId }, select: { fileKey: true } })).fileKey;
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: `L'état de « ${cell.label} » vient de changer : rechargez la fiche.` };
    throw e;
  }
  if (fileKey) await deleteFileByKey(fileKey).catch(sansBloquer("care-pieces-db.retirerFichierDeLaPiece.deleteFileByKey"));
  return { ok: true, restants };
}
