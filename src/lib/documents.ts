import { randomUUID } from "crypto";
import type { Confidentiality, DocumentCategory, EntityType } from "@prisma/client";
import { ENTITY_MODULE } from "@/lib/entity-access";
import { saveFile, deleteFileByKey, validateDocumentUpload } from "@/lib/storage";
import { sha256 } from "@/lib/drive-storage";
import { getAppSettings } from "@/lib/settings";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { mirrorDocumentsToDrive } from "@/lib/drive/document-mirror";
import { mirrorRegulatoryUpload } from "@/lib/regulatory-drive-mirror";
import { cheminSur, refusDepotCtd } from "@/lib/regulatory/ctd-initiale";
import { signalerDocumentDepose } from "@/lib/enrichissement/signalement";
import { inscrireDocument } from "@/modules/bibliotheque/api-inscription";
import { sansBloquer } from "@/lib/journal";

/**
 * Chemin de dossier SÛR : jamais de « .. », jamais de chemin absolu, séparateur « / », borné.
 * `null` quand il ne reste rien. Une pièce déposée seule n'a pas de dossier. UNE seule écriture,
 * au module pur de la CTD initiale : le navigateur choisit la destination avec la même règle.
 */
export const dossierSur = cheminSur;

export interface PersistDocInput {
  entityType: EntityType;
  entityId: string;
  category: DocumentCategory;
  confidentiality: Confidentiality;
  stepKey: string | null;
  /** Dossier d'origine quand on a déposé un DOSSIER (« Module 3/3.2.P ») : l'arborescence se garde. */
  folder?: string | null;
  file: File;
  /** Limite de taille (Mo) déjà résolue — évite de relire les réglages pour chaque fichier d'un lot. */
  maxUploadMb?: number;
  /** Contenu déjà lu (évite une 2ᵉ lecture quand l'appelant a besoin du binaire — ex. miroir Drive). */
  buffer?: Buffer;
  /**
   * Miroir Drive : `false` quand l'appelant s'en charge lui-même (route de lot, qui groupe les
   * fichiers d'un même envoi en une seule descente d'arborescence, ou miroir Regulatory par
   * produit). Par défaut le miroir part d'ici — un chemin de téléversement oublié serait un
   * fichier absent du Drive, et c'est précisément ce qu'on corrige.
   */
  mirrorToDrive?: boolean;
  /** Le dépôt vient du bloc « CTD initiale » d'un dossier Regulatory (§118.213) — voir `refusDepotCtd`. */
  ctd?: boolean;
}

/**
 * Enregistre un fichier téléversé comme **Document** : blob chiffré (dédupliqué),
 * métadonnées (catégorie, confidentialité, étape), versionnage par nom, audit.
 * Logique **partagée** par la route d'upload en lot (`/api/documents/upload`) et
 * l'action serveur historique (`uploadDocument`). Accepte tout type de fichier sauf
 * les exécutables (voir `validateDocumentUpload`).
 */
export async function persistUploadedDocument(
  userId: string,
  input: PersistDocInput,
): Promise<{ ok: boolean; error?: string; documentId?: string }> {
  const { entityType, entityId, category, confidentiality, stepKey, file } = input;
  const folder = dossierSur(input.folder);
  if (!file || file.size === 0) return { ok: false, error: "Fichier vide." };
  // UN DÉPÔT QUI VISE LA CTD INITIALE LE DIT (§118.213) — gardé ICI, là où passent tous les dépôts.
  const refusCtd = refusDepotCtd({ entityType, stepKey, category }, input.ctd === true);
  if (refusCtd) return { ok: false, error: refusCtd };

  const maxMb = input.maxUploadMb ?? (await getAppSettings()).maxUploadMb;
  const invalid = validateDocumentUpload(file.name, file.size, maxMb);
  if (invalid) return { ok: false, error: invalid };

  const key = `${entityType}/${entityId}/${randomUUID()}__${file.name}`;
  const content: Buffer = input.buffer ?? Buffer.from(await file.arrayBuffer());

  // UNE RELANCE N'EST PAS UNE VERSION 2 (audit du 04/10, constat 13). Une requête dont la réponse
  // s'est perdue en route est renvoyée par le navigateur ; le serveur, lui, avait bien enregistré
  // la première. Même pièce (même nom, mêmes octets), même personne, même fiche, il y a moins de
  // dix minutes : c'est le même dépôt, on rend la fiche existante.
  const deja = await depotIdentiqueRecent(userId, entityType, entityId, file.name, content, folder);
  if (deja) return { ok: true, documentId: deja };

  // PAS DE FICHE SANS FICHIER (audit du 04/10, constat 1). La version d'avant avalait l'échec
  // d'écriture, créait la fiche quand même et l'écran disait « téléversé » : la personne
  // découvrait des semaines plus tard un document « indisponible », l'original jeté entre-temps.
  // Un échec d'écriture est DIT, et rien n'est créé — renvoyer le fichier suffit.
  let ecrit: { blobId: string; sha256: string };
  try {
    ecrit = await saveFile(key, content);
  } catch (err) {
    console.error("[upload] écriture du fichier impossible — aucune fiche créée", err);
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `« ${file.name} » n'a pas pu être enregistré (${detail}). Aucun document n'a été créé : renvoyez le fichier.` };
  }

  // Versionnage : incrémente selon les documents existants de même nom sur l'entité.
  // Toute erreur d'écriture est CAPTURÉE et renvoyée telle quelle (jamais une 500 opaque) : le
  // widget de téléversement affiche alors la vraie cause, et un fichier fautif ne fait pas échouer
  // le lot entier.
  let documentId: string;
  try {
    // Deux « index.xml » de deux dossiers différents ne sont PAS deux versions du même fichier.
    const previous = await prisma.document.count({ where: { entityType, entityId, name: file.name, folder } });
    // L'identifiant est RENDU : un appelant qui rattache la pièce à un objet métier (une pièce de
    // dossier de paiement, par exemple) ne doit pas avoir à la retrouver « la plus récente », ce
    // qui se trompe dès que deux fichiers partent en même temps.
    const created = await prisma.document.create({
      data: {
        name: file.name,
        category,
        entityType,
        entityId,
        stepKey,
        folder,
        fileKey: key,
        mimeType: file.type || null,
        sizeBytes: file.size,
        version: previous + 1,
        confidentiality,
        uploadedById: userId,
      },
      select: { id: true },
    });
    documentId = created.id;
  } catch (err) {
    console.error("[upload] document.create failed", { name: file.name, entityType, entityId }, err);
    // Le fichier écrit n'a pas de fiche : on le rend, sinon il reste payé et invisible.
    await deleteFileByKey(key).catch(sansBloquer("documents.persistUploadedDocument.deleteFileByKey"));
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Enregistrement impossible : ${msg}` };
  }

  await recordAudit({
    actorId: userId,
    action: "UPLOAD",
    module: ENTITY_TYPE_LABELS[entityType] ?? ENTITY_MODULE[entityType],
    entityType,
    entityId,
    summary: `Document « ${folder ? `${folder}/` : ""}${file.name} » téléversé`,
  }).catch((e) => console.error("[upload] audit failed (non-bloquant)", e));

  // LA PIÈCE NOURRIT LES FICHES (refonte, lot V2-A) : fait `PIECE_DEPOSEE` et mise en file de
  // l'enrichissement, une fois le document acquis. Interrupteur fermé : rien. Ne lève jamais.
  await signalerDocumentDepose({
    documentId, entityType, entityId, category, confidentiality, blobId: ecrit.blobId, sha256: ecrit.sha256,
    nom: file.name, mime: file.type || null, taille: file.size, deposeParId: userId,
  });
  // LA BIBLIOTHÈQUE (J1) : la pièce entre au registre, sous la clé du document, et en file de lecture. Ne lève jamais.
  await inscrireDocument({
    documentId, entityType, category, confidentiality, blobId: ecrit.blobId, sha256: ecrit.sha256,
    nom: file.name, mime: file.type || null, taille: file.size, deposeParId: userId,
  });

  // MIROIR DRIVE, en arrière-plan : le document est déjà enregistré, c'est ce que la personne
  // voit. La copie se termine côté serveur — on ne fait pas attendre un téléversement pour elle.
  if (input.mirrorToDrive !== false) {
    const data = content;
    // Regulatory a SON rangement (dossier du produit, catégorie « Regulatory ») — le miroir générique
    // l'écarte ; sans cette branche, une pièce posée par un autre chemin que la route de lot n'arrivait
    // dans aucun Drive.
    const miroir = entityType === "REGULATORY_PRODUCT"
      ? mirrorRegulatoryUpload({ productId: entityId, ownerId: userId, documentIds: [documentId], files: [{ name: folder ? `${folder}/${file.name}` : file.name, data, mime: file.type || undefined }] })
      : mirrorDocumentsToDrive({ ownerId: userId, entityType, entityId, files: [{ name: file.name, data, mime: file.type || null }] });
    void miroir.catch((e) => console.error("[upload] miroir Drive échoué (non bloquant)", e));
  }
  return { ok: true, documentId };
}

/**
 * INSCRIT un document dont les octets sont DÉJÀ dans le bucket (envoi direct du navigateur, gros
 * fichiers). Le blob existe ; il reste la correspondance clé → blob et la fiche, avec le même
 * versionnage, le même audit et la même clé de fichier que le chemin ordinaire — un document ne
 * se distingue pas, à l'usage, selon la façon dont il est arrivé.
 */
export async function inscrireDocumentDirect(
  userId: string,
  input: {
    entityType: EntityType; entityId: string; category: DocumentCategory; confidentiality: Confidentiality;
    stepKey: string | null; folder?: string | null; blobId: string; size: number; mimeType: string | null; name: string;
    /** Le dépôt vient du bloc « CTD initiale » (§118.213). */
    ctd?: boolean;
  },
): Promise<{ documentId: string }> {
  const { entityType, entityId, name } = input;
  const refusCtd = refusDepotCtd({ entityType, stepKey: input.stepKey, category: input.category }, input.ctd === true);
  if (refusCtd) throw new Error(refusCtd);
  const folder = dossierSur(input.folder);
  const key = `${entityType}/${entityId}/${randomUUID()}__${name}`;
  await prisma.storedFile.create({ data: { key, blobId: input.blobId, size: input.size } });
  try {
    const previous = await prisma.document.count({ where: { entityType, entityId, name, folder } });
    const created = await prisma.document.create({
      data: {
        name, category: input.category, entityType, entityId, stepKey: input.stepKey, folder, fileKey: key,
        mimeType: input.mimeType, sizeBytes: input.size, version: previous + 1, confidentiality: input.confidentiality,
        uploadedById: userId,
      },
      select: { id: true },
    });
    await recordAudit({
      actorId: userId, action: "UPLOAD", module: ENTITY_TYPE_LABELS[entityType] ?? ENTITY_MODULE[entityType], entityType, entityId,
      summary: `Document « ${folder ? `${folder}/` : ""}${name} » téléversé (envoi direct)`,
    }).catch((e) => console.error("[upload direct] audit failed (non-bloquant)", e));
    // L'empreinte d'un envoi direct n'est pas calculée (`direct:…`) : la file la calculera avant d'émettre.
    const blob = await prisma.fileBlob.findUnique({ where: { id: input.blobId }, select: { sha256: true } }).catch(sansBloquer("documents.inscrireDocumentDirect.fileBlob", null));
    if (blob) {
      await signalerDocumentDepose({
        documentId: created.id, entityType, entityId, category: input.category, confidentiality: input.confidentiality, blobId: input.blobId,
        sha256: blob.sha256, nom: name, mime: input.mimeType, taille: input.size, deposeParId: userId,
      });
    }
    // LA BIBLIOTHÈQUE (J1) : l'empreinte manquante (`direct:…`) sera posée par l'ingestion, qui relit les octets.
    await inscrireDocument({
      documentId: created.id, entityType, category: input.category, confidentiality: input.confidentiality, blobId: input.blobId,
      sha256: blob?.sha256 ?? null, nom: name, mime: input.mimeType, taille: input.size, deposeParId: userId,
    });
    // REGULATORY (Direction, 06/10) : la pièce rejoint le dossier du produit dans la catégorie
    // « Regulatory » par RÉFÉRENCE à son blob — aucun octet relu, même pour plusieurs Go.
    if (entityType === "REGULATORY_PRODUCT") {
      void mirrorRegulatoryUpload({ productId: entityId, ownerId: userId, documentIds: [created.id], files: [] })
        .catch((e) => console.error("[upload direct] rangement Drive Regulatory échoué (non bloquant)", e));
    }
    return { documentId: created.id };
  } catch (e) {
    // Pas de correspondance sans fiche : la ligne `StoredFile` part, le blob reste à l'appelant.
    await prisma.storedFile.delete({ where: { key } }).catch(sansBloquer("documents.inscrireDocumentDirect.storedFile"));
    throw e;
  }
}

/** Fenêtre dans laquelle un renvoi identique est lu comme une relance, pas comme une version. */
export const RELANCE_FENETRE_MS = 10 * 60_000;

/**
 * Le même dépôt, déjà enregistré ? Même personne, même fiche, même nom, mêmes octets, il y a
 * moins de dix minutes. Les octets comptent : renvoyer un fichier CORRIGÉ sous le même nom reste
 * une nouvelle version, et c'est voulu.
 */
async function depotIdentiqueRecent(
  userId: string, entityType: EntityType, entityId: string, name: string, content: Buffer, folder: string | null,
): Promise<string | null> {
  const recents = await prisma.document.findMany({
    where: { entityType, entityId, name, folder, uploadedById: userId, fileKey: { not: null }, createdAt: { gte: new Date(Date.now() - RELANCE_FENETRE_MS) } },
    orderBy: { createdAt: "desc" }, take: 5, select: { id: true, fileKey: true },
  });
  if (recents.length === 0) return null;
  const empreinte = sha256(content);
  for (const d of recents) {
    const stored = await prisma.storedFile.findUnique({ where: { key: d.fileKey! }, select: { blobId: true } });
    if (!stored) continue;
    const blob = await prisma.fileBlob.findUnique({ where: { id: stored.blobId }, select: { sha256: true } });
    if (blob?.sha256 === empreinte) return d.id;
  }
  return null;
}

/**
 * LES PIÈCES JOINTES D'UN FORMULAIRE DE CRÉATION — rattachées à l'objet qui vient de naître.
 *
 * Un document légal ou un courrier se saisit avec sa pièce en main : la personne l'a sous les
 * yeux, c'est le seul moment où elle est certaine de laquelle il s'agit. La renvoyer sur la
 * fiche pour l'y déposer ensuite, c'est la moitié des dossiers qui restent sans pièce.
 *
 * NE FAIT JAMAIS ÉCHOUER LA CRÉATION. L'objet existe déjà quand cette fonction s'exécute :
 * refuser tout parce qu'un fichier sur trois est trop gros ferait perdre la saisie entière.
 * Les échecs sont RENDUS, à afficher — jamais avalés en silence.
 */
export async function attachFormFiles(
  userId: string,
  entityType: EntityType,
  entityId: string,
  formData: FormData,
  fieldName = "attachment",
): Promise<{ attached: number; failed: { name: string; error: string }[] }> {
  // Un champ fichier laissé vide envoie un fichier SANS NOM de zéro octet : ce n'est pas une
  // pièce. Un fichier NOMMÉ de zéro octet, si — et il est dit, plus écarté en silence (constat 13).
  const all = formData.getAll(fieldName).filter((v): v is File => v instanceof File && (v.size > 0 || v.name !== ""));
  const failed: { name: string; error: string }[] = all
    .filter((f) => f.size === 0)
    .map((f) => ({ name: f.name, error: "Fichier vide (0 octet) — rien à enregistrer." }));
  const files = all.filter((f) => f.size > 0);
  if (files.length === 0) return { attached: 0, failed };

  // La limite est lue UNE fois pour le lot : chaque fichier n'a pas à relire les réglages.
  const maxUploadMb = (await getAppSettings()).maxUploadMb;
  let attached = 0;
  for (const file of files) {
    const r = await persistUploadedDocument(userId, {
      entityType, entityId, category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file, maxUploadMb,
    });
    if (r.ok) attached += 1;
    else failed.push({ name: file.name, error: r.error ?? "Fichier non joint." });
  }
  return { attached, failed };
}
