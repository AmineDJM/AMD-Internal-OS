import { randomUUID } from "node:crypto";
import type { DocumentCategory, EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveFile, deleteFileByKey, validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { mirrorDocumentsToDrive, type MirrorFile } from "@/lib/drive/document-mirror";
import { notifyUser } from "@/lib/notify";
import { entityHref } from "@/lib/entity-href";
import { signalerDocumentDepose } from "@/lib/enrichissement/signalement";

/**
 * JOINDRE DES FICHIERS À UN OBJET, DÈS SA CRÉATION.
 *
 * Le même bloc était recopié dans cinq actions. Le sortir ici évite qu'une correction (limite
 * de taille, garde de type, chemin de stockage) ne soit appliquée qu'à quatre d'entre elles.
 *
 * Trois règles (audit du 04/10, constats 1, 7, 8, 13) :
 *   • **un fichier refusé se dit AVANT d'agir** — `validateAttachments` se lance avant de créer
 *     l'objet : une demande créée puis refusée pour sa pièce se recrée au second essai, et l'on
 *     en a deux ;
 *   • **pas de fiche sans fichier** — une écriture qui échoue ne crée plus de document « fantôme »
 *     qui s'affichera « indisponible » : elle est rendue, avec le nom du fichier ;
 *   • **toutes les erreurs d'un lot sont dites**, pas la première seulement — et un fichier vide
 *     n'est plus écarté en silence.
 */
export interface AttachResult {
  saved: number;
  /** Message d'erreur si un fichier a été refusé ou n'a pas pu être écrit — à afficher. */
  error?: string;
}

/**
 * Un champ fichier laissé vide envoie un fichier de zéro octet SANS NOM — ou, une fois passé par une action
 * serveur de Next, nommé « undefined » (mesuré au navigateur : la demande de prise en charge ne pouvait plus
 * être envoyée sans fichier, refusée « « undefined » est vide »). Ce n'est pas une pièce. Un fichier vide
 * qui porte un VRAI nom, lui, reste refusé et dit son nom.
 */
const estUnePiece = (f: unknown): f is File => f instanceof File && (f.size > 0 || (f.name !== "" && f.name !== "undefined"));

/**
 * Contrôle les fichiers SANS rien écrire — pour les appelants qui doivent refuser une saisie
 * AVANT d'agir (une demande à créer, une décision de workflow).
 *
 * Renvoie TOUTES les raisons de refus du lot, réunies, ou `null` si tout passe.
 */
export async function validateAttachments(files: File[]): Promise<string | null> {
  const list = files.filter(estUnePiece);
  if (list.length === 0) return null;
  const maxMb = (await getAppSettings()).maxUploadMb;
  const erreurs: string[] = [];
  for (const file of list) {
    if (file.size === 0) { erreurs.push(`« ${file.name} » est vide (0 octet).`); continue; }
    const invalid = validateUpload(file.name, file.size, maxMb);
    if (invalid) erreurs.push(`« ${file.name} » : ${invalid}`);
  }
  return erreurs.length > 0 ? erreurs.join(" ") : null;
}

export async function attachFiles(input: {
  files: File[];
  entityType: EntityType;
  entityId: string;
  uploadedById: string;
  category?: DocumentCategory;
  /** Rattache la pièce à une étape / une case précise (colonne `stepKey`). */
  stepKey?: string | null;
}): Promise<AttachResult> {
  const files = input.files.filter(estUnePiece);
  if (files.length === 0) return { saved: 0 };

  const refus = await validateAttachments(files);
  if (refus) return { saved: 0, error: refus };

  let saved = 0;
  const toMirror: MirrorFile[] = [];
  const echecs: string[] = [];

  for (const file of files) {
    const key = `${input.entityType}/${input.entityId}/${randomUUID()}__${file.name}`;
    const content = Buffer.from(await file.arrayBuffer());
    let ecrit: { blobId: string; sha256: string };
    try {
      ecrit = await saveFile(key, content);
    } catch (err) {
      console.error("[attach] écriture du fichier impossible — aucune fiche créée", key, err);
      echecs.push(`« ${file.name} » n'a pas pu être enregistré (${err instanceof Error ? err.message : "stockage indisponible"}).`);
      continue;
    }
    let documentId: string;
    try {
      ({ id: documentId } = await prisma.document.create({
        data: {
          name: file.name,
          category: input.category ?? "OTHER",
          entityType: input.entityType,
          entityId: input.entityId,
          stepKey: input.stepKey ?? null,
          fileKey: key,
          mimeType: file.type || null,
          sizeBytes: file.size,
          confidentiality: "INTERNAL",
          uploadedById: input.uploadedById,
        },
        select: { id: true },
      }));
    } catch (err) {
      await deleteFileByKey(key).catch(() => undefined);
      echecs.push(`« ${file.name} » : fiche impossible à créer (${err instanceof Error ? err.message : "erreur"}).`);
      continue;
    }
    toMirror.push({ name: file.name, data: content, mime: file.type || null });
    saved++;
    // La pièce nourrit les fiches (refonte, lot V2-A) — interrupteur fermé : rien ; ne lève jamais.
    await signalerDocumentDepose({
      documentId, entityType: input.entityType, entityId: input.entityId, category: input.category ?? "OTHER", confidentiality: "INTERNAL",
      blobId: ecrit.blobId, sha256: ecrit.sha256, nom: file.name, mime: file.type || null, taille: file.size, deposeParId: input.uploadedById,
    });
  }

  // Une pièce jointe à une demande est un fichier comme un autre : elle doit se retrouver dans le
  // Drive de celui qui l'a déposée, là où il ira la chercher. En arrière-plan — la demande est
  // déjà enregistrée, et une copie ratée ne doit jamais la faire échouer.
  if (toMirror.length > 0) {
    void mirrorDocumentsToDrive({
      ownerId: input.uploadedById, entityType: input.entityType, entityId: input.entityId, files: toMirror,
    }).catch((e) => console.error("[attach] miroir Drive échoué (non bloquant)", e));
  }

  if (echecs.length === 0) return { saved };
  const error = `${echecs.join(" ")} Joignez ${echecs.length > 1 ? "ces fichiers" : "ce fichier"} à nouveau depuis la fiche.`;
  // L'objet existe déjà : l'appelant ne doit pas le refaire (il en aurait deux). Le manque est donc
  // aussi DIT dans la cloche de la personne, avec le lien de la fiche — un écran qui se ferme sur
  // « créé » ne doit pas être la seule trace d'une pièce perdue (constat 8).
  await notifyUser({
    userId: input.uploadedById, type: "GENERIC", title: "Pièce jointe non enregistrée", body: error,
    link: entityHref(input.entityType, input.entityId) ?? undefined,
  }).catch(() => undefined);
  return { saved, error };
}
