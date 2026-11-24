import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import { deleteFileByKey } from "@/lib/storage";
import { sansBloquer } from "@/lib/journal";
import type { LigneVersionDocument } from "@/lib/document-versions-partage";
import { inscrireDocumentExistant } from "@/modules/bibliotheque/api-inscription";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VERSIONS D'UN DOCUMENT (hors Drive) — audit du Drive, 24/11, point A4.
 *
 * L'éditeur Office et l'éditeur de texte réécrivaient la MÊME clé de stockage (`saveFile(doc.fileKey)`) : l'ancien
 * contenu était libéré à l'instant, le numéro de version montait, et rien ne permettait de revenir en arrière. Une
 * mauvaise manipulation dans l'éditeur effaçait le contrat d'origine.
 *
 * LA RÈGLE : chaque enregistrement écrit une NOUVELLE clé (`StoredFile`) et une ligne `DocumentVersion` ; la clé
 * précédente reste, lisible depuis le petit « Versions » de la fiche. Rien n'est rendu avant la destruction RÉELLE
 * (corbeille du Super Admin, `libererVersionsDocuments`).
 *
 * Le numéro se prend SOUS VERROU (pg_advisory_xact_lock sur le document) : deux rappels simultanés de l'éditeur
 * font deux versions, l'une après l'autre, jamais une P2002 avec un blob compté pour rien.
 *
 * Les documents d'avant n'ont aucune ligne : la première réécriture inscrit d'abord la version qu'elle remplace
 * (sa clé, sa taille, son déposant) — l'historique commence là, sans reprise de masse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatVersionDocument =
  | { ok: true; version: number; taille: number }
  | { ok: false; raison: "introuvable" | "conflit" };

export async function enregistrerVersionDocument(
  documentId: string,
  octets: Buffer,
  userId: string,
  options: {
    /** Statut 6 de l'éditeur Office : la session continue, sa clé d'édition ne change pas. */
    forcesave?: boolean;
    /** Comparer et échanger : la version que la personne a LUE — une autre écriture entre-temps rend « conflit ». */
    versionLue?: number;
  } = {},
): Promise<ResultatVersionDocument> {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { entityType: true, entityId: true, name: true } });
  if (!doc) return { ok: false, raison: "introuvable" };
  const { blobId, size } = await putBlob(octets);
  const key = `${doc.entityType}/${doc.entityId}/${randomUUID()}__${doc.name}`;
  let r: ResultatVersionDocument;
  try {
    r = await prisma.$transaction(async (tx): Promise<ResultatVersionDocument> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('document-version'), hashtext(${documentId}))`;
      const cur = await tx.document.findUnique({
        where: { id: documentId },
        select: { version: true, fileKey: true, sizeBytes: true, uploadedById: true, updatedAt: true },
      });
      if (!cur) return { ok: false, raison: "introuvable" };
      if (options.versionLue !== undefined && cur.version !== options.versionLue) return { ok: false, raison: "conflit" };
      await tx.storedFile.create({ data: { key, blobId, size } });
      // La version qu'on remplace, inscrite si elle ne l'est pas encore (document d'avant les versions).
      if (cur.fileKey) {
        await tx.documentVersion.createMany({
          data: [{ documentId, version: cur.version, fileKey: cur.fileKey, size: cur.sizeBytes, createdById: cur.uploadedById, createdAt: cur.updatedAt }],
          skipDuplicates: true,
        });
      }
      const version = cur.version + 1;
      await tx.documentVersion.create({ data: { documentId, version, fileKey: key, size, createdById: userId, forcesave: options.forcesave ?? false } });
      await tx.document.update({ where: { id: documentId }, data: { fileKey: key, sizeBytes: size, version } });
      return { ok: true, version, taille: size };
    });
  } catch (e) {
    // Rien n'est écrit (la transaction a tout annulé) : le blob compté pour cet enregistrement se rend.
    await releaseBlob(blobId).catch(sansBloquer("document-versions.enregistrer.releaseBlob"));
    throw e;
  }
  if (!r.ok) {
    await releaseBlob(blobId).catch(sansBloquer("document-versions.enregistrer.releaseBlob"));
    return r;
  }
  // La nouvelle version entre à la bibliothèque (J1), sous la clé du document ; l'ancienne reste lisible par
  // « Versions ». Ne lève jamais.
  await inscrireDocumentExistant(documentId, userId);
  return r;
}

/** Les versions d'un document, la plus récente d'abord. Un document jamais réécrit en a une : celle d'aujourd'hui. */
export async function listerVersionsDocument(documentId: string): Promise<LigneVersionDocument[]> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { version: true, fileKey: true, sizeBytes: true, updatedAt: true, uploadedBy: { select: { name: true } } },
  });
  if (!doc) return [];
  const lignes = await prisma.documentVersion.findMany({ where: { documentId }, orderBy: { version: "desc" } });
  const ids = [...new Set(lignes.map((l) => l.createdById).filter((x): x is string => Boolean(x)))];
  const noms = new Map((ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  const out: LigneVersionDocument[] = lignes.map((l) => ({
    version: l.version,
    taille: l.size,
    auteur: l.createdById ? noms.get(l.createdById) ?? null : null,
    date: l.createdAt.toISOString(),
    courante: l.fileKey === doc.fileKey,
    forcee: l.forcesave,
  }));
  if (!out.some((l) => l.courante) && doc.fileKey) {
    // Remplacé hors des éditeurs (ou jamais réécrit) : la version d'aujourd'hui n'a pas de ligne, on la montre quand même.
    out.unshift({ version: doc.version, taille: doc.sizeBytes, auteur: doc.uploadedBy?.name ?? null, date: doc.updatedAt.toISOString(), courante: true, forcee: false });
  }
  return out;
}

/** La clé de stockage d'une version précise d'un document, ou `null`. */
export async function cleDeVersionDocument(documentId: string, version: number): Promise<string | null> {
  const l = await prisma.documentVersion.findUnique({ where: { documentId_version: { documentId, version } }, select: { fileKey: true } });
  return l?.fileKey ?? null;
}

/**
 * LA DESTRUCTION RÉELLE rend les clés des versions — et seulement elle (corbeille du Super Admin, suppression
 * définitive de l'administration des bases). Une clé encore montrée par un document vivant n'est pas rendue.
 */
export async function libererVersionsDocuments(documentIds: readonly string[]): Promise<void> {
  if (documentIds.length === 0) return;
  const lignes = await prisma.documentVersion.findMany({ where: { documentId: { in: [...documentIds] } }, select: { id: true, fileKey: true } });
  if (lignes.length === 0) return;
  const cles = [...new Set(lignes.map((l) => l.fileKey))];
  const vivantes = new Set((await prisma.document.findMany({ where: { fileKey: { in: cles } }, select: { fileKey: true } })).map((d) => d.fileKey));
  await prisma.documentVersion.deleteMany({ where: { id: { in: lignes.map((l) => l.id) } } });
  for (const k of cles) {
    if (!vivantes.has(k)) await deleteFileByKey(k).catch(sansBloquer("document-versions.liberer.deleteFileByKey"));
  }
}
