import { BLOB_MAX_BYTES } from "@/lib/storage/limites-blob";
import crypto from "crypto";
import { createReadStream } from "fs";
import { readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join as joindre } from "path";
import { Prisma } from "@prisma/client";
import { decider, compresserFichierSiUtile, decompresser } from "./compression/flux";
import { codecConnu } from "./compression/politique";
import { prisma } from "./prisma";
import { sqlAucuneColonneNeLeTient, sqlBlobsCitesEnJson } from "./storage/blob-refs";
import {
  objectStorageConfigured, putObject, putObjectStream, getObject, deleteObject, MULTIPART_THRESHOLD_BYTES,
} from "./storage/object-storage";
import { sansBloquer } from "@/lib/journal";

/**
 * Drive blob backend — content-addressed, encrypted at rest.
 *
 * Les octets sont chiffrés (AES-256-GCM) puis dédupliqués par le SHA-256 du *clair*. Le contenu
 * chiffré est stocké soit **dans un bucket S3-compatible** (Supabase Storage, R2, MinIO… si
 * `S3_*` est configuré → la base ne garde que les métadonnées, son disque arrête de gonfler),
 * soit **en base** (repli historique, toujours fonctionnel). Le bucket ne reçoit QUE du chiffré :
 * il ne remplace pas la sécurité applicative, il porte les octets. La base
 * conserve toujours l'IV (12 o) + taille + SHA + compteur de références. **Rétrocompatible** : un
 * blob existant sans `storageKey` est lu depuis la colonne `data`. Point unique touchant les octets.
 */

function masterKey(): Buffer {
  const explicit = process.env.DRIVE_ENCRYPTION_KEY;
  if (explicit) {
    const buf = Buffer.from(explicit, explicit.length === 64 ? "hex" : "base64");
    if (buf.length === 32) return buf;
  }
  // Fallback: derive a stable 32-byte key from the auth secret (always present).
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "amd-internal-os";
  return crypto.createHash("sha256").update(secret).digest();
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Clé objet du contenu chiffré d'un blob — UNIQUE par écriture, jamais par contenu seul.
 *
 * Adressée par le seul SHA-256, deux écritures concurrentes du MÊME contenu visaient la même
 * clé, chacune avec son propre IV : la seconde arrivée écrasait l'objet de la première, dont la
 * ligne gardait l'IV d'origine — fichier indéchiffrable. Et l'effacement d'un blob libéré
 * supprimait l'objet que le dépôt suivant du même contenu venait d'écrire sous la même clé
 * (audit du 04/10, constat 4). La déduplication se décide EN BASE (index unique `sha256`) ;
 * l'objet, lui, appartient à une seule ligne. Les blobs existants gardent leur clé : elle est
 * lue dans `storageKey`, jamais recalculée.
 */
const blobKey = (hash: string) => `blobs/${hash.slice(0, 2)}/${hash}-${crypto.randomBytes(6).toString("hex")}`;

/** Taille maximale d'un blob : la colonne `size` est un entier 32 bits. Au-delà, on le DIT avant d'écrire. */
export { BLOB_MAX_BYTES };
function refuserSiTropGros(size: number): void {
  if (size > BLOB_MAX_BYTES) {
    throw new Error(`Fichier trop volumineux pour le coffre chiffré (${Math.round(size / 1024 ** 2)} Mo > 2 047 Mo).`);
  }
}

/**
 * RÉEMPLOI ATOMIQUE d'un contenu déjà stocké. Une seule instruction : le compteur monte et la
 * date de prise est posée sous le verrou de la ligne. Lire puis incrémenter laissait un
 * effacement passer entre les deux — le dépôt recevait l'identifiant d'un blob effacé, et la
 * fiche créée ensuite tombait sur une erreur de clé étrangère brute (constat 4).
 */
async function reemployer(hash: string): Promise<PutBlobResult | null> {
  const rows = await prisma.$queryRaw<{ id: string; size: number }[]>`
    UPDATE "FileBlob" SET "refCount" = "refCount" + 1, "touchedAt" = now()
    WHERE sha256 = ${hash} RETURNING id, size`;
  const r = rows[0];
  return r ? { blobId: r.id, sha256: hash, size: r.size, deduplicated: true } : null;
}

/**
 * PREND une référence de plus sur un blob existant — c'est ce que fait une COPIE de fichier.
 *
 * Copier un fichier du Drive pointait la nouvelle version vers le même blob sans compter ce
 * nouveau détenteur : supprimer la copie puis l'original libérait deux fois un compteur qui
 * valait un (audit du 04/10, constat 3). Rend `false` si le blob n'existe plus : l'appelant
 * refuse alors au lieu de créer une version qui ne s'ouvrira jamais.
 */
export async function retainBlob(
  blobId: string,
  client: { $executeRaw: typeof prisma.$executeRaw } = prisma,
): Promise<boolean> {
  const n = await client.$executeRaw`
    UPDATE "FileBlob" SET "refCount" = "refCount" + 1, "touchedAt" = now() WHERE id = ${blobId}`;
  return n > 0;
}

// Taille d'une TRANCHE de contenu chiffré en base (défaut 16 Mo). Au-delà de cette taille, un fichier
// est stocké en plusieurs lignes ordonnées plutôt qu'en un bytea unique — dont l'encodage hex sur le
// fil doublerait la taille en mémoire (cause d'OOM). Permet des fichiers jusqu'à ~1 Go en base.
const blobChunkBytes = () => {
  const mb = Number(process.env.REG_BLOB_CHUNK_MB ?? 16);
  return Math.max(1, Number.isFinite(mb) && mb > 0 ? mb : 16) * 1024 * 1024;
};

/** Chiffre le clair en UN buffer `ciphertext || tag` (petits fichiers / stockage objet). */
function encryptWhole(plain: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]);
}

/**
 * Chiffre un fichier EN FLUX : rend le contenu chiffré morceau par morceau, terminé par le tag
 * d'authentification GCM. La concaténation de ce que rend ce générateur est exactement ce que
 * produirait `encryptWhole` — c'est ce qui rend les deux chemins interchangeables à la lecture.
 *
 * Le fichier n'est jamais tenu entier en mémoire, ni en clair ni chiffré.
 */
async function* encryptFileStream(path: string, iv: Buffer): AsyncGenerator<Buffer> {
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) {
    const enc = cipher.update(chunk as Buffer);
    if (enc.length > 0) yield enc;
  }
  yield Buffer.concat([cipher.final(), cipher.getAuthTag()]);
}


/**
 * PAS DE FAUX SUCCÈS, PAS DE REPLI SILENCIEUX.
 *
 * Quand le stockage objet est configuré mais refuse d'écrire (panne, clé révoquée, bucket plein),
 * on NE bascule PAS discrètement sur la base : un retour au stockage en base fabriquerait des
 * blobs gigantesques dans Postgres à l'insu de tout le monde, jusqu'à saturer le disque de la
 * base — une panne bien pire, et découverte bien plus tard. On échoue, et on le dit clairement.
 */
function storageFailure(err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    `Le fichier n'a pas pu être enregistré dans le stockage : ${detail} `
    + "Réessayez dans un instant ; si cela persiste, signalez-le à l'administrateur "
    + "(Administration → Stockage → Tester la connexion).",
  );
}

/** Ce qu'a produit une écriture. `deduplicated` = le contenu existait déjà, aucune place NEUVE prise. */
export interface PutBlobResult {
  blobId: string; sha256: string; size: number; deduplicated: boolean;
  /** Octets RÉELLEMENT pris par une écriture neuve (le clair compressé quand il l'est) ; absent si dédupliqué. */
  storedSize?: number;
}

/** Ce qu'une écriture ajoute à la ligne `FileBlob` quand son contenu est stocké compressé (rien sinon : brut). */
type MetaCompression = { codec?: string; storedSize?: number };

/**
 * LA COURSE DE DÉDUPLICATION — deux écritures du MÊME contenu au même instant.
 *
 * `putBlob` cherche l'empreinte, ne la trouve pas, et crée la ligne. Deux appels parallèles
 * (deux personnes qui déposent la même pièce, une ingestion qui traite un lot de fichiers
 * identiques de front) passent tous deux la recherche, et le second `create` tombe sur l'index
 * unique `sha256` (P2002). Mesuré dans la suite : l'ingestion d'un dossier CTD de mille fichiers
 * échouait ainsi une fois sur quelques passages. Le contenu existe bel et bien — la bonne réponse
 * n'est pas une erreur, c'est la ligne gagnante, avec son compteur de références incrémenté.
 */
function isUniqueSha256Violation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== "P2002") return false;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.includes("sha256") : typeof target === "string" ? target.includes("sha256") : true;
}

async function createOrAdoptBlob(
  data: Parameters<typeof prisma.fileBlob.create>[0]["data"],
  hash: string,
  size: number,
): Promise<PutBlobResult> {
  try {
    const blob = await prisma.fileBlob.create({ data, select: { id: true } });
    const stocke = (data as { storedSize?: number | null }).storedSize;
    return { blobId: blob.id, sha256: hash, size, deduplicated: false, storedSize: stocke ?? size };
  } catch (err) {
    if (!isUniqueSha256Violation(err)) throw err;
    const winner = await reemployer(hash);
    if (!winner) throw err;
    // L'objet que CETTE écriture avait poussé n'appartient à personne : la ligne gagnante a le sien.
    const own = (data as { storageKey?: string | null }).storageKey;
    if (own) await deleteObject(own);
    return winner;
  }
}

/** Store bytes (encrypted, deduplicated). Increments the ref-count on reuse. */
export async function putBlob(plain: Buffer): Promise<PutBlobResult> {
  const hash = sha256(plain);
  const existing = await reemployer(hash);
  if (existing) return existing;
  const iv = crypto.randomBytes(12);

  // COMPRESSION SANS PERTE AU REPOS (§118.214) : compresser AVANT de chiffrer (un contenu chiffré
  // ne se compresse plus). La décision se lit sur les OCTETS — ce point d'entrée ne reçoit pas de
  // nom de fichier — et le résultat est relu avant d'être rendu ; un doute, un gain mince ou un
  // format déjà compressé laissent les octets bruts, comme avant. `sha256` et `size` restent ceux du clair.
  const d = await decider(plain);
  const contenu = d.compresse ? d.octets : plain;
  const meta: MetaCompression = d.compresse ? { codec: d.codec, storedSize: d.octets.length } : {};

  // Stockage OBJET (S3/R2) si configuré → la base ne garde que les métadonnées + l'IV.
  if (objectStorageConfigured()) {
    const key = blobKey(hash);
    // contenu CHIFFRÉ dans le bucket — il ne voit jamais le clair
    const encrypted = encryptWhole(contenu, iv);
    try {
      // Gros contenu → envoi EN PARTIES PARALLÈLES. Un PUT unique de 300 Mo attend un seul flux du
      // début à la fin ; quatre parties en vol saturent la liaison. Le découpage ne recopie rien
      // (des vues sur le buffer déjà chiffré), le gain est donc net.
      if (encrypted.length > MULTIPART_THRESHOLD_BYTES) {
        await putObjectStream(key, (async function* () { yield encrypted; })());
      } else {
        await putObject(key, encrypted);
      }
    } catch (err) { throw storageFailure(err); }
    return createOrAdoptBlob({ sha256: hash, size: plain.length, iv, data: null, storageKey: key, refCount: 1, ...meta }, hash, plain.length);
  }

  // Base, gros fichier → écriture EN TRANCHES (mémoire bornée à une tranche, pas d'hex géant).
  if (contenu.length > blobChunkBytes()) return putBlobChunked(contenu, plain.length, hash, iv, meta);

  // Base, petit fichier → une seule valeur bytea (chemin historique, rétrocompatible).
  return createOrAdoptBlob({ sha256: hash, size: plain.length, iv, data: encryptWhole(contenu, iv), refCount: 1, ...meta }, hash, plain.length);
}

/** Écrit le contenu chiffré en tranches ordonnées (streaming du chiffrement → mémoire bornée). */
async function putBlobChunked(plain: Buffer, tailleClair: number, hash: string, iv: Buffer, meta: MetaCompression = {}): Promise<PutBlobResult> {
  // `plain` = le contenu À STOCKER (le clair, ou le clair compressé) ; `tailleClair` = ce que dit `size`.
  const created = await createOrAdoptBlob({ sha256: hash, size: tailleClair, iv, data: null, refCount: 1, ...meta }, hash, tailleClair);
  // Le contenu venait d'être écrit par un autre appel : ses tranches sont (ou seront) les siennes.
  if (created.deduplicated) return created;
  const blob = { id: created.blobId };
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
    const step = blobChunkBytes();
    let idx = 0;
    for (let off = 0; off < plain.length; off += step) {
      const enc = cipher.update(plain.subarray(off, Math.min(off + step, plain.length)));
      if (enc.length > 0) await prisma.fileBlobChunk.create({ data: { blobId: blob.id, idx: idx++, data: enc } });
    }
    // Dernière tranche : reliquat éventuel + tag d'authentification (16 o). Concat des tranches = ciphertext || tag.
    await prisma.fileBlobChunk.create({ data: { blobId: blob.id, idx: idx++, data: Buffer.concat([cipher.final(), cipher.getAuthTag()]) } });
    return { blobId: blob.id, sha256: hash, size: tailleClair, deduplicated: false, storedSize: meta.storedSize ?? tailleClair };
  } catch (err) {
    await prisma.fileBlob.delete({ where: { id: blob.id } }).catch(sansBloquer("drive-storage.putBlobChunked.fileBlob")); // cascade → supprime les tranches partielles
    throw err;
  }
}

/** SHA-256 d'un fichier lu EN FLUX (jamais chargé entier en mémoire). */
export async function sha256File(path: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Stocke le contenu d'un FICHIER sur disque sans jamais le charger entièrement en mémoire :
 * lecture en flux → chiffrement incrémental → écriture par tranches. Pic mémoire ≈ une tranche,
 * quelle que soit la taille du fichier (une archive CTD peut peser plusieurs centaines de Mo).
 *
 * `sha256` peut être fourni quand l'empreinte a déjà été calculée en amont (c'est le cas à
 * l'assemblage d'un upload) : la déduplication se décide alors SANS relire le fichier du tout.
 */
export async function putBlobFromFile(path: string, opts: { sha256?: string } = {}): Promise<PutBlobResult> {
  const hash = opts.sha256 || (await sha256File(path));
  const existing = await reemployer(hash);
  if (existing) return existing;
  const { size } = await stat(path);
  refuserSiTropGros(size);

  // COMPRESSION SANS PERTE AU REPOS (§118.214), EN FLUX : le fichier est compressé vers un fichier
  // temporaire, relu en flux (décompression + SHA-256 comparé à celui du clair) et seulement alors
  // stocké à sa place. La mémoire ne dépend pas de la taille ; un doute laisse les octets bruts.
  const compresse = await compresserFichierSiUtile(path, size, hash, joindre(tmpdir(), `amd-cmp-${crypto.randomBytes(8).toString("hex")}.br`));
  const source = compresse.resultat?.chemin ?? path;
  const aStocker = compresse.resultat?.taille ?? size;
  const meta: MetaCompression = compresse.resultat ? { codec: compresse.resultat.codec, storedSize: compresse.resultat.taille } : {};
  try {
    // Stockage OBJET — EN FLUX. Le fichier est lu par morceaux, chiffré au fil de l'eau et poussé
    // vers le bucket en plusieurs parties : le pic mémoire vaut une partie (16 Mio), qu'il s'agisse
    // d'un PDF de 2 Mo ou d'une archive CTD d'un gigaoctet. Charger le fichier entier ici ferait
    // tomber le processus sur un hébergeur à mémoire bornée — panne d'autant plus difficile à
    // diagnostiquer qu'elle ne se déclenche qu'au-delà d'une certaine taille de dossier.
    if (objectStorageConfigured()) {
      const key = blobKey(hash);
      const iv = crypto.randomBytes(12);
      try {
        if (aStocker <= MULTIPART_THRESHOLD_BYTES) {
          // Petit fichier : un PUT simple reste plus rapide qu'un téléversement en parties.
          await putObject(key, encryptWhole(await readFile(source), iv));
        } else {
          await putObjectStream(key, encryptFileStream(source, iv));
        }
      } catch (err) {
        throw storageFailure(err);
      }
      return await createOrAdoptBlob({ sha256: hash, size, iv, data: null, storageKey: key, refCount: 1, ...meta }, hash, size);
    }

    const iv = crypto.randomBytes(12);
    const created = await createOrAdoptBlob({ sha256: hash, size, iv, data: null, refCount: 1, ...meta }, hash, size);
    // Le contenu venait d'être écrit par un autre appel : ses tranches sont (ou seront) les siennes.
    if (created.deduplicated) return created;
    const blob = { id: created.blobId };
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
      let idx = 0;
      let read = 0;
      // Les tranches sont recollées à la lecture dans l'ordre `idx` : leurs tailles respectives
      // n'ont aucune importance, seul l'ordre compte.
      for await (const chunk of createReadStream(source, { highWaterMark: blobChunkBytes() })) {
        const plain = chunk as Buffer;
        read += plain.length;
        const enc = cipher.update(plain);
        if (enc.length > 0) await prisma.fileBlobChunk.create({ data: { blobId: blob.id, idx: idx++, data: enc } });
      }
      if (read !== aStocker) throw new Error(`Fichier modifié pendant la lecture (${read} ≠ ${aStocker}).`);
      await prisma.fileBlobChunk.create({ data: { blobId: blob.id, idx: idx++, data: Buffer.concat([cipher.final(), cipher.getAuthTag()]) } });
      return { blobId: blob.id, sha256: hash, size, deduplicated: false, storedSize: aStocker };
    } catch (err) {
      await prisma.fileBlob.delete({ where: { id: blob.id } }).catch(sansBloquer("drive-storage.putBlobFromFile.fileBlob")); // cascade → tranches partielles
      throw err;
    }
  } finally {
    await compresse.resultat?.nettoyer();
  }
}

/** Retrieve and decrypt bytes by blob id (objet S3/R2, bytea unique, ou tranches — selon le stockage). */
export async function getBlob(blobId: string): Promise<Buffer | null> {
  const blob = await prisma.fileBlob.findUnique({ where: { id: blobId }, select: { iv: true, data: true, storageKey: true, size: true, codec: true, storedSize: true, sha256: true } });
  if (!blob) return null;
  // Déposé EN DIRECT par le navigateur (gros fichier) : l'objet est en clair dans le bucket,
  // protégé par le chiffrement au repos du fournisseur — un IV vide le signale.
  if (blob.storageKey && blob.iv.length === 0) return getObject(blob.storageKey);
  let cipherBytes: Buffer | null;
  if (blob.storageKey) cipherBytes = await getObject(blob.storageKey);
  else if (blob.data) cipherBytes = Buffer.from(blob.data);
  else {
    const chunks = await prisma.fileBlobChunk.findMany({ where: { blobId }, orderBy: { idx: "asc" }, select: { data: true } });
    cipherBytes = chunks.length > 0 ? Buffer.concat(chunks.map((c) => Buffer.from(c.data))) : null;
    // Intégrité : le chiffré GCM fait taille_stockée + 16 (tag) — la taille du clair quand rien
    // n'est compressé. Un blob chunké incomplet est écarté (`storedSize` nul pendant l'écriture
    // d'une ligne compressée : le test échoue alors, et c'est voulu).
    const attendu = (blob.codec ? blob.storedSize : blob.size);
    if (cipherBytes && (attendu == null || cipherBytes.length !== attendu + 16)) return null;
  }
  if (!cipherBytes) return null;
  const iv = Buffer.from(blob.iv);
  const tag = cipherBytes.subarray(cipherBytes.length - 16);
  const enc = cipherBytes.subarray(0, cipherBytes.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  const stocke = Buffer.concat([decipher.update(enc), decipher.final()]);
  if (!blob.codec) return stocke; // brut : tout fichier d'avant, et tout ce que la mesure juge déjà compressé
  // COMPRIMÉ AU REPOS : on rend EXACTEMENT les octets déposés. Taille ET empreinte sont relues —
  // le chiffrement authentifie ce qui est stocké, pas ce que la décompression en fait.
  if (!codecConnu(blob.codec)) throw new Error(`Codec de stockage inconnu « ${blob.codec} » — ce fichier ne peut pas être relu par cette version.`);
  const clair = await decompresser(blob.codec, stocke, blob.size);
  if (sha256(clair) !== blob.sha256) throw new Error("Empreinte du fichier décompressé inattendue — fichier corrompu.");
  return clair;
}

/**
 * Ce qu'on peut dire d'un blob SANS le lire : l'empreinte du clair (vérifiable par qui reçoit les
 * octets), sa taille, et si le stockage le garde compressé. `null` : blob absent. Un blob déposé
 * en direct n'a pas de vraie empreinte (`direct:<clé>`) : elle est rendue absente, pas inventée.
 */
export async function infoBlob(blobId: string): Promise<{ sha256: string | null; size: number; codec: string | null; storedSize: number | null } | null> {
  const b = await prisma.fileBlob.findUnique({ where: { id: blobId }, select: { sha256: true, size: true, codec: true, storedSize: true } });
  if (!b) return null;
  return { sha256: /^[0-9a-f]{64}$/.test(b.sha256) ? b.sha256 : null, size: b.size, codec: b.codec, storedSize: b.storedSize };
}

/**
 * Rend une référence ; efface le blob (base + objet) quand plus PERSONNE ne le tient.
 *
 * Deux gardes, et il faut les deux (audit du 04/10, constats 2 et 4) :
 *   • le compteur descend, et l'effacement se décide sous la condition « compteur ≤ 0 » RELUE au
 *     moment d'effacer — un dépôt du même contenu qui l'a fait remonter entre-temps le garde ;
 *   • aucune colonne du schéma ne doit encore le désigner — un compteur périmé (une suppression
 *     en cascade ne décrémente rien) ne suffit plus à faire disparaître les octets d'un détenteur
 *     vivant. Le blob reste alors, compteur à zéro, et seule la purge (qui lit aussi le JSON)
 *     peut décider de lui.
 */
export async function releaseBlob(blobId: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ refCount: number }[]>`
    UPDATE "FileBlob" SET "refCount" = GREATEST("refCount" - 1, 0) WHERE id = ${blobId} RETURNING "refCount"`;
  if (!rows[0] || rows[0].refCount > 0) return;
  const gone = await prisma.$queryRaw<{ storageKey: string | null }[]>(Prisma.sql`
    DELETE FROM "FileBlob" b
    WHERE b.id = ${blobId} AND b."refCount" <= 0 AND ${sqlAucuneColonneNeLeTient("b")}
    RETURNING b."storageKey"`);
  if (gone[0]?.storageKey) await deleteObject(gone[0].storageKey); // ne lève jamais
}

/** Un blob pris depuis moins de ce délai n'est jamais purgé : son détenteur s'écrit peut-être. */
export const PURGE_DELAI_MINUTES = 60;

/**
 * RAMASSE-MIETTES du stockage physique : efface les blobs que PERSONNE ne tient plus.
 *
 * « Personne » se lit dans le SCHÉMA (`storage/blob-refs.ts`) : toutes les colonnes qui
 * désignent un blob, ET toute clé `…blobId` d'une colonne JSON (logo de marque, ligne de la
 * corbeille). La version d'avant ne regardait que deux tables : lancée, elle aurait détruit les
 * pièces de messagerie, les documents RH, les pièces Regulatory, les rapports terrain, le papier
 * en-tête… (audit du 04/10, constat 2). Un blob pris depuis moins d'une heure est épargné : le
 * dépôt qui l'a créé n'a peut-être pas encore écrit sa fiche.
 *
 * Elle ne se déclenche plus d'elle-même à chaque suppression : c'est un geste d'administration.
 */
export async function purgeOrphanBlobs(opts: { parmi?: string[] } = {}): Promise<{ count: number; bytes: number }> {
  const candidats = await orphelins(opts.parmi);
  if (candidats.length === 0) return { count: 0, bytes: 0 };
  const ids = candidats.map((c) => c.id);
  // La condition est REJOUÉE au moment d'effacer : un réemploi passé entre les deux lectures a
  // fait bouger `touchedAt`, et la ligne est épargnée.
  const orphans = await prisma.$queryRaw<{ id: string; size: number; storageKey: string | null }[]>(Prisma.sql`
    DELETE FROM "FileBlob" b
    WHERE b.id = ANY(${ids}) AND b."touchedAt" < now() - make_interval(mins => ${PURGE_DELAI_MINUTES}::int)
      AND ${sqlAucuneColonneNeLeTient("b")}
    RETURNING b.id, b.size, b."storageKey"`);
  let bytes = 0;
  for (const o of orphans) {
    bytes += o.size;
    if (o.storageKey) await deleteObject(o.storageKey); // ne lève jamais
  }
  return { count: orphans.length, bytes };
}

/** Les blobs qu'aucune colonne ni aucun JSON ne tient, pris depuis plus d'une heure (`parmi` : bornés à ces identifiants). */
async function orphelins(parmi?: string[]): Promise<{ id: string; size: number }[]> {
  const borne = parmi ? Prisma.sql`AND b.id = ANY(${parmi})` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: string; size: number }[]>(Prisma.sql`
    SELECT b.id, b.size FROM "FileBlob" b
    WHERE b."touchedAt" < now() - make_interval(mins => ${PURGE_DELAI_MINUTES}::int)
      AND ${sqlAucuneColonneNeLeTient("b")} ${borne}`);
  if (rows.length === 0) return rows;
  const json = sqlBlobsCitesEnJson();
  if (!json) return rows;
  const cites = new Set((await prisma.$queryRaw<{ id: string }[]>(json)).map((r) => r.id));
  return rows.filter((r) => !cites.has(r.id));
}

/** Octets physiques réellement récupérables par un ramasse-miettes (blobs que personne ne tient). */
export async function countOrphanBlobs(): Promise<{ count: number; bytes: number }> {
  const rows = await orphelins();
  return { count: rows.length, bytes: rows.reduce((a, r) => a + r.size, 0) };
}

/**
 * La clé objet d'un blob déposé EN DIRECT (en clair dans le bucket), ou `null`. Le téléchargement
 * d'un tel fichier ne passe pas par l'application : elle signe une adresse, et le navigateur lit
 * le bucket — plusieurs gigaoctets ne transitent ni par la mémoire du serveur ni par sa bande.
 */
export async function cleObjetDirect(blobId: string): Promise<string | null> {
  const b = await prisma.fileBlob.findUnique({ where: { id: blobId }, select: { iv: true, storageKey: true } });
  return b?.storageKey && b.iv.length === 0 ? b.storageKey : null;
}
