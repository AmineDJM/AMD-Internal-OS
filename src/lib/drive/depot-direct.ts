import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { validateDriveUpload } from "@/lib/storage";
import { objectStorageConfigured, deleteObject } from "@/lib/storage/object-storage";
import { quotaVerdict } from "@/lib/drive/quota";
import { userUsageBytes, physicalUsageBytes, addPhysicalUsage } from "@/lib/drive/usage";
import { LIMITE_FICHIER_BYTES, LIMITE_FICHIER_LIBELLE } from "@/lib/storage/limites-blob";
import { MAX_SANS_STOCKAGE_OBJET_MO } from "@/lib/storage/phrases-stockage";
import { refusDepotDrive, enregistrerFichierDrive, type CibleDepot } from "@/lib/drive/depot";
import {
  CLIENT_S3, ouvrirEnvoi, planDeReprise, finaliserEnvoi, refusSansStockageObjet,
  type ClientS3Direct, type PlanEnvoi,
} from "@/lib/storage/televersement-direct";
import { sansBloquer } from "@/lib/journal";

/**
 * GROS FICHIERS DU DRIVE — déposés DIRECTEMENT dans le bucket par le navigateur.
 *
 * Le chemin habituel tient le fichier entier en mémoire, le chiffre, puis l'écrit : au-delà de
 * quelques centaines de Mo, c'est la mémoire de l'instance qui cède. Ici le serveur ne voit pas
 * un octet : il vérifie les droits, signe les adresses, puis inscrit le fichier quand le bucket
 * confirme l'avoir reçu en entier.
 *
 * CE QUE CELA CHANGE, DIT FRANCHEMENT. Ces fichiers ne passent pas par le chiffrement applicatif
 * (le navigateur n'a pas la clé, et ne doit pas l'avoir) : ils sont protégés par le chiffrement
 * au repos du fournisseur (R2, S3 le font d'office) et par le contrôle d'accès de l'application,
 * qui seule signe les adresses. Ils ne sont pas dédupliqués (leur empreinte n'est pas calculée :
 * relire plusieurs gigaoctets pour la connaître coûterait plus que le doublon évité). Une ligne
 * `FileBlob` dont l'IV est VIDE les désigne ; `getBlob` et le téléchargement le savent.
 */

export { MAX_SANS_STOCKAGE_OBJET_MO } from "@/lib/storage/phrases-stockage";

/** Une session non terminée depuis ce délai est abandonnée (ses parties sont libérées). */
const SESSION_PERIMEE_MS = 7 * 24 * 3600_000;

export type ResultatOuverture =
  | { ok: true; sessionId: string; plan: PlanEnvoi; repris: boolean }
  | { ok: false; error: string; status: number };

/** Ce qui identifie un fichier choisi : la reprise ne se fait QUE sur le même fichier, au même endroit. */
export function empreinteFichier(nom: string, taille: number, modifieLe: number): string {
  return `${nom}|${taille}|${Number.isFinite(modifieLe) ? modifieLe : 0}`;
}

const cibleCanonique = (c: CibleDepot): string => JSON.stringify({
  nodeId: c.nodeId ?? null, parentId: c.parentId ?? null, spaceId: c.spaceId ?? null, category: c.category ?? null,
  viewers: [...(c.viewers ?? [])].sort(), editors: [...(c.editors ?? [])].sort(),
});

export async function ouvrirDepotDirect(
  user: SessionUser,
  entree: { nom: string; taille: number; type: string; modifieLe: number; cible: CibleDepot },
  client: ClientS3Direct = CLIENT_S3,
): Promise<ResultatOuverture> {
  const { nom, taille } = entree;
  if (!objectStorageConfigured()) return { ok: false, status: 413, error: refusSansStockageObjet(taille, MAX_SANS_STOCKAGE_OBJET_MO) };

  const refus = await refusDepotDrive(user, entree.cible);
  if (refus) return { ok: false, ...refus };

  const settings = await getAppSettings();
  const invalide = validateDriveUpload(nom, taille, settings.maxDriveUploadMb);
  if (invalide) return { ok: false, status: 400, error: invalide };
  if (taille > LIMITE_FICHIER_BYTES) {
    return { ok: false, status: 413, error: `Fichier trop volumineux pour le Drive (${Math.round(taille / 1024 ** 2)} Mo > ${LIMITE_FICHIER_LIBELLE}).` };
  }
  const [mine, physique] = await Promise.all([userUsageBytes(user.id), physicalUsageBytes()]);
  const verdict = quotaVerdict({
    userUsageBytes: mine, physicalUsageBytes: physique, fileSize: taille,
    userQuotaGb: settings.driveUserQuotaGb, capacityGb: settings.driveCapacityGb,
  });
  if (!verdict.ok) return { ok: false, status: 400, error: verdict.error ?? "Quota dépassé." };

  // REPRISE — même personne, même fichier (nom, taille, date), même destination, envoi pas fini.
  const fingerprint = empreinteFichier(nom, taille, entree.modifieLe);
  const target = cibleCanonique(entree.cible);
  const enCours = await prisma.directUpload.findFirst({
    where: { userId: user.id, purpose: "DRIVE", fingerprint, status: "UPLOADING", updatedAt: { gt: new Date(Date.now() - SESSION_PERIMEE_MS) } },
    orderBy: { createdAt: "desc" },
  });
  // jsonb réordonne les clés : on compare deux formes CANONIQUES, jamais deux textes bruts.
  if (enCours && enCours.uploadId && cibleCanonique(enCours.target as unknown as CibleDepot) === target) {
    try {
      const plan = await planDeReprise(enCours.objectKey, enCours.uploadId, Number(enCours.totalBytes), enCours.partSize, client);
      await prisma.directUpload.update({ where: { id: enCours.id }, data: { error: null } });
      return { ok: true, sessionId: enCours.id, plan, repris: true };
    } catch {
      // Le bucket a oublié cet envoi (expiré, nettoyé) : on repart d'un envoi neuf.
      await prisma.directUpload.update({ where: { id: enCours.id }, data: { status: "ABORTED", error: "Envoi oublié par le stockage." } });
    }
  }

  const cle = `direct/${user.id}/${randomBytes(12).toString("hex")}`;
  const { uploadId, plan } = await ouvrirEnvoi(cle, taille, entree.type, client);
  const session = await prisma.directUpload.create({
    data: {
      userId: user.id, purpose: "DRIVE", objectKey: cle, uploadId, fileName: nom.slice(0, 255),
      mimeType: entree.type || null, totalBytes: BigInt(taille), partSize: plan.taillePartie,
      fingerprint, target: JSON.parse(target),
    },
    select: { id: true },
  });
  return { ok: true, sessionId: session.id, plan, repris: false };
}

async function sessionDe(user: SessionUser, id: string) {
  return prisma.directUpload.findFirst({ where: { id, userId: user.id, purpose: "DRIVE" } });
}

/** Adresses fraîches pour les parties encore manquantes (après expiration, ou à la reprise). */
export async function replanifierDepotDirect(user: SessionUser, id: string, client: ClientS3Direct = CLIENT_S3): Promise<ResultatOuverture> {
  const s = await sessionDe(user, id);
  if (!s || s.status !== "UPLOADING" || !s.uploadId) return { ok: false, status: 404, error: "Envoi introuvable ou déjà terminé." };
  const plan = await planDeReprise(s.objectKey, s.uploadId, Number(s.totalBytes), s.partSize, client);
  return { ok: true, sessionId: s.id, plan, repris: true };
}

export type ResultatFinalisation =
  | { ok: true; id: string; version?: number }
  | { ok: false; error: string; status: number; reprendre?: boolean; manquantes?: number[] };

/**
 * FINALISE : le bucket a-t-il TOUT, à la bonne taille ? Alors le fichier entre au Drive. Rejouable :
 * une seconde finalisation rend le même fichier, jamais un second.
 */
export async function finaliserDepotDirect(
  user: SessionUser, id: string, client: ClientS3Direct = CLIENT_S3,
  /** Les empreintes reçues par le navigateur — secours quand le stockage ne liste pas ses parties. */
  etagsClient: Record<number, string> = {},
): Promise<ResultatFinalisation> {
  const s = await sessionDe(user, id);
  if (!s) return { ok: false, status: 404, error: "Envoi introuvable." };
  if (s.status === "COMPLETED" && s.resultId) return { ok: true, id: s.resultId };
  if (s.status !== "UPLOADING" || !s.uploadId) return { ok: false, status: 409, error: s.error ?? "Cet envoi a été abandonné." };

  const cible = s.target as unknown as CibleDepot;
  // Les droits sont RELUS : un envoi de deux heures ne garde pas un droit retiré entre-temps.
  const refus = await refusDepotDrive(user, cible);
  if (refus) return { ok: false, ...refus };

  // Une finalisation à la fois : la seconde (double clic, relance réseau) attend la première.
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
      // Empreinte non calculée (voir l'en-tête) : la clé d'objet, préfixée, tient lieu d'identité
      // unique et ne peut coïncider avec aucun SHA-256 hexadécimal.
      data: { sha256: `direct:${s.objectKey}`, size: total, iv: Buffer.alloc(0), data: null, storageKey: s.objectKey, refCount: 1 },
      select: { id: true },
    });
    blobId = blob.id;
    const res = await enregistrerFichierDrive(user, cible, { blobId, size: total, mimeType: s.mimeType || "application/octet-stream", name: s.fileName });
    await prisma.directUpload.update({ where: { id }, data: { status: "COMPLETED", resultId: res.id, error: null } });
    addPhysicalUsage(total);
    return { ok: true, id: res.id, ...(res.version ? { version: res.version } : {}) };
  } catch (e) {
    // L'objet est complet dans le bucket : on garde l'envoi reprenable (une nouvelle finalisation
    // retrouvera l'objet), et l'on ne laisse pas une ligne de blob sans fichier.
    if (blobId) await prisma.fileBlob.delete({ where: { id: blobId } }).catch(sansBloquer("depot-direct.finaliserDepotDirect.fileBlob"));
    const msg = e instanceof Error ? e.message : "erreur";
    await rouvrir(`Inscription au Drive impossible : ${msg}`);
    return { ok: false, status: 500, error: `Le fichier est bien arrivé, mais son inscription au Drive a échoué (${msg}). Relancez : il ne sera pas renvoyé.`, reprendre: true };
  }
}

/** Abandon à la demande : les parties déjà envoyées sont libérées dans le bucket. */
export async function abandonnerDepotDirect(user: SessionUser, id: string, client: ClientS3Direct = CLIENT_S3): Promise<{ ok: boolean }> {
  const s = await sessionDe(user, id);
  if (!s || s.status !== "UPLOADING") return { ok: true };
  await prisma.directUpload.updateMany({ where: { id, status: "UPLOADING" }, data: { status: "ABORTED", error: "Abandon demandé." } });
  if (s.uploadId) await client.abandonner(s.objectKey, s.uploadId);
  return { ok: true };
}

/** Ménage de fond : les envois jamais terminés libèrent leurs parties (facturées tant qu'on ne le fait pas). */
export async function nettoyerDepotsDirectsPerimes(client: ClientS3Direct = CLIENT_S3): Promise<number> {
  const vieux = await prisma.directUpload.findMany({
    where: { status: { in: ["UPLOADING", "FINALIZING"] }, updatedAt: { lt: new Date(Date.now() - SESSION_PERIMEE_MS) } },
    select: { id: true, objectKey: true, uploadId: true }, take: 200,
  });
  for (const v of vieux) {
    const n = await prisma.directUpload.updateMany({ where: { id: v.id, status: { in: ["UPLOADING", "FINALIZING"] } }, data: { status: "ABORTED", error: "Expiré (inactif depuis 7 jours)." } });
    if (n.count > 0 && v.uploadId) await client.abandonner(v.objectKey, v.uploadId);
  }
  return vieux.length;
}
