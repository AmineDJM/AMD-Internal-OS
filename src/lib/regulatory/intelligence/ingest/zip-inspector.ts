import { createHash } from "crypto";
import { stat } from "fs/promises";
import JSZip from "jszip";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";

/**
 * INSPECTEUR ZIP SÉCURISÉ (Regulatory Intelligence — Phase 1).
 *
 * Traite l'archive fournisseur comme **hostile**. Applique des garde-fous AVANT toute
 * extraction (anti ZIP-bomb par taille/ratio déclarés, nombre de fichiers, profondeur),
 * refuse le path traversal et les exécutables/scripts/macros, signale archives imbriquées
 * et entrées chiffrées, et produit un **manifest** (chemin/nom d'origine, taille, SHA-256,
 * ratio, statut de sécurité). Fonction PURE (aucune base) → unitairement testable.
 *
 * Les tailles DÉCLARÉES du répertoire central ne sont qu'une annonce (un fichier hostile peut mentir) :
 * chaque entrée se décompresse EN FLUX avec un compteur des octets RÉELS, coupé net au plafond par
 * entrée (≤ 256 Mo) — jamais une entrée décompressée entière en mémoire avant d'être mesurée
 * (audit Drive F10, 24/11/2026). Les gros dossiers passent par `inspectZipFile` (yauzl, depuis le disque).
 */

const MB = 1024 * 1024;

/** Le plafond DUR d'une entrée décompressée (audit Drive F10) : ni une variable, ni un appelant ne le relèvent. */
export const PLAFOND_ENTREE_OCTETS = 256 * MB;

export interface ZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxTotalUncompressed: number;
  maxFileUncompressed: number;
  maxRatio: number; // total décompressé / archive compressée
  maxDepth: number; // profondeur d'arborescence
}

// Plafonds de TAILLE volontairement LARGES (gros dossiers CTD réels : plusieurs centaines de Mo).
// Ces défauts pilotent en un seul point le contrôle d'archive (route directe + session résumable
// + inspecteur) — voir `MAX_TOTAL_BYTES` (session) aligné dessus. Tout reste réglable par variables
// d'env : à la HAUSSE si l'hôte a la RAM (l'archive est inspectée en mémoire → pic ≈ archive + plus
// gros fichier ; prévoir une instance dimensionnée), ou à la BAISSE pour re-durcir.
// Les gardes anti ZIP-bomb (ratio de compression, profondeur, nombre d'entrées) restent actives :
// elles protègent contre l'abus SANS brider la taille d'un dossier légitime.
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxArchiveBytes: Number(process.env.REG_ZIP_MAX_ARCHIVE_MB ?? "10240") * MB, // 10 Go compressés
  maxEntries: Number(process.env.REG_ZIP_MAX_ENTRIES ?? "50000"),
  maxTotalUncompressed: Number(process.env.REG_ZIP_MAX_TOTAL_MB ?? "16384") * MB, // 16 Go décompressés
  // Par ENTRÉE : 256 Mo au plus, quoi que dise la variable — une entrée se tient en mémoire le temps
  // d'être empreintée et stockée ; au-delà, une seule entrée suffirait à faire tomber l'instance.
  maxFileUncompressed: Math.min(PLAFOND_ENTREE_OCTETS, Number(process.env.REG_ZIP_MAX_FILE_MB ?? "256") * MB),
  maxRatio: Number(process.env.REG_ZIP_MAX_RATIO ?? "500"),
  maxDepth: Number(process.env.REG_ZIP_MAX_DEPTH ?? "16"),
};

export type SecurityStatus =
  | "SAFE" | "BLOCKED_EXECUTABLE" | "BLOCKED_ENCRYPTED" | "BLOCKED_PATH"
  | "BLOCKED_OVERSIZE" | "SUSPICIOUS" | "CORRUPTED";

export type RejectionCode =
  | "ARCHIVE_TOO_LARGE" | "TOO_MANY_FILES" | "TOTAL_TOO_LARGE" | "RATIO_EXCEEDED"
  | "CORRUPT_ARCHIVE" | "EMPTY";

export interface ManifestEntry {
  path: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  sha256: string;
  compressionRatio?: number;
  securityStatus: SecurityStatus;
  note?: string;
}

export interface ZipInspection {
  ok: boolean;
  rejection?: { code: RejectionCode; message: string };
  entries: ManifestEntry[];
  totals: { files: number; totalBytes: number; archiveBytes: number };
}

/**
 * Options de l'inspecteur : plafonds + rappel de stockage optionnel.
 * `onStorableEntry` est appelé pour chaque entrée SÛRE/SUSPECTE avec ses octets déjà
 * décompressés — permettant à l'ingestion de **stocker immédiatement** le blob (un
 * fichier à la fois → mémoire bornée) sans re-décompresser ni retenir tout le contenu.
 */
export type InspectOptions = Partial<ZipLimits> & {
  onStorableEntry?: (entry: ManifestEntry, data: Buffer) => Promise<void>;
};

// Exécutables / scripts / macros / contenu actif : jamais matérialisés.
const BLOCKED_EXT = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "cpl", "jar", "js", "mjs", "cjs",
  "vbs", "vbe", "ws", "wsf", "wsh", "ps1", "psm1", "sh", "bash", "zsh", "app", "dmg",
  "deb", "rpm", "apk", "dll", "so", "sys", "scf", "lnk", "reg", "hta", "jse", "msc",
  "gadget", "vb", "vba", "docm", "xlsm", "pptm", "dotm", "xltm", "potm", "xlam", "ppam",
]);

// Archives imbriquées : signalées (non décompressées récursivement).
const NESTED_ARCHIVE_EXT = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "cab", "iso"]);

const extOf = (name: string) => {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/**
 * Détecte un chemin dangereux (traversal `..`, absolu, octet nul, backslash, lecteur, `~`).
 *
 * Prédicat de sécurité PUR et exhaustif : il ne dépend PAS de JSZip. À noter que JSZip
 * *normalise* déjà `../a` → `a` à la lecture, et que notre stockage est adressé par
 * SHA-256 (jamais par ce chemin) — cette fonction reste la défense explicite pour les
 * vecteurs que JSZip préserve (chemins absolus, backslashes, octet nul, `C:`) et documente
 * l'intention de sécurité indépendamment de la lib.
 */
export function unsafePath(path: string): boolean {
  if (!path) return true;
  if (path.includes("\0")) return true;
  if (path.includes("\\")) return true; // séparateurs Windows normalisés côté sûr
  if (path.startsWith("/")) return true; // absolu POSIX
  if (/^[a-zA-Z]:/.test(path)) return true; // lecteur Windows (C:)
  const segs = path.split("/");
  return segs.some((s) => s === ".." || s === "~");
}

/** Tailles déclarées dans le répertoire central (JSZip interne, avec repli). */
function declaredSizes(file: JSZip.JSZipObject): { compressed?: number; uncompressed?: number } {
  const d = (file as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
  return { compressed: d?.compressedSize, uncompressed: d?.uncompressedSize };
}

/** Les plafonds effectifs : ceux de l'appelant, l'entrée jamais au-delà du plafond dur. */
function limites(limOpts: Partial<ZipLimits>): ZipLimits {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limOpts };
  return { ...lim, maxFileUncompressed: Math.min(lim.maxFileUncompressed, PLAFOND_ENTREE_OCTETS) };
}

/**
 * Décompresse UNE entrée JSZip EN FLUX, en comptant les octets RÉELS : au-delà de `cap`, le flux est
 * coupé et l'entrée rend « OVERSIZE » — rien de plus que `cap` octets n'est jamais tenu en mémoire.
 */
function lireEntreeBornee(f: JSZip.JSZipObject, cap: number): Promise<Buffer | "OVERSIZE"> {
  return new Promise((resolve, rej) => {
    const flux = f.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy?: () => void };
    const morceaux: Buffer[] = [];
    let total = 0, fini = false;
    flux.on("data", (c: Buffer) => {
      if (fini) return;
      total += c.length;
      if (total > cap) { fini = true; morceaux.length = 0; flux.pause(); flux.destroy?.(); resolve("OVERSIZE"); return; }
      morceaux.push(c);
    });
    flux.on("error", (e: Error) => { if (!fini) { fini = true; rej(e); } });
    flux.on("end", () => { if (!fini) { fini = true; resolve(Buffer.concat(morceaux)); } });
  });
}

export async function inspectZip(buffer: Buffer, opts: InspectOptions = {}): Promise<ZipInspection> {
  const { onStorableEntry, ...limOpts } = opts;
  const lim = limites(limOpts);
  const archiveBytes = buffer.length;

  if (archiveBytes === 0) return reject("EMPTY", "Archive vide.", archiveBytes);
  if (archiveBytes > lim.maxArchiveBytes) {
    return reject("ARCHIVE_TOO_LARGE", `Archive trop volumineuse (${Math.round(archiveBytes / MB)} Mo > ${Math.round(lim.maxArchiveBytes / MB)} Mo).`, archiveBytes);
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return reject("CORRUPT_ARCHIVE", "Archive illisible ou corrompue.", archiveBytes);
  }

  const files = Object.values(zip.files).filter((f) => !f.dir);
  if (files.length === 0) return reject("EMPTY", "Aucun fichier dans l'archive.", archiveBytes);
  if (files.length > lim.maxEntries) {
    return reject("TOO_MANY_FILES", `Trop de fichiers (${files.length} > ${lim.maxEntries}).`, archiveBytes);
  }

  // Pré-contrôle anti-bombe : total décompressé DÉCLARÉ + ratio, sans extraire.
  let declaredTotal = 0;
  for (const f of files) {
    const u = declaredSizes(f).uncompressed;
    if (typeof u === "number") declaredTotal += u;
  }
  if (declaredTotal > lim.maxTotalUncompressed) {
    return reject("TOTAL_TOO_LARGE", `Contenu décompressé annoncé trop volumineux (${Math.round(declaredTotal / MB)} Mo).`, archiveBytes);
  }
  if (archiveBytes > 0 && declaredTotal / archiveBytes > lim.maxRatio) {
    return reject("RATIO_EXCEEDED", `Ratio de compression suspect (${Math.round(declaredTotal / archiveBytes)}:1) — possible ZIP bomb.`, archiveBytes);
  }

  const entries: ManifestEntry[] = [];
  let accumulated = 0;

  for (const f of files) {
    const path = f.name;
    const filename = path.split("/").pop() ?? path;
    const ext = extOf(path);
    const declared = declaredSizes(f);

    // 1) Chemin dangereux → bloqué, non extrait.
    if (unsafePath(path) || path.split("/").length - 1 > lim.maxDepth) {
      entries.push({ path, filename, ext, sizeBytes: declared.uncompressed ?? 0, sha256: "", securityStatus: "BLOCKED_PATH", note: "Chemin non sûr ou profondeur excessive — non extrait." });
      continue;
    }
    // 2) Exécutable / script / macro → jamais matérialisé.
    if (BLOCKED_EXT.has(ext)) {
      entries.push({ path, filename, ext, sizeBytes: declared.uncompressed ?? 0, sha256: "", securityStatus: "BLOCKED_EXECUTABLE", note: "Exécutable/script/macro — refusé." });
      continue;
    }
    // 3) Garde total avant extraction.
    if (typeof declared.uncompressed === "number" && accumulated + declared.uncompressed > lim.maxTotalUncompressed) {
      return reject("TOTAL_TOO_LARGE", "Dépassement du volume total à l'extraction.", archiveBytes);
    }

    // 4) Extraction EN FLUX, bornée par le compteur RÉEL : au plus le plafond par entrée, et jamais
    // au-delà de ce qui reste du volume total. Entrée chiffrée → JSZip échoue → BLOCKED_ENCRYPTED.
    const cap = Math.min(lim.maxFileUncompressed, Math.max(0, lim.maxTotalUncompressed - accumulated));
    let data: Buffer | "OVERSIZE";
    try {
      data = await lireEntreeBornee(f, cap);
    } catch {
      entries.push({ path, filename, ext, sizeBytes: declared.uncompressed ?? 0, sha256: "", securityStatus: "BLOCKED_ENCRYPTED", note: "Entrée chiffrée/illisible — non traitée." });
      continue;
    }
    if (data === "OVERSIZE") {
      if (cap < lim.maxFileUncompressed) return reject("TOTAL_TOO_LARGE", "Dépassement du volume total à l'extraction.", archiveBytes);
      entries.push({ path, filename, ext, sizeBytes: declared.uncompressed ?? 0, sha256: "", securityStatus: "BLOCKED_OVERSIZE", note: "Fichier trop volumineux — non conservé." });
      continue;
    }
    accumulated += data.length;
    if (accumulated > lim.maxTotalUncompressed) {
      return reject("TOTAL_TOO_LARGE", "Dépassement du volume total à l'extraction.", archiveBytes);
    }

    const sha256 = createHash("sha256").update(data).digest("hex");
    const ratio = declared.compressed && declared.compressed > 0 ? data.length / declared.compressed : undefined;
    const nested = NESTED_ARCHIVE_EXT.has(ext);
    const entry: ManifestEntry = {
      path, filename, ext, sizeBytes: data.length, sha256,
      compressionRatio: ratio,
      securityStatus: nested ? "SUSPICIOUS" : "SAFE",
      note: nested ? "Archive imbriquée — non décompressée automatiquement." : undefined,
    };
    entries.push(entry);
    // Stockage inline (un fichier à la fois). Un échec de STOCKAGE marque le fichier SANS faire
    // tomber toute l'archive (le fichier a été lu, mais non conservé → à renvoyer).
    if (onStorableEntry) {
      try { await onStorableEntry(entry, data); }
      catch (err) {
        console.error("[inspectZip] stockage entrée échoué", entry.path, err instanceof Error ? err.message : err);
        entry.securityStatus = "CORRUPTED";
        entry.note = "Fichier lu mais stockage momentanément indisponible — non conservé, réessayez.";
      }
    }
  }

  const totalBytes = entries.reduce((s, e) => s + (e.securityStatus === "SAFE" || e.securityStatus === "SUSPICIOUS" ? e.sizeBytes : 0), 0);
  return { ok: true, entries, totals: { files: entries.length, totalBytes, archiveBytes } };
}

function reject(code: RejectionCode, message: string, archiveBytes: number): ZipInspection {
  return { ok: false, rejection: { code, message }, entries: [], totals: { files: 0, totalBytes: 0, archiveBytes } };
}

// ─────────────────────── INSPECTION EN FLUX (gros dossiers, mémoire bornée) ───────────────────────
//
// Version STREAMING de `inspectZip`, lisant l'archive depuis un FICHIER sur disque via yauzl, UNE
// entrée à la fois : le pic mémoire ≈ le plus gros fichier de l'archive (pas l'archive entière).
// Corrige l'OOM d'ingestion des gros ZIP (jszip charge tout en RAM). Sémantique de sécurité
// IDENTIQUE à `inspectZip` (mêmes prédicats : `unsafePath`, exécutables, chiffrement, plafonds).
//
// `decodeStrings:false` → noms d'entrée BRUTS (aucune validation/normalisation par yauzl) : ce sont
// NOS gardes qui tranchent, et une entrée hostile (chemin absolu…) NE fait PAS avorter toute
// l'archive — elle est marquée BLOQUÉE tandis que les fichiers sains restent traités.

/** Nom d'entrée décodé (yauzl renvoie un Buffer quand `decodeStrings:false`). */
function entryName(e: Entry): string {
  const raw = e.fileName as unknown as string | Buffer;
  return typeof raw === "string" ? raw : raw.toString("utf8");
}

function openZipFile(path: string): Promise<ZipFile> {
  return new Promise((resolve, rej) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return rej(err ?? new Error("Ouverture ZIP impossible."));
      resolve(zip);
    });
  });
}

/** Tire l'entrée suivante (mode lazyEntries) ; `null` à la fin ; rejette sur erreur d'archive. */
function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, rej) => {
    const cleanup = () => { zip.removeListener("entry", onEntry); zip.removeListener("end", onEnd); zip.removeListener("error", onErr); };
    const onEntry = (e: Entry) => { cleanup(); resolve(e); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onErr = (e: Error) => { cleanup(); rej(e); };
    zip.on("entry", onEntry); zip.on("end", onEnd); zip.on("error", onErr);
    zip.readEntry();
  });
}

/** Lit une entrée EN FLUX vers un buffer, plafonné à `cap` octets → « OVERSIZE » si dépassé. */
function readEntryCapped(zip: ZipFile, entry: Entry, cap: number): Promise<Buffer | "OVERSIZE"> {
  return new Promise((resolve, rej) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return rej(err ?? new Error("Flux d'entrée indisponible."));
      const chunks: Buffer[] = [];
      let total = 0, settled = false;
      const finish = (v: Buffer | "OVERSIZE") => { if (!settled) { settled = true; resolve(v); } };
      stream.on("data", (c: Buffer) => {
        if (settled) return;
        total += c.length;
        if (total > cap) { finish("OVERSIZE"); stream.destroy(); return; } // stoppe net (anti-bombe par fichier)
        chunks.push(c);
      });
      stream.on("error", (e) => { if (!settled) { settled = true; rej(e); } });
      stream.on("end", () => finish(Buffer.concat(chunks)));
    });
  });
}

export async function inspectZipFile(zipPath: string, opts: InspectOptions = {}): Promise<ZipInspection> {
  // Filet ULTIME : `inspectZipFile` ne LÈVE JAMAIS — au pire elle renvoie un rejet propre (jamais
  // d'exception qui ferait échouer toute l'ingestion avec un message cryptique).
  try {
    return await inspectZipFileInner(zipPath, opts);
  } catch (err) {
    console.error("[inspectZipFile] erreur inattendue", err);
    return reject("CORRUPT_ARCHIVE", "Archive illisible (erreur inattendue lors de l'inspection).", 0);
  }
}

async function inspectZipFileInner(zipPath: string, opts: InspectOptions = {}): Promise<ZipInspection> {
  const { onStorableEntry, ...limOpts } = opts;
  const lim = limites(limOpts);
  const archiveBytes = (await stat(zipPath)).size;

  if (archiveBytes === 0) return reject("EMPTY", "Archive vide.", archiveBytes);
  if (archiveBytes > lim.maxArchiveBytes) {
    return reject("ARCHIVE_TOO_LARGE", `Archive trop volumineuse (${Math.round(archiveBytes / MB)} Mo > ${Math.round(lim.maxArchiveBytes / MB)} Mo).`, archiveBytes);
  }

  // ── PASSE 1 — métadonnées du répertoire central UNIQUEMENT (anti-bombe sur tailles déclarées).
  let files: { uncompressed: number }[];
  {
    let zip: ZipFile;
    try { zip = await openZipFile(zipPath); } catch { return reject("CORRUPT_ARCHIVE", "Archive illisible ou corrompue.", archiveBytes); }
    try {
      const metas: { uncompressed: number }[] = [];
      for (;;) {
        let e: Entry | null;
        try { e = await nextEntry(zip); } catch { return reject("CORRUPT_ARCHIVE", "Archive illisible ou corrompue.", archiveBytes); }
        if (!e) break;
        if (/\/$/.test(entryName(e))) continue; // dossier
        metas.push({ uncompressed: Number(e.uncompressedSize) || 0 });
      }
      files = metas;
    } finally { zip.close(); }
  }

  if (files.length === 0) return reject("EMPTY", "Aucun fichier dans l'archive.", archiveBytes);
  if (files.length > lim.maxEntries) return reject("TOO_MANY_FILES", `Trop de fichiers (${files.length} > ${lim.maxEntries}).`, archiveBytes);
  const declaredTotal = files.reduce((s, f) => s + f.uncompressed, 0);
  if (declaredTotal > lim.maxTotalUncompressed) {
    return reject("TOTAL_TOO_LARGE", `Contenu décompressé annoncé trop volumineux (${Math.round(declaredTotal / MB)} Mo).`, archiveBytes);
  }
  if (archiveBytes > 0 && declaredTotal / archiveBytes > lim.maxRatio) {
    return reject("RATIO_EXCEEDED", `Ratio de compression suspect (${Math.round(declaredTotal / archiveBytes)}:1) — possible ZIP bomb.`, archiveBytes);
  }

  // ── PASSE 2 — extraction EN FLUX, une entrée à la fois (pic mémoire ≈ plus gros fichier).
  // ROBUSTESSE TOTALE : AUCUNE erreur d'entrée n'avorte l'archive. Un fichier illisible / chiffré /
  // au format non supporté / non stockable est MARQUÉ (avec sa raison exacte) et l'on CONTINUE →
  // les fichiers sains sont ingérés, les autres remontés au manifeste pour re-soumission ciblée.
  const entries: ManifestEntry[] = [];
  let accumulated = 0;
  let zip: ZipFile;
  try { zip = await openZipFile(zipPath); } catch { return reject("CORRUPT_ARCHIVE", "Archive illisible ou corrompue (répertoire central).", archiveBytes); }
  zip.on("error", () => { /* capté → jamais d'évènement 'error' non géré pendant l'extraction */ });
  try {
    for (;;) {
      let e: Entry | null;
      try { e = await nextEntry(zip); }
      catch { break; } // erreur structurelle de lecture → on s'arrête proprement AVEC ce qu'on a déjà lu
      if (!e) break;
      const path = entryName(e);
      if (/\/$/.test(path)) continue; // dossier
      const filename = path.split("/").pop() ?? path;
      const ext = extOf(path);
      const declaredU = Number(e.uncompressedSize) || 0;
      const declaredC = Number(e.compressedSize) || 0;
      const blocked = (securityStatus: SecurityStatus, note: string) =>
        entries.push({ path, filename, ext, sizeBytes: declaredU, sha256: "", securityStatus, note });

      try {
        // 1) Chemin dangereux → bloqué, non extrait.
        if (unsafePath(path) || path.split("/").length - 1 > lim.maxDepth) { blocked("BLOCKED_PATH", "Chemin non sûr ou profondeur excessive — non extrait."); continue; }
        // 2) Exécutable / script / macro → jamais matérialisé.
        if (BLOCKED_EXT.has(ext)) { blocked("BLOCKED_EXECUTABLE", "Exécutable/script/macro — refusé pour raison de sécurité."); continue; }
        // 3) Entrée chiffrée → non traitée.
        if (typeof e.isEncrypted === "function" && e.isEncrypted()) { blocked("BLOCKED_ENCRYPTED", "Entrée protégée par mot de passe — retirez le chiffrement et renvoyez ce fichier."); continue; }
        // 4) Garde total (taille déclarée) → fichier marqué, pas d'abandon de l'archive.
        if (accumulated + declaredU > lim.maxTotalUncompressed) { blocked("BLOCKED_OVERSIZE", "Volume total du dossier dépassé — ce fichier n'a pas été conservé."); continue; }

        // 5) Extraction EN FLUX bornée + hash. Toute erreur de décompression → marquée, on continue.
        let data: Buffer | "OVERSIZE";
        // Le compteur RÉEL borne aussi le volume total : une entrée qui ment sur sa taille ne le dépasse pas.
        const cap = Math.min(lim.maxFileUncompressed, Math.max(0, lim.maxTotalUncompressed - accumulated));
        try { data = await readEntryCapped(zip, e, cap); }
        catch (err) { console.error("[inspectZipFile] décompression échouée", path, err instanceof Error ? err.message : err); blocked("CORRUPTED", "Décompression impossible (format de compression non supporté ou fichier corrompu) — renvoyez ce fichier."); continue; }
        if (data === "OVERSIZE") { blocked("BLOCKED_OVERSIZE", "Fichier trop volumineux — non conservé."); continue; }

        accumulated += data.length;
        const sha256 = createHash("sha256").update(data).digest("hex");
        const ratio = declaredC > 0 ? data.length / declaredC : undefined;
        const nested = NESTED_ARCHIVE_EXT.has(ext);
        const entry: ManifestEntry = {
          path, filename, ext, sizeBytes: data.length, sha256, compressionRatio: ratio,
          securityStatus: nested ? "SUSPICIOUS" : "SAFE",
          note: nested ? "Archive imbriquée — non décompressée automatiquement." : undefined,
        };
        // 6) Stockage inline (un fichier à la fois). Un échec de STOCKAGE marque le fichier sans
        // faire tomber l'archive (le fichier a été lu, mais non conservé → à renvoyer).
        if (onStorableEntry) {
          try { await onStorableEntry(entry, data); }
          catch (err) {
            console.error("[inspectZipFile] stockage entrée échoué", path, err instanceof Error ? err.message : err);
            entry.securityStatus = "CORRUPTED";
            entry.note = "Fichier lu mais stockage momentanément indisponible — non conservé, réessayez.";
          }
        }
        entries.push(entry);
      } catch (err) {
        // Garde-fou ULTIME par entrée : quoi qu'il arrive, on marque et on continue.
        console.error("[inspectZipFile] entrée en erreur", path, err instanceof Error ? err.message : err);
        blocked("CORRUPTED", "Entrée illisible — non traitée, renvoyez ce fichier.");
      }
    }
  } finally { zip.close(); }

  if (entries.length === 0) return reject("CORRUPT_ARCHIVE", "Aucune entrée exploitable dans l'archive.", archiveBytes);
  const totalBytes = entries.reduce((s, e) => s + (e.securityStatus === "SAFE" || e.securityStatus === "SUSPICIOUS" ? e.sizeBytes : 0), 0);
  return { ok: true, entries, totals: { files: entries.length, totalBytes, archiveBytes } };
}
