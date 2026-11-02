import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { attendu } from "@/lib/journal";

/**
 * FFMPEG — savoir s'il est là, et tirer une image d'une vidéo à un instant donné.
 *
 * Les deux assistants regardent une vidéo : Adam dans sa transcription (`in-process/media/transcription.ts`),
 * l'Assistant IA quand il lit une pièce jointe (`lib/agent/lecture/pieces.ts`). Le code vivait chez Adam ;
 * l'Assistant IA l'importait de là. Il est au socle, déplacé tel quel.
 */
const execFileAsync = promisify(execFile);

let ffmpegDisponible: boolean | null = null;
export async function ffmpegPresent(): Promise<boolean> {
  if (ffmpegDisponible !== null) return ffmpegDisponible;
  try { await execFileAsync("ffmpeg", ["-version"], { timeout: 5_000 }); ffmpegDisponible = true; } catch { ffmpegDisponible = false; }
  return ffmpegDisponible;
}
/** Pour les bancs : forcer l'état de ffmpeg. */
export function __forcerFfmpeg(v: boolean | null): void { ffmpegDisponible = v; }

/** Une image PNG à l'instant donné, ou `null`. Le fichier passe par un dossier temporaire, effacé ensuite. */
export async function imageAlInstant(octets: Buffer, nom: string, secondes: number): Promise<Buffer | null> {
  if (!(await ffmpegPresent())) return null;
  const dossier = await mkdtemp(join(tmpdir(), "adam-video-"));
  const entree = join(dossier, nom.replace(/[^a-zA-Z0-9._-]/g, "_") || "video.mp4");
  try {
    await writeFile(entree, octets);
    const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, secondes)), "-i", entree, "-frames:v", "1", "-vf", "scale=1024:-2", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024, timeout: 30_000 });
    return Buffer.isBuffer(stdout) && stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  } finally {
    await rm(dossier, { recursive: true, force: true }).catch(attendu("nettoyage : le fichier peut déjà être parti"));
  }
}
