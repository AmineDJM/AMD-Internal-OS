import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { rolesWithModule } from "@/lib/rbac";

/**
 * MIROIR DRIVE d'un contrat de travail — dans une CATÉGORIE RH, jamais dans un Drive personnel.
 *
 * Un contrat déposé depuis la fiche employé doit se retrouver dans le Drive : c'est là qu'on va
 * le chercher trois ans plus tard, quand la personne qui l'a déposé a changé de poste. La
 * version précédente de ce miroir le rangeait dans le Drive PERSONNEL du RH qui téléversait —
 * ce qui liait les contrats de la société au compte d'un salarié, et les faisait disparaître de
 * la vue des autres RH.
 *
 * Il vit désormais dans une **catégorie de Drive** dont l'accès est explicite : les rôles qui
 * gouvernent le module RH, et eux seuls. Pas de partage nominatif à maintenir, pas d'arbre
 * appartenant à quelqu'un.
 *
 * ⚠️ Une réserve, dite franchement : les comptes dont le Drive a une portée GLOBALE (Direction,
 * Super Admin) voient tout le Drive, catégories comprises — c'est une règle de plateforme, pas
 * un défaut de ce module. « Réservé aux RH » signifie donc ici : invisible du salarié et de
 * toute personne étrangère aux ressources humaines, à l'exception de la direction générale.
 *
 * **Best-effort** : ne doit JAMAIS faire échouer le dépôt RH (toute erreur est journalisée et
 * avalée). Dédup : même nom dans le même dossier → nouvelle VERSION, pas un doublon.
 */

const HR_CONTRACT_SPACE = "RH — Contrats";

/**
 * La catégorie « RH — Contrats », créée à la première utilisation et ouverte aux seuls rôles
 * qui gouvernent le module RH.
 *
 * Les rôles sont LUS dans la matrice RBAC, jamais écrits à la main : une liste recopiée ici
 * serait fausse le jour où un rôle RH est ajouté, et le contrat atterrirait dans une catégorie
 * que plus personne des ressources humaines ne peut ouvrir.
 */
async function ensureContractSpace(creatorId: string): Promise<string> {
  const existing = await prisma.driveSpace.findFirst({
    where: { name: HR_CONTRACT_SPACE, isArchived: false },
    select: { id: true },
  });
  if (existing) return existing.id;
  const hrRoles = rolesWithModule("RH");
  const space = await prisma.driveSpace.create({
    data: {
      name: HR_CONTRACT_SPACE, icon: "FileSignature",
      accessRoles: hrRoles, managerRoles: hrRoles,
      createdById: creatorId,
    },
    select: { id: true },
  });
  return space.id;
}

/** Trouve/crée un dossier Drive DANS la catégorie (par nom, sous parent) — idempotent. */
async function ensureFolder(name: string, parentId: string | null, spaceId: string, ownerId: string): Promise<string> {
  const existing = await prisma.driveNode.findFirst({
    where: { type: "FOLDER", name, parentId, spaceId, isTrashed: false },
    select: { id: true },
  });
  if (existing) return existing.id;
  const node = await prisma.driveNode.create({
    data: { name, type: "FOLDER", parentId, spaceId, ownerId, createdById: ownerId },
    select: { id: true },
  });
  return node.id;
}

export async function mirrorEmployeeContractToDrive(opts: {
  ownerId: string;
  employeeName: string;
  filename: string;
  data: Buffer;
  mime?: string;
}): Promise<void> {
  try {
    const spaceId = await ensureContractSpace(opts.ownerId);
    const folderId = await ensureFolder(opts.employeeName.trim() || "Employé", null, spaceId, opts.ownerId);
    const { blobId, size } = await putBlob(opts.data);
    const mimeType = opts.mime || "application/octet-stream";

    const existing = await prisma.driveNode.findFirst({
      where: { type: "FILE", name: opts.filename, parentId: folderId, isTrashed: false },
      select: { id: true },
    });
    if (existing) {
      const last = await prisma.fileVersion.findFirst({ where: { nodeId: existing.id }, orderBy: { version: "desc" }, select: { version: true } });
      await prisma.fileVersion.create({ data: { nodeId: existing.id, blobId, version: (last?.version ?? 0) + 1, size, mimeType, createdById: opts.ownerId } });
      await prisma.driveNode.update({ where: { id: existing.id }, data: { size, mimeType } });
    } else {
      await prisma.driveNode.create({
        data: {
          name: opts.filename, type: "FILE", parentId: folderId, spaceId, ownerId: opts.ownerId, mimeType, size, createdById: opts.ownerId,
          versions: { create: { blobId, version: 1, size, mimeType, createdById: opts.ownerId } },
        },
      });
    }
  } catch (e) {
    console.error("[hr-drive-mirror] miroir contrat → Drive échoué (non-bloquant)", e);
  }
}
