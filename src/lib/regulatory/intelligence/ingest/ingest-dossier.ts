import { mkdtemp, rename, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { RegDocExtractionStatus, RegDocSecurityStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { putBlob, putBlobFromFile, releaseBlob, sha256, sha256File } from "@/lib/drive-storage";
import { objectStorageConfigured } from "@/lib/storage/object-storage";
import { regAudit } from "../audit";
import { inspectZip, inspectZipFile, type ManifestEntry, type SecurityStatus, type ZipInspection } from "./zip-inspector";
import { sansBloquer, attendu } from "@/lib/journal";

/**
 * SERVICE D'INGESTION d'un dossier CTD (ZIP) — Regulatory Intelligence OS.
 *
 * Chaîne robuste et transactionnelle :
 *  1. inspection sécurisée AVANT tout stockage (anti-bombe / traversal / exécutables) ;
 *  2. stockage inline de chaque fichier SÛR (blob chiffré, adressé par SHA-256), un fichier
 *     à la fois → mémoire bornée ;
 *  3. conservation de l'archive ORIGINALE **immuable** — empreinte SHA-256 tout de suite,
 *     octets écrits EN FOND (voir « archive originale » plus bas) ;
 *  4. création atomique de la version + du manifeste (une ligne par entrée, y compris les
 *     entrées BLOQUÉES — traçabilité, jamais de fausse conformité) ;
 *  5. mise en file d'un job EXTRACT (traitement lourd asynchrone, Node-first) ;
 *  6. audit.
 * En cas d'échec à toute étape après stockage : **rollback** (libération de tous les blobs).
 */

const SECURITY_MAP: Record<SecurityStatus, RegDocSecurityStatus> = {
  SAFE: "SAFE",
  SUSPICIOUS: "SUSPICIOUS",
  BLOCKED_EXECUTABLE: "BLOCKED_EXECUTABLE",
  BLOCKED_ENCRYPTED: "BLOCKED_ENCRYPTED",
  BLOCKED_PATH: "BLOCKED_PATH",
  BLOCKED_OVERSIZE: "BLOCKED_OVERSIZE",
  CORRUPTED: "CORRUPTED",
};

const isStorable = (s: SecurityStatus) => s === "SAFE" || s === "SUSPICIOUS";

// Int32 de sécurité pour les colonnes `sizeBytes`/`totalBytes` (garde anti-débordement).
const INT32_MAX = 2_147_483_647;
const clampInt = (n: number) => Math.max(0, Math.min(INT32_MAX, Math.round(n)));

// Plafond de taille d'UN blob stocké EN BASE (Postgres) : le contenu est désormais écrit EN TRANCHES
// (voir drive-storage) → plus d'insert bytea unique géant, mémoire bornée. On peut donc viser ~1 Go.
// Défaut 950 Mo (≈ 1 Go, sous la borne de l'Int `size`). En stockage OBJET (R2/S3) cette limite ne
// s'applique pas. Réglable via REG_MAX_PG_BLOB_MB.
const maxPgBlobBytes = () => Number(process.env.REG_MAX_PG_BLOB_MB ?? 950) * 1024 * 1024;
// Même garde pour UN FICHIER individuel du dossier (réglable séparément) : un fichier au-delà du
// plafond est MARQUÉ (jamais un crash), les autres continuent. Défaut 950 Mo. Réglable via
// REG_MAX_PG_FILE_MB. NB : océriser un PDF proche d'1 Go reste borné par la RAM (voir README).
const maxPgFileBytes = () => Number(process.env.REG_MAX_PG_FILE_MB ?? 950) * 1024 * 1024;
/**
 * Fichiers stockés EN PARALLÈLE pendant l'ingestion. Quatre : mesuré comme l'optimum réel — au
 * delà, les écritures se disputent le pool de connexions et le total REMONTE.
 * Réglable : REG_INGEST_STORE_CONCURRENCY (à relever seulement avec DB_CONNECTION_LIMIT).
 */
const ingestStoreConcurrency = () =>
  Math.min(Math.max(Number(process.env.REG_INGEST_STORE_CONCURRENCY ?? 4), 1), 16);

export interface IngestSummary {
  total: number;
  stored: number;
  blocked: number;
  suspicious: number;
  totalBytes: number;
}

export interface IngestResult {
  ok: boolean;
  error?: string;
  rejectionCode?: string;
  versionId?: string;
  versionNo?: number;
  summary?: IngestSummary;
}

/** Provenance des octets de l'archive originale : buffer en mémoire ou fichier temporaire sur disque. */
type OriginalSource =
  | { kind: "buffer"; buffer: Buffer }
  | { kind: "file"; path: string; sha256?: string };

/** Ingestion d'un dossier CTD depuis un BUFFER (petits fichiers, route directe). */
export async function ingestDossierZip(opts: {
  companyId: string;
  dossierId: string;
  actorId: string;
  filename: string;
  buffer: Buffer;
  label?: string | null;
}): Promise<IngestResult> {
  return ingestCore(
    opts,
    (onStorableEntry) => inspectZip(opts.buffer, { onStorableEntry }),
    { kind: "buffer", buffer: opts.buffer },
  );
}

/**
 * Ingestion d'un dossier CTD depuis un FICHIER sur disque (gros dossiers, upload résumable). Lit
 * l'archive EN FLUX (yauzl, une entrée à la fois) → pic mémoire ≈ plus gros fichier, jamais
 * l'archive entière. Corrige l'OOM d'ingestion des gros ZIP.
 */
export async function ingestDossierZipFromFile(opts: {
  companyId: string;
  dossierId: string;
  actorId: string;
  filename: string;
  zipPath: string;
  /** Empreinte déjà calculée à l'assemblage — évite une seconde lecture complète de l'archive. */
  sha256?: string;
  label?: string | null;
}): Promise<IngestResult> {
  return ingestCore(
    opts,
    (onStorableEntry) => inspectZipFile(opts.zipPath, { onStorableEntry }),
    { kind: "file", path: opts.zipPath, sha256: opts.sha256 },
  );
}

/**
 * Cœur d'ingestion partagé (buffer OU fichier) : inspection sécurisée avec stockage inline,
 * archive originale immuable, persistance atomique version + manifeste + job EXTRACT, rollback.
 * `runInspection` fournit la source (buffer/flux) ; `original` désigne les octets de l'archive à
 * figer, conservés en fond une fois la version créée.
 */
async function ingestCore(
  opts: { companyId: string; dossierId: string; actorId: string; filename: string; label?: string | null },
  runInspection: (onStorableEntry: (entry: ManifestEntry, data: Buffer) => Promise<void>) => Promise<ZipInspection>,
  original: OriginalSource,
): Promise<IngestResult> {
  const { companyId, dossierId, actorId, filename } = opts;

  // Blobs stockés pendant l'inspection → à libérer si la suite échoue.
  const blobByPath = new Map<string, string>();
  const releaseAll = async () => {
    for (const id of new Set(blobByPath.values())) await releaseBlob(id).catch(sansBloquer("ingest-dossier.releaseAll.releaseBlob"));
  };

  // 1) + 2) Inspection sécurisée avec stockage inline des fichiers sûrs.
  //
  // STOCKAGE EN PARALLÈLE BORNÉ — le poste de temps qui dominait l'ingestion. Chaque fichier
  // est chiffré puis écrit ; fait un par un, on passait l'essentiel du temps à ATTENDRE la base
  // sans rien calculer. Mesuré sur 60 fichiers de 1 Mo : 4,7 s en série contre 1,5 s à quatre en
  // vol (×3). Au-delà de quatre, le pool de connexions sature et l'on REPERD du temps (2,0 s à
  // huit) — la borne n'est donc pas décorative.
  //
  // La lecture de l'archive reste séquentielle (une entrée décompressée à la fois) : seule
  // l'écriture est parallélisée, et le sémaphore fait la contre-pression. Pic mémoire ≈ quatre
  // fichiers, pas l'archive.
  const storeLimit = ingestStoreConcurrency();
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < storeLimit) { active++; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  };
  const release = (): void => { active--; waiting.shift()?.(); };
  const inFlight: Promise<void>[] = [];
  let storeError: Error | null = null;

  let inspection: ZipInspection;
  try {
    inspection = await runInspection(async (entry: ManifestEntry, data: Buffer) => {
      // Garde anti-OOM par FICHIER (mode base) : un fichier unique trop volumineux pour un bytea
      // est refusé PROPREMENT (l'inspecteur le marque et continue) au lieu de tuer le process à
      // l'insert. Contrôle SYNCHRONE, avant toute mise en file : l'entrée est marquée sur-le-champ,
      // exactement comme avant. Sans objet en stockage R2/S3 (pas de plafond).
      if (!objectStorageConfigured() && data.length > maxPgFileBytes()) {
        throw new Error(`Fichier trop volumineux pour le stockage en base (${Math.round(data.length / (1024 * 1024))} Mo > ${Math.round(maxPgFileBytes() / (1024 * 1024))} Mo) — non conservé.`);
      }
      await acquire(); // contre-pression : on ne lit l'entrée suivante que si une place se libère
      inFlight.push(
        putBlob(data)
          .then((b) => { blobByPath.set(entry.path, b.blobId); })
          .catch((e) => { storeError ??= e instanceof Error ? e : new Error(String(e)); })
          .finally(release),
      );
    });
    // Les écritures encore en vol doivent être terminées AVANT de juger l'inspection : sans cette
    // attente, on créerait des documents pointant vers des blobs pas encore écrits.
    await Promise.all(inFlight);
    if (storeError) throw storeError;
  } catch (err) {
    console.error("[ingest] inspection échouée", err);
    await Promise.all(inFlight).catch(sansBloquer("ingest-dossier.ingestCore.all")); // ne jamais laisser une écriture orpheline
    await releaseAll();
    return { ok: false, error: "Échec de l'inspection de l'archive (fichier illisible ?)." };
  }

  if (!inspection.ok) {
    await releaseAll(); // une bombe rejetée en cours de boucle a pu stocker des blobs partiels
    await regAudit({
      companyId, actorId, dossierId, action: "INGEST_REJECTED",
      detail: `Archive « ${filename} » refusée : ${inspection.rejection?.message ?? "raison inconnue"}.`,
      meta: { code: inspection.rejection?.code ?? null, filename },
    });
    return { ok: false, error: inspection.rejection?.message ?? "Archive refusée.", rejectionCode: inspection.rejection?.code };
  }

  // 3) Archive ORIGINALE — EMPREINTE maintenant, OCTETS en fond (voir `keepOriginalArchive`).
  // L'empreinte est le seul élément dont la version a besoin tout de suite : c'est elle qui prouve
  // que le dossier analysé est bien celui qui a été reçu. Elle ne dépend jamais du fond.
  let originalSha256 = "";
  let originalSize = 0;
  try {
    if (original.kind === "buffer") {
      originalSha256 = sha256(original.buffer);
      originalSize = original.buffer.length;
    } else {
      originalSha256 = original.sha256 || (await sha256File(original.path));
      originalSize = (await stat(original.path)).size;
    }
  } catch (err) {
    console.error("[ingest] empreinte de l'archive originale illisible (analyse poursuivie)", err instanceof Error ? err.message : err);
  }
  // Garde anti-OOM : en base, on n'INSÈRE pas un bytea au-delà du plafond. Objet → pas de limite.
  const keepOriginal = originalSize > 0 && (objectStorageConfigured() || originalSize <= maxPgBlobBytes());
  if (originalSize > 0 && !keepOriginal) {
    console.warn(`[ingest] archive originale ${Math.round(originalSize / (1024 * 1024))} Mo > plafond base ${Math.round(maxPgBlobBytes() / (1024 * 1024))} Mo — non retenue (activez R2 pour la conserver). Analyse poursuivie.`);
  }

  // 4) Numéro de version + création atomique version + documents.
  try {
    const last = await prisma.regulatoryDossierVersion.findFirst({
      where: { dossierId }, orderBy: { versionNo: "desc" }, select: { versionNo: true },
    });
    const versionNo = (last?.versionNo ?? 0) + 1;

    const storableBytes = inspection.entries
      .filter((e) => isStorable(e.securityStatus))
      .reduce((s, e) => s + e.sizeBytes, 0);

    // Lignes documents préparées HORS transaction (le `dossierVersionId` est ajouté au moment de
    // l'insertion). Insertion PAR LOTS : Postgres plafonne à 65 535 paramètres/requête (~5000 docs
    // × 11 colonnes) — un très gros dossier CTD dépasse ce seuil, d'où l'échec « enregistrement
    // annulé ». On découpe donc le createMany, et on ALLONGE le délai de transaction (le défaut
    // Prisma de 5 s est trop court pour des milliers de lignes).
    const docData = inspection.entries.map((e) => {
      const storable = isStorable(e.securityStatus);
      const extraction: RegDocExtractionStatus = storable ? "PENDING" : "UNSUPPORTED";
      return {
        kind: "ORIGINAL" as const,
        originalPath: e.path,
        originalFilename: e.filename,
        ext: e.ext,
        sizeBytes: clampInt(e.sizeBytes),
        sha256: e.sha256 || "",
        compressionRatio: e.compressionRatio ?? null,
        securityStatus: SECURITY_MAP[e.securityStatus],
        extractionStatus: extraction,
        blobId: blobByPath.get(e.path) ?? null,
      };
    });
    const DOC_CHUNK = 1000; // 1000 × 11 colonnes = 11 000 paramètres, très en-deçà des 65 535

    const versionId = await prisma.$transaction(
      async (tx) => {
        const version = await tx.regulatoryDossierVersion.create({
          data: {
            dossierId, versionNo, label: opts.label ?? null,
            originalZipBlobId: null, // renseigné en fond dès que l'archive est écrite (voir ci-dessous)
            originalSha256: originalSha256 || null,
            fileCount: inspection.entries.length,
            totalBytes: clampInt(storableBytes),
            createdById: actorId,
          },
          select: { id: true },
        });

        for (let i = 0; i < docData.length; i += DOC_CHUNK) {
          await tx.regulatoryDocument.createMany({
            data: docData.slice(i, i + DOC_CHUNK).map((d) => ({ ...d, dossierVersionId: version.id })),
          });
        }

        // 5) Job EXTRACT (Node-first) — le runner le traitera en arrière-plan.
        await tx.regulatoryJob.create({
          data: { companyId, dossierId, dossierVersionId: version.id, type: "EXTRACT", status: "QUEUED", payload: { filename } },
        });

        await tx.regulatoryDossier.update({ where: { id: dossierId }, data: { status: "INGESTED" } });
        return version.id;
      },
      { timeout: 120_000, maxWait: 15_000 },
    );

    const summary: IngestSummary = {
      total: inspection.entries.length,
      stored: inspection.entries.filter((e) => e.securityStatus === "SAFE").length,
      blocked: inspection.entries.filter((e) => e.securityStatus.startsWith("BLOCKED") || e.securityStatus === "CORRUPTED").length,
      suspicious: inspection.entries.filter((e) => e.securityStatus === "SUSPICIOUS").length,
      totalBytes: clampInt(storableBytes),
    };

    // 6) Archive originale : on prend possession des octets (instantané) et on rend la main.
    // À partir d'ici l'appelant peut supprimer son répertoire temporaire sans rien casser.
    if (keepOriginal) await keepOriginalArchive(versionId, original, originalSha256);

    const originalNote = keepOriginal ? "" : " — archive originale non retenue (trop volumineuse pour la base ; activez R2 pour la conserver)";
    await regAudit({
      companyId, actorId, dossierId, dossierVersionId: versionId, action: "INGEST_OK",
      detail: `Archive « ${filename} » ingérée (v${versionNo}) : ${summary.stored} fichier(s) conservé(s), ${summary.blocked} bloqué(s), ${summary.suspicious} suspect(s)${originalNote}.`,
      meta: { filename, versionNo, ...summary, originalSha256, originalStored: keepOriginal },
    });

    return { ok: true, versionId, versionNo, summary };
  } catch (err) {
    console.error("[ingest] persistance échouée — rollback", err);
    // Pas d'archive originale à libérer : elle n'est écrite qu'APRÈS le succès de la transaction.
    await releaseAll();
    return { ok: false, error: "Échec de l'enregistrement du dossier (annulé)." };
  }
}

// ───────────────────── Archive originale : conservée HORS DU CHEMIN CRITIQUE ─────────────────────

const pendingArchives = new Set<Promise<void>>();
let archiveQueue: Promise<void> = Promise.resolve();

/**
 * Les archives sont écrites UNE À LA FOIS. Elles ne sont plus sur le chemin critique, donc leur
 * durée n'intéresse personne — mais chacune monopolise une connexion à la base pendant toute son
 * écriture. Sans cette file, trois dossiers déposés ensemble en retiendraient trois, et c'est la
 * transaction d'enregistrement du dossier SUIVANT qui attendrait une connexion (`maxWait`) puis
 * échouerait. La pression de fond est ainsi bornée à une connexion, quoi qu'il arrive.
 */
function enqueueArchive(run: () => Promise<void>): void {
  const task = archiveQueue.then(run); // `run` n'échoue jamais (attachArchive absorbe ses erreurs)
  archiveQueue = task;
  pendingArchives.add(task);
  void task.finally(() => pendingArchives.delete(task));
}

/**
 * Écrire l'archive complète en base coûte ~10 s par 60 Mo — c'était PLUS DE LA MOITIÉ du temps de
 * finalisation d'un téléversement, et cela grandit linéairement (≈ 2 min pour 800 Mo). Postgres
 * plafonne à ~11 Mo/s en écriture d'octets, WAL compris : ni la taille des tranches ni le
 * parallélisme n'y changent quoi que ce soit (mesuré — `scripts/bench/big-blob.ts`). Le seul vrai
 * remède est le stockage objet (R2/S3), où le navigateur écrit directement dans le bucket.
 *
 * Or PERSONNE n'attend cette archive : elle sert à la traçabilité et au téléchargement ultérieur,
 * jamais à l'analyse, qui travaille sur les fichiers déjà stockés un par un. On rend donc la main
 * dès que la version existe, et l'archive rejoint la base en fond. Ce qui est garanti tout de
 * suite — l'empreinte SHA-256, le manifeste, les fichiers — l'est exactement comme avant.
 *
 * Le fichier temporaire est DÉPLACÉ hors du répertoire de l'appelant (rename, instantané : même
 * système de fichiers), qui le supprime dès son retour ; le fond en devient propriétaire et le
 * nettoie. Si le déplacement échoue, on écrit en ligne comme auparavant : jamais de perte.
 */
async function keepOriginalArchive(versionId: string, source: OriginalSource, sha: string): Promise<void> {
  if (source.kind === "buffer") {
    enqueueArchive(() => attachArchive(versionId, () => putBlob(source.buffer)));
    return;
  }

  let kept: { dir: string; path: string };
  try {
    const dir = await mkdtemp(join(tmpdir(), "reg-archive-"));
    const path = join(dir, "archive.zip");
    await rename(source.path, path);
    kept = { dir, path };
  } catch (err) {
    // Déplacement impossible (systèmes de fichiers distincts…) → écriture EN LIGNE, comme avant.
    console.warn("[ingest] archive originale non détachable — écriture immédiate", err instanceof Error ? err.message : err);
    await attachArchive(versionId, () => putBlobFromFile(source.path, { sha256: sha }));
    return;
  }

  enqueueArchive(() =>
    attachArchive(versionId, async () => {
      try {
        return await putBlobFromFile(kept.path, { sha256: sha });
      } finally {
        await rm(kept.dir, { recursive: true, force: true }).catch(attendu("nettoyage : le fichier peut déjà être parti"));
      }
    }),
  );
}

/** Écrit l'archive puis raccroche le blob à sa version. Ne lève jamais : l'analyse prime. */
async function attachArchive(versionId: string, write: () => Promise<{ blobId: string }>): Promise<void> {
  let blobId: string | null = null;
  try {
    blobId = (await write()).blobId;
    await prisma.regulatoryDossierVersion.update({ where: { id: versionId }, data: { originalZipBlobId: blobId } });
  } catch (err) {
    console.error("[ingest] conservation de l'archive originale échouée (dossier analysable)", err instanceof Error ? err.message : err);
    // La version a disparu (dossier supprimé pendant l'écriture) → ne pas laisser un blob orphelin.
    if (blobId) await releaseBlob(blobId).catch(sansBloquer("ingest-dossier.attachArchive.releaseBlob"));
  }
}

/** Attend les archives encore en cours d'écriture (tests, arrêt propre). */
export async function flushOriginalArchives(): Promise<void> {
  while (pendingArchives.size > 0) await Promise.all([...pendingArchives]);
}
