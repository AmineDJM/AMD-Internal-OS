/**
 * Runner réglementaire — LES RÉGLAGES : verrou expiré, lots par tour, OCR (local ou cloud),
 * plafonds d'extraction, budget de temps d'un passage, et le petit pool de concurrence.
 */
import { mistralOcrConfigured } from "../../ocr/mistral-ocr";

export const STALE_LOCK_MS = 5 * 60_000; // un job « RUNNING » figé > 5 min est repris

/**
 * Jobs pris par passage. Relevé de 5 à 20 : avec la séparation calcul / attente réseau, la
 * plupart des jobs d'un lot sont désormais des attentes qui se recouvrent. À 5, une quarantaine
 * de dossiers déposés ensemble s'écoulaient au compte-gouttes.
 */
export const MAX_JOBS_PER_TICK = 20;

/**
 * Documents extraits par tour (le reste est re-mis en file, repris dans le MÊME passage depuis
 * l'introduction du budget de temps). Relevé de 20 à 40 : la mémoire ne dépend pas de ce nombre
 * — un seul document est chargé à la fois — seul le nombre d'allers-retours en base en dépend.
 */
export const EXTRACT_BATCH = clampInt(process.env.REG_EXTRACT_BATCH, 40, 1, 200);

const OCR_BATCH_LOCAL = 3; // Tesseract = WASM/CPU lourd → petit lot séquentiel, reste re-mis en file

export const ocrEnabled = () => (process.env.REG_OCR_ENABLED ?? "1") !== "0";

/**
 * Débit OCR adapté au moteur actif. Mistral (cloud) = latence RÉSEAU → on parallélise un gros
 * lot (plusieurs documents en vol) pour finir un dossier en quelques minutes. Tesseract (WASM
 * local, CPU/mémoire) reste SÉQUENTIEL (concurrence 1) sur un petit lot pour borner la RAM.
 */
function ocrIsCloud(): boolean {
  return (process.env.REG_OCR_ENGINE ?? "auto").trim().toLowerCase() !== "tesseract" && mistralOcrConfigured();
}

export function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function ocrBatchSize(): number {
  return ocrIsCloud() ? clampInt(process.env.REG_OCR_BATCH, 24, 1, 200) : OCR_BATCH_LOCAL;
}

// Concurrence AU NIVEAU DOCUMENT (défaut 3). Volontairement modérée : un document massif
// (8 000–10 000 pages) charge un gros blob + le découpe en mémoire, ET fait lui-même du parallélisme
// PAR TRANCHES en interne. Trop de gros documents en vol simultané = risque OOM. Ajustable selon la RAM.
export function ocrConcurrency(): number {
  return ocrIsCloud() ? clampInt(process.env.REG_OCR_CONCURRENCY, 3, 1, 20) : 1;
}

// Plafond du texte extrait persisté (fin de la troncature 1 M) et des pages OCR détaillées stockées
// (borne la taille de ligne pour un document de 10 000 pages, sans fausser les agrégats).
export const extractionMaxChars = () => clampInt(process.env.REG_EXTRACTION_MAX_CHARS, 20_000_000, 100_000, 200_000_000);

export const ocrStoredPages = () => clampInt(process.env.REG_OCR_STORED_PAGES, 5000, 100, 20_000);

// SOUPAPE DE SÉCURITÉ (désactivée par défaut) : pdf-parse (extraction) et mupdf (OCR) chargent le
// PDF ENTIER en mémoire ; sur une instance à faible RAM, un fichier de plusieurs centaines de Mo peut
// provoquer un OOM. Défaut 1000 Mo → au-dessus du plafond de stockage (950 Mo) : aucun fichier n'est
// bloqué en fonctionnement normal (pas de régression). À ABAISSER (ex. 200) sur une petite instance :
// un fichier au-delà est alors marqué REVUE MANUELLE (sans être chargé) pour ne pas bloquer le lot.
/**
 * Taille au-delà de laquelle un fichier part en revue manuelle.
 *
 * Le plafond valait 1 Go (bridé à 4 Go), pour une raison qui n'existe plus : la rastérisation
 * gardait toutes les pages en mémoire. Elle est désormais EN FLUX — une page vit à la fois — donc
 * le nombre de pages n'entre plus en ligne de compte. Ne reste que la taille du fichier lui-même,
 * que mupdf doit ouvrir d'un bloc.
 *
 * Défaut porté à 8 Go, plafond de réglage à 200 Go : ce n'est plus un choix de produit, c'est la
 * mémoire de la machine qui décide. Et quand elle ne suffit pas, on le DIT (avec la taille, le
 * seuil et quoi faire) plutôt que de laisser un document silencieusement de côté.
 */
export const maxProcessBytes = () => clampInt(process.env.REG_MAX_PROCESS_MB, 8000, 20, 200_000) * 1024 * 1024;

/**
 * REND LA MAIN À LA BOUCLE D'ÉVÉNEMENTS (macro-tâche). Node est mono-thread : entre deux unités
 * de travail LOURDES (pdf-parse, OCR WASM, jumeau numérique…), on cède la main pour que les autres
 * requêtes HTTP (navigation, messagerie, autres utilisateurs) soient servies IMMÉDIATEMENT →
 * l'application reste fluide PENDANT l'extraction/analyse d'un dossier, au lieu de « geler ».
 */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Exécute `fn` sur `items` avec au plus `concurrency` traitements EN VOL (pool à curseur partagé).
 * `fn` NE DOIT JAMAIS lever (ici `ocrOne` avale ses erreurs) — le pool n'a donc pas à récupérer.
 * On cède la boucle d'événements entre deux unités pour ne jamais monopoliser le thread.
 */
export async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx], idx);
      await yieldToEventLoop(); // laisser respirer les autres requêtes entre deux documents
    }
  });
  await Promise.all(workers);
}

/**
 * BUDGET DE TRAVAIL D'UN PASSAGE — ce qui a transformé l'attente en analyse.
 *
 * Le planificateur ne se déclenche qu'une fois par minute. Or plusieurs jobs se RE-METTENT EN
 * FILE pour reprendre là où ils s'étaient arrêtés (l'extraction traite un lot de documents, puis
 * repasse la main). Résultat : un dossier de 262 fichiers avançait par paliers d'un lot… toutes
 * les minutes — un quart d'heure d'attente pure, sans que rien ne calcule.
 *
 * Le passage continue donc de travailler TANT QU'IL RESTE DU TRAVAIL, dans une enveloppe de temps
 * bornée. On cède la boucle d'événements entre chaque unité (l'application reste fluide), et le
 * verrou de débounce empêche deux passages de se chevaucher.
 */
export const JOBS_BUDGET_MS = clampInt(process.env.REG_JOBS_BUDGET_MS, 120_000, 5_000, 600_000);
