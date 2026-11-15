import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { saveFile, readFileByKey } from "@/lib/storage";

/**
 * LA SIGNATURE ET LE CACHET D'UNE PERSONNE (Direction, 15/11/2026) — serveur seulement.
 *
 * Chacun dépose UNE image de sa signature et UNE de son cachet (PNG ou JPEG, fond blanc rendu transparent). Elles sont
 * gardées chiffrées (`saveFile` → blob AES-256-GCM) et ne servent qu'à deux choses : l'aperçu de leur propriétaire, et
 * l'incrustation au moment d'une signature en ligne qu'il a lui-même confirmée. Une nouvelle image révoque l'ancienne.
 */

export type NatureVisuel = "SIGNATURE" | "CACHET";
export const NATURES_VISUEL: readonly NatureVisuel[] = ["SIGNATURE", "CACHET"];
const TAILLE_MAX = 3 * 1024 * 1024;

/** Le fond blanc d'un scan devient transparent : la signature se pose sur le BC sans rectangle blanc. */
async function preparer(octets: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(octets).rotate().resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) data[i + 3] = 0;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).trim().png().toBuffer();
}

export async function deposerVisuel(userId: string, nature: NatureVisuel, fichier: File): Promise<string | null> {
  if (!NATURES_VISUEL.includes(nature)) return "Nature inconnue.";
  if (!fichier || fichier.size === 0) return "Choisissez une image.";
  if (fichier.size > TAILLE_MAX) return "Image trop lourde (3 Mo au plus).";
  const brut = Buffer.from(await fichier.arrayBuffer());
  let png: Buffer;
  try {
    const meta = await sharp(brut).metadata();
    if (!meta.format || !["png", "jpeg", "webp"].includes(meta.format)) return "Déposez une image PNG, JPEG ou WebP.";
    png = await preparer(brut);
  } catch {
    return "Cette image ne se lit pas : déposez un PNG ou un JPEG.";
  }
  const cle = `SIGNATURE/${userId}/${nature}/${randomUUID()}.png`;
  const { sha256 } = await saveFile(cle, png);
  await prisma.$transaction([
    prisma.signatureVisuelle.updateMany({ where: { userId, nature, revoqueeLe: null }, data: { revoqueeLe: new Date() } }),
    prisma.signatureVisuelle.create({ data: { userId, nature, fichierCle: cle, sha256, mime: "image/png" } }),
  ]);
  return null;
}

export async function lireVisuel(userId: string, nature: NatureVisuel): Promise<Buffer | null> {
  const v = await prisma.signatureVisuelle.findFirst({ where: { userId, nature, revoqueeLe: null }, orderBy: { createdAt: "desc" }, select: { fichierCle: true } });
  if (!v) return null;
  return readFileByKey(v.fichierCle).catch(() => null);
}

export async function etatVisuels(userId: string): Promise<Record<NatureVisuel, Date | null>> {
  const v = await prisma.signatureVisuelle.findMany({ where: { userId, revoqueeLe: null }, select: { nature: true, createdAt: true } });
  const depuis = (n: NatureVisuel) => v.filter((x) => x.nature === n).map((x) => x.createdAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return { SIGNATURE: depuis("SIGNATURE"), CACHET: depuis("CACHET") };
}
