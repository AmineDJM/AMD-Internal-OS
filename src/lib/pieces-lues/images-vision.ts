import sharp from "sharp";
import { rasterizePdfStream } from "@/lib/storage/raster";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES IMAGES QUE LA VISION LIT — rendues assez grandes, et RECADRÉES sur la pièce. Serveur.
 *
 * Un ticket de caisse scanné sur une page A4 n'en occupe qu'un quart (Moyens généraux, 09/11/2026 :
 * « l'IA ne lit pas bien les bons » — un ticket de 15 articles rendu en 6 lignes, chaque montant
 * centuplé). Rendue entière, la page envoie au modèle trois quarts de blanc et un ticket en petits
 * caractères, que le modèle réduit encore. On rend donc la page plus finement, puis on la recadre
 * sur l'encre : le ticket remplit l'image.
 *
 * Le recadrage ignore les poussières de scan : une colonne ou une rangée ne compte que si elle porte
 * assez de pixels sombres. Une photo (fond non blanc) ne se recadre pas — elle n'y gagnerait rien —,
 * mais elle se REDRESSE selon son EXIF : un téléphone qui enregistre la photo couchée et l'indique
 * dans l'EXIF la ferait lire couchée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Rendu d'une page pour la vision : ~300 DPI (l'OCR rend à ~200 ; un ticket thermique en demande plus). */
const ECHELLE_VISION = 3;
/** Le plus grand côté envoyé : le modèle ramène toute image à 2048 px — au-delà, on paierait l'envoi pour rien. */
const COTE_MAX = 2048;
/** En deçà de ce gain de surface, on garde l'image entière : le recadrage n'apporterait rien. */
const GAIN_MIN = 0.75;
/** Un pixel est « encre » sous ce niveau de gris. */
const ENCRE = 150;

/** Le cadre de l'encre d'une image en niveaux de gris — `null` si rien ne se détache. Pur, exporté pour les tests. */
export function cadreDeLEncre(
  gris: Uint8Array, largeur: number, hauteur: number,
): { gauche: number; haut: number; largeur: number; hauteur: number } | null {
  const colonnes = new Uint32Array(largeur);
  const rangees = new Uint32Array(hauteur);
  for (let y = 0; y < hauteur; y++) {
    const base = y * largeur;
    for (let x = 0; x < largeur; x++) if (gris[base + x] < ENCRE) { colonnes[x]++; rangees[y]++; }
  }
  // Une poussière ne fait pas une colonne : il en faut 1 % de la hauteur (et au moins 4 pixels).
  const plage = (t: Uint32Array, min: number): [number, number] | null => {
    let a = -1, b = -1;
    for (let i = 0; i < t.length; i++) if (t[i] >= min) { if (a < 0) a = i; b = i; }
    return a < 0 ? null : [a, b];
  };
  const px = plage(colonnes, Math.max(4, Math.round(hauteur * 0.01)));
  const py = plage(rangees, Math.max(4, Math.round(largeur * 0.01)));
  if (!px || !py) return null;
  const marge = Math.round(Math.max(largeur, hauteur) * 0.015);
  const gauche = Math.max(0, px[0] - marge);
  const haut = Math.max(0, py[0] - marge);
  const l = Math.min(largeur, px[1] + marge + 1) - gauche;
  const h = Math.min(hauteur, py[1] + marge + 1) - haut;
  if (l <= 0 || h <= 0 || (l * h) / (largeur * hauteur) > GAIN_MIN) return null;
  return { gauche, haut, largeur: l, hauteur: h };
}

/**
 * L'image recadrée sur la pièce — redressée, et ramenée à 2048 px au plus. En PNG pour une page rendue (du texte net),
 * en JPEG pour une photo (un PNG de photo pèserait des dizaines de mégaoctets).
 */
export async function recadrerSurLaPiece(image: Buffer, format: "png" | "jpeg" = "png"): Promise<{ buffer: Buffer; recadree: boolean }> {
  const droite = await sharp(image).rotate().png().toBuffer();
  const { data, info } = await sharp(droite).greyscale().raw().toBuffer({ resolveWithObject: true });
  const cadre = cadreDeLEncre(new Uint8Array(data.buffer, data.byteOffset, data.length), info.width, info.height);
  let sortie = sharp(droite);
  if (cadre) sortie = sortie.extract({ left: cadre.gauche, top: cadre.haut, width: cadre.largeur, height: cadre.hauteur });
  sortie = sortie.resize({ width: COTE_MAX, height: COTE_MAX, fit: "inside", withoutEnlargement: true });
  const buffer = await (format === "jpeg" ? sortie.jpeg({ quality: 90 }) : sortie.png()).toBuffer();
  return { buffer, recadree: Boolean(cadre) };
}

/** Les pages d'un PDF, rendues pour la vision et recadrées une à une (une page qui échoue au recadrage reste entière). */
export async function pagesPourVision(pdf: Buffer, max: number): Promise<Buffer[]> {
  const pages: Buffer[] = [];
  await rasterizePdfStream(pdf, async (png) => {
    pages.push(await recadrerSurLaPiece(png).then((r) => r.buffer).catch(() => png));
  }, { maxPages: max, scale: ECHELLE_VISION });
  return pages;
}

/** Une image déposée telle quelle (photo, scan JPEG/PNG), préparée pour la vision. */
export async function imagePourVision(buffer: Buffer, mime: string): Promise<{ buffer: Buffer; mime: string }> {
  try {
    const r = await recadrerSurLaPiece(buffer, "jpeg");
    return { buffer: r.buffer, mime: "image/jpeg" };
  } catch {
    return { buffer, mime };
  }
}
