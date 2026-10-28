import { brotliCompress, brotliDecompress, constants, createBrotliCompress, createBrotliDecompress } from "zlib";
import { promisify } from "util";
import crypto from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { open, rm, stat } from "fs/promises";
import { pipeline } from "stream/promises";
import {
  CODEC_BROTLI, GAIN_ECHANTILLON_MIN, GAIN_MIN, TAILLE_MIN_COMPRESSION, TRANCHE_ECHANTILLON,
  codecConnu, formatDejaCompresse, qualiteBrotli, type Codec,
} from "./politique";

/**
 * COMPRESSER / DÉCOMPRESSER — l'effet de bord de la politique, jamais sa décision.
 *
 * Trois propriétés, chacune tenue par un cas :
 *   • JAMAIS DE GONFLEMENT : un contenu n'est rendu compressé que s'il économise `GAIN_MIN`
 *     sur le résultat RÉEL ; sinon `null` et le stockage garde les octets bruts ;
 *   • RELIRE AVANT D'ÉCRIRE (§104.8) : le résultat est décompressé et comparé à l'original AVANT
 *     d'être rendu. Un doute rend `null` — on stocke brut, on ne stocke pas un fichier qu'on
 *     ne saurait pas relire ;
 *   • MÉMOIRE BORNÉE sur le chemin fichier : compression en flux vers un fichier temporaire,
 *     jamais le fichier entier en mémoire (le tas d'un déploiement Render est d'environ 4 Go).
 */

const brotliAsync = promisify(brotliCompress);
const unbrotliAsync = promisify(brotliDecompress);

const optionsBrotli = (taille: number) => ({
  params: {
    [constants.BROTLI_PARAM_QUALITY]: qualiteBrotli(taille),
    [constants.BROTLI_PARAM_LGWIN]: 22,
    [constants.BROTLI_PARAM_SIZE_HINT]: Math.min(taille, 2 ** 31 - 1),
  },
});

/** Pourquoi un contenu n'a PAS été compressé — dit au journal et aux bancs, jamais à l'écran. */
export type RaisonBrut = "petit" | "deja-compresse" | "echantillon-incompressible" | "gain-insuffisant" | "verification-echouee";

export type DecisionCompression =
  | { compresse: true; codec: Codec; octets: Buffer }
  | { compresse: false; raison: RaisonBrut };

/** Gain estimé sur un échantillon (début, milieu, fin) — l'essai bon marché qui évite de tout compresser pour rien. */
export async function gainSurEchantillon(echantillon: Buffer): Promise<number> {
  if (echantillon.length === 0) return 0;
  const out = await brotliAsync(echantillon, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_LGWIN]: 22 } });
  return 1 - out.length / echantillon.length;
}

function echantillonDeTampon(b: Buffer): Buffer {
  if (b.length <= 3 * TRANCHE_ECHANTILLON) return b;
  const milieu = Math.floor((b.length - TRANCHE_ECHANTILLON) / 2);
  return Buffer.concat([
    b.subarray(0, TRANCHE_ECHANTILLON),
    b.subarray(milieu, milieu + TRANCHE_ECHANTILLON),
    b.subarray(b.length - TRANCHE_ECHANTILLON),
  ]);
}

/** Décide, et compresse si ça vaut le coup. Rend les octets compressés, relus et identiques à l'original. */
export async function decider(plain: Buffer): Promise<DecisionCompression> {
  if (plain.length < TAILLE_MIN_COMPRESSION) return { compresse: false, raison: "petit" };
  if (formatDejaCompresse(plain.subarray(0, 16))) return { compresse: false, raison: "deja-compresse" };
  if ((await gainSurEchantillon(echantillonDeTampon(plain))) < GAIN_ECHANTILLON_MIN) return { compresse: false, raison: "echantillon-incompressible" };
  let octets: Buffer;
  try { octets = await brotliAsync(plain, optionsBrotli(plain.length)); } catch { return { compresse: false, raison: "verification-echouee" }; }
  if (octets.length > plain.length * (1 - GAIN_MIN)) return { compresse: false, raison: "gain-insuffisant" };
  // RELIRE avant d'écrire : octet pour octet.
  try {
    const relu = await unbrotliAsync(octets, { maxOutputLength: plain.length + 1 });
    if (!relu.equals(plain)) return { compresse: false, raison: "verification-echouee" };
  } catch { return { compresse: false, raison: "verification-echouee" }; }
  return { compresse: true, codec: CODEC_BROTLI, octets };
}

/**
 * Décompresse. Un codec INCONNU lève : rendre les octets stockés tels quels ferait servir du
 * brotli pour un PDF — un fichier illisible, annoncé « téléchargé ». La taille attendue borne la
 * sortie (une « bombe » ne peut pas gonfler au-delà de ce que le blob déclare).
 */
export async function decompresser(codec: string, octets: Buffer, tailleClair: number): Promise<Buffer> {
  if (!codecConnu(codec)) throw new Error(`Codec de stockage inconnu « ${codec} » — ce fichier ne peut pas être relu par cette version.`);
  const clair = await unbrotliAsync(octets, { maxOutputLength: tailleClair + 1 });
  if (clair.length !== tailleClair) {
    throw new Error(`Contenu décompressé inattendu (${clair.length} octets au lieu de ${tailleClair}) — fichier corrompu.`);
  }
  return clair;
}

// ───────────────────────────── chemin fichier (flux) ─────────────────────────────────────

async function lireTranche(path: string, debut: number, longueur: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(longueur);
    const { bytesRead } = await fh.read(buf, 0, longueur, debut);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

async function echantillonDeFichier(path: string, taille: number): Promise<Buffer> {
  if (taille <= 3 * TRANCHE_ECHANTILLON) return lireTranche(path, 0, taille);
  const milieu = Math.floor((taille - TRANCHE_ECHANTILLON) / 2);
  return Buffer.concat([
    await lireTranche(path, 0, TRANCHE_ECHANTILLON),
    await lireTranche(path, milieu, TRANCHE_ECHANTILLON),
    await lireTranche(path, taille - TRANCHE_ECHANTILLON, TRANCHE_ECHANTILLON),
  ]);
}

export interface FichierCompresse { chemin: string; taille: number; codec: Codec; nettoyer: () => Promise<void> }

/**
 * Compresse UN FICHIER en flux vers `cheminTemp`, le relit en flux (décompression + SHA-256) et
 * ne le rend QUE si l'empreinte retombe sur `sha256Clair` et que le gain est réel. La mémoire ne
 * dépend pas de la taille du fichier. `null` : stocker brut (le fichier temporaire est déjà retiré).
 */
export async function compresserFichierSiUtile(
  chemin: string, tailleClair: number, sha256Clair: string, cheminTemp: string,
): Promise<{ resultat: FichierCompresse } | { resultat: null; raison: RaisonBrut }> {
  const nettoyer = () => rm(cheminTemp, { force: true });
  if (tailleClair < TAILLE_MIN_COMPRESSION) return { resultat: null, raison: "petit" };
  const tete = await lireTranche(chemin, 0, 16);
  if (formatDejaCompresse(tete)) return { resultat: null, raison: "deja-compresse" };
  if ((await gainSurEchantillon(await echantillonDeFichier(chemin, tailleClair))) < GAIN_ECHANTILLON_MIN) {
    return { resultat: null, raison: "echantillon-incompressible" };
  }
  try {
    await pipeline(
      createReadStream(chemin, { highWaterMark: 4 * 1024 * 1024 }),
      createBrotliCompress(optionsBrotli(tailleClair)),
      createWriteStream(cheminTemp),
    );
    const taille = (await stat(cheminTemp)).size;
    if (taille > tailleClair * (1 - GAIN_MIN)) { await nettoyer(); return { resultat: null, raison: "gain-insuffisant" }; }
    // RELIRE : décompression en flux, empreinte du clair comparée à celle que l'appelant a calculée.
    const hash = crypto.createHash("sha256");
    let total = 0;
    const lecteur = createReadStream(cheminTemp, { highWaterMark: 4 * 1024 * 1024 }).pipe(createBrotliDecompress());
    for await (const morceau of lecteur) { hash.update(morceau as Buffer); total += (morceau as Buffer).length; }
    if (total !== tailleClair || hash.digest("hex") !== sha256Clair) { await nettoyer(); return { resultat: null, raison: "verification-echouee" }; }
    return { resultat: { chemin: cheminTemp, taille, codec: CODEC_BROTLI, nettoyer } };
  } catch {
    await nettoyer();
    return { resultat: null, raison: "verification-echouee" };
  }
}
