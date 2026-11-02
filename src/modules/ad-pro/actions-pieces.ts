"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { deleteFileByKey } from "@/lib/storage";
import { entityHref } from "@/lib/entity-href";
import type { ApercuSuppression } from "@/lib/admin-delete-registry";
import { supprimerReversible, type DeleteResult } from "@/lib/suppression/coeur";
import { verdictSuppressionFichier, verdictSuppressionPiece } from "@/lib/queries/pieces-demande-droits";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UNE PIÈCE LEGAL, OU L'UN DE SES FICHIERS, DEPUIS LA DEMANDE AD & PRO (§118.209).
 *
 * « On doit pouvoir supprimer les documents dans les demandes Ad & Pro » (Direction, 05/10). Le bloc des
 * pièces de la demande les montrait en lecture seule — « la gestion se fait dans Legal ».
 *
 * Trois propriétés, et chacune a son cas :
 *   • RÉVERSIBLE — la pièce part par le cœur de la suppression (`supprimerReversible`, §118.162) : corbeille
 *     du Super Admin, journal, instantané de ses fichiers et de ses commentaires. Un devis effacé par erreur
 *     se récupère. Un FICHIER, lui, se supprime comme dans Legal (`deleteDocument`) : le document et son
 *     fichier disparaissent, et la fenêtre le dit.
 *   • JAMAIS PLUS LARGE QUE LA FICHE LEGAL (§118.109) — la personne peut MODIFIER la demande ET gérer la
 *     pièce, par la règle même de `deleteOwnRecord` ; le verdict est UN (`verdictSuppressionPiece`), lu par
 *     l'écran pour poser le bouton, par l'aperçu et par l'action : un bouton offert que l'action refuse
 *     fait chercher une panne qui n'existe pas (§118.83).
 *   • JAMAIS CE QUI ENGAGE — une pièce signée, réglée, partie au règlement, validée par un centre ou base
 *     d'une autre pièce ne se supprime pas d'ici (`legal/suppression-piece`), et le refus nomme le geste
 *     qui reste. Ce refus vit AUSSI chez l'écrivain (`DELETE_REGISTRY.LEGAL_DOCUMENT.refuse`) : la corbeille
 *     et la fiche Legal ne peuvent pas défaire ce que cet écran protège (§118.106).
 *
 * Ce sont des gestes d'écran (action-parity : EXCLUDED) : supprimer une pièce commerciale se fait devant
 * l'aperçu de ce qui part, et la supprimer n'est pas la rendre invisible mais la retirer du registre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ResultatFichier {
  ok: boolean;
  error?: string;
}

/** Supprime une pièce Legal rattachée à une demande Ad & Pro — réversible (corbeille). */
export async function supprimerPieceDeLaDemande(formData: FormData): Promise<DeleteResult> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "Pièce introuvable." };
  const v = await verdictSuppressionPiece(user, id);
  if (!v.ok) return { ok: false, error: v.error };
  const r = await supprimerReversible(
    "LEGAL_DOCUMENT", v.piece.id, user.id,
    `Pièce « ${v.piece.titre} » supprimée depuis sa demande Ad & Pro (restaurable depuis la corbeille)`,
  );
  if (r.ok) {
    const adresse = entityHref(v.demande.type, v.demande.id);
    if (adresse) revalidatePath(adresse);
    revalidatePath("/legal");
  }
  return r;
}

/**
 * CE QUE LA SUPPRESSION EMPORTERA — lu par la fenêtre de confirmation AVANT le clic (§118.53). La même
 * porte que l'action : un aperçu plus large dirait à quelqu'un ce qui dépend d'une pièce qu'il ne peut
 * pas toucher ; plus étroit, le bouton ne s'armerait pas devant une suppression que l'action accepte.
 */
export async function apercuSuppressionPieceDeLaDemande(formData: FormData): Promise<ApercuSuppression | { erreur: string }> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return { erreur: "Pièce introuvable." };
  const v = await verdictSuppressionPiece(user, id);
  if (!v.ok) return { erreur: v.error };
  const [fichiers, commentaires, lecteurs] = await Promise.all([
    prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: id } }),
    prisma.comment.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: id } }),
    prisma.legalDocumentReader.count({ where: { documentId: id } }),
  ]);
  const pl = (n: number, un: string, des: string) => `${n} ${n > 1 ? des : un}`;
  const emporte: string[] = [];
  if (fichiers > 0) emporte.push(pl(fichiers, "fichier joint à la pièce", "fichiers joints à la pièce"));
  if (commentaires > 0) emporte.push(pl(commentaires, "commentaire", "commentaires"));
  // Ce que la restauration ne rend pas se DIT dans la ligne : « tout revient » serait faux pour cette liste.
  if (lecteurs > 0) emporte.push(`${pl(lecteurs, "lecteur désigné", "lecteurs désignés")} (à redésigner si la pièce est restaurée)`);
  return { nom: v.piece.titre, emporte, detache: [], refus: null, lot: true };
}

/**
 * Supprime UN fichier d'une pièce Legal depuis la demande — la même suppression que sur la fiche Legal
 * (`deleteDocument` : le document et son fichier), sous le verdict de la demande : la personne la
 * modifie, gère la pièce, et la pièce n'est pas engagée. Signature positionnelle comme `deleteDocument` :
 * la liste de documents (`DocumentList`) appelle l'une ou l'autre sans rien changer de son côté.
 */
export async function supprimerFichierDePieceDeLaDemande(id: string, path?: string): Promise<ResultatFichier> {
  const user = await requireUser();
  const v = await verdictSuppressionFichier(user, id);
  if (!v.ok) return { ok: false, error: v.error };
  const doc = await prisma.document.findUnique({ where: { id }, select: { id: true, name: true, fileKey: true, entityType: true, entityId: true } });
  if (!doc) return { ok: false, error: "Document introuvable." };

  await prisma.document.delete({ where: { id } });
  if (doc.fileKey) await deleteFileByKey(doc.fileKey);
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Legal", entityType: doc.entityType, entityId: doc.entityId,
    summary: `Document « ${doc.name} » supprimé depuis sa demande Ad & Pro`,
  });
  const adresse = entityHref(v.demande.type, v.demande.id);
  if (adresse) revalidatePath(adresse);
  revalidatePath(v.chemin);
  if (path) revalidatePath(path);
  return { ok: true };
}
