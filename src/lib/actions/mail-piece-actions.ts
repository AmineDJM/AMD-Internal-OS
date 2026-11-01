"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { canAccessEntity } from "@/lib/entity-access";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { attachFormFiles } from "@/lib/documents";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * LES PIÈCES D'UN COURRIER, CHACUNE AVEC SON DESTINATAIRE.
 *
 * Un pli porte souvent plusieurs pièces qui ne vont pas au même endroit : le contrat signé pour le
 * fournisseur, la copie pour les finances, l'attestation pour l'ANPP. Avec un destinataire unique
 * au niveau du courrier, il fallait créer trois courriers pour un seul envoi — et la trace de ce
 * qui est parti à qui se perdait.
 *
 * Une pièce vient SOIT d'un téléversement, SOIT du Drive — où elle n'est PAS recopiée, seulement
 * référencée. Deux copies auraient divergé dès la première correction.
 */

const path = (entryId: string) => `/courriers/${entryId}`;

/** Le pli est-il dans le périmètre de cette personne, avec le droit demandé ? */
async function guard(entryId: string, action: "UPDATE" | "DELETE") {
  const user = await requireUser();
  if (!userCan(user, "MAIL_REGISTER", action)) return { ok: false as const, error: "Non autorisé." };
  if (!entryId) return { ok: false as const, error: "Courrier introuvable." };
  if (!(await canAccessEntity(user, "MAIL_ENTRY", entryId, action))) {
    return { ok: false as const, error: "Ce courrier n'est pas dans votre périmètre." };
  }
  return { ok: true as const, user };
}

/**
 * Ajoute une pièce : un fichier téléversé, ou un nœud du Drive référencé.
 *
 * Le droit de LIRE le fichier du Drive est revérifié ici : sans ce contrôle, référencer un nœud
 * dont on devine l'identifiant exposerait son contenu à tous les lecteurs du courrier.
 */
export async function addMailPiece(formData: FormData): Promise<ActionResult> {
  return gesteReversible(await requireUser(), { capaciteId: "mail-piece-actions:addMailPiece", libelle: "Pièce ajoutée au courrier" }, async () => {
    const entryId = fdStr(formData, "entryId") ?? "";
    const g = await guard(entryId, "UPDATE");
    if (!g.ok) return g;
    const { user } = g;

    const recipient = fdStr(formData, "recipient");
    const notes = fdStr(formData, "notes");
    const driveNodeId = fdStr(formData, "driveNodeId");
    let label = fdStr(formData, "label") ?? "";

    if (driveNodeId) {
      const node = await prisma.driveNode.findUnique({ where: { id: driveNodeId }, select: { name: true, isTrashed: true } });
      if (!node || node.isTrashed) return { ok: false, error: "Ce fichier n'existe plus dans le Drive." };
      if (!canViewDrive(await resolveDriveAccess(user, driveNodeId))) {
        return { ok: false, error: "Vous n'avez pas accès à ce fichier du Drive." };
      }
      if (!label) label = node.name;
      await prisma.mailEntryPiece.create({
        data: { entryId, label, recipient, notes, driveNodeId, createdById: user.id },
      });
    } else {
      // Un téléversement passe par le circuit commun : même stockage, même contrôle, même
      // réplication dans le Drive de celui qui importe. `attachFormFiles` ne rend que des
      // COMPTEURS — on relève donc les identifiants existants avant, pour reconnaître exactement
      // les nouveaux ensuite. Comparer par différence est sûr là où « les N derniers créés »
      // attraperait le téléversement simultané d'un collègue.
      const before = new Set(
        (await prisma.document.findMany({ where: { entityType: "MAIL_ENTRY", entityId: entryId }, select: { id: true } })).map((d) => d.id),
      );
      const res = await attachFormFiles(user.id, "MAIL_ENTRY", entryId, formData);
      if (res.attached === 0) {
        const why = res.failed[0]?.error;
        return { ok: false, error: why ?? "Joignez un fichier, ou désignez une pièce du Drive." };
      }
      const added = (await prisma.document.findMany({
        where: { entityType: "MAIL_ENTRY", entityId: entryId },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      })).filter((d) => !before.has(d.id));

      for (const d of added) {
        // Le libellé saisi ne vaut que pour un envoi d'UN fichier : sur un lot, chaque pièce garde
        // son propre nom, sans quoi trois lignes s'appelleraient toutes pareil.
        await prisma.mailEntryPiece.create({
          data: {
            entryId, label: added.length === 1 ? (label || d.name) : d.name,
            recipient, notes, documentId: d.id, createdById: user.id,
          },
        });
      }
      if (added.length > 1) label = `${added.length} pièces`;
      else if (added.length === 1) label = label || added[0].name;
    }

    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Courriers", entityType: "MAIL_ENTRY", entityId: entryId,
      // Le NOM du destinataire est la donnée utile : « qui a reçu quoi » est exactement la question
      // qu'on pose à ce registre six mois plus tard.
      summary: `Pièce « ${label} » ajoutée${recipient ? ` — destinataire : ${recipient}` : " (sans destinataire)"}`,
    });
    revalidatePath(path(entryId));
    return { ok: true };
  });
}

/** Corrige le libellé, le destinataire ou la note d'une pièce. */
export async function updateMailPiece(formData: FormData): Promise<ActionResult> {
  return gesteReversible(await requireUser(), { capaciteId: "mail-piece-actions:updateMailPiece", libelle: "Pièce du courrier corrigée" }, async () => {
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Pièce introuvable." };
    const piece = await prisma.mailEntryPiece.findUnique({ where: { id }, select: { entryId: true, label: true } });
    if (!piece) return { ok: false, error: "Pièce introuvable." };
    const g = await guard(piece.entryId, "UPDATE");
    if (!g.ok) return g;

    const label = fdStr(formData, "label") || piece.label;
    const recipient = fdStr(formData, "recipient");
    await prisma.mailEntryPiece.update({
      where: { id },
      data: { label, recipient, ...(formData.has("notes") ? { notes: fdStr(formData, "notes") } : {}) },
    });
    await recordAudit({
      actorId: g.user.id, action: "UPDATE", module: "Courriers", entityType: "MAIL_ENTRY", entityId: piece.entryId,
      summary: `Pièce « ${piece.label}${label !== piece.label ? ` → ${label}` : ""} » corrigée${recipient ? ` — destinataire : ${recipient}` : ""}`,
    });
    revalidatePath(path(piece.entryId));
    return { ok: true };
  });
}

/**
 * Retire une pièce du courrier.
 *
 * Le FICHIER n'est pas supprimé : un téléversement reste dans les pièces jointes du pli (et dans
 * le Drive de celui qui l'a importé), une référence Drive n'a jamais été qu'un lien. On retire
 * l'affectation « cette pièce va à untel », pas le document.
 */
export async function deleteMailPiece(formData: FormData): Promise<ActionResult> {
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Pièce introuvable." };
  const piece = await prisma.mailEntryPiece.findUnique({ where: { id }, select: { entryId: true, label: true } });
  if (!piece) return { ok: false, error: "Pièce introuvable." };
  const g = await guard(piece.entryId, "UPDATE");
  if (!g.ok) return g;

  await prisma.mailEntryPiece.delete({ where: { id } });
  await recordAudit({
    actorId: g.user.id, action: "UPDATE", module: "Courriers", entityType: "MAIL_ENTRY", entityId: piece.entryId,
    summary: `Pièce « ${piece.label} » retirée du courrier (le fichier est conservé)`,
  });
  revalidatePath(path(piece.entryId));
  return { ok: true };
}
