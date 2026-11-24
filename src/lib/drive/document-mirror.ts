import type { Confidentiality } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ENTITIES } from "@/lib/api/registry/entities";
import { ensureDrivePath, putDriveFile } from "./mirror";
import { shouldMirrorToDrive, importFolderPath, IMPORT_DRIVE_ROOT } from "./mirror-path";

/**
 * TOUT CE QUI ENTRE DANS L'ERP ENTRE AUSSI DANS LE DRIVE.
 *
 * Une pièce importée depuis un sponsoring, un appel d'offres, une demande RH restait accrochée à
 * son objet métier. Six semaines plus tard on la cherche « dans le Drive » — parce que c'est là
 * qu'on cherche les fichiers — et elle n'y est pas. Chaque téléversement dépose donc désormais une
 * copie dans le Drive de celui qui importe, rangée par module puis par objet.
 *
 * **Dans SON drive, à lui — et jamais une pièce sensible.** La copie se lit par la portée ALL du Drive et survit aux
 * droits de l'objet : elle CRÉE un accès. Seules les pièces INTERNES des objets d'entreprise sont copiées
 * (`COPIE_AU_DRIVE`, audit Drive du 24/11, F2), et la copie part à la corbeille quand la pièce est supprimée
 * (`retirerCopiesDrive`).
 *
 * **Best-effort, toujours** : le document est déjà enregistré côté métier quand on arrive ici. Une
 * erreur de miroir est journalisée et avalée — jamais un téléversement perdu pour une copie ratée.
 */

/** Le champ « référence » de cet objet, d'après le registre : « SPO-2026-014 », « AO-12 »… */
function referenceFieldFor(entityType: string): { model: string; field: string } | null {
  const def = ENTITIES.find((e) => e.entityType === entityType && e.referenceField);
  if (!def) return null;
  return { model: def.model.charAt(0).toLowerCase() + def.model.slice(1), field: def.referenceField! };
}

/** La référence lisible de l'objet, quand l'ERP en connaît une. Silencieux en cas d'échec. */
async function resolveReference(entityType: string, entityId: string): Promise<string | null> {
  const target = referenceFieldFor(entityType);
  if (!target) return null;
  try {
    const delegate = (prisma as any)[target.model];
    if (!delegate?.findUnique) return null;
    const row = await delegate.findUnique({ where: { id: entityId }, select: { [target.field]: true } });
    const value = row?.[target.field];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export interface MirrorFile {
  name: string;
  data: Buffer;
  mime?: string | null;
}

/**
 * Réplique dans le Drive les fichiers qui viennent d'être téléversés sur un objet métier.
 * À appeler SANS `await` bloquant depuis une route : la copie se termine côté serveur pendant que
 * l'utilisateur enchaîne (`void mirrorDocumentsToDrive(...).catch(...)`).
 */
export async function mirrorDocumentsToDrive(opts: {
  ownerId: string;
  entityType: string;
  entityId: string;
  /** Exigé : c'est lui, avec le type d'objet, qui décide s'il peut y avoir une copie. */
  confidentiality: Confidentiality;
  files: readonly MirrorFile[];
}): Promise<void> {
  if (opts.files.length === 0 || !shouldMirrorToDrive(opts.entityType, opts.confidentiality)) return;
  try {
    const reference = await resolveReference(opts.entityType, opts.entityId);
    const folderId = await ensureDrivePath(importFolderPath(opts.entityType, reference, opts.entityId), opts.ownerId);
    if (!folderId) return;
    for (const f of opts.files) {
      try {
        await putDriveFile({ parentId: folderId, name: f.name, data: f.data, mimeType: f.mime, ownerId: opts.ownerId });
      } catch (err) {
        console.error("[drive mirror] fichier ignoré", f.name, err);
      }
    }
  } catch (err) {
    console.error("[drive mirror] miroir Drive échoué (non bloquant)", err);
  }
}

/**
 * LA COPIE SUIT LA PIÈCE À LA CORBEILLE (F2) : une pièce supprimée de son objet ne doit pas rester lisible dans
 * « Mes documents importés ». La copie se reconnaît sans lien en base : même déposant, même contenu (le blob est
 * dédupliqué par empreinte), rangée sous la boîte d'import et le dossier du module. Corbeille et non effacement :
 * son propriétaire peut la restaurer. Rien n'est touché si une autre pièce du même déposant porte encore ce contenu.
 * À appeler AVANT de libérer le fichier (la correspondance clé → blob y est lue). Ne lève jamais.
 */
export async function retirerCopiesDrive(doc: { id: string; uploadedById: string | null; entityType: string; fileKey: string | null }): Promise<number> {
  if (!doc.fileKey || !doc.uploadedById) return 0;
  try {
    const stocke = await prisma.storedFile.findUnique({ where: { key: doc.fileKey }, select: { blobId: true } });
    if (!stocke) return 0;
    const memesOctets = await prisma.storedFile.findMany({ where: { blobId: stocke.blobId, key: { not: doc.fileKey } }, select: { key: true } });
    if (memesOctets.length > 0 && (await prisma.document.count({
      where: { id: { not: doc.id }, uploadedById: doc.uploadedById, fileKey: { in: memesOctets.map((m) => m.key) } },
    })) > 0) return 0;
    const module = importFolderPath(doc.entityType, null, doc.id)[1];
    const r = await prisma.driveNode.updateMany({
      where: {
        type: "FILE", ownerId: doc.uploadedById, spaceId: null, isTrashed: false,
        versions: { some: { blobId: stocke.blobId } },
        parent: { parent: { name: module, parent: { name: IMPORT_DRIVE_ROOT, parentId: null, ownerId: doc.uploadedById } } },
      },
      data: { isTrashed: true },
    });
    return r.count;
  } catch (err) {
    console.error("[drive mirror] copie non retirée (non bloquant)", doc.id, err);
    return 0;
  }
}
