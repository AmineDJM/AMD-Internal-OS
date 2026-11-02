import { buildPagedContent } from "../extract/pages";
// La rastérisation est de l'INFRASTRUCTURE de fichiers, pas une règle du Regulatory :
// elle vit dans la couche partagée, d'où l'ingestion de connaissance peut aussi la lire.
import { rasterizePdfStream as rasterizeShared } from "@/lib/storage/raster";
export { rasterizePdfStream } from "@/lib/storage/raster";
import { ensureLangData, ocrCacheDir, defaultOcrLangs } from "./lang-data";
import { mistralOcrConfigured, mistralOcrDocument, mistralOcrEligible } from "./mistral-ocr";
import { applyAiRescue, type RescueContext } from "./vision-ocr";
// L'interrupteur général de l'IA (« Contrôle de l'IA ») — voir `ocrDocument`.
import { interrupteurIaCoupe } from "@/lib/ai-settings";
import { attendu } from "@/lib/journal";

/**
 * MOTEUR OCR (G13) — deux moteurs, contrat commun (`OcrResult`) :
 *  1. PRIMAIRE — Mistral OCR (cloud, `mistral-ocr-latest`) quand `MISTRAL_API_KEY` est présent :
 *     un appel réseau par document, rapide et précis (multi-pages géré côté serveur) ;
 *  2. REPLI/AUTO-HÉBERGÉ — `mupdf` (rastérisation) + `sharp` (pré-traitement) + `tesseract.js`
 *     (reconnaissance fr/en/ar, score de confiance par page), sans service tiers ni clé.
 *
 * Sélection par `REG_OCR_ENGINE` : "auto" (défaut — Mistral si clé, sinon Tesseract, avec repli
 * automatique sur Tesseract en cas d'échec Mistral), "mistral" (forcé, pas de repli), "tesseract"
 * (forcé local). Le texte OCR est stocké SÉPARÉMENT du texte natif (méthode = "ocr"). Les pages de
 * faible confiance sont signalées pour REVUE HUMAINE (jamais présumées correctes).
 *
 * Interrupteur général de l'IA coupé (Administration › Contrôle de l'IA) : Tesseract seul, quel
 * que soit `REG_OCR_ENGINE`, et pas de secours vision — aucun document ne quitte le serveur.
 *
 * Lecture LOCALE demandée par l'appelant (`cloud: false`, lot D2) : la même chose, pour CET appel
 * seulement — ni Mistral, ni secours vision, et l'interrupteur n'est même pas lu, puisque rien ne sort.
 */

export interface OcrPage {
  page: number;
  text: string;
  confidence: number; // 0..100
  chars: number;
  lowConfidence: boolean;
}

export interface OcrResult {
  engine: string; // "tesseract.js" (+ version)
  langs: string;
  method: "ocr";
  pages: OcrPage[];
  text: string;
  meanConfidence: number;
  pageCount: number;
  lowConfidencePages: number;
  needsReview: boolean;
  truncated: boolean; // pages au-delà du plafond non océrisées
  /** Carte des pages : position du début de chaque page dans `text`. */
  pageOffsets?: number[] | null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"]);
const LOW_CONFIDENCE = Number(process.env.REG_OCR_MIN_CONFIDENCE ?? 62); // seuil de revue humaine
/**
 * Pages océrisées par document. **0 = ILLIMITÉ, et c'est le défaut.**
 *
 * Le plafond valait 25 pages : un dossier scanné de 800 pages ressortait « océrisé » avec 3 % de
 * son contenu lu. Il n'existait que pour tenir la mémoire — problème désormais réglé à la source
 * par la rastérisation EN FLUX (une page vit à la fois), qui rend le plafond inutile.
 */
const MAX_PAGES = Number(process.env.REG_OCR_MAX_PAGES ?? 0);
const RASTER_SCALE = Number(process.env.REG_OCR_SCALE ?? 2.0); // ~200 DPI
const MAX_DIM = 2600; // borne mémoire par page

export function canOcr(ext: string): boolean {
  const e = ext.toLowerCase();
  return e === "pdf" || IMAGE_EXTS.has(e);
}

/**
 * Rastérise les pages d'un PDF en PNG via mupdf (auto-réparation des PDF imparfaits).
 * ROBUSTE PAR PAGE : une page qui refuse de se rastériser (page corrompue) est SAUTÉE — on
 * rastérise toutes les autres. Jamais une seule mauvaise page ne fait perdre tout le document.
 */
export async function rasterizePdf(buffer: Buffer, maxPages: number): Promise<{ pages: Buffer[]; total: number; failedPages: number }> {
  const pages: Buffer[] = [];
  const { total, failed } = await rasterizeShared(buffer, async (png) => { pages.push(png); }, { maxPages, scale: RASTER_SCALE });
  return { pages, total, failedPages: failed.length };
}


/**
 * Pré-traitement image (auto-rotation, niveaux de gris, normalisation, netteté, borne de taille).
 * Les PETITS scans (photo de téléphone, fax, vignette) sont AGRANDIS ×2 avant reconnaissance :
 * Tesseract lit mal sous ~1400 px de large, et l'agrandissement interpolé lui redonne des lettres
 * pleines. Un léger `sharpen` compense le flou de numérisation — sans seuillage brutal, qui
 * détruirait les documents gris.
 */
/**
 * CES OCTETS SONT-ILS UNE IMAGE ? La seule question qui décide si on ose les donner au moteur.
 *
 * `sharp` lit l'en-tête ; s'il n'y arrive pas, aucun décodeur n'y arrivera. On répond `false`
 * plutôt que de propager : un contrôle qui lève là où il devait trancher ne tranche rien.
 */
export async function estUneImage(buffer: Buffer): Promise<boolean> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buffer).metadata();
    return Boolean(meta.width && meta.height);
  } catch {
    return false;
  }
}

async function preprocess(buffer: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const base = sharp(buffer).rotate(); // applique l'orientation EXIF
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const resized = width > 0 && width < 1400
    ? base.resize({ width: Math.min(width * 2, MAX_DIM), height: MAX_DIM, fit: "inside" }) // agrandissement AUTORISÉ
    : base.resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true });
  return resized
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
}

type Worker = { recognize: (img: Buffer) => Promise<{ data: { text: string; confidence: number } }>; terminate: () => Promise<unknown> };

async function createOcrWorker(langs: string[]): Promise<{ worker: Worker; version: string }> {
  const langPath = await ensureLangData(langs);
  const tesseract = await import("tesseract.js");
  const worker = (await tesseract.createWorker(langs.join("+"), 1, {
    langPath,
    cachePath: ocrCacheDir(),
    gzip: true,
  })) as unknown as Worker;
  return { worker, version: "tesseract.js/7" };
}

/**
 * Océrise un document (image ou PDF scanné). Aiguille vers Mistral OCR (cloud) quand il est
 * configuré et autorisé, sinon vers Tesseract (auto-hébergé). En mode "auto", tout échec Mistral
 * (réseau, quota, indisponibilité) bascule silencieusement sur Tesseract — jamais de perte.
 *
 * DERNIER ÉTAGE — SECOURS VISION (`aiRescue`) : quand le contexte est fourni, les pages restées
 * vides ou douteuses APRÈS le moteur OCR sont re-présentées EN IMAGE au modèle multimodal, qui
 * les transcrit (tracé au registre des coûts, plafonné par le budget du dossier, mis en cache).
 * C'est ce qui fait la différence entre « scan illisible → revue humaine » et un texte exploitable.
 */
export async function ocrDocument(input: { ext: string; buffer: Buffer; langs?: string[]; maxPages?: number; aiRescue?: RescueContext; cloud?: boolean }): Promise<OcrResult> {
  const ext = input.ext.toLowerCase();
  if (!canOcr(ext)) throw new Error(`OCR non supporté pour « ${ext} ».`);

  const engine = (process.env.REG_OCR_ENGINE ?? "auto").trim().toLowerCase();
  /**
   * `cloud: false` — UNE LECTURE GRATUITE ET LOCALE, PAR APPEL (lot D2). Sans elle, une lecture
   * censée ne rien coûter partait chez Mistral dès que la clé existait — facturée au PDF entier, et
   * le document sorti du serveur. Comme l'interrupteur, elle l'emporte sur un moteur FORCÉ : c'est
   * une décision explicite de l'appelant, pas une dégradation silencieuse après un échec.
   */
  const cloudPermis = input.cloud !== false;
  const secoursDemande = cloudPermis && Boolean(input.aiRescue);
  const mistralConfigure = cloudPermis && engine !== "tesseract" && mistralOcrConfigured();
  /**
   * L'INTERRUPTEUR GÉNÉRAL DE L'IA COUPE LE CLOUD, PAS LA LECTURE (audit 360°, rapport 19, F3).
   *
   * Interrupteur coupé, l'écran promet « Toute l'IA est coupée » ; ce moteur envoyait pourtant
   * chaque scan à Mistral — un fournisseur cloud — et chaque page douteuse au modèle vision. Coupé,
   * le document reste ICI : Tesseract le lit sur ce serveur, et aucun octet ne part. Le résultat
   * le dit déjà par son `engine` (« tesseract.js… », jamais « mistral… ») : ce qui est rendu nomme
   * le moteur qui a VRAIMENT lu.
   *
   * Même un moteur FORCÉ (`REG_OCR_ENGINE=mistral`) cède : son « pas de repli » protège d'une
   * dégradation SILENCIEUSE après un échec ; ici le repli est dit, et il exécute une décision
   * explicite de l'administrateur. Une variable posée au déploiement ne l'emporte pas sur l'écran —
   * sinon l'écran mentirait.
   *
   * L'interrupteur n'est lu que s'il peut changer quelque chose (un moteur cloud configuré, ou un
   * secours vision demandé) : un OCR purement local ne paie pas une lecture de base pour rien.
   */
  const iaCoupee = (mistralConfigure || secoursDemande) ? await interrupteurIaCoupe() : false;
  if (mistralConfigure && iaCoupee) {
    console.warn("[reg-ocr] IA coupée par l'interrupteur général → OCR local Tesseract (aucun document envoyé à Mistral).");
  }
  const mistralUsable = mistralConfigure && !iaCoupee;
  let base: OcrResult | null = null;
  if (mistralUsable && mistralOcrEligible(ext, input.buffer)) {
    try {
      base = await mistralOcrDocument(input);
    } catch (err) {
      if (engine === "mistral") throw err; // moteur forcé → pas de repli silencieux
      console.error("[reg-ocr] Mistral OCR indisponible → repli Tesseract :", err instanceof Error ? err.message : err);
    }
  } else if (mistralUsable) {
    // Document hors limites Mistral (taille) → OCR local direct : Mistral le refuserait de toute
    // façon, inutile de dépenser un appel réseau voué à l'échec. Aucune perte (Tesseract prend le relais).
    console.warn(`[reg-ocr] document hors limites Mistral (${(input.buffer.length / 1048576).toFixed(1)} Mo) → OCR local Tesseract.`);
  }
  if (!base) base = await ocrWithTesseract(input, ext);
  // Le secours vision envoie les pages EN IMAGE à un modèle multimodal : coupé, il ne part pas, et
  // les pages douteuses restent signalées pour revue humaine — ce qu'elles étaient avant lui.
  return secoursDemande && input.aiRescue && !iaCoupee ? applyAiRescue({ ext, buffer: input.buffer }, base, input.aiRescue) : base;
}

/** OCR auto-hébergé : rastérisation mupdf + pré-traitement sharp + reconnaissance Tesseract. */
async function ocrWithTesseract(input: { ext: string; buffer: Buffer; langs?: string[]; maxPages?: number }, ext: string): Promise<OcrResult> {
  const langs = input.langs && input.langs.length > 0 ? input.langs : defaultOcrLangs();
  const maxPages = input.maxPages ?? MAX_PAGES;

  // RASTÉRISER PUIS RECONNAÎTRE **PAGE PAR PAGE**, jamais document par document : c'est ce qui
  // permet d'océriser 15 000 pages sans que la mémoire ne dépende du nombre de pages. Une seule
  // image de page vit à la fois ; le worker Tesseract, lui, est créé une seule fois.
  //
  // ROBUSTE PAR PAGE : une page qui échoue au pré-traitement OU à la reconnaissance est
  // enregistrée VIDE (revue humaine) et on continue — les pages lisibles sont océrisées.
  const { worker, version } = await createOcrWorker(langs);
  const pages: OcrPage[] = [];
  let total = 1;
  let failedPages = 0;

  const illisible = (index: number) => {
    pages.push({ page: index + 1, text: "", confidence: 0, chars: 0, lowConfidence: true }); // → revue humaine
  };

  const recognizeOne = async (raw: Buffer, index: number): Promise<void> => {
    let img = raw;
    try {
      img = await preprocess(img);
    } catch (err) {
      // ── CE QUI SE PASSAIT ICI FAISAIT TOMBER LE PROCESSUS ────────────────────────────
      //
      // « Pré-traitement best-effort : on OCR l'image brute si sharp échoue » est juste quand
      // sharp renonce à OPTIMISER. C'est faux quand il ne reconnaît même pas l'en-tête : ces
      // octets ne sont pas une image, et Tesseract, lui, ne se contente pas de rejeter la
      // promesse — son worker Node émet un événement `error`, et un `error` sans écouteur est
      // une EXCEPTION NON RATTRAPÉE : le serveur s'arrête. Mesuré sur six octets « BM???? »
      // dans une archive, exactement le genre de fichier qu'une personne dépose.
      //
      // On distingue donc les deux : sharp ne sait pas LIRE le fichier → la page est illisible,
      // on ne la présente pas au moteur. Sharp a échoué APRÈS l'avoir lue → on tente le brut.
      if (!(await estUneImage(raw))) {
        console.error("[reg-ocr] page ignorée — ces octets ne sont pas une image", index + 1, err instanceof Error ? err.message : err);
        illisible(index);
        return;
      }
    }
    try {
      const { data } = await worker.recognize(img);
      const text = (data.text ?? "").trim();
      const confidence = Math.round(data.confidence ?? 0);
      pages.push({ page: index + 1, text, confidence, chars: text.length, lowConfidence: confidence < LOW_CONFIDENCE });
    } catch (err) {
      console.error("[reg-ocr] reconnaissance page échouée", index + 1, err instanceof Error ? err.message : err);
      illisible(index);
    }
  };

  try {
    if (ext === "pdf") {
      // `recognizeOne` compte les pages à partir de 0 et rajoute 1 pour l'affichage ; la couche
      // partagée, elle, rend le rang tel qu'un humain le lit. On convertit ici, une seule fois —
      // un décalage d'un rang ferait citer la mauvaise page comme preuve.
      const out = await rasterizeShared(
        input.buffer,
        async (png, page) => recognizeOne(png, page - 1),
        { maxPages, scale: RASTER_SCALE },
      );
      total = out.total;
      failedPages = out.failed.length;
    } else {
      await recognizeOne(input.buffer, 0);
    }
  } finally {
    await worker.terminate().catch(attendu("fermeture au mieux : la ressource est abandonnée de toute façon"));
  }

  // « Tronqué » ne veut dire qu'une chose : des pages n'ont pas été lues. Qu'elles aient été
  // écartées par un plafond ou par une corruption, l'utilisateur doit le savoir.
  const truncated = pages.length < total;
  if (failedPages > 0) console.warn(`[reg-ocr] ${failedPages} page(s) corrompue(s) sautée(s) sur ${total}.`);

  // Contenu PAGINÉ (jamais retaillé : la carte des pages pointe dans CE texte).
  const paged = buildPagedContent(pages.map((p) => p.text));
  const text = paged.content;
  const withText = pages.filter((p) => p.chars > 0);
  const meanConfidence = withText.length > 0 ? Math.round(withText.reduce((s, p) => s + p.confidence, 0) / withText.length) : 0;
  const lowConfidencePages = pages.filter((p) => p.lowConfidence).length;

  return {
    engine: version, langs: langs.join("+"), method: "ocr", pages, text,
    meanConfidence, pageCount: total, lowConfidencePages,
    needsReview: meanConfidence < LOW_CONFIDENCE || lowConfidencePages > 0 || text.trim().length === 0,
    truncated,
    pageOffsets: paged.pageMap,
  };
}
