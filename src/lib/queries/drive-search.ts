import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { driveVisibilityWhere } from "@/lib/queries/drive";
import { describePath, matchesQuery, sortHits, type SearchHit } from "@/lib/drive/search";
import type { SessionUser } from "@/lib/rbac";

/**
 * CHERCHER DANS LE DRIVE — la requête, ses limites, et pourquoi elle en a deux.
 *
 * Le classement et la correspondance vivent dans `@/lib/drive/search` (module pur, testé). Ici on
 * ne s'occupe que de trois choses difficiles : le PÉRIMÈTRE (ce qu'on a le droit de trouver), le
 * VOLUME (ce qu'on accepte de relire), et le CHEMIN de chaque résultat.
 *
 * ── Le périmètre ────────────────────────────────────────────────────────────────────────────
 * `driveVisibilityWhere` retient ce qu'on possède, ce qui nous est partagé nommément et les
 * catégories auxquelles on a accès — mais PAS un fichier dont le droit ne viendrait que d'un
 * dossier parent partagé. Pour les listes « Récents », cette prudence coûte peu. Pour une
 * recherche, elle serait absurde : un dossier partagé avec moi contient surtout des fichiers
 * déposés par d'AUTRES, et ce sont précisément ceux-là qu'on cherche. On étend donc le périmètre
 * aux SOUS-ARBRES des dossiers visibles — exactement ce que la navigation laisse déjà ouvrir.
 *
 * ── Le volume : deux passes, et c'est voulu ─────────────────────────────────────────────────
 * PostgreSQL sait faire un `ILIKE` (insensible à la casse), il ne sait pas ignorer les ACCENTS
 * sans extension ni colonne dédiée. Or personne ne tape « Règlement » avec son accent grave.
 *   • passe 1 — la base cherche le motif tel quel, sur TOUT le Drive : un vieux dossier nommé
 *     exactement comme le terme reste trouvable, même dans un Drive énorme ;
 *   • passe 2 — on relit en mémoire une tranche bornée des nœuds visibles, les plus récemment
 *     touchés, en repliant les accents. C'est ce qui fait marcher « reglement » → « Règlement ».
 * Les deux ensembles sont fusionnés par identifiant. Quand la seconde passe bute sur son plafond,
 * on le DIT (`truncated`) : une recherche tronquée qu'on prendrait pour une absence de résultat
 * conduirait à re-téléverser un fichier qui existe déjà.
 */

/** Ce qu'on affiche : au-delà, la liste ne se lit plus, elle se refiltre. */
const RESULTS = 60;
/** Ce que la base ramène sur le motif exact (passe 1). */
const SQL_TAKE = 300;
/** Ce qu'on relit en mémoire pour ignorer les accents (passe 2). */
const SCAN_TAKE = 4000;
/** L'index des dossiers — il n'y en a jamais autant que de fichiers. */
const FOLDER_TAKE = 20000;
/** Garde-fou de remontée d'arborescence : une boucle de parents ne doit pas figer la page. */
const MAX_DEPTH = 50;

export interface DriveSearchRow extends SearchHit {
  size: number;
  /** Où cliquer — un fichier s'ouvre, un dossier se navigue (dans son onglet). */
  href: string;
}

export interface DriveSearchOutcome {
  rows: DriveSearchRow[];
  /** Vrai quand on a coupé : il faut affiner, pas conclure à l'absence. */
  truncated: boolean;
}

type FolderLite = { id: string; name: string; parentId: string | null };

const ROW_SELECT = {
  id: true, name: true, type: true, size: true, updatedAt: true,
  parentId: true, spaceId: true,
  space: { select: { name: true } },
} as const;

type RowLite = {
  id: string; name: string; type: string; size: number; updatedAt: Date;
  parentId: string | null; spaceId: string | null; space: { name: string } | null;
};

/**
 * Tous les dossiers descendant des `roots`, racines comprises.
 *
 * On part des dossiers, pas des fichiers : un fichier n'a pas d'enfant, et l'ensemble des dossiers
 * d'un Drive tient en mémoire là où l'ensemble des fichiers ne tiendrait pas. Le parcours est
 * itératif et marque les nœuds déjà vus — une arborescence corrompue (un dossier redevenu son
 * propre ancêtre) ferait sinon tourner la boucle indéfiniment.
 */
function subtreeIds(roots: readonly string[], folders: readonly FolderLite[]): string[] {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const list = children.get(f.parentId);
    if (list) list.push(f.id);
    else children.set(f.parentId, [f.id]);
  }
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return [...seen];
}

/** Le chemin lisible d'un nœud, remonté de parent en parent. */
function pathOf(n: RowLite, byId: Map<string, FolderLite>): string {
  const segments: string[] = [];
  let cursor = n.parentId;
  let depth = 0;
  while (cursor && depth < MAX_DEPTH) {
    const folder = byId.get(cursor);
    if (!folder) break; // dossier hors périmètre chargé : on s'arrête là plutôt que d'inventer
    segments.unshift(folder.name);
    cursor = folder.parentId;
    depth += 1;
  }
  return describePath(n.space?.name ?? "Drive", segments);
}

/** Un fichier s'ouvre ; un dossier se navigue — dans son onglet, personnel ou catégorie. */
function hrefOf(n: RowLite): string {
  if (n.type === "FILE") return `/drive/${n.id}`;
  return n.spaceId ? `/drive/espace/${n.spaceId}?folder=${n.id}` : `/drive?folder=${n.id}`;
}

/**
 * La recherche. `query` est supposée déjà validée par `normalizeQuery` (assez longue, rognée).
 */
export async function searchDrive(user: SessionUser, query: string): Promise<DriveSearchOutcome> {
  const visibility = await driveVisibilityWhere(user);
  // `driveVisibilityWhere` rend `{}` quand la personne voit tout le Drive : rien à étendre.
  const seesAll = Object.keys(visibility).length === 0;

  // L'index des dossiers sert DEUX fois : étendre le périmètre, puis écrire les chemins.
  const folders = (await prisma.driveNode.findMany({
    where: { type: "FOLDER", isTrashed: false },
    select: { id: true, name: true, parentId: true },
    take: FOLDER_TAKE,
  })) as FolderLite[];
  const byId = new Map(folders.map((f) => [f.id, f]));

  let scope: Prisma.DriveNodeWhereInput = {};
  if (!seesAll) {
    const roots = await prisma.driveNode.findMany({
      where: { type: "FOLDER", isTrashed: false, ...visibility },
      select: { id: true },
    });
    const inside = subtreeIds(roots.map((r) => r.id), folders);
    scope = inside.length > 0 ? { OR: [visibility, { parentId: { in: inside } }] } : visibility;
  }

  const base: Prisma.DriveNodeWhereInput = { AND: [{ isTrashed: false }, scope] };

  const [exact, scan] = await Promise.all([
    prisma.driveNode.findMany({
      where: { ...base, name: { contains: query, mode: "insensitive" } },
      select: ROW_SELECT,
      orderBy: { updatedAt: "desc" },
      take: SQL_TAKE,
    }),
    prisma.driveNode.findMany({
      where: base,
      select: ROW_SELECT,
      orderBy: { updatedAt: "desc" },
      take: SCAN_TAKE,
    }),
  ]);

  const found = new Map<string, RowLite>();
  for (const n of exact as unknown as RowLite[]) found.set(n.id, n);
  for (const n of scan as unknown as RowLite[]) {
    if (matchesQuery(n.name, query)) found.set(n.id, n);
  }

  const rows: DriveSearchRow[] = [...found.values()].map((n) => ({
    id: n.id,
    name: n.name,
    isFile: n.type === "FILE",
    size: n.size,
    updatedAt: n.updatedAt.toISOString(),
    path: pathOf(n, byId),
    href: hrefOf(n),
  }));

  const sorted = sortHits(rows, query);
  return {
    rows: sorted.slice(0, RESULTS),
    // Deux façons d'être incomplet : trop de résultats à afficher, ou une seconde passe qui n'a
    // pas pu relire tout le Drive visible.
    truncated: sorted.length > RESULTS || scan.length === SCAN_TAKE,
  };
}
