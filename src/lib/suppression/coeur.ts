import { revalidatePath } from "next/cache";
import type { DeletedRecord, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { DELETE_REGISTRY, deleteDelegateOf, modeleDuRegistre, refusDuLot, type DeletableKind } from "@/lib/admin-delete-registry";
import { dejaPresents, instantaneTete, inventorier, restaurerLot, supprimerLot, type InstantaneLot } from "./lot";
import { sansBloquer } from "@/lib/journal";


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CŒUR DE LA SUPPRESSION RÉVERSIBLE — hors du fichier d'actions, et c'est voulu (§118.162).
 *
 * Il vivait dans `admin-delete-actions.ts`, donc derrière le Super Admin et nulle part ailleurs.
 * Le module Événements, lui, supprimait un événement par son propre chemin : `prisma.event.delete`,
 * sans instantané, sans audit, sans corbeille — et sans rien savoir de ses branches. Deux chemins
 * pour le même geste, dont un irréversible, ouvert à quatre rôles (§118.5, §118.71).
 *
 * Il ne peut pas vivre dans un fichier `"use server"` : tout ce qu'un tel fichier exporte devient
 * un point d'entrée public, et une fonction qui prend un TYPE et un IDENTIFIANT sans vérifier qui
 * appelle serait une porte ouverte sur les trente types du registre. Ici, il n'est appelé QUE par
 * des actions qui ont vérifié le droit — `superAdminDelete`, `deleteOwnRecord`, `deleteEvent`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DeleteResult {
  ok: boolean;
  error?: string;
  redirect?: string;
}

/**
 * SUPPRIME, de façon réversible. L'appelant a vérifié le DROIT ; ce cœur vérifie le RESTE — ce que
 * le type refuse, ce qui a quitté l'ERP, ce qui dépend encore de l'élément.
 */
export async function supprimerReversible(kind: DeletableKind, id: string, actorId: string, summary: string): Promise<DeleteResult> {
  const spec = DELETE_REGISTRY[kind];

  // 0) CE QUE CE TYPE REFUSE, avant tout instantané : le refus porte sa raison et le geste qui
  //    reste. Sans cette porte, un refus légitime sortait soit en « introuvable » (faux : l'objet
  //    est là), soit en « des éléments liés bloquent » (faux : rien ne se détache).
  if (spec.refuse) {
    const motif = await spec.refuse(id);
    if (motif) return { ok: false, error: motif };
  }

  const name = await spec.describe(id);
  if (name === null) return { ok: false, error: "Élément introuvable (déjà supprimé ?)." };

  if (spec.lot) return supprimerAvecBranches(kind, id, actorId, summary, name);

  // 1) Instantané de la ligne principale (tous les champs scalaires/Json).
  const payload = await deleteDelegateOf(spec).findUnique({ where: { id } });
  if (!payload) return { ok: false, error: "Élément introuvable (déjà supprimé ?)." };

  // 2) Instantané puis retrait des Documents/Commentaires polymorphes. Les FICHIERS
  //    restent dans le stockage : ils ne sont effacés qu'à la destruction réelle.
  let docsSnapshot: Record<string, unknown>[] = [];
  let commentsSnapshot: Record<string, unknown>[] = [];
  if (spec.entityType) {
    docsSnapshot = (await prisma.document.findMany({ where: { entityType: spec.entityType, entityId: id } })) as unknown as Record<string, unknown>[];
    commentsSnapshot = (await prisma.comment.findMany({ where: { entityType: spec.entityType, entityId: id } })) as unknown as Record<string, unknown>[];
    await prisma.document.deleteMany({ where: { entityType: spec.entityType, entityId: id } });
    await prisma.comment.deleteMany({ where: { entityType: spec.entityType, entityId: id } });
  }

  // 3) Suppression de la ligne principale (les enfants en cascade suivent).
  try {
    await spec.remove(id);
  } catch (err) {
    console.error("[softDelete] échec suppression", kind, id, err);
    // Remet les documents/commentaires retirés à l'étape 2 (la ligne principale existe encore).
    if (spec.entityType) {
      if (docsSnapshot.length) await prisma.document.createMany({ data: docsSnapshot as never[] }).catch(sansBloquer("suppression-coeur.supprimerReversible.document"));
      if (commentsSnapshot.length) await prisma.comment.createMany({ data: commentsSnapshot as never[] }).catch(sansBloquer("suppression-coeur.supprimerReversible.comment"));
    }
    return { ok: false, error: "Suppression impossible (des éléments liés bloquent). Détachez-les puis réessayez." };
  }

  // 4) Dépôt dans la corbeille (restaurable par le Super Admin).
  await prisma.deletedRecord.create({
    data: {
      kind, label: spec.label, name, sourceId: id,
      payload: payload as Prisma.InputJsonValue,
      documents: docsSnapshot.length ? (docsSnapshot as Prisma.InputJsonValue) : undefined,
      comments: commentsSnapshot.length ? (commentsSnapshot as Prisma.InputJsonValue) : undefined,
      deletedById: actorId,
    },
  });

  await recordAudit({
    actorId, action: "DELETE", module: spec.module, entityType: spec.entityType, entityId: id, summary,
  });

  revalidatePath(spec.redirect);
  return { ok: true, redirect: spec.redirect };
}

/**
 * LA DEMANDE ET SES BRANCHES — un lot, une transaction, une entrée de corbeille (§118.162).
 * Ce qui part est RE-LU au moment de supprimer : l'aperçu montré à la personne peut dater de
 * quelques minutes, la base, elle, a pu recevoir une déclaration ou un paiement depuis.
 */
async function supprimerAvecBranches(kind: DeletableKind, id: string, actorId: string, summary: string, name: string): Promise<DeleteResult> {
  const spec = DELETE_REGISTRY[kind];
  const inv = await inventorier(modeleDuRegistre(spec), id);
  if (!inv) return { ok: false, error: "Élément introuvable (déjà supprimé ?)." };
  if (inv.bloquants.length) return { ok: false, error: refusDuLot(inv.bloquants) };

  const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as Prisma.InputJsonValue;
  try {
    await supprimerLot(inv, async (tx, lot, tete) => {
      await tx.deletedRecord.create({
        data: {
          kind, label: spec.label, name, sourceId: id,
          payload: instantaneTete(tete) as Prisma.InputJsonValue,
          documents: inv.documents.length ? json(inv.documents) : undefined,
          comments: inv.commentaires.length ? json(inv.commentaires) : undefined,
          lot: lot as unknown as Prisma.InputJsonValue,
          deletedById: actorId,
        },
      });
    });
  } catch (err) {
    console.error("[softDelete] échec du lot", kind, id, err);
    // La transaction a TOUT annulé : rien n'est parti, et c'est ce qu'on dit.
    return { ok: false, error: "Suppression impossible : rien n'a été retiré. Un élément lié a refusé de partir — réessayez, ou signalez-le si cela se répète." };
  }

  await recordAudit({
    actorId, action: "DELETE", module: spec.module, entityType: spec.entityType, entityId: id,
    summary: inv.resume.length ? `${summary} — avec ${inv.resume.join(", ")}` : summary,
  });
  revalidatePath(spec.redirect);
  return { ok: true, redirect: spec.redirect };
}

/**
 * RESTAURE une entrée de la corbeille — la ligne principale, et, pour un lot, TOUTES ses
 * branches. Rend `null` quand l'entrée n'est pas un lot : l'appelant garde son chemin d'avant.
 */
export async function restaurerLotDeLaCorbeille(rec: DeletedRecord, kind: DeletableKind): Promise<DeleteResult | null> {
  const lot = rec.lot as unknown as InstantaneLot | null;
  if (!lot || lot.version !== 1) return null;
  const spec = DELETE_REGISTRY[kind];
  const modele = modeleDuRegistre(spec);
  if ((await dejaPresents(modele, rec.sourceId, lot)) > 0) {
    return { ok: false, error: "Des éléments de ce lot existent déjà (déjà restauré ?) — rien n'a été recréé." };
  }
  try {
    await restaurerLot(
      modele,
      rec.payload as Record<string, unknown>,
      lot,
      (rec.documents as Record<string, unknown>[] | null) ?? [],
      (rec.comments as Record<string, unknown>[] | null) ?? [],
    );
    await spec.restored?.(rec.sourceId);
  } catch (err) {
    console.error("[restoreDeletedRecord] échec du lot", rec.kind, rec.sourceId, err);
    return { ok: false, error: "Restauration impossible — rien n'a été recréé (un élément lié manque, ou une référence a été réutilisée depuis)." };
  }
  return { ok: true, redirect: spec.redirect };
}
