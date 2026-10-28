"use server";

import { revalidatePath } from "next/cache";
import type { DriveAccess } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { putBlob, getBlob, retainBlob } from "@/lib/drive-storage";
import { resolveDriveAccess, effectiveSpaceId, canCreateInSpace, canViewDrive } from "@/lib/drive";
import { blankOffice, isOfficeKind } from "@/lib/office-templates";
import { documentName, KIND_LABEL } from "@/lib/office/letterhead";
import { getMyCompanies } from "@/lib/company";
import { convertConfigured, convertDocument } from "@/lib/office-convert";
import { makeFileReadToken, appBaseUrl, onlyofficeEditable, extensionsEditables, fileExt } from "@/lib/onlyoffice";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { creerArborescenceDrive } from "@/lib/drive/arborescence";
import { supprimerReversible } from "@/lib/suppression/coeur";

const DENIED: ActionResult = { ok: false, error: "Non autorisé." };

/** IDs d'un nœud **et de tout son sous-arbre** (dossiers → enfants), pour cascader
 *  corbeille / restauration / suppression sur l'ensemble du dossier. */
async function collectSubtree(rootId: string): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let frontier = [rootId];
  while (frontier.length) {
    const batch = frontier.filter((id) => !seen.has(id));
    if (batch.length === 0) break;
    batch.forEach((id) => seen.add(id));
    ids.push(...batch);
    const children = await prisma.driveNode.findMany({ where: { parentId: { in: batch } }, select: { id: true } });
    frontier = children.map((c) => c.id);
  }
  return ids;
}

export async function createFolder(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Nom du dossier requis." };
  const parentId = fdStr(formData, "parentId");
  const spaceId = fdStr(formData, "spaceId");
  // Un accès ÉDITEUR sur le dossier parent (partage/catégorie) suffit à y créer un sous-dossier,
  // même sans le droit module « Créer ». À la racine d'une CATÉGORIE : gestionnaire requis.
  // À la racine PERSONNELLE : droit module « Créer ».
  if (parentId) {
    if ((await resolveDriveAccess(user, parentId)) !== "EDIT") return DENIED;
  } else if (spaceId) {
    if (!(await canCreateInSpace(user, spaceId))) return DENIED;
  } else if (!userCan(user, "DRIVE", "CREATE")) {
    return DENIED;
  }
  const effSpaceId = await effectiveSpaceId(parentId || null, spaceId || null);

  const node = await prisma.driveNode.create({
    data: { name, type: "FOLDER", parentId: parentId || null, spaceId: effSpaceId, ownerId: user.id, createdById: user.id },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Drive", entityType: "DRIVE_NODE", entityId: node.id, summary: `Dossier « ${name} »` });
  revalidatePath("/drive");
  if (effSpaceId) revalidatePath(`/drive/espace/${effSpaceId}`);
  return { ok: true, id: node.id };
}

/**
 * Import de DOSSIER (façon Google Drive) : recrée l'arborescence exacte à partir des chemins
 * relatifs des fichiers (`webkitRelativePath`). Pour chaque chemin de dossier, crée les niveaux
 * manquants sous `parentId` en RÉUTILISANT un dossier existant du même nom (pas de doublon), et
 * renvoie la carte `chemin relatif → id du dossier` pour y téléverser ensuite chaque fichier.
 */
export async function ensureDriveFolders(
  parentId: string | null,
  paths: string[],
  spaceId: string | null = null,
): Promise<{ ok: boolean; error?: string; map?: Record<string, string> }> {
  const user = await requireUser();
  // Éditeur sur le dossier de destination (partage/catégorie) suffit ; racine d'une catégorie →
  // gestionnaire ; racine personnelle → droit module « Créer ».
  if (parentId) {
    if ((await resolveDriveAccess(user, parentId)) !== "EDIT") return { ok: false, error: "Dossier de destination non autorisé." };
  } else if (spaceId) {
    if (!(await canCreateInSpace(user, spaceId))) return { ok: false, error: "Catégorie non autorisée." };
  } else if (!userCan(user, "DRIVE", "CREATE")) {
    return { ok: false, error: "Non autorisé." };
  }
  // Tout l'arbre importé atterrit dans une même catégorie (ou le Drive personnel).
  const baseSpace = await effectiveSpaceId(parentId || null, spaceId || null);

  // La boucle est partagée avec le dépôt de la messagerie (même arborescence, même réutilisation).
  const map = await creerArborescenceDrive({ ownerId: user.id, parentId, spaceId: baseSpace, paths });
  revalidatePath("/drive");
  if (baseSpace) revalidatePath(`/drive/espace/${baseSpace}`);
  return { ok: true, map };
}

/** Partages actuels d'un nœud (dossier OU fichier) pour le panneau « Gérer l'accès ». */
/** `withUsers` : joindre les personnes à qui partager (pour qui peut modifier) — le panneau s'ouvre sans rien attendre d'autre. */
export async function getDriveNodeShares(
  nodeId: string,
  withUsers?: boolean,
): Promise<{ ok: boolean; error?: string; canEdit?: boolean; shares?: { userId: string; name: string; access: string }[]; users?: { id: string; name: string }[] }> {
  const user = await enLecture(requireUser);
  const level = await resolveDriveAccess(user, nodeId);
  if (level === "NONE") return { ok: false, error: "Non autorisé." };
  const canEdit = level === "EDIT";
  const [node, users] = await Promise.all([
    prisma.driveNode.findUnique({
      where: { id: nodeId },
      select: { shares: { include: { user: { select: { id: true, name: true } } } } },
    }),
    withUsers && canEdit
      ? prisma.user.findMany({ where: { isActive: true, id: { not: user.id } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve(undefined),
  ]);
  if (!node) return { ok: false, error: "Introuvable." };
  return {
    ok: true,
    canEdit,
    shares: node.shares.map((s) => ({ userId: s.userId, name: s.user?.name ?? "—", access: s.access })),
    users,
  };
}

/** L'historique des versions d'un fichier — lu à l'ouverture de son panneau, jamais avant. */
export async function getDriveNodeVersions(
  nodeId: string,
): Promise<{ ok: boolean; error?: string; versions?: { id: string; version: number; size: number; createdAt: string }[] }> {
  const user = await enLecture(requireUser);
  if ((await resolveDriveAccess(user, nodeId)) === "NONE") return { ok: false, error: "Non autorisé." };
  const versions = await prisma.fileVersion.findMany({
    where: { nodeId }, orderBy: { version: "desc" }, take: 50,
    select: { id: true, version: true, size: true, createdAt: true },
  });
  return { ok: true, versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })) };
}

export async function renameNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id || !name) return { ok: false, error: "Paramètres manquants." };
  if ((await resolveDriveAccess(user, id)) !== "EDIT") return DENIED;
  await prisma.driveNode.update({ where: { id }, data: { name } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: id, field: "name", newValue: name, summary: `Renommé en « ${name} »` });
  revalidatePath("/drive");
  revalidatePath(`/drive/${id}`);
  return { ok: true };
}

export async function moveNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const targetId = fdStr(formData, "targetId"); // null/"" → racine
  const contextSpaceId = fdStr(formData, "spaceId") || null; // catégorie courante (racine)
  if (!id) return { ok: false, error: "Élément introuvable." };
  if ((await resolveDriveAccess(user, id)) !== "EDIT") return DENIED;

  // Catégorie de DESTINATION : celle du dossier cible, ou la catégorie courante à la racine.
  let targetSpaceId: string | null;
  if (targetId) {
    if ((await resolveDriveAccess(user, targetId)) !== "EDIT") return DENIED;
    // empêcher de déplacer un dossier dans lui-même ou un descendant
    let cur: string | null = targetId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === id) return { ok: false, error: "Déplacement invalide (dans son propre sous-dossier)." };
      seen.add(cur);
      const n: { parentId: string | null } | null = await prisma.driveNode.findUnique({ where: { id: cur }, select: { parentId: true } });
      cur = n?.parentId ?? null;
    }
    // UNE CIBLE EST UN DOSSIER VIVANT (audit du 27/10/2026, RH-DOCUMENTS-COMMS-06) : rangé sous un FICHIER ou sous un
    // dossier à la corbeille, l'élément n'apparaissait plus dans aucune liste — ni dans la corbeille.
    const t = await prisma.driveNode.findUnique({ where: { id: targetId }, select: { spaceId: true, type: true, isTrashed: true } });
    if (!t || t.type !== "FOLDER" || t.isTrashed) return { ok: false, error: "La destination doit être un dossier (hors corbeille)." };
    targetSpaceId = t.spaceId ?? null;
  } else {
    // Déplacement à la racine d'une catégorie : gestionnaire requis (racine personnelle : libre).
    if (contextSpaceId && !(await canCreateInSpace(user, contextSpaceId))) return DENIED;
    targetSpaceId = contextSpaceId;
  }

  // SORTIR D'UNE CATÉGORIE se décide comme y entrer : gestionnaire de la catégorie d'origine. Un simple partage EDIT
  // vidait la catégorie vers une racine personnelle (`spaceId` fourni par le client), et ses gestionnaires
  // perdaient l'accès (audit du 27/10/2026, RH-DOCUMENTS-COMMS-06).
  const source = await prisma.driveNode.findUnique({ where: { id }, select: { spaceId: true } });
  if (source?.spaceId && source.spaceId !== targetSpaceId && !(await canCreateInSpace(user, source.spaceId))) {
    return { ok: false, error: "Seul un gestionnaire de la catégorie peut en sortir cet élément." };
  }

  // Maintient l'invariant « tout le sous-arbre porte le spaceId de sa catégorie » : le sous-arbre
  // déplacé adopte la catégorie de destination (ou repasse en personnel si null).
  const subtree = await collectSubtree(id);
  await prisma.driveNode.updateMany({ where: { id: { in: subtree } }, data: { spaceId: targetSpaceId } });
  await prisma.driveNode.update({ where: { id }, data: { parentId: targetId || null } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: id, summary: "Déplacé" });
  revalidatePath("/drive");
  return { ok: true };
}

export async function trashNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Élément introuvable." };
  if ((await resolveDriveAccess(user, id)) !== "EDIT") return DENIED;
  // Cascade : un dossier mis à la corbeille y emmène tout son contenu.
  const ids = await collectSubtree(id);
  await prisma.driveNode.updateMany({ where: { id: { in: ids } }, data: { isTrashed: true } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: id, field: "isTrashed", newValue: "true", summary: ids.length > 1 ? `Mis à la corbeille (${ids.length} éléments)` : "Mis à la corbeille" });
  revalidatePath("/drive");
  return { ok: true };
}

export async function restoreNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Élément introuvable." };
  if ((await resolveDriveAccess(user, id)) !== "EDIT") return DENIED;
  const node = await prisma.driveNode.findUnique({ where: { id }, select: { parentId: true } });
  // Restaure le dossier ET tout son sous-arbre.
  const ids = await collectSubtree(id);
  await prisma.driveNode.updateMany({ where: { id: { in: ids } }, data: { isTrashed: false } });
  // Si le parent est lui-même à la corbeille (ou supprimé), on restaure à la racine.
  if (node?.parentId) {
    const parent = await prisma.driveNode.findUnique({ where: { id: node.parentId }, select: { isTrashed: true } });
    if (!parent || parent.isTrashed) await prisma.driveNode.update({ where: { id }, data: { parentId: null } });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: id, field: "isTrashed", newValue: "false", summary: "Restauré" });
  revalidatePath("/drive");
  return { ok: true };
}

/** « Supprimer définitivement » depuis la corbeille du Drive — vers la corbeille du Super Admin, restaurable. */
export async function deleteNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Élément introuvable." };
  if ((await resolveDriveAccess(user, id)) !== "EDIT") return DENIED;
  const node = await prisma.driveNode.findUnique({ where: { id }, select: { name: true } });
  if (!node) return { ok: false, error: "Élément introuvable." };
  // TOUJOURS RÉCUPÉRABLE (Direction, 10/2026) : quitter la corbeille du Drive, c'est passer dans la corbeille du
  // Super Admin — un lot (versions, partages, commentaires, sous-dossiers) qu'il restaure tel quel. Les octets
  // restent tenus par la ligne de corbeille ; seule la destruction réelle, chez le Super Admin, les libère.
  const ids = await collectSubtree(id);
  const r = await supprimerReversible("DRIVE_NODE", id, user.id, `Supprimé de la corbeille du Drive « ${node.name} »${ids.length > 1 ? ` (${ids.length} éléments)` : ""}`);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/drive");
  return { ok: true };
}

export async function shareNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nodeId = fdStr(formData, "nodeId");
  const userId = fdStr(formData, "userId");
  const access = (fdStr(formData, "access") as DriveAccess) ?? "VIEW";
  if (!nodeId || !userId) return { ok: false, error: "Paramètres manquants." };
  if ((await resolveDriveAccess(user, nodeId)) !== "EDIT") return DENIED;

  await prisma.driveShare.upsert({
    where: { nodeId_userId: { nodeId, userId } },
    create: { nodeId, userId, access },
    update: { access },
  });
  const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true } });
  await notifyUser({ userId, type: "DOCUMENT_UPLOADED", title: "Fichier partagé avec vous", body: node?.name ?? "Un élément du Drive", link: `/drive/${nodeId}` });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: nodeId, summary: `Partagé (${access})` });
  revalidatePath(`/drive/${nodeId}`);
  revalidatePath("/drive");
  return { ok: true };
}

/**
 * PARTAGER AVEC PLUSIEURS PERSONNES EN UNE FOIS.
 *
 * Partager un dossier de campagne avec six délégués un par un, c'est six ouvertures du panneau,
 * six sélections, six clics — et la sixième personne se fait oublier une fois sur deux. On accepte
 * donc une liste, avec le même droit pour tout le monde : c'est le cas réel (« l'équipe peut
 * lire »), et les exceptions se règlent ensuite personne par personne.
 *
 * Le droit d'écrire sur le nœud est vérifié UNE fois — il ne dépend pas du destinataire — puis
 * chaque partage est écrit et notifié. Un destinataire déjà présent voit son droit mis à jour
 * plutôt que dupliqué.
 */
export async function shareNodeWithMany(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nodeId = fdStr(formData, "nodeId");
  const access = (fdStr(formData, "access") as DriveAccess) ?? "VIEW";
  const userIds = Array.from(new Set(formData.getAll("userId").map(String).filter(Boolean)))
    // On ne se partage pas à soi-même : le partage n'ajouterait rien et brouillerait la liste.
    .filter((id) => id !== user.id);
  if (!nodeId) return { ok: false, error: "Élément introuvable." };
  if (userIds.length === 0) return { ok: false, error: "Choisissez au moins une personne." };
  if ((await resolveDriveAccess(user, nodeId)) !== "EDIT") return DENIED;

  const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true } });
  if (!node) return { ok: false, error: "Élément introuvable." };

  for (const userId of userIds) {
    await prisma.driveShare.upsert({
      where: { nodeId_userId: { nodeId, userId } },
      create: { nodeId, userId, access },
      update: { access },
    });
    await notifyUser({
      userId, type: "DOCUMENT_UPLOADED", title: "Élément partagé avec vous",
      body: node.name, link: `/drive/${nodeId}`,
    });
  }

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: nodeId,
    summary: `Partagé avec ${userIds.length} personne(s) — ${access === "EDIT" ? "modification" : "lecture"}`,
  });
  revalidatePath(`/drive/${nodeId}`);
  revalidatePath("/drive");
  return { ok: true, message: `Partagé avec ${userIds.length} personne(s).` };
}

export async function unshareNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const nodeId = fdStr(formData, "nodeId");
  const userId = fdStr(formData, "userId");
  if (!nodeId || !userId) return { ok: false, error: "Paramètres manquants." };
  if ((await resolveDriveAccess(user, nodeId)) !== "EDIT") return DENIED;
  await prisma.driveShare.deleteMany({ where: { nodeId, userId } });
  revalidatePath(`/drive/${nodeId}`);
  return { ok: true };
}

/**
 * Crée un document Office (Word / Excel / PowerPoint) dans le Drive, **vierge ou sur papier
 * en-tête**, puis renvoie son id pour l'ouvrir dans l'éditeur OnlyOffice.
 *
 * Sans en-tête : un vrai OOXML vierge, généré côté serveur sans dépendance.
 *
 * Avec en-tête (`letterheadId`) : on RECOPIE les octets du modèle. Le document neuf s'ouvre
 * donc exactement comme lui — mêmes marges, même pied de page, même logo à la bonne taille —
 * là où une fusion ou une image injectée produirait des décalages qu'on ne découvre qu'à
 * l'impression, chez le destinataire. Et parce que c'est une COPIE, modifier ou supprimer le
 * modèle plus tard ne réécrit jamais un courrier déjà parti.
 */
export async function createOfficeNode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser(); // hors du `try` : sa redirection vers /login doit passer
  try {
    const kind = fdStr(formData, "kind");
    if (!kind || !isOfficeKind(kind)) return { ok: false, error: "Type de document invalide." };
    const parentId = fdStr(formData, "parentId");
    const spaceId = fdStr(formData, "spaceId");
    // Éditeur sur le dossier de destination (partage/catégorie) suffit ; racine d'une catégorie →
    // gestionnaire ; racine personnelle → droit module « Créer ».
    if (parentId) {
      if ((await resolveDriveAccess(user, parentId)) !== "EDIT") return DENIED;
    } else if (spaceId) {
      if (!(await canCreateInSpace(user, spaceId))) return DENIED;
    } else if (!userCan(user, "DRIVE", "CREATE")) {
      return DENIED;
    }
    const effSpaceId = await effectiveSpaceId(parentId || null, spaceId || null);

    const base = fdStr(formData, "name") ?? "Document";
    const name = documentName(base, kind);
    const blank = blankOffice(kind);
    let data = blank.data;
    let mime = blank.mime;
    let letterheadName: string | null = null;

    const letterheadId = fdStr(formData, "letterheadId");
    if (letterheadId) {
      const lh = await prisma.officeLetterhead.findUnique({
        where: { id: letterheadId },
        select: { name: true, kind: true, blobId: true, mime: true, isActive: true, companyId: true },
      });
      if (!lh || !lh.isActive) return { ok: false, error: "Ce papier en-tête n'existe plus." };
      // Le type doit correspondre : un en-tête Word recopié sous un nom `.xlsx` donnerait un
      // fichier qui refuse de s'ouvrir, et l'erreur ne se verrait qu'au moment de l'urgence.
      if (lh.kind !== kind) {
        const label = isOfficeKind(lh.kind) ? KIND_LABEL[lh.kind] : lh.kind;
        return { ok: false, error: `Ce papier en-tête est un modèle ${label} — il ne convient pas ici.` };
      }
      // Le cloisonnement s'applique aussi à la papeterie : on n'écrit pas sur l'en-tête d'une
      // société qu'on ne voit pas. Les en-têtes communs (sans entité) restent ouverts à tous.
      if (lh.companyId) {
        const mine = await getMyCompanies(user.id);
        if (!mine.some((c) => c.id === lh.companyId)) return { ok: false, error: "Ce papier en-tête n'est pas dans votre périmètre." };
      }
      const bytes = await getBlob(lh.blobId);
      if (!bytes) return { ok: false, error: "Le fichier du papier en-tête est introuvable sur le serveur." };
      data = bytes;
      mime = lh.mime || blank.mime;
      letterheadName = lh.name;
    }

    const { blobId, size } = await putBlob(data);
    const node = await prisma.driveNode.create({
      data: {
        name, type: "FILE", parentId: parentId || null, spaceId: effSpaceId, ownerId: user.id, createdById: user.id, mimeType: mime, size,
        versions: { create: { blobId, version: 1, size, mimeType: mime, createdById: user.id } },
      },
      select: { id: true },
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Drive", entityType: "DRIVE_NODE", entityId: node.id,
      summary: `Nouveau document « ${name} »${letterheadName ? ` — papier en-tête « ${letterheadName} »` : ""}`,
    });
    revalidatePath("/drive");
    if (effSpaceId) revalidatePath(`/drive/espace/${effSpaceId}`);
    return { ok: true, id: node.id };
  } catch (err) {
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_")) throw err; // redirect / notFound de Next
    // UNE ERREUR LEVÉE N'ARRIVE PAS À L'ÉCRAN : en production, Next la remplace par un message opaque,
    // et l'écran qui attendait la réponse restait sur sa roue. On la journalise (journaux Render) et on RÉPOND.
    console.error("[drive] createOfficeNode : création du document Office impossible", err);
    const detail = err instanceof Error ? err.message : "";
    // Les refus du stockage sont déjà rédigés pour l'utilisateur (`drive-storage.ts`) : on les relaie.
    if (/^(Le fichier n'a pas pu être enregistré|Fichier trop volumineux)/.test(detail)) return { ok: false, error: detail };
    return {
      ok: false,
      error: "Le document n'a pas pu être créé (erreur du serveur). Réessayez ; si cela persiste, "
        + "signalez-le à l'administrateur.",
    };
  }
}

/**
 * Convertit un fichier Office du Drive (docx / xlsx / pptx) en **PDF** via OnlyOffice,
 * et range le PDF dans le Drive (à côté de la source si possible). Renvoie l'id du PDF.
 */
export async function convertNodeToPdf(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "DRIVE", "CREATE")) return DENIED;
  // LE REFUS NOMME LE GESTE, pas seulement la cause. « éditeur Office non configuré » laisse la
  // personne sans savoir qui le configure ni ce qu'elle peut faire en attendant (§118.30).
  if (!convertConfigured()) {
    return { ok: false, error:
      "Conversion PDF indisponible : l'éditeur Office (OnlyOffice) n'est pas configuré sur ce serveur. "
      + "C'est un réglage d'administration (variables ONLYOFFICE_*) — en attendant, ouvrez le document "
      + "et enregistrez-le en PDF depuis votre poste." };
  }
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fichier introuvable." };
  if ((await resolveDriveAccess(user, id)) === "NONE") return DENIED;

  const node = await prisma.driveNode.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!node || node.type !== "FILE") return { ok: false, error: "Fichier introuvable." };
  if (!onlyofficeEditable(node.name)) {
    // ON NOMME LES FORMATS ADMIS, dérivés de la table de l'éditeur : « ce type ne peut pas être
    // converti » laissait la personne deviner lesquels le peuvent (§118.30, §118.73).
    const ext = fileExt(node.name);
    return { ok: false, error:
      `L'éditeur Office ne sait pas ouvrir un fichier « .${ext || "sans extension"} », donc il ne peut pas l'imprimer en PDF. `
      + `Formats convertibles : ${extensionsEditables().map((e) => `.${e}`).join(", ")}.` };
  }
  const version = node.versions[0];
  if (!version) return { ok: false, error: "Aucun contenu à convertir." };

  // URL signée que le Document Server peut télécharger (serveur-à-serveur).
  const token = makeFileReadToken(id, user.id, 300);
  const srcUrl = `${appBaseUrl()}/api/onlyoffice/file?token=${token}`;
  let pdf: Buffer;
  try {
    pdf = await convertDocument({ srcUrl, fromExt: fileExt(node.name), outputType: "pdf", key: `topdf_${id}_${version.version}` });
  } catch (e) {
    console.error("[drive] conversion PDF échouée", e);
    return { ok: false, error: "La conversion a échoué. Réessayez plus tard." };
  }

  const pdfName = `${node.name.replace(/\.[a-z0-9]+$/i, "")}.pdf`;
  // À côté de la source si on peut éditer son dossier, sinon à la racine (chez soi).
  const parentId = node.parentId && (await resolveDriveAccess(user, node.parentId)) === "EDIT" ? node.parentId : null;
  const { blobId, size } = await putBlob(pdf);
  const created = await prisma.driveNode.create({
    data: {
      name: pdfName, type: "FILE", parentId, ownerId: user.id, createdById: user.id, mimeType: "application/pdf", size,
      versions: { create: { blobId, version: 1, size, mimeType: "application/pdf", createdById: user.id } },
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Drive", entityType: "DRIVE_NODE", entityId: created.id, summary: `PDF généré depuis « ${node.name} »` });
  revalidatePath("/drive");
  return { ok: true, id: created.id };
}

/**
 * AGIR SUR UNE SÉLECTION — corbeille et partage, sur plusieurs éléments à la fois.
 *
 * Sélectionner cinq fichiers puis devoir ouvrir cinq menus pour les supprimer, c'est ne pas avoir
 * de sélection du tout. Les deux actions ci-dessous prennent la liste entière.
 *
 * **Un refus ne fait pas tout échouer** : sur dix éléments dont deux ne nous appartiennent pas,
 * on traite les huit et on dit lesquels ont été refusés. Tout annuler pour deux lignes obligerait
 * à recommencer en devinant lesquelles retirer.
 */
export interface BulkResult { ok: boolean; done: number; denied: number; error?: string }

export async function trashNodes(formData: FormData): Promise<BulkResult> {
  const user = await requireUser();
  const ids = Array.from(new Set(formData.getAll("id").map(String).filter(Boolean)));
  if (ids.length === 0) return { ok: false, done: 0, denied: 0, error: "Aucun élément sélectionné." };

  let done = 0;
  let denied = 0;
  for (const id of ids) {
    if ((await resolveDriveAccess(user, id)) !== "EDIT") { denied += 1; continue; }
    // Cascade : un dossier mis à la corbeille y emmène tout son contenu.
    const subtree = await collectSubtree(id);
    await prisma.driveNode.updateMany({ where: { id: { in: subtree } }, data: { isTrashed: true } });
    done += 1;
  }
  if (done > 0) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: ids[0],
      field: "isTrashed", newValue: "true",
      summary: `Mis à la corbeille (${done} élément·s${denied ? `, ${denied} refusé·s` : ""})`,
    });
    revalidatePath("/drive");
  }
  return {
    ok: done > 0,
    done,
    denied,
    error: done === 0 ? "Vous ne pouvez supprimer aucun des éléments sélectionnés." : undefined,
  };
}

export async function shareNodesWithMany(formData: FormData): Promise<BulkResult> {
  const user = await requireUser();
  const nodeIds = Array.from(new Set(formData.getAll("nodeId").map(String).filter(Boolean)));
  const access = (fdStr(formData, "access") as DriveAccess) ?? "VIEW";
  const userIds = Array.from(new Set(formData.getAll("userId").map(String).filter(Boolean)))
    .filter((id) => id !== user.id);
  if (nodeIds.length === 0) return { ok: false, done: 0, denied: 0, error: "Aucun élément sélectionné." };
  if (userIds.length === 0) return { ok: false, done: 0, denied: 0, error: "Choisissez au moins une personne." };

  let done = 0;
  let denied = 0;
  const sharedNames: string[] = [];
  for (const nodeId of nodeIds) {
    if ((await resolveDriveAccess(user, nodeId)) !== "EDIT") { denied += 1; continue; }
    const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true } });
    if (!node) { denied += 1; continue; }
    for (const userId of userIds) {
      await prisma.driveShare.upsert({
        where: { nodeId_userId: { nodeId, userId } },
        create: { nodeId, userId, access },
        update: { access },
      });
    }
    sharedNames.push(node.name);
    done += 1;
  }

  // UNE notification par personne pour TOUT le lot : partager douze fichiers d'un coup ne doit
  // pas remplir douze fois la boîte de chacun — c'est le meilleur moyen de faire ignorer les
  // notifications suivantes.
  if (done > 0) {
    const body = sharedNames.length === 1
      ? sharedNames[0]
      : `${sharedNames.length} éléments — ${sharedNames.slice(0, 3).join(", ")}${sharedNames.length > 3 ? "…" : ""}`;
    for (const userId of userIds) {
      await notifyUser({
        userId, type: "DOCUMENT_UPLOADED",
        title: sharedNames.length === 1 ? "Élément partagé avec vous" : "Éléments partagés avec vous",
        body, link: sharedNames.length === 1 ? `/drive/${nodeIds[0]}` : "/drive",
      });
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Drive", entityType: "DRIVE_NODE", entityId: nodeIds[0],
      summary: `${done} élément·s partagé·s avec ${userIds.length} personne·s — ${access === "EDIT" ? "modification" : "lecture"}${denied ? ` (${denied} refusé·s)` : ""}`,
    });
    revalidatePath("/drive");
  }
  return {
    ok: done > 0,
    done,
    denied,
    error: done === 0 ? "Vous ne pouvez partager aucun des éléments sélectionnés." : undefined,
  };
}

// ───────────────────────── Copier / coller, comme dans un explorateur ─────────────────────────

/** Au-delà, on refuse plutôt que de copier une arborescence sans fin. */
const COPY_MAX_NODES = 500;

/**
 * COPIER des éléments dans un dossier — Ctrl+C puis Ctrl+V.
 *
 * Le contenu n'est PAS recopié : les blobs sont adressés par leur empreinte, une copie ne fait
 * donc que pointer les mêmes octets. Copier un dossier de 400 Mo ne consomme rien de plus que
 * les quelques lignes de l'arborescence — et c'est ce qui rend le geste utilisable au quotidien
 * plutôt que réservé aux petits fichiers.
 *
 * L'HISTORIQUE NE SE COPIE PAS. La copie part à la version courante : reprendre les dix
 * versions antérieures d'un fichier ferait croire que la copie a une histoire qu'elle n'a pas.
 */
export async function copyNodes(formData: FormData): Promise<BulkResult> {
  const user = await requireUser();
  const ids = formData.getAll("id").map(String).filter(Boolean);
  const targetId = fdStr(formData, "targetId");
  const contextSpaceId = fdStr(formData, "spaceId") || null;
  if (ids.length === 0) return { ok: false, done: 0, denied: 0, error: "Rien à coller." };

  // Destination : le dossier visé, ou la racine de l'emplacement courant.
  let destSpaceId: string | null;
  if (targetId) {
    if ((await resolveDriveAccess(user, targetId)) !== "EDIT") return { ok: false, done: 0, denied: ids.length, error: DENIED.error };
    const t = await prisma.driveNode.findUnique({ where: { id: targetId }, select: { spaceId: true, type: true } });
    if (!t || t.type !== "FOLDER") return { ok: false, done: 0, denied: 0, error: "La destination n'est pas un dossier." };
    destSpaceId = t.spaceId ?? null;
  } else {
    if (contextSpaceId && !(await canCreateInSpace(user, contextSpaceId))) return { ok: false, done: 0, denied: ids.length, error: DENIED.error };
    destSpaceId = contextSpaceId;
  }

  let done = 0;
  let denied = 0;
  let budget = COPY_MAX_NODES;

  /** Duplique un nœud et, si c'est un dossier, tout ce qu'il contient. */
  const duplicate = async (sourceId: string, parentId: string | null): Promise<void> => {
    if (budget <= 0) return;
    const src = await prisma.driveNode.findUnique({
      where: { id: sourceId },
      select: { id: true, name: true, type: true, mimeType: true, size: true, category: true, isTrashed: true },
    });
    if (!src || src.isTrashed) return;
    budget -= 1;

    const nodeData = {
      name: src.name, type: src.type, parentId, spaceId: destSpaceId,
      mimeType: src.mimeType, size: src.size, category: src.category,
      // La copie APPARTIENT à celui qui colle : c'est lui qui en répond désormais, et c'est ce
      // qui lui permet de la renommer ou de la supprimer sans redemander un droit.
      ownerId: user.id, createdById: user.id,
    };

    if (src.type === "FILE") {
      const current = await prisma.fileVersion.findFirst({
        where: { nodeId: sourceId }, orderBy: { version: "desc" },
        select: { blobId: true, size: true, mimeType: true },
      });
      // UN DÉTENTEUR DE PLUS, COMPTÉ (audit du 04/10, constat 3). La copie partage les octets de
      // l'original : sans prendre une référence, supprimer la copie puis l'original rendait le
      // compteur à zéro alors qu'un détenteur restait — et le document d'origine devenait
      // illisible. Nœud, référence et version s'écrivent ensemble, ou rien.
      await prisma.$transaction(async (tx) => {
        const copy = await tx.driveNode.create({ data: nodeData, select: { id: true } });
        if (!current) return;
        if (!(await retainBlob(current.blobId, tx))) {
          throw new Error(`Le contenu de « ${src.name} » est introuvable : la copie n'a pas été créée.`);
        }
        await tx.fileVersion.create({
          data: { nodeId: copy.id, blobId: current.blobId, version: 1, size: current.size, mimeType: current.mimeType, createdById: user.id },
        });
      });
    } else {
      const copy = await prisma.driveNode.create({ data: nodeData, select: { id: true } });
      const children = await prisma.driveNode.findMany({
        where: { parentId: sourceId, isTrashed: false }, select: { id: true }, orderBy: { name: "asc" },
      });
      for (const c of children) await duplicate(c.id, copy.id);
    }
  };

  for (const id of ids) {
    // On ne copie que ce qu'on a le droit de LIRE — copier ouvrirait sinon une porte dérobée
    // vers un contenu qu'on ne pouvait pas voir.
    if (!canViewDrive(await resolveDriveAccess(user, id))) { denied += 1; continue; }
    // Coller un dossier dans lui-même ou dans un de ses descendants boucle sans fin.
    if (targetId && (await collectSubtree(id)).includes(targetId)) { denied += 1; continue; }
    try {
      await duplicate(id, targetId || null);
      done += 1;
    } catch (e) {
      console.error("[drive] copie impossible", id, e);
      denied += 1;
    }
  }

  if (done > 0) {
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Drive", entityType: "DRIVE_NODE", entityId: targetId || "root", summary: `${done} élément(s) copié(s)` });
    revalidatePath("/drive");
  }
  const truncated = budget <= 0;
  return {
    ok: done > 0,
    done, denied,
    error: done === 0
      ? "Rien n'a pu être collé."
      : truncated
        ? `Copie partielle : au-delà de ${COPY_MAX_NODES} éléments, le reste n'a pas été copié.`
        : denied > 0 ? `${denied} élément(s) refusé(s).` : undefined,
  };
}

/**
 * DÉPLACER plusieurs éléments d'un coup — le pendant de `moveNode` pour une sélection.
 *
 * Boucler côté client marcherait, mais chaque échec y arriverait séparément et l'on verrait
 * passer cinq messages d'erreur pour un seul geste.
 */
export async function moveNodes(formData: FormData): Promise<BulkResult> {
  await requireUser();
  const ids = formData.getAll("id").map(String).filter(Boolean);
  if (ids.length === 0) return { ok: false, done: 0, denied: 0, error: "Rien à déplacer." };

  let done = 0;
  let denied = 0;
  for (const id of ids) {
    const one = new FormData();
    one.set("id", id);
    one.set("targetId", fdStr(formData, "targetId") ?? "");
    one.set("spaceId", fdStr(formData, "spaceId") ?? "");
    const r = await moveNode(one);
    if (r.ok) done += 1;
    else denied += 1;
  }
  return { ok: done > 0, done, denied, error: done === 0 ? "Déplacement impossible." : denied > 0 ? `${denied} élément(s) refusé(s).` : undefined };
}
