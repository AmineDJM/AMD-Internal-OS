import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { resolveDriveAccess, effectiveSpaceId, canCreateInSpace } from "@/lib/drive";
import { recordAudit } from "@/lib/audit";
import type { SessionUser } from "@/lib/rbac";
import { signalerFichierDrive } from "@/lib/enrichissement/signalement";
import { inscrireFichierDrive } from "@/modules/bibliotheque/api-inscription";
import { ajouterVersionDrive, rendreBlobOrphelin } from "@/lib/drive/versions";
import { refusDepotPhrase, nomLibre, nomApresNouvelleVersion, type ChoixDoublon } from "@/lib/drive/depot-regles";

/**
 * DÉPOSER UN FICHIER DANS LE DRIVE — la porte et l'écriture, une seule fois pour les deux chemins.
 *
 * Le chemin habituel (le serveur reçoit le fichier) et le chemin DIRECT (le navigateur écrit
 * dans le bucket, le serveur finalise) doivent répondre la même chose à « ai-je le droit ? » et
 * créer le même fichier. Deux copies de cette règle finiraient par ne plus accorder la même chose
 * (§118.5) : on la sort ici, et les deux routes l'appellent.
 */

export interface CibleDepot {
  /** Nouvelle VERSION de ce fichier. */
  nodeId?: string | null;
  /** Nouveau fichier dans ce dossier. */
  parentId?: string | null;
  /** Nouveau fichier à la racine de cette catégorie. */
  spaceId?: string | null;
  category?: string | null;
  viewers?: string[];
  editors?: string[];
  /**
   * Un fichier du même nom existe déjà à cet endroit (audit Drive, C2) : « version » = nouvelle
   * version de celui-ci (si l'on peut le modifier), « garder » = un second fichier, renommé
   * « nom (2).ext ». Absent = comportement d'avant (le dépôt ne regarde pas les noms).
   */
  siExiste?: ChoixDoublon | null;
}

/**
 * Autorisation d'écriture. Un accès ÉDITEUR explicite sur la cible suffit, même sans le droit
 * module « Téléverser » :
 *  - nouvelle version d'un fichier → éditeur sur CE fichier ;
 *  - nouveau fichier dans un dossier → éditeur sur CE dossier ;
 *  - nouveau fichier à la racine d'une CATÉGORIE → gestionnaire de la catégorie ;
 *  - nouveau fichier à la racine (espace perso) → droit module « Téléverser ».
 * Rend le refus (et son code HTTP), ou `null`.
 */
export async function refusDepotDrive(user: SessionUser, cible: CibleDepot): Promise<{ error: string; status: number } | null> {
  if (cible.nodeId) {
    if ((await resolveDriveAccess(user, cible.nodeId)) !== "EDIT") return { error: refusDepotPhrase(await quiOuvre(cible.nodeId, null)), status: 403 };
  } else if (cible.parentId) {
    if ((await resolveDriveAccess(user, cible.parentId)) !== "EDIT") return { error: refusDepotPhrase(await quiOuvre(cible.parentId, null)), status: 403 };
  } else if (cible.spaceId) {
    if (!(await canCreateInSpace(user, cible.spaceId))) return { error: refusDepotPhrase(await quiOuvre(null, cible.spaceId)), status: 403 };
  } else if (!userCan(user, "DRIVE", "UPLOAD")) {
    return { error: "Vous ne pouvez pas encore déposer dans « Mes fichiers » : demandez le droit « Téléverser » du Drive à l'administrateur de la plateforme.", status: 403 };
  }
  return null;
}

/**
 * QUI PEUT OUVRIR L'ACCÈS (le remède d'un refus, point C10) : les gestionnaires nommés de la
 * catégorie, sinon le propriétaire du dossier ou du fichier. `null` quand personne n'est nommé.
 */
async function quiOuvre(nodeId: string | null, spaceId: string | null): Promise<string | null> {
  let sid = spaceId;
  if (nodeId) {
    const n = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { spaceId: true, owner: { select: { name: true } } } });
    if (!n) return null;
    if (!n.spaceId) return n.owner?.name ?? null;
    sid = n.spaceId;
  }
  if (!sid) return null;
  const s = await prisma.driveSpace.findUnique({ where: { id: sid }, select: { name: true, managerUserIds: true } });
  if (!s) return null;
  const noms = (await prisma.user.findMany({ where: { id: { in: s.managerUserIds }, isActive: true }, select: { name: true }, take: 2 })).map((u) => u.name);
  return noms.length ? noms.join(" ou ") : `un gestionnaire de la catégorie « ${s.name} »`;
}

/** Les fichiers (non corbeillés) déjà présents à cet endroit sous l'un de ces noms. */
export async function fichiersHomonymes(
  emplacement: { parentId?: string | null; spaceId?: string | null; ownerId: string },
  noms: string[],
): Promise<{ id: string; name: string }[]> {
  if (noms.length === 0) return [];
  const ou = emplacement.parentId
    ? { parentId: emplacement.parentId }
    : emplacement.spaceId ? { parentId: null, spaceId: emplacement.spaceId } : { parentId: null, spaceId: null, ownerId: emplacement.ownerId };
  return prisma.driveNode.findMany({
    where: { ...ou, type: "FILE", isTrashed: false, OR: noms.map((n) => ({ name: { equals: n, mode: "insensitive" as const } })) },
    select: { id: true, name: true }, orderBy: { createdAt: "asc" },
  });
}

/**
 * APPLIQUE LE CHOIX « EXISTE DÉJÀ ICI » : la cible devient le fichier existant (nouvelle version,
 * si on peut le modifier), ou le nom devient libre (garder les deux). Une nouvelle version d'un
 * autre type prend l'extension du contenu déposé (sinon l'aperçu se tromperait de format).
 */
async function appliquerChoixDoublon(user: SessionUser, cible: CibleDepot, nom: string): Promise<{ cible: CibleDepot; nom: string }> {
  if (!cible.nodeId && cible.siExiste) {
    const ou = { parentId: cible.parentId ?? null, spaceId: cible.parentId ? null : cible.spaceId ?? null, ownerId: user.id };
    const homonymes = await fichiersHomonymes(ou, [nom]);
    if (homonymes.length > 0) {
      const premier = homonymes[0];
      if (cible.siExiste === "version" && (await resolveDriveAccess(user, premier.id)) === "EDIT") {
        cible = { ...cible, nodeId: premier.id };
      } else {
        // Garder les deux — ou une version refusée faute de droit sur l'existant : on n'écrase rien.
        const voisins = await prisma.driveNode.findMany({ where: { parentId: ou.parentId, ...(ou.parentId ? {} : { spaceId: ou.spaceId, ...(ou.spaceId ? {} : { ownerId: user.id }) }), isTrashed: false }, select: { name: true } });
        nom = nomLibre(nom, voisins.map((v) => v.name));
      }
    }
  }
  if (cible.nodeId) {
    const n = await prisma.driveNode.findUnique({ where: { id: cible.nodeId }, select: { name: true } });
    const renomme = n ? nomApresNouvelleVersion(n.name, nom) : null;
    if (n && renomme && renomme !== n.name) await prisma.driveNode.update({ where: { id: cible.nodeId }, data: { name: renomme } });
  }
  return { cible, nom };
}

/**
 * Inscrit le fichier (nouvelle version, ou nouveau nœud + partages) pour un blob DÉJÀ écrit.
 * Rend l'identifiant du nœud et, pour une version, son numéro.
 */
export async function enregistrerFichierDrive(
  user: SessionUser,
  cible: CibleDepot,
  fichier: {
    blobId: string; size: number; mimeType: string; name: string;
    /** L'empreinte du contenu quand l'appelant l'a (`putBlob().sha256`) ; sinon relue sur le blob. */
    sha256?: string | null;
  },
  options: {
    /**
     * Rendre le blob si l'inscription échoue (défaut : oui — `putBlob` l'a compté pour l'appelant, et sans ligne qui
     * le tienne il resterait compté pour rien). Le dépôt DIRECT dit non : son objet doit survivre pour la reprise.
     */
    rendreSiEchec?: boolean;
  } = {},
): Promise<{ id: string; version?: number }> {
  const choix = await appliquerChoixDoublon(user, cible, fichier.name);
  cible = choix.cible;
  fichier = { ...fichier, name: choix.nom };
  const { blobId, size, mimeType, name } = fichier;
  // La pièce nourrit les fiches (refonte, lot V2-A), une fois le fichier inscrit — interrupteur fermé : rien.
  // Et elle entre à la bibliothèque (J1) : registre, clé d'accès du nœud, file d'ingestion. Ni l'un ni l'autre ne lève.
  const signaler = async (nodeId: string, version: number | null) => {
    await signalerFichierDrive({ nodeId, version, blobId, sha256: fichier.sha256 ?? null, nom: name, mime: mimeType, taille: size, deposeParId: user.id });
    await inscrireFichierDrive({ nodeId, version, blobId, sha256: fichier.sha256 ?? null, nom: name, mime: mimeType, taille: size, deposeParId: user.id });
  };
  const rendre = async () => {
    if (options.rendreSiEchec !== false) await rendreBlobOrphelin(blobId, "drive.depot.enregistrerFichierDrive.rendreBlob");
  };
  if (cible.nodeId) {
    const nodeId = cible.nodeId;
    // Numéro sous verrou (`ajouterVersionDrive`) : deux nouvelles versions déposées en même temps en font deux, pas une P2002.
    let version: number;
    try {
      ({ version } = await ajouterVersionDrive({ nodeId, blobId, size, mimeType, createdById: user.id }));
    } catch (e) {
      await rendre();
      throw e;
    }
    await recordAudit({ actorId: user.id, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: nodeId, summary: `Nouvelle version (v${version})` });
    await signaler(nodeId, version);
    return { id: nodeId, version };
  }

  const category = (cible.category ?? "").trim() || null;
  const parentId = cible.parentId ?? null;
  const effSpaceId = await effectiveSpaceId(parentId, cible.spaceId ?? null);
  let node: { id: string };
  try {
    node = await prisma.driveNode.create({
      data: {
        name, type: "FILE", parentId, spaceId: effSpaceId, ownerId: user.id, mimeType, size, category, createdById: user.id,
        versions: { create: { blobId, version: 1, size, mimeType, createdById: user.id } },
      },
      select: { id: true },
    });
  } catch (e) {
    await rendre();
    throw e;
  }

  // Crée les partages (EDIT prioritaire sur VIEW ; on ignore l'auteur et les IDs invalides).
  const editorIds = new Set((cible.editors ?? []).filter((id) => id && id !== user.id));
  const viewerIds = new Set((cible.viewers ?? []).filter((id) => id && id !== user.id && !editorIds.has(id)));
  const ids = [...editorIds, ...viewerIds];
  if (ids.length) {
    const valid = new Set(
      (await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } })).map((u) => u.id),
    );
    const shareData = [
      ...[...editorIds].filter((id) => valid.has(id)).map((userId) => ({ nodeId: node.id, userId, access: "EDIT" as const })),
      ...[...viewerIds].filter((id) => valid.has(id)).map((userId) => ({ nodeId: node.id, userId, access: "VIEW" as const })),
    ];
    if (shareData.length) await prisma.driveShare.createMany({ data: shareData, skipDuplicates: true });
  }

  await recordAudit({ actorId: user.id, action: "UPLOAD", module: "Drive", entityType: "DRIVE_NODE", entityId: node.id, summary: `Fichier « ${name} »${category ? ` · ${category}` : ""}${ids.length ? ` · partagé (${ids.length})` : ""}` });
  await signaler(node.id, null);
  return { id: node.id };
}
