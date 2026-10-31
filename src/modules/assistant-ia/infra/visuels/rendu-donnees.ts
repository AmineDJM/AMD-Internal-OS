import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { attendu } from "@/lib/journal";
import { ffmpegPresent } from "@/platform/ia/media/ffmpeg";
import { IMAGES_VIDEO, imageVideoDonnees, VIDEO_DUREE_S, VIDEO_IPS, type SpecVideoDonnees } from "../../domaine/visuels/video-donnees";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RENDU D'UNE VIDÉO DE DONNÉES (lot K2, décision 0032) — chaque image est un SVG pur (`domaine/visuels/
 * video-donnees.ts`), rastérisé par sharp, puis encodé par ffmpeg en H.264 `yuv420p` + `faststart` : le format que
 * lit le lecteur natif de l'iPhone sans détour.
 *
 * ffmpeg n'est pas sur le web Render (Node natif) : la vidéo y reste EN FILE et c'est le WORKER (Docker, ffmpeg
 * installé) qui la rend au battement suivant (`traiterVisuelsEnFile`). Ici, rien n'attend ffmpeg qui n'est pas là.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const execFileAsync = promisify(execFile);

let logoMemo: string | null | undefined;

/** Le logo Adventum en URI `data:` (128 px), lu une fois — `null` s'il manque (la vidéo se fait sans). */
async function logo(): Promise<string | null> {
  if (logoMemo !== undefined) return logoMemo;
  try {
    const png = await sharp(join(process.cwd(), "public/adventum-ia/logo-marque.png")).resize(128, 128, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
    logoMemo = `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // L'image Docker du worker peut ne pas porter `public/` : la vidéo garde son bandeau texte.
    logoMemo = null;
  }
  return logoMemo;
}

export const rendrePossible = (): Promise<boolean> => ffmpegPresent();

/** Rend la vidéo (MP4) ; `surAvancement` reçoit 0–100. Lève si ffmpeg échoue (l'appelant le dit). */
export async function rendreVideoDonnees(spec: SpecVideoDonnees, surAvancement?: (p: number) => Promise<void> | void): Promise<{ octets: Buffer; secondes: number }> {
  const dossier = await mkdtemp(join(tmpdir(), "visuel-donnees-"));
  try {
    const l = await logo();
    const PAQUET = 6;
    for (let i = 0; i < IMAGES_VIDEO; i += PAQUET) {
      await Promise.all(Array.from({ length: Math.min(PAQUET, IMAGES_VIDEO - i) }, (_, k) => {
        const n = i + k;
        return sharp(Buffer.from(imageVideoDonnees(spec, n / VIDEO_IPS, l))).png({ compressionLevel: 1 }).toFile(join(dossier, `f${String(n).padStart(4, "0")}.png`));
      }));
      if (i % 48 === 0) await surAvancement?.(Math.round((i / IMAGES_VIDEO) * 85));
    }
    const sortie = join(dossier, "video.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(VIDEO_IPS), "-i", join(dossier, "f%04d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0", "-crf", "20", "-preset", "veryfast",
      "-movflags", "+faststart", sortie,
    ], { timeout: 180_000 });
    await surAvancement?.(95);
    return { octets: await readFile(sortie), secondes: VIDEO_DUREE_S };
  } finally {
    await rm(dossier, { recursive: true, force: true }).catch(attendu("nettoyage : le dossier temporaire peut déjà être parti"));
  }
}
