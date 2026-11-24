import type { DriveNodeType, Prisma } from "@prisma/client";
import { canManageDriveSpace, canViewDriveSpace, userCan, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { resolveDriveAccess, driveBreadcrumb, type DriveAccessLevel } from "@/lib/drive";
import { estEspaceAdamDAutrui } from "@/lib/drive/espace-adam";
import { MES_FICHIERS } from "@/lib/drive/explorer";
import { matchesQuery } from "@/lib/drive/search";

/** Ligne du Drive prête pour l'UI, avec le droit d'édition **résolu par nœud**. */
export interface DriveNodeRow {
  id: string;
  name: string;
  type: DriveNodeType;
  mimeType: string | null;
  size: number;
  category: string | null;
  isTrashed: boolean;
  updatedAt: Date;
  owner: { name: string } | null;
  /** L'utilisateur courant peut-il modifier CE nœud (renommer / corbeille / déplacer) ? */
  canEdit: boolean;
  /** Compteurs des icônes de la ligne (Partage, Commentaires) et de l'en-tête du menu « ⋯ ». */
  counts: { shares: number; comments: number; versions: number };
  /** Corbeille : l'endroit d'où l'élément a été supprimé (« Mes fichiers », une catégorie, un dossier). */
  supprimeDe?: string;
  /** Corbeille : la personne peut-elle encore OUVRIR l'élément ? Sinon, son nom n'est pas un lien. */
  ouvrable?: boolean;
}

export interface DriveListing {
  folder: { id: string; name: string } | null;
  breadcrumb: { id: string; name: string }[];
  nodes: DriveNodeRow[];
  /** Droit sur le dossier courant (gouverne « Nouveau dossier / Importer ici »). */
  level: DriveAccessLevel;
  trash: boolean;
  /** Catégorie (espace partagé) en cours de consultation ; null = Drive personnel. */
  space?: { id: string; name: string; canManage: boolean } | null;
}

/** Onglet d'une catégorie visible par l'utilisateur (à côté de Drive · Documents). */
export interface DriveSpaceTab { id: string; name: string; icon: string | null; canManage: boolean }

type RawNode = {
  id: string; name: string; type: DriveNodeType; mimeType: string | null; size: number;
  category: string | null; isTrashed: boolean; ownerId: string | null; spaceId: string | null; updatedAt: Date;
  owner: { name: string } | null; shares: { access: string }[];
  _count?: { shares: number; comments: number; versions: number };
};

/** La catégorie d'un nœud est-elle visible pour cette personne ? (`null` = Drive personnel : non.) */
export async function voitLaCategorie(user: SessionUser, spaceId: string | null): Promise<boolean> {
  if (!spaceId) return false;
  const s = await prisma.driveSpace.findUnique({ where: { id: spaceId } });
  return !!s && !s.isArchived && canViewDriveSpace(user, s);
}

/**
 * LE FIL D'ARIANE QU'ON PEUT SUIVRE — un dossier partagé s'ouvre au milieu de l'arborescence d'un
 * autre (« Messagerie / Conversation / Envoi du… » de l'expéditeur) : afficher ces parents, c'était
 * montrer des noms de dossiers privés et des liens qui menaient à un refus. Le fil commence au
 * premier dossier OUVERT à la personne (le droit descend : tout ce qui est en dessous l'est aussi).
 */
async function filAccessible(user: SessionUser, fil: { id: string; name: string }[]): Promise<{ id: string; name: string }[]> {
  if (user.role === "SUPER_ADMIN") return fil;
  for (let i = 0; i < fil.length - 1; i++) {
    if ((await resolveDriveAccess(user, fil[i].id)) !== "NONE") return fil.slice(i);
  }
  return fil.slice(-1);
}

/** Catégories (espaces partagés) que l'utilisateur peut voir — pour les onglets du Drive. */
export async function getDriveSpacesForUser(user: SessionUser): Promise<DriveSpaceTab[]> {
  const spaces = await prisma.driveSpace.findMany({ where: { isArchived: false }, orderBy: { name: "asc" } });
  return spaces
    // L'espace d'Adam d'une autre personne n'est l'onglet de personne d'autre — Super Admin compris (lot I3, décision 0065).
    .filter((s) => canViewDriveSpace(user, s) && !estEspaceAdamDAutrui(s, user.id))
    .map((s) => ({ id: s.id, name: s.name, icon: s.icon, canManage: canManageDriveSpace(user, s) }));
}

/**
 * Onglets du module Documents : « Drive » · « Documents » PUIS chaque CATÉGORIE visible
 * (« Promotion Médicale »…), présentés côte à côte. Utilisé par /drive, /documents et
 * /drive/espace/[id] pour une barre d'onglets identique.
 */
export async function getDriveTabs(user: SessionUser): Promise<{ label: string; href: string; show: boolean }[]> {
  const spaces = await getDriveSpacesForUser(user);
  // « Drive » = le Drive personnel. L'onglet « Documents » a été retiré : tout passe par le Drive
  // et les catégories. Depuis le Drive, on glisse des dossiers vers une catégorie.
  return [
    { label: MES_FICHIERS, href: "/drive", show: userCan(user, "DRIVE", "VIEW") },
    ...spaces.map((s) => ({ label: s.name, href: `/drive/espace/${s.id}`, show: true })),
  ];
}

/**
 * LES NŒUDS QU'UNE PERSONNE PEUT VOIR, en une clause Prisma.
 *
 * Sert aux vues TRANSVERSES de l'explorateur — « Récents », « Téléchargements » — qui ne
 * parcourent pas l'arborescence et ne peuvent donc pas s'appuyer sur l'héritage de droits calculé
 * dossier par dossier (`resolveDriveAccess`).
 *
 * Le filtre est volontairement CONSERVATEUR : il retient ce qu'on possède, ce qui nous est
 * partagé nommément, et les catégories auxquelles on a accès — mais pas un fichier dont le droit
 * ne viendrait que d'un dossier parent partagé. Un raccourci qui montre trop est une fuite ; un
 * raccourci qui montre un peu moins reste un raccourci, et le fichier se retrouve par son dossier.
 */
export async function driveVisibilityWhere(user: SessionUser): Promise<Prisma.DriveNodeWhereInput> {
  const scopeAll = user.role === "SUPER_ADMIN" || user.access.modules.get("DRIVE")?.scope === "ALL";
  if (scopeAll) return {};
  const spaces = await getDriveSpacesForUser(user);
  const ors: Prisma.DriveNodeWhereInput[] = [
    { ownerId: user.id },
    { shares: { some: { userId: user.id } } },
  ];
  if (spaces.length > 0) ors.push({ spaceId: { in: spaces.map((s) => s.id) } });
  return { OR: ors };
}

function nodeInclude(userId: string) {
  return {
    owner: { select: { name: true } },
    shares: { where: { userId }, select: { access: true } },
    // Trois COMPTEURS, pas les données : les partages, versions et commentaires eux-mêmes ne se
    // lisent qu'à l'ouverture de leur panneau — c'est ce qui garde l'ouverture d'un fichier légère.
    _count: { select: { shares: true, comments: true, versions: true } },
  };
}
function nodeArgs(userId: string) {
  return {
    include: nodeInclude(userId),
    orderBy: [{ type: "desc" as const }, { name: "asc" as const }], // dossiers avant fichiers
  };
}

/** Droit d'édition effectif sur un nœud listé (sans requête supplémentaire). */
function rowCanEdit(user: SessionUser, n: RawNode, inheritedEdit: boolean): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  if (n.ownerId === user.id) return true;
  if (n.shares.some((s) => s.access === "EDIT")) return true;
  return inheritedEdit;
}

function toRow(user: SessionUser, n: RawNode, inheritedEdit: boolean): DriveNodeRow {
  return {
    id: n.id, name: n.name, type: n.type, mimeType: n.mimeType, size: n.size,
    category: n.category, isTrashed: n.isTrashed, updatedAt: n.updatedAt, owner: n.owner,
    canEdit: rowCanEdit(user, n, inheritedEdit),
    counts: { shares: n._count?.shares ?? 0, comments: n._count?.comments ?? 0, versions: n._count?.versions ?? 0 },
  };
}

/**
 * List a folder's contents (or the roots / trash), enforcing access.
 * `spaceId` = null → Drive PERSONNEL (racine = ses fichiers + partages) ; sinon → la
 * CATÉGORIE partagée correspondante (racine = tous les nœuds de la catégorie).
 */
export async function getDriveListing(
  user: SessionUser,
  folderId: string | null,
  trash: boolean,
  spaceId: string | null = null,
): Promise<DriveListing | null> {
  // Catégorie demandée : la charger et vérifier l'accès en amont.
  let space: DriveListing["space"] = null;
  let spaceManage = false;
  if (spaceId) {
    const s = await prisma.driveSpace.findUnique({ where: { id: spaceId } });
    if (!s || s.isArchived || !canViewDriveSpace(user, s) || estEspaceAdamDAutrui(s, user.id)) return null;
    spaceManage = canManageDriveSpace(user, s);
    space = { id: s.id, name: s.name, canManage: spaceManage };
  }

  if (trash) {
    // LA corbeille de la personne : tout ce qu'ELLE a supprimé, de ses fichiers comme des catégories.
    if (!spaceId) return { folder: null, breadcrumb: [], nodes: await getCorbeille(user), level: "EDIT", trash: true, space: null };
    // La corbeille d'une catégorie (tout ce qui y a été supprimé, par qui que ce soit) reste à ses gestionnaires.
    if (!spaceManage) return null;
    const where = spaceId
      ? { spaceId, isTrashed: true, OR: [{ parentId: null }, { parent: { isTrashed: false } }] }
      : { ownerId: user.id, spaceId: null, isTrashed: true, OR: [{ parentId: null }, { parent: { isTrashed: false } }] };
    const nodes = (await prisma.driveNode.findMany({ where, ...nodeArgs(user.id) })) as RawNode[];
    const inherited = spaceId ? spaceManage : true;
    return { folder: null, breadcrumb: [], nodes: nodes.map((n) => toRow(user, n, inherited)), level: inherited ? "EDIT" : "VIEW", trash: true, space };
  }

  if (folderId) {
    const level = await resolveDriveAccess(user, folderId);
    if (level === "NONE") return null;
    const folder = await prisma.driveNode.findUnique({ where: { id: folderId }, select: { id: true, name: true, isTrashed: true, spaceId: true } });
    if (!folder || folder.isTrashed) return null; // pas de navigation dans un dossier corbeillé
    // Garde-fou : un dossier consulté via l'onglet d'une catégorie doit appartenir à CETTE catégorie
    // (et un dossier personnel ne se consulte pas via un onglet de catégorie, et inversement).
    // Seule exception : le dossier d'une catégorie qu'on ne voit pas, mais qui nous a été PARTAGÉ
    // (nommément ou joint à un message) — il n'a pas d'onglet chez nous, il s'ouvre dans « Drive ».
    if ((folder.spaceId ?? null) !== (spaceId ?? null) && !(spaceId === null && !(await voitLaCategorie(user, folder.spaceId)))) return null;
    const nodes = (await prisma.driveNode.findMany({ where: { parentId: folderId, isTrashed: false }, ...nodeArgs(user.id) })) as RawNode[];
    const breadcrumb = await filAccessible(user, await driveBreadcrumb(folderId));
    return { folder: { id: folder.id, name: folder.name }, breadcrumb, nodes: nodes.map((n) => toRow(user, n, level === "EDIT")), level, trash: false, space };
  }

  // Racine d'une CATÉGORIE : tous ses nœuds de 1er niveau (partagés entre les membres).
  if (spaceId) {
    const nodes = (await prisma.driveNode.findMany({ where: { spaceId, parentId: null, isTrashed: false }, ...nodeArgs(user.id) })) as RawNode[];
    return { folder: null, breadcrumb: [], nodes: nodes.map((n) => toRow(user, n, spaceManage)), level: spaceManage ? "EDIT" : "VIEW", trash: false, space };
  }

  // Racine PERSONNELLE : ses propres dossiers/fichiers + ceux partagés (ou tout, si scope ALL) —
  // à l'EXCLUSION des nœuds de catégories (spaceId null), qui vivent dans leurs propres onglets.
  const scopeAll = user.role === "SUPER_ADMIN" || user.access.modules.get("DRIVE")?.scope === "ALL";
  const owned = (await prisma.driveNode.findMany({
    where: { parentId: null, isTrashed: false, spaceId: null, ...(scopeAll ? {} : { ownerId: user.id }) },
    ...nodeArgs(user.id),
  })) as RawNode[];

  const map = new Map(owned.map((n) => [n.id, n]));
  if (!scopeAll) {
    const shares = await prisma.driveShare.findMany({ where: { userId: user.id }, include: { node: { include: nodeInclude(user.id) } } });
    for (const s of shares) {
      const node = s.node as RawNode | null;
      if (node && !node.isTrashed && node.spaceId == null) map.set(node.id, node);
    }
  }
  const merged = [...map.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "FOLDER" ? -1 : 1));
  // À la racine il n'y a pas d'héritage : chaque nœud est éditable selon sa propre propriété/partage.
  return { folder: null, breadcrumb: [], nodes: merged.map((n) => toRow(user, n, false)), level: "EDIT", trash: false, space: null };
}


/** Le haut de la corbeille : un élément dont le parent n'y est pas (le contenu d'un dossier supprimé part avec lui). */
const HAUT_DE_CORBEILLE = { isTrashed: true, OR: [{ parentId: null }, { parent: { isTrashed: false } }] } satisfies Prisma.DriveNodeWhereInput;

/**
 * LA CORBEILLE UNIFIÉE (audit Drive du 24/11, C1) — « ce que J'AI supprimé ».
 *
 * La corbeille de gauche ne montrait que les fichiers PERSONNELS dont on est propriétaire : un fichier
 * supprimé dans une catégorie disparaissait de la vue de celui qui l'avait supprimé (la corbeille de
 * la catégorie est réservée à ses gestionnaires), et un nœud sans propriétaire n'était visible nulle
 * part. On retient désormais l'AUTEUR de la mise à la corbeille (le journal l'écrit à chaque geste),
 * plus ses fichiers personnels supprimés avant ce journal — et chaque ligne dit d'où elle vient.
 */
export async function getCorbeille(user: SessionUser): Promise<DriveNodeRow[]> {
  const traces = await prisma.auditLog.findMany({
    where: { actorId: user.id, entityType: "DRIVE_NODE", field: "isTrashed", newValue: "true" },
    select: { entityId: true }, orderBy: { createdAt: "desc" }, take: 2000,
  });
  const tracesIds = [...new Set(traces.map((t) => t.entityId).filter((x): x is string => !!x))];
  const candidats = (await prisma.driveNode.findMany({
    where: { AND: [HAUT_DE_CORBEILLE, { OR: [{ id: { in: tracesIds } }, { ownerId: user.id, spaceId: null }] }] },
    include: { ...nodeInclude(user.id), parent: { select: { name: true } }, space: { select: { name: true, accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true, isArchived: true } } },
    orderBy: { updatedAt: "desc" },
  })) as (RawNode & { parent: { name: string } | null; space: (Parameters<typeof canManageDriveSpace>[1] & { name: string }) | null })[];
  if (candidats.length === 0) return [];

  // Supprimé à nouveau par QUELQU'UN D'AUTRE depuis (restauré puis remis) : c'est dans SA corbeille.
  const derniers = new Map<string, string | null>();
  for (const t of await prisma.auditLog.findMany({
    where: { entityType: "DRIVE_NODE", field: "isTrashed", newValue: "true", entityId: { in: candidats.map((c) => c.id) } },
    select: { entityId: true, actorId: true }, orderBy: { createdAt: "desc" },
  })) if (t.entityId && !derniers.has(t.entityId)) derniers.set(t.entityId, t.actorId);

  const rows: DriveNodeRow[] = [];
  for (const n of candidats) {
    const auteur = derniers.get(n.id);
    if (auteur !== undefined ? auteur !== user.id : n.ownerId !== user.id) continue;
    // Le droit est relu sur le nœud même : la règle d'accès d'un élément à la corbeille vit dans `resolveDriveAccess`.
    const level = await resolveDriveAccess(user, n.id);
    const gestionnaire = !!n.space && canManageDriveSpace(user, n.space);
    rows.push({
      ...toRow(user, n, level === "EDIT"),
      canEdit: level === "EDIT",
      supprimeDe: n.parent?.name ?? n.space?.name ?? MES_FICHIERS,
      ouvrable: level !== "NONE" && (n.ownerId === user.id || gestionnaire || user.role === "SUPER_ADMIN"),
    });
  }
  return rows;
}

/** Combien d'éléments de MA corbeille portent ce mot — la recherche le signale (« 2 résultats dans la corbeille »). */
export async function compterDansLaCorbeille(user: SessionUser, query: string): Promise<number> {
  return (await getCorbeille(user)).filter((n) => matchesQuery(n.name, query)).length;
}
