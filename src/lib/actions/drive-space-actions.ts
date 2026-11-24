"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { canCreateDriveSpace, canManageDriveSpace } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";

const readIds = (fd: FormData, key: string) => [...new Set(fd.getAll(key).map(String).filter(Boolean))];

/** Charge une catégorie et vérifie que l'utilisateur courant peut la GÉRER. */
async function ensureCanManageSpace(userId: string, role: string, spaceId: string): Promise<{ error: string } | { space: { id: string; name: string } }> {
  const space = await prisma.driveSpace.findUnique({ where: { id: spaceId } });
  if (!space) return { error: "Catégorie introuvable." };
  if (!canManageDriveSpace({ id: userId, role } as never, space)) return { error: "Gestion de la catégorie non autorisée." };
  return { space: { id: space.id, name: space.name } };
}

/**
 * Crée une CATÉGORIE (espace partagé) de Drive. Réservé au Super Admin ou à un rôle
 * autorisé par lui (AppSetting.driveSpaceCreatorRoles). Le créateur est ajouté d'office
 * aux gestionnaires afin de pouvoir aussitôt y déposer des fichiers et régler ses accès.
 */
export async function createDriveSpace(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { driveSpaceCreatorRoles } = await getAppSettings();
  if (!canCreateDriveSpace(user, driveSpaceCreatorRoles)) return { ok: false, error: "Création de catégorie non autorisée." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de la catégorie est obligatoire." };

  const managerUserIds = [...new Set([user.id, ...readIds(formData, "managerUserIds")])];
  const created = await prisma.driveSpace.create({
    data: {
      name: name.slice(0, 120),
      icon: fdStr(formData, "icon"),
      accessRoles: readIds(formData, "accessRoles"),
      accessUserIds: readIds(formData, "accessUserIds"),
      managerRoles: readIds(formData, "managerRoles"),
      managerUserIds,
      createdById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Drive", summary: `Catégorie Drive « ${name} »` });
  revalidatePath("/drive");
  return { ok: true, id: created.id };
}

/** Met à jour une catégorie : nom, icône et listes d'accès (consultation + gestion). */
export async function updateDriveSpace(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id || !name) return { ok: false, error: "Paramètres manquants." };
  const guard = await ensureCanManageSpace(user.id, user.role, id);
  if ("error" in guard) return { ok: false, error: guard.error };

  const accessRoles = readIds(formData, "accessRoles");
  const accessUserIds = readIds(formData, "accessUserIds");
  const managerRoles = readIds(formData, "managerRoles");
  // Le créateur/gestionnaire ne peut pas se retirer TOUS les gestionnaires : on garde au moins l'acteur.
  const managerUserIds = [...new Set([...readIds(formData, "managerUserIds"), user.id])];
  await prisma.driveSpace.update({
    where: { id },
    data: { name: name.slice(0, 120), icon: fdStr(formData, "icon"), accessRoles, accessUserIds, managerRoles, managerUserIds },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Drive",
    summary: `Catégorie « ${name} » modifiée — accès : ${accessRoles.length} rôle(s) + ${accessUserIds.length} personne(s) ; gestion : ${managerRoles.length} rôle(s) + ${managerUserIds.length} personne(s)`,
  });
  revalidatePath("/drive");
  revalidatePath(`/drive/espace/${id}`);
  return { ok: true };
}

/** Archive / désarchive une catégorie (masquée des onglets sans rien supprimer). */
export async function archiveDriveSpace(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const guard = await ensureCanManageSpace(user.id, user.role, id);
  if ("error" in guard) return { ok: false, error: guard.error };
  const archived = fdStr(formData, "archived") === "1";
  await prisma.driveSpace.update({ where: { id }, data: { isArchived: archived } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Drive", summary: `Catégorie « ${guard.space.name} » ${archived ? "archivée" : "réactivée"}` });
  revalidatePath("/drive");
  return { ok: true };
}

/**
 * Supprime une catégorie et TOUT son contenu (fichiers/dossiers) — réservé au Super Admin. RÉVERSIBLE (audit du
 * Drive, 24/11, point A5) : la catégorie part à la corbeille du Super Admin avec tout ce qu'elle contient, et en
 * revient de même ; les octets ne sont rendus qu'à la destruction réelle (`destroyDeletedRecord`).
 */
export async function deleteDriveSpace(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Suppression d'une catégorie réservée au Super Admin." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const space = await prisma.driveSpace.findUnique({ where: { id }, select: { name: true, _count: { select: { nodes: true } } } });
  if (!space) return { ok: false, error: "Catégorie introuvable." };
  const r = await supprimerReversible("DRIVE_SPACE", id, user.id, `Catégorie « ${space.name} » mise à la corbeille (${space._count.nodes} élément(s)) — restaurable depuis la corbeille`);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/drive");
  return { ok: true };
}
