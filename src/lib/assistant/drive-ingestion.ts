import { prisma } from "@/lib/prisma";
import { ensureNodeIndexed } from "@/lib/assistant/document-discovery";
import { embedDriveBacklog } from "@/lib/assistant/semantic-drive";
import { sansBloquer } from "@/lib/journal";

/**
 * INGESTION DRIVE EXHAUSTIVE — l'index textuel n'attend plus qu'un fichier soit LU.
 *
 * Avant : l'index grandissait au fil des lectures (read_document, find_documents) — un document
 * jamais ouvert ET mal nommé restait invisible à la recherche par contenu. Désormais une tâche
 * planifiée ingère le Drive PAR PETITS PAQUETS (un paquet par passage, jamais plus — le même
 * régime que l'arriéré d'embeddings) : extraction native, classification déterministe
 * (platform/doc-kind), et index-témoin pour les fichiers illisibles (on ne re-tente pas un scan
 * mort à chaque passage).
 *
 * SÉCURITÉ : l'ingestion STOCKE sans lire les droits — c'est la RECHERCHE qui revérifie l'ACL
 * nœud par nœud avant d'exposer le moindre extrait (find_documents / read_document), exactement
 * comme pour l'index progressif historique. Aucun contenu n'atteint un compte qui ne peut pas
 * ouvrir le fichier. Débrayage : ASSISTANT_DRIVE_INGESTION=off.
 */

/** Fichiers ingérés par passage — l'ingestion avance sans jamais peser sur le service. */
const SWEEP_BATCH = 20;
/** Au-delà, pas d'extraction planifiée (même borne que la lecture à la volée). */
const SWEEP_SIZE_CAP = 8 * 1024 * 1024;
/** Vérification de fraîcheur : à chaque passage, quelques entrées anciennes sont recontrôlées
 *  (nouvelle version du fichier → réindexation par le même chemin). */
const REFRESH_BATCH = 5;

export function driveIngestionEnabled(): boolean {
  return process.env.ASSISTANT_DRIVE_INGESTION !== "off";
}

/**
 * Un passage d'ingestion : indexe jusqu'à SWEEP_BATCH fichiers jamais indexés (les plus
 * récemment modifiés d'abord — c'est là que vivent les questions du jour), puis recontrôle
 * REFRESH_BATCH entrées anciennes dont le fichier aurait changé de version. Ne lève jamais.
 */
export async function runDriveIngestionSweep(batch = SWEEP_BATCH): Promise<{ indexed: number; refreshed: number }> {
  if (!driveIngestionEnabled()) return { indexed: 0, refreshed: 0 };
  let indexed = 0;
  let refreshed = 0;
  try {
    // 1) Les fichiers JAMAIS indexés — récents d'abord.
    const candidates = await prisma.driveNode.findMany({
      where: { type: "FILE", isTrashed: false, size: { lte: SWEEP_SIZE_CAP }, textIndex: null },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: batch,
    });
    for (const c of candidates) {
      const ok = await ensureNodeIndexed(c.id).catch(sansBloquer("drive-ingestion.runDriveIngestionSweep.ensureNodeIndexed", false));
      if (ok) indexed += 1;
    }

    // 2) FRAÎCHEUR : les entrées les plus anciennes — si le fichier a une nouvelle version,
    //    ensureNodeIndexed la détecte (versionId ≠) et réextrait ; sinon l'appel est un no-op
    //    (lecture d'index) et on tamponne updatedAt pour faire tourner la file.
    const stale = await prisma.driveTextIndex.findMany({
      select: { nodeId: true, versionId: true },
      orderBy: { updatedAt: "asc" },
      take: REFRESH_BATCH,
    });
    for (const s of stale) {
      const latest = await prisma.fileVersion.findFirst({
        where: { nodeId: s.nodeId }, orderBy: { version: "desc" }, select: { id: true },
      });
      if (latest && latest.id !== s.versionId) {
        const ok = await ensureNodeIndexed(s.nodeId).catch(sansBloquer("drive-ingestion.runDriveIngestionSweep.ensureNodeIndexed", false));
        if (ok) refreshed += 1;
      } else {
        await prisma.driveTextIndex.update({ where: { nodeId: s.nodeId }, data: { updatedAt: new Date() } }).catch(sansBloquer("drive-ingestion.runDriveIngestionSweep.driveTextIndex"));
      }
    }

    // Phase 3 — VECTORISATION de rattrapage (bornée) : les entrées d'index sans vecteur
    // gagnent leur embedding sémantique. Jamais bloquant : sans clé, zéro travail.
    const embedded = await embedDriveBacklog().catch(sansBloquer("drive-ingestion.runDriveIngestionSweep.embedDriveBacklog", 0));

    if (indexed > 0 || refreshed > 0 || embedded > 0) {
      console.info("[assistant] drive_ingestion_sweep", { indexed, refreshed, embedded });
    }
  } catch (err) {
    console.error("[assistant] drive ingestion sweep failed", err);
  }
  return { indexed, refreshed };
}
