import fs from "node:fs";
import path from "node:path";
import { attendu } from "@/lib/journal";

/**
 * PARSE CPU-LOURD (pdf-parse / mammoth / xlsx) exécuté SOIT dans un WORKER THREAD (gros fichiers →
 * le serveur reste réactif), SOIT en ligne (petits fichiers : le coût de démarrage d'un worker
 * n'en vaut pas la peine). Renvoie du TEXTE BRUT ; le packaging (statut, plafonds) reste à l'appelant.
 *
 * ROBUSTE : toute défaillance du worker (fichier introuvable, spawn impossible, timeout, erreur)
 * bascule silencieusement sur l'exécution en ligne — l'extraction n'échoue jamais à cause du worker.
 */

export type HeavyKind = "pdf" | "docx" | "xlsx";

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Seuil de bascule vers le worker (fichiers « gros » = ceux qui figeraient le thread principal).
const workerThresholdBytes = () => clampInt(process.env.REG_WORKER_THRESHOLD_MB, 100, 1, 4000) * 1024 * 1024;
// Garde-fou : un parse qui n'aboutit pas dans ce délai → on abandonne le worker (repli en ligne).
const workerTimeoutMs = () => clampInt(process.env.REG_WORKER_TIMEOUT_MS, 300_000, 5_000, 1_800_000);

let cachedWorkerPath: string | null | undefined; // undefined = non résolu ; null = indisponible

/** Localise le fichier worker (.cjs). `next start` conserve `src/` → ancré sur process.cwd(). */
function resolveWorkerPath(): string | null {
  if (cachedWorkerPath !== undefined) return cachedWorkerPath;
  const candidates = [
    process.env.REG_EXTRACT_WORKER_PATH,
    path.join(process.cwd(), "src/lib/regulatory/intelligence/extract/extract.worker.cjs"),
    path.join(__dirname, "extract.worker.cjs"),
  ].filter((p): p is string => Boolean(p));
  cachedWorkerPath = candidates.find((p) => fs.existsSync(p)) ?? null;
  return cachedWorkerPath;
}

/**
 * Exécute le parse dans un worker. Renvoie le texte, ou `null` si le worker est indisponible/échoue.
 * Exporté pour les tests d'intégration (round-trip réel du worker), sinon appelé via `heavyText`.
 */
export async function parseHeavyInWorker(kind: HeavyKind, buffer: Buffer): Promise<string | null> {
  const workerFile = resolveWorkerPath();
  if (!workerFile) return null;

  let Worker: typeof import("node:worker_threads").Worker;
  try {
    ({ Worker } = await import("node:worker_threads"));
  } catch {
    return null;
  }

  // ArrayBuffer autonome (le pool interne de Node ne doit pas être détaché) → transfert zéro-copie.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(attendu("fermeture au mieux : la ressource est abandonnée de toute façon"));
      resolve(v);
    };
    let worker: import("node:worker_threads").Worker;
    const timer = setTimeout(() => finish(null), workerTimeoutMs());
    try {
      worker = new Worker(workerFile, { workerData: { kind, bytes: ab }, transferList: [ab] });
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    worker.once("message", (msg: { ok?: boolean; text?: string }) => finish(msg && msg.ok ? String(msg.text ?? "") : null));
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null)); // sortie sans message → repli en ligne
  });
}

/** Implémentations EN LIGNE (thread principal) — repli et petits fichiers. */
async function parseInline(kind: HeavyKind, buffer: Buffer): Promise<string> {
  if (kind === "pdf") {
    // IMPORT PROFOND, comme dans le worker — et pour la même raison, qui a fini par mordre ici.
    //
    // L'index de `pdf-parse` embarque un harnais de démonstration : quand il se croit exécuté
    // directement, il tente d'ouvrir `./test/data/05-versions-space.pdf`, qui n'existe pas chez
    // nous. Le worker évitait déjà le piège par un import profond ; le chemin EN LIGNE, lui,
    // importait l'index — et comme le worker ne sert qu'au-delà de 100 Mo, tout PDF ordinaire
    // passait par le chemin piégé.
    //
    // Invisible dans le serveur Next.js, où l'empaquetage rend le harnais inactif. Fatal partout
    // ailleurs : scripts, tâches de fond, ingestion de connaissance — c'est-à-dire précisément
    // là où les documents arrivent. Constaté en montant le banc d'ingestion, pas en relisant.
    const mod = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as
      { default: (b: Buffer | Uint8Array) => Promise<{ text?: string }> };
    // Uint8Array et non Buffer : le pdf.js embarqué par pdf-parse emprunte, face à un Buffer Node,
    // un chemin de récupération qui refuse des PDF pourtant valides (« bad XRef entry ») — constaté
    // sur nos propres PDF générés, lus sans peine par le même pdf.js en Uint8Array.
    const data = await mod.default(new Uint8Array(buffer));
    return (data.text ?? "").toString();
  }
  if (kind === "docx") {
    const mammoth = (await import("mammoth")).default;
    const m = await mammoth.extractRawText({ buffer });
    return (m.value ?? "").toString();
  }
  // xlsx
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    if (csv.trim()) parts.push(`# ${name}\n${csv}`);
  }
  return parts.join("\n\n");
}

/**
 * Extrait le TEXTE BRUT d'un buffer selon son format. Gros fichier (≥ seuil) → worker thread
 * (avec repli en ligne si indisponible) ; petit fichier → en ligne directement.
 */
export async function heavyText(kind: HeavyKind, buffer: Buffer): Promise<string> {
  if (buffer.byteLength >= workerThresholdBytes()) {
    const viaWorker = await parseHeavyInWorker(kind, buffer);
    if (viaWorker !== null) return viaWorker;
    // worker indisponible/échec → repli en ligne (l'extraction ne doit jamais être bloquée par le worker)
  }
  return parseInline(kind, buffer);
}
