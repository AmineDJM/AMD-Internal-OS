import { randomBytes } from "crypto";
import type { Confidentiality, DocumentCategory, EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { validateDocumentUpload } from "@/lib/storage";
import { objectStorageConfigured, deleteObject } from "@/lib/storage/object-storage";
import { LIMITE_FICHIER_BYTES, LIMITE_FICHIER_MO, LIMITE_FICHIER_LIBELLE } from "@/lib/storage/limites-blob";
import { MAX_SANS_STOCKAGE_OBJET_MO } from "@/lib/storage/phrases-stockage";
import { refusDevisLibre } from "@/lib/promo-material/rangement";
import { dossierSur, inscrireDocumentDirect } from "@/lib/documents";
import { refusDepotCtd } from "@/lib/regulatory/ctd-initiale";
import { addPhysicalUsage } from "@/lib/drive/usage";
import { empreinteFichier } from "@/lib/drive/depot-direct";
import {
  CLIENT_S3, ouvrirEnvoi, planDeReprise, finaliserEnvoi, refusSansStockageObjet,
  type ClientS3Direct, type PlanEnvoi,
} from "@/lib/storage/televersement-direct";
import { sansBloquer } from "@/lib/journal";

/**
 * GROS FICHIERS DES DOCUMENTS (checklist Regulatory, dossiers, pièces des objets métier) — déposés
 * DIRECTEMENT dans le bucket par le navigateur, comme ceux du Drive.
 *
 * Avant, tout document passait par une requête qui tient le fichier entier en mémoire, le chiffre,
 * puis l'écrit : au-delà de la limite réglée (≈ 250 Mo) l'envoi échouait, et même sous la limite un
 * ZIP de CTD faisait plier l'instance. Ici le serveur vérifie les droits, signe les adresses, puis
 * inscrit la fiche quand le bucket confirme avoir TOUT reçu. Plafond : 10 Go par fichier, comme le Drive.
 *
 * Mêmes réserves que le Drive, dites franchement : ces fichiers ne passent pas par le chiffrement
 * applicatif (le navigateur n'a pas la clé) — chiffrement au repos du fournisseur, accès contrôlé par
 * l'application qui seule signe les adresses ; non dédupliqués ; PAS de copie automatique dans le Drive
 * (la recopier relirait plusieurs Go) — la fiche reste la référence, le ZIP s'y parcourt. Exception
 * Regulatory (Direction, 06/10) : la pièce apparaît dans le dossier du produit de la catégorie
 * « Regulatory » par RÉFÉRENCE au même blob (`inscrireDocumentDirect`) — rien n'est relu ni recopié.
 */

const SESSION_PERIMEE_MS = 7 * 24 * 3600_000;

export interface CibleDocument {
  entityType: EntityType;
  entityId: string;
  category: DocumentCategory;
  confidentiality: Confidentiality;
  stepKey: string | null;
  folder: string | null;
  /** Le dépôt vient du bloc « CTD initiale » d'un dossier Regulatory (§118.213). */
  ctd?: boolean;
}

export type ResultatOuvertureDoc =
  | { ok: true; sessionId: string; plan: PlanEnvoi; repris: boolean }
  | { ok: false; error: string; status: number };

const cibleCanonique = (c: CibleDocument): string => JSON.stringify({
  entityType: c.entityType, entityId: c.entityId, category: c.category, confidentiality: c.confidentiality,
  stepKey: c.stepKey ?? null, folder: c.folder ?? null,
  // Posée seulement quand elle l'est : l'empreinte d'un dépôt ordinaire ne change pas (reprise des envois en cours).
  ...(c.ctd ? { ctd: true } : {}),
});

/** Les droits ET la règle des devis, relus à l'ouverture comme à la finalisation. */
async function refusDepotDocument(user: SessionUser, c: CibleDocument): Promise<{ status: number; error: string } | null> {
  if (!c.entityType || !c.entityId) return { status: 400, error: "Entité manquante." };
  if (!(await canAccessEntity(user, c.entityType, c.entityId, "UPLOAD"))) return { status: 403, error: "Vous n'êtes pas autorisé à téléverser ici." };
  // UN DÉPÔT QUI VISE LA CTD INITIALE LE DIT (§118.213) — à l'ouverture comme à la finalisation.
  const refusCtd = refusDepotCtd({ entityType: c.entityType, stepKey: c.stepKey, category: c.category }, c.ctd === true);
  if (refusCtd) return { status: 400, error: refusCtd };
  if (c.entityType === "PROMO_MATERIAL" && c.category === "QUOTE") {
    const refus = refusDevisLibre(await prisma.promoMaterial.findUnique({ where: { id: c.entityId }, select: { circuitVersion: true } }));
    if (refus) return { status: 400, error: refus };
  }
  return null;
}

export async function ouvrirDepotDirectDocument(
  user: SessionUser,
  entree: { nom: string; taille: number; type: string; modifieLe: number; cible: CibleDocument },
  client: ClientS3Direct = CLIENT_S3,
): Promise<ResultatOuvertureDoc> {
  const { nom, taille } = entree;
  const cible: CibleDocument = { ...entree.cible, folder: dossierSur(entree.cible.folder) };
  if (!objectStorageConfigured()) return { ok: false, status: 413, error: refusSansStockageObjet(taille, MAX_SANS_STOCKAGE_OBJET_MO) };
  const refus = await refusDepotDocument(user, cible);
  if (refus) return { ok: false, ...refus };
  // La TAILLE est celle d'une personne (10 Go), dite en Go ; la POLITIQUE de types vaut ici comme partout.
  if (taille > LIMITE_FICHIER_BYTES) return { ok: false, status: 413, error: `Fichier trop volumineux (${Math.round(taille / 1024 ** 2)} Mo > ${LIMITE_FICHIER_LIBELLE}).` };
  const invalide = validateDocumentUpload(nom, taille, LIMITE_FICHIER_MO);
  if (invalide) return { ok: false, status: 400, error: invalide };

  const fingerprint = `${empreinteFichier(nom, taille, entree.modifieLe)}|${cibleCanonique(cible)}`;
  const enCours = await prisma.directUpload.findFirst({
    where: { userId: user.id, purpose: "DOCUMENT", fingerprint, status: "UPLOADING", updatedAt: { gt: new Date(Date.now() - SESSION_PERIMEE_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (enCours && enCours.uploadId) {
    try {
      const plan = await planDeReprise(enCours.objectKey, enCours.uploadId, Number(enCours.totalBytes), enCours.partSize, client);
      await prisma.directUpload.update({ where: { id: enCours.id }, data: { error: null } });
      return { ok: true, sessionId: enCours.id, plan, repris: true };
    } catch {
      await prisma.directUpload.update({ where: { id: enCours.id }, data: { status: "ABORTED", error: "Envoi oublié par le stockage." } });
    }
  }

  const cle = `direct/${user.id}/${randomBytes(12).toString("hex")}`;
  const { uploadId, plan } = await ouvrirEnvoi(cle, taille, entree.type, client);
  const session = await prisma.directUpload.create({
    data: {
      userId: user.id, purpose: "DOCUMENT", objectKey: cle, uploadId, fileName: nom.slice(0, 255),
      mimeType: entree.type || null, totalBytes: BigInt(taille), partSize: plan.taillePartie,
      fingerprint, target: JSON.parse(cibleCanonique(cible)),
    },
    select: { id: true },
  });
  return { ok: true, sessionId: session.id, plan, repris: false };
}

const sessionDe = (user: SessionUser, id: string) => prisma.directUpload.findFirst({ where: { id, userId: user.id, purpose: "DOCUMENT" } });

export async function replanifierDepotDirectDocument(user: SessionUser, id: string, client: ClientS3Direct = CLIENT_S3): Promise<ResultatOuvertureDoc> {
  const s = await sessionDe(user, id);
  if (!s || s.status !== "UPLOADING" || !s.uploadId) return { ok: false, status: 404, error: "Envoi introuvable ou déjà terminé." };
  const plan = await planDeReprise(s.objectKey, s.uploadId, Number(s.totalBytes), s.partSize, client);
  return { ok: true, sessionId: s.id, plan, repris: true };
}

export type ResultatFinalisationDoc =
  | { ok: true; id: string }
  | { ok: false; error: string; status: number; reprendre?: boolean; manquantes?: number[] };

/** Le bucket a-t-il TOUT, à la bonne taille ? Alors le document est inscrit. Rejouable : jamais deux fiches. */
export async function finaliserDepotDirectDocument(
  user: SessionUser, id: string, client: ClientS3Direct = CLIENT_S3,
  /** Les empreintes reçues par le navigateur — secours quand le stockage ne liste pas ses parties. */
  etagsClient: Record<number, string> = {},
): Promise<ResultatFinalisationDoc> {
  const s = await sessionDe(user, id);
  if (!s) return { ok: false, status: 404, error: "Envoi introuvable." };
  if (s.status === "COMPLETED" && s.resultId) return { ok: true, id: s.resultId };
  if (s.status !== "UPLOADING" || !s.uploadId) return { ok: false, status: 409, error: s.error ?? "Cet envoi a été abandonné." };

  const cible = s.target as unknown as CibleDocument;
  // Les droits sont RELUS : un envoi de deux heures ne garde pas un droit retiré entre-temps.
  const refus = await refusDepotDocument(user, cible);
  if (refus) return { ok: false, ...refus };

  const pris = await prisma.directUpload.updateMany({ where: { id, status: "UPLOADING" }, data: { status: "FINALIZING" } });
  if (pris.count === 0) {
    const r = await prisma.directUpload.findUnique({ where: { id }, select: { status: true, resultId: true } });
    if (r?.status === "COMPLETED" && r.resultId) return { ok: true, id: r.resultId };
    return { ok: false, status: 409, error: "Finalisation déjà en cours — patientez un instant." };
  }
  const rouvrir = (error: string) => prisma.directUpload.update({ where: { id }, data: { status: "UPLOADING", error } });

  const total = Number(s.totalBytes);
  const issue = await finaliserEnvoi(s.objectKey, s.uploadId, total, s.partSize, client, etagsClient);
  if (!issue.ok) {
    if (issue.reprendre) {
      await rouvrir(issue.erreur);
      return { ok: false, status: 409, error: issue.erreur, reprendre: true, manquantes: issue.manquantes };
    }
    await prisma.directUpload.update({ where: { id }, data: { status: "ABORTED", error: issue.erreur } });
    await deleteObject(s.objectKey);
    return { ok: false, status: 422, error: issue.erreur };
  }

  let blobId: string | null = null;
  try {
    const blob = await prisma.fileBlob.create({
      data: { sha256: `direct:${s.objectKey}`, size: total, iv: Buffer.alloc(0), data: null, storageKey: s.objectKey, refCount: 1 },
      select: { id: true },
    });
    blobId = blob.id;
    const r = await inscrireDocumentDirect(user.id, {
      entityType: cible.entityType, entityId: cible.entityId, category: cible.category, confidentiality: cible.confidentiality,
      stepKey: cible.stepKey, folder: cible.folder, ctd: cible.ctd === true, blobId, size: total, mimeType: s.mimeType || "application/octet-stream", name: s.fileName,
    });
    await prisma.directUpload.update({ where: { id }, data: { status: "COMPLETED", resultId: r.documentId, error: null } });
    addPhysicalUsage(total);
    return { ok: true, id: r.documentId };
  } catch (e) {
    if (blobId) await prisma.fileBlob.delete({ where: { id: blobId } }).catch(sansBloquer("documents-depot-direct.finaliserDepotDirectDocument.fileBlob"));
    const msg = e instanceof Error ? e.message : "erreur";
    await rouvrir(`Inscription du document impossible : ${msg}`);
    return { ok: false, status: 500, error: `Le fichier est bien arrivé, mais son inscription a échoué (${msg}). Relancez : il ne sera pas renvoyé.`, reprendre: true };
  }
}

export async function abandonnerDepotDirectDocument(user: SessionUser, id: string, client: ClientS3Direct = CLIENT_S3): Promise<{ ok: boolean }> {
  const s = await sessionDe(user, id);
  if (!s || s.status !== "UPLOADING") return { ok: true };
  await prisma.directUpload.updateMany({ where: { id, status: "UPLOADING" }, data: { status: "ABORTED", error: "Abandon demandé." } });
  if (s.uploadId) await client.abandonner(s.objectKey, s.uploadId);
  return { ok: true };
}
