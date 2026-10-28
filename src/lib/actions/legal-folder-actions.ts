"use server";

import { ouvrirPourEcrire } from "@/lib/acces/objet";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getMyCompanies } from "@/lib/company";
import { canReparent, type FolderLite } from "@/lib/legal/folders";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * LES DOSSIERS DE CLASSEMENT DE LEGAL.
 *
 * Un dossier RANGE, il n'AUTORISE pas : la restriction d'un engagement reste sur lui (ses
 * lecteurs désignés) et sur son entité. C'est pourquoi ces actions ne touchent jamais aux
 * lecteurs d'un document — y ranger une pièce ne doit rien ouvrir à personne.
 */

const PATH = "/legal";

/** Tous les dossiers, en forme légère — ce dont les règles pures ont besoin. */
async function allFolders(): Promise<FolderLite[]> {
  return prisma.legalFolder.findMany({ select: { id: true, name: true, parentId: true, companyId: true } });
}

/** L'entité demandée est-elle dans le périmètre ? On ne classe pas dans une société qu'on ne voit pas. */
async function companyAllowed(userId: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return true;
  const mine = await getMyCompanies(userId);
  return mine.some((c) => c.id === companyId);
}

export async function createLegalFolder(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "LEGAL", "CREATE")) return { ok: false, error: "Non autorisé." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Donnez un nom au dossier." };

  const companyId = fdStr(formData, "companyId");
  if (!(await companyAllowed(user.id, companyId))) return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };

  const parentId = fdStr(formData, "parentId");
  if (parentId) {
    const parent = await prisma.legalFolder.findUnique({ where: { id: parentId }, select: { id: true } });
    if (!parent) return { ok: false, error: "Dossier parent introuvable." };
  }

  const created = await prisma.legalFolder.create({
    data: { name, companyId: companyId || null, parentId: parentId || null, description: fdStr(formData, "description"), createdById: user.id },
    select: { id: true },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: created.id,
    summary: `Dossier de classement « ${name} » créé`,
  });
  revalidatePath(PATH);
  return { ok: true, id: created.id };
}

/** Renomme un dossier, ou le déplace sous un autre. */
export async function updateLegalFolder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  // LA PORTE DU DOSSIER (audit 27/10, SA-16) : le droit du module ET sa société — la création la vérifiait déjà.
  const porte = await ouvrirPourEcrire(user, "LEGAL_FOLDER", id, "UPDATE");
  if (!porte.ok) return porte;
  const existing = await prisma.legalFolder.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return { ok: false, error: "Dossier introuvable." };

  const parentRaw = formData.get("parentId");
  const nextParent = parentRaw != null ? (String(parentRaw) || null) : undefined;
  if (nextParent !== undefined && !canReparent(await allFolders(), id, nextParent)) {
    // Créer une boucle ferait disparaître le dossier — et tout ce qu'il contient — de l'arbre.
    return { ok: false, error: "Un dossier ne peut pas être rangé dans lui-même ni dans l'un de ses sous-dossiers." };
  }

  const companyRaw = formData.get("companyId");
  if (companyRaw != null && !(await companyAllowed(user.id, String(companyRaw) || null))) {
    return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
  }

  const name = fdStr(formData, "name") || existing.name;
  await prisma.legalFolder.update({
    where: { id },
    data: {
      name,
      description: formData.has("description") ? fdStr(formData, "description") : undefined,
      ...(nextParent !== undefined ? { parentId: nextParent } : {}),
      ...(companyRaw != null ? { companyId: String(companyRaw) || null } : {}),
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: id,
    summary: `Dossier de classement modifié : ${existing.name}${name !== existing.name ? ` → ${name}` : ""}`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Supprime un dossier. Ses SOUS-DOSSIERS partent avec lui (ils n'ont pas de sens sans leur
 * parent) ; ses DOCUMENTS repassent « non classés » — jamais supprimés.
 *
 * Ranger un engagement dans un dossier ne doit pas offrir un moyen détourné de le faire
 * disparaître : c'est la contrainte de base (`ON DELETE SET NULL`) qui le garantit, pas une
 * précaution d'écran.
 */
export async function deleteLegalFolder(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  // LA PORTE DU DOSSIER (audit 27/10, SA-16) : le droit du module ET sa société — la création la vérifiait déjà.
  const porte = await ouvrirPourEcrire(user, "LEGAL_FOLDER", id, "DELETE");
  if (!porte.ok) return porte;
  const existing = await prisma.legalFolder.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return { ok: false, error: "Dossier introuvable." };

  await prisma.legalFolder.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: id,
    summary: `Dossier de classement « ${existing.name} » supprimé (documents déclassés, non supprimés)`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Range un ou plusieurs engagements dans un dossier — ou les en sort (`folderId` vide).
 *
 * Le contrôle porte sur chaque document : on ne range que ce qu'on a le droit de modifier, et
 * le classement ne change RIEN à qui peut le lire.
 */
export async function moveLegalDocuments(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "LEGAL", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const ids = [...new Set(formData.getAll("documentId").map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Aucun document sélectionné." };

  const folderId = fdStr(formData, "folderId");
  let folderName = "Non classés";
  if (folderId) {
    // On ne range pas dans le dossier d'une société qu'on ne voit pas (SA-16).
    const porte = await ouvrirPourEcrire(user, "LEGAL_FOLDER", folderId, "UPDATE");
    if (!porte.ok) return porte;
    const folder = await prisma.legalFolder.findUnique({ where: { id: folderId }, select: { name: true } });
    if (!folder) return { ok: false, error: "Dossier introuvable." };
    folderName = folder.name;
  }

  // Le cloisonnement d'entité s'applique au classement comme au reste : on ne déplace pas un
  // engagement d'une société qu'on ne voit pas, même en devinant son identifiant.
  const mine = await getMyCompanies(user.id);
  const movable = await prisma.legalDocument.findMany({
    where: { id: { in: ids }, OR: [{ companyId: null }, { companyId: { in: mine.map((c) => c.id) } }] },
    select: { id: true },
  });
  if (movable.length === 0) return { ok: false, error: "Ces documents ne sont pas dans votre périmètre." };

  // porte d'écriture : `movable` ne garde que les pièces des sociétés de la personne (filtre ci-dessus).
  await prisma.legalDocument.updateMany({
    where: { id: { in: movable.map((d) => d.id) } },
    data: { folderId: folderId || null },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    summary: `${movable.length} engagement(s) rangé(s) dans « ${folderName} »`,
  });
  revalidatePath(PATH);
  return { ok: true, message: `${movable.length} document(s) rangé(s) dans « ${folderName} ».` };
}
