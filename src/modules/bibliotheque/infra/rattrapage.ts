import type { Confidentiality, SourcePiece } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { VERSION_INGESTION } from "../domaine/ingestion";
import type { Famille } from "../domaine/familles";
import { inscrireDocument, inscrireFichierDrive, inscrirePiece } from "./inscription";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RATTRAPAGE — les pièces entrées AVANT la bibliothèque, inscrites par petits lots (J1).
 *
 * Pour chaque famille d'endroits, les lignes qui n'ont pas encore de lien au registre (`PieceLien` de type
 * ENTITE, `entityType` = la famille) sont inscrites par la même porte que les nouvelles (`inscrirePiece`) :
 * même registre, mêmes clés, même file. Un lot borné par famille et par passage de la tâche de fond
 * `bibliotheque.rattrapage` : le stock se résorbe sans jamais charger le serveur. Idempotent — une ligne
 * inscrite a son lien, elle ne ressort plus de la requête.
 *
 * Et les fiches lues par une version ANTÉRIEURE des règles d'ingestion se remettent en file, par lots aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const LOT_RATTRAPAGE = 25;

interface Ligne {
  id: string;
  blobId: string;
  sha256: string | null;
  nom: string;
  mime: string | null;
  taille: number | null;
  auteurId: string | null;
  date: Date;
}

/** Les lignes d'une famille sans lien au registre — la requête est propre à chaque table. */
const A_INSCRIRE: Record<Famille, (n: number) => Promise<Ligne[]>> = {
  DRIVE_NODE: (n) => prisma.$queryRaw<Ligne[]>`
    SELECT d."id", v."blobId", b."sha256", d."name" AS nom, coalesce(v."mimeType", d."mimeType") AS mime, v."size" AS taille,
           coalesce(v."createdById", d."ownerId") AS "auteurId", v."createdAt" AS date
      FROM "DriveNode" d
      JOIN LATERAL (SELECT * FROM "FileVersion" fv WHERE fv."nodeId" = d."id" ORDER BY fv."version" DESC LIMIT 1) v ON true
      JOIN "FileBlob" b ON b."id" = v."blobId"
     WHERE d."type" = 'FILE' AND d."isTrashed" = false
       AND NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = 'DRIVE_NODE' AND l."sujetId" = d."id")
     ORDER BY d."createdAt" DESC LIMIT ${n}`,
  DOCUMENT: async () => [], // voir `documentsAInscrire` : la ligne porte aussi son entité et sa catégorie
  MESSAGE_PIECE: (n) => lignesSimples("MessageAttachment", "MESSAGE_PIECE", n),
  SUJET_PIECE: (n) => lignesSimples("DossierMessageAttachment", "SUJET_PIECE", n),
  REUNION_PIECE: (n) => lignesSimples("MeetingMessageAttachment", "REUNION_PIECE", n),
  REUNION_AUDIO: (n) => prisma.$queryRaw<Ligne[]>`
    SELECT m."id", m."audioBlobId" AS "blobId", b."sha256", 'reunion-' || m."id" || '.webm' AS nom, 'audio/webm' AS mime,
           b."size"::float AS taille, m."organizerId" AS "auteurId", m."createdAt" AS date
      FROM "Meeting" m JOIN "FileBlob" b ON b."id" = m."audioBlobId"
     WHERE NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = 'REUNION_AUDIO' AND l."sujetId" = m."id")
     ORDER BY m."createdAt" DESC LIMIT ${n}`,
  RH_DOCUMENT: (n) => prisma.$queryRaw<Ligne[]>`
    SELECT e."id", e."blobId", b."sha256", e."name" AS nom, e."mime", e."size"::float AS taille, e."uploadedById" AS "auteurId", e."createdAt" AS date
      FROM "EmployeeDocument" e JOIN "FileBlob" b ON b."id" = e."blobId"
     WHERE NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = 'RH_DOCUMENT' AND l."sujetId" = e."id")
     ORDER BY e."createdAt" DESC LIMIT ${n}`,
  TERRAIN_PIECE: (n) => lignesSimples("FieldReportAttachment", "TERRAIN_PIECE", n),
  TERRAIN_AUDIO: (n) => prisma.$queryRaw<Ligne[]>`
    SELECT r."id", r."audioBlobId" AS "blobId", b."sha256", 'rapport-' || r."id" || '.webm' AS nom, 'audio/webm' AS mime,
           b."size"::float AS taille, r."delegateId" AS "auteurId", r."createdAt" AS date
      FROM "FieldReport" r JOIN "FileBlob" b ON b."id" = r."audioBlobId"
     WHERE NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = 'TERRAIN_AUDIO' AND l."sujetId" = r."id")
     ORDER BY r."createdAt" DESC LIMIT ${n}`,
  RETOUR_PIECE: (n) => prisma.$queryRaw<Ligne[]>`
    SELECT a."id", a."blobId", b."sha256", a."name" AS nom, a."mime", a."size"::float AS taille, a."uploadedById" AS "auteurId", a."createdAt" AS date
      FROM "FeedbackAttachment" a JOIN "FileBlob" b ON b."id" = a."blobId"
     WHERE NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = 'RETOUR_PIECE' AND l."sujetId" = a."id")
     ORDER BY a."createdAt" DESC LIMIT ${n}`,
  KPI_PIECE: (n) => prisma.$queryRaw<Ligne[]>`
    SELECT k."id", k."pieceBlobId" AS "blobId", b."sha256", coalesce(k."pieceNom", 'piece') AS nom, k."pieceMime" AS mime,
           b."size"::float AS taille, k."userId" AS "auteurId", k."createdAt" AS date
      FROM "KpiDeclaration" k JOIN "FileBlob" b ON b."id" = k."pieceBlobId"
     WHERE NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = 'KPI_PIECE' AND l."sujetId" = k."id")
     ORDER BY k."createdAt" DESC LIMIT ${n}`,
};

/** Les tables de pièces jointes au même gabarit (`blobId`, `name`, `mime`, `size`, `createdAt`). */
function lignesSimples(table: "MessageAttachment" | "DossierMessageAttachment" | "MeetingMessageAttachment" | "FieldReportAttachment", famille: Famille, n: number): Promise<Ligne[]> {
  // Le nom de table vient d'une liste fermée (le type ci-dessus), jamais d'une saisie.
  return prisma.$queryRawUnsafe<Ligne[]>(
    `SELECT a."id", a."blobId", b."sha256", a."name" AS nom, a."mime", a."size"::float AS taille, NULL::text AS "auteurId", a."createdAt" AS date
       FROM "${table}" a JOIN "FileBlob" b ON b."id" = a."blobId"
      WHERE a."blobId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = $1 AND l."sujetId" = a."id")
      ORDER BY a."createdAt" DESC LIMIT $2`,
    famille, n,
  );
}

const SOURCE: Partial<Record<Famille, SourcePiece>> = {
  MESSAGE_PIECE: "CONVERSATION", SUJET_PIECE: "AUTRE", REUNION_PIECE: "CONVERSATION", REUNION_AUDIO: "CONVERSATION",
  RH_DOCUMENT: "RH", TERRAIN_PIECE: "AUTRE", TERRAIN_AUDIO: "AUTRE", RETOUR_PIECE: "AUTRE", KPI_PIECE: "AUTRE",
};
const CONFIDENTIALITE: Partial<Record<Famille, Confidentiality>> = { RH_DOCUMENT: "CONFIDENTIAL" };

async function documentsAInscrire(n: number) {
  return prisma.$queryRaw<(Ligne & { entityType: string; category: string; confidentiality: Confidentiality })[]>`
    SELECT d."id", s."blobId", b."sha256", d."name" AS nom, d."mimeType" AS mime, s."size" AS taille, d."uploadedById" AS "auteurId",
           d."createdAt" AS date, d."entityType"::text AS "entityType", d."category"::text AS category, d."confidentiality"
      FROM "Document" d JOIN "StoredFile" s ON s."key" = d."fileKey" JOIN "FileBlob" b ON b."id" = s."blobId"
     WHERE NOT EXISTS (SELECT 1 FROM "PieceLien" l WHERE l."sujetType" = 'ENTITE' AND l."entityType" = 'DOCUMENT' AND l."sujetId" = d."id")
     ORDER BY d."createdAt" DESC LIMIT ${n}`;
}

export interface BilanRattrapage {
  inscrites: number;
  rejetees: number;
  relues: number;
}

export async function rattraper(opts: { lot?: number } = {}): Promise<BilanRattrapage> {
  const n = Math.max(1, opts.lot ?? LOT_RATTRAPAGE);
  const bilan: BilanRattrapage = { inscrites: 0, rejetees: 0, relues: 0 };
  const compter = (s: { statut: string }) => { if (s.statut === "INSCRITE") bilan.inscrites += 1; else bilan.rejetees += 1; };

  for (const d of await documentsAInscrire(n)) {
    compter(await inscrireDocument({
      documentId: d.id, entityType: d.entityType, category: d.category, confidentiality: d.confidentiality,
      blobId: d.blobId, sha256: d.sha256, nom: d.nom, mime: d.mime, taille: d.taille, deposeParId: d.auteurId,
    }));
  }
  for (const [famille, lire] of Object.entries(A_INSCRIRE) as [Famille, (n: number) => Promise<Ligne[]>][]) {
    for (const l of await lire(n)) {
      compter(famille === "DRIVE_NODE"
        ? await inscrireFichierDrive({ nodeId: l.id, blobId: l.blobId, sha256: l.sha256, nom: l.nom, mime: l.mime, taille: l.taille, deposeParId: l.auteurId })
        : await inscrirePiece({
          blobId: l.blobId, empreinte: l.sha256, nom: l.nom, mime: l.mime, taille: l.taille, source: SOURCE[famille] ?? "AUTRE",
          objet: { famille, id: l.id }, confidentialite: CONFIDENTIALITE[famille], proprietaireId: l.auteurId, date: l.date,
        }));
    }
  }

  // Une nouvelle version des règles d'ingestion : les fiches déjà lues se relisent, par lots.
  const r = await prisma.$executeRaw`
    UPDATE "BibliothequeFiche" SET "statut" = 'A_FAIRE', "tentatives" = 0, "prochainEssaiLe" = now(), "updatedAt" = now()
     WHERE "pieceId" IN (SELECT "pieceId" FROM "BibliothequeFiche"
                          WHERE "statut" IN ('FAITE', 'IGNOREE') AND "versionIngestion" < ${VERSION_INGESTION} LIMIT ${n})`;
  bilan.relues = r;
  return bilan;
}
