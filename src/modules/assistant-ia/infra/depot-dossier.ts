import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import {
  bornesDossier, compterLot, dossiersARecreer, empreinteDepot, nomLibre, planifierDossier, racineDuDepot,
  type EtatLot, type FichierDeDossier,
} from "../domaine/lecture/depot-dossier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPÔT DE DOSSIER, CÔTÉ SERVEUR (lot J11, décision 0030).
 *
 *   OUVRIR un lot : bornes rejugées (le serveur fait foi), racine nommée créée dans le Drive PERSONNEL, sous-dossiers
 *   recréés (port `creerArborescence` : `lib/drive/arborescence`, passé par la route — le module ne l'importe pas),
 *   et la carte « chemin → dossier » rendue au navigateur, qui téléverse chaque fichier dans SON dossier par le
 *   gestionnaire d'envois (direct par morceaux au-delà du seuil, reprise des parties). Chaque fichier arrivé passe par
 *   le dépôt du Drive, donc par `inscrireFichierDrive` : une pièce par fichier, inscrite à la Bibliothèque.
 *
 *   REPRENDRE : la même liste (même empreinte) redéposée retrouve son lot ; le navigateur ne renvoie que ce qui manque
 *   dans le Drive (même chemin, même taille).
 *
 *   SUIVRE : le Drive dit ce qui est arrivé (sous la racine), la Bibliothèque ce qui est lu, échoué, en file.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PortsDepotDossier {
  /** `creerArborescenceDrive` — recrée les chemins sous `parentId` (réutilise un dossier du même nom). */
  creerArborescence: (a: { ownerId: string; parentId: string; paths: readonly string[] }) => Promise<Record<string, string>>;
}

export type OuvertureLot =
  | { ok: true; lotId: string; racineId: string; nom: string; repris: boolean; map: Record<string, string>; deja: { relatif: string; taille: number }[]; refus: { chemin: string; raison: string }[] }
  | { ok: false; error: string; status: number };

/**
 * Les fichiers ACTIFS sous la racine d'un lot, chemin relatif reconstruit, avec la fiche de la Bibliothèque qui porte
 * leur clé (`DRIVE_NODE:<id>` — la version courante ; index GIN sur `cles`).
 */
async function fichiersSousRacine(racineId: string): Promise<{ id: string; relatif: string; taille: number; pieceId: string | null; statut: string | null }[]> {
  return prisma.$queryRaw`
    WITH RECURSIVE arbre AS (
      SELECT n."id", n."type", n."size", n."name"::text AS relatif
        FROM "DriveNode" n WHERE n."parentId" = ${racineId} AND n."isTrashed" = false
      UNION ALL
      SELECT c."id", c."type", c."size", a.relatif || '/' || c."name"
        FROM "DriveNode" c JOIN arbre a ON c."parentId" = a."id"
       WHERE a."type" = 'FOLDER' AND c."isTrashed" = false
    )
    SELECT a."id", a.relatif, a."size"::float8 AS taille, f."pieceId", f."statut"::text AS statut
      FROM arbre a
      LEFT JOIN LATERAL (
        SELECT b."pieceId", b."statut" FROM "BibliothequeFiche" b WHERE b."cles" @> ARRAY['DRIVE_NODE:' || a."id"] LIMIT 1
      ) f ON true
     WHERE a."type" = 'FILE'`;
}

/**
 * OUVRE (ou REPREND) un dépôt de dossier. `fichiers` : les chemins tels que déposés et leurs tailles — rien d'autre
 * ne part avant que les octets ne suivent, fichier par fichier, par le dépôt ordinaire du Drive.
 */
export async function ouvrirLotDossier(
  user: CurrentUser,
  entree: { fichiers: FichierDeDossier[]; mode: "MESSAGE" | "DOSSIER" },
  ports: PortsDepotDossier,
): Promise<OuvertureLot> {
  const propres = entree.fichiers
    .filter((f) => f && typeof f.chemin === "string" && Number.isFinite(f.taille))
    .map((f) => ({ chemin: f.chemin.replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 1000), taille: Number(f.taille) }))
    .filter((f) => f.chemin && !f.chemin.split("/").some((s) => s === ".." || s === "."));
  const { acceptes, refus, octets } = planifierDossier(propres, bornesDossier(process.env));
  if (!acceptes.length) return { ok: false, status: 400, error: refus[0] ? `Rien à déposer : « ${refus[0].chemin} » — ${refus[0].raison}` : "Rien à déposer." };

  const empreinte = empreinteDepot(acceptes);
  const { nom, fichiers } = racineDuDepot(acceptes);
  const paths = dossiersARecreer(fichiers.map((f) => f.relatif));

  // LA REPRISE : même personne, même liste, lot pas abandonné, racine toujours là.
  const precedent = await prisma.assistantIaDepotDossier.findFirst({
    where: { userId: user.id, empreinte, statut: { not: "ABANDONNE" } }, orderBy: { createdAt: "desc" },
  });
  const racineVivante = precedent
    ? await prisma.driveNode.findFirst({ where: { id: precedent.racineId, ownerId: user.id, type: "FOLDER", isTrashed: false }, select: { id: true } })
    : null;
  if (precedent && racineVivante) {
    const map = paths.length ? await ports.creerArborescence({ ownerId: user.id, parentId: precedent.racineId, paths }) : {};
    const deja = (await fichiersSousRacine(precedent.racineId)).map((f) => ({ relatif: f.relatif, taille: Number(f.taille) }));
    await prisma.assistantIaDepotDossier.update({ where: { id: precedent.id }, data: { statut: "TELEVERSEMENT", termineLe: null } });
    return { ok: true, lotId: precedent.id, racineId: precedent.racineId, nom: precedent.nom, repris: true, map, deja, refus };
  }

  // UNE RACINE NEUVE à la racine du Drive personnel, au nom du dossier déposé (« (2) » s'il est pris).
  const pris = new Set((await prisma.driveNode.findMany({
    where: { parentId: null, ownerId: user.id, spaceId: null, type: "FOLDER", isTrashed: false, name: { startsWith: nom.slice(0, 60) } },
    select: { name: true },
  })).map((n) => n.name));
  const nomRacine = nomLibre(nom, pris);
  const racine = await prisma.driveNode.create({
    data: { name: nomRacine, type: "FOLDER", parentId: null, ownerId: user.id, createdById: user.id },
    select: { id: true },
  });
  const map = paths.length ? await ports.creerArborescence({ ownerId: user.id, parentId: racine.id, paths }) : {};
  const lot = await prisma.assistantIaDepotDossier.create({
    data: {
      userId: user.id, racineId: racine.id, nom: nomRacine, mode: entree.mode, fichiersAnnonces: acceptes.length,
      octetsAnnonces: octets, empreinte,
    },
    select: { id: true },
  });
  return { ok: true, lotId: lot.id, racineId: racine.id, nom: nomRacine, repris: false, map, deja: [], refus };
}

/** Clore un lot (téléversement fini) ou l'abandonner (la personne l'a annulé). Seulement le sien. */
export async function cloreLotDossier(user: CurrentUser, lotId: string, statut: "TERMINE" | "ABANDONNE"): Promise<boolean> {
  const n = await prisma.assistantIaDepotDossier.updateMany({
    where: { id: lotId, userId: user.id }, data: { statut, termineLe: new Date() },
  });
  return n.count === 1;
}

/** L'ÉTAT des derniers lots de la personne — n fichiers, arrivés, lus, échoués, en file. */
export async function etatDesLots(user: CurrentUser, opts: { max?: number; lotId?: string } = {}): Promise<EtatLot[]> {
  const lots = await prisma.assistantIaDepotDossier.findMany({
    where: { userId: user.id, ...(opts.lotId ? { id: opts.lotId } : {}) },
    orderBy: { createdAt: "desc" }, take: Math.min(20, Math.max(1, opts.max ?? 5)),
  });
  return Promise.all(lots.map(async (l) => {
    const f = await fichiersSousRacine(l.racineId);
    return {
      id: l.id, nom: l.nom, racineId: l.racineId, statut: l.statut as EtatLot["statut"], annonces: l.fichiersAnnonces,
      ...compterLot(f.map((x) => x.statut)), createdAt: l.createdAt.toISOString(),
    };
  }));
}

/** Les PIÈCES d'un lot, pour l'assistant : chemin relatif et identifiant de pièce (la Bibliothèque dit le reste). */
export async function piecesDuLot(user: CurrentUser, lotId: string): Promise<{ lot: { id: string; nom: string; annonces: number }; pieces: { relatif: string; nodeId: string; pieceId: string | null; taille: number; statut: string | null }[] } | null> {
  const l = await prisma.assistantIaDepotDossier.findFirst({ where: { id: lotId, userId: user.id } });
  if (!l) return null;
  const f = await fichiersSousRacine(l.racineId);
  return {
    lot: { id: l.id, nom: l.nom, annonces: l.fichiersAnnonces },
    pieces: f.map((x) => ({ relatif: x.relatif, nodeId: x.id, pieceId: x.pieceId, taille: Number(x.taille), statut: x.statut })),
  };
}

/** Le lot désigné par la personne (« le dossier Congrès Oran »), sinon son plus récent. */
export async function lotDesigne(user: CurrentUser, nom?: string | null): Promise<{ id: string; nom: string } | null> {
  const q = (nom ?? "").trim();
  return prisma.assistantIaDepotDossier.findFirst({
    where: { userId: user.id, statut: { not: "ABANDONNE" }, ...(q ? { nom: { contains: q, mode: Prisma.QueryMode.insensitive } } : {}) },
    orderBy: { createdAt: "desc" }, select: { id: true, nom: true },
  });
}
