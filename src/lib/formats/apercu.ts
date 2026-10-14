/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUEL APERÇU POUR QUEL FICHIER — une seule table, pour le Drive, les documents et les pièces.
 *
 * « Des fois, dans le Drive ou dans Regulatory, je veux visualiser un document mais le format est
 * ancien ou pas configuré : « Aperçu non disponible pour ce type ». Je veux que tous les formats
 * soient lisibles, navigables, téléchargeables, ingérables, modifiables » (Direction, 06/10).
 *
 * Avant : chaque écran avait SA liste d'extensions (le Drive en connaissait quatre familles, la fenêtre
 * des documents six, le visualiseur de ZIP une autre) — un format ajouté à l'un restait « non disponible »
 * chez les autres. Ici, UNE table : chaque extension a une NATURE, et la nature dit comment l'afficher.
 *
 *   image / video / audio / pdf  → le navigateur les lit tels quels
 *   texte                         → lu ET modifiable (code, journaux, JSON, YAML, SQL, Markdown…)
 *   html                          → affiché dans un cadre isolé (jamais exécuté dans l'application)
 *   docx / xlsx / pptx            → ouverts dans l'ÉDITEUR OFFICE (modifiables sur place) ; la visionneuse du
 *                                   navigateur n'est que le secours
 *   converti                      → ouverts DANS L'ÉDITEUR OFFICE, dans leur format exact (.doc, .rtf, .odt, .ppt,
 *                                   .xls, .ods, .odp, .pages, .key, .numbers, .epub, .djvu, .xps…) : lisibles,
 *                                   navigables, imprimables — sans rien convertir ni changer au fichier d'origine
 *   zip                           → parcouru dans la fenêtre
 *   autre                         → aucun aperçu possible (binaire, exécutable…) : téléchargement
 *
 * Quel que soit le format, TÉLÉCHARGER reste possible (le fichier d'origine n'est jamais touché), et
 * l'INGESTION lit le même fichier par ses propres lecteurs. Module PUR : aucune importation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureApercu =
  | "image" | "video" | "audio" | "pdf" | "texte" | "html" | "docx" | "xlsx" | "pptx" | "converti" | "zip" | "autre";

const IMAGE = ["png", "jpg", "jpeg", "jpe", "gif", "webp", "svg", "bmp", "avif", "ico", "apng"];
const VIDEO = ["mp4", "webm", "ogv", "m4v", "mov"];
const AUDIO = ["mp3", "wav", "oga", "ogg", "m4a", "aac", "flac", "opus", "weba"];
const TEXTE = [
  "txt", "text", "md", "markdown", "log", "json", "jsonl", "ndjson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "properties", "csv-brut", "tsv", "sql", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "php", "java",
  "kt", "c", "h", "cpp", "hpp", "cs", "go", "rs", "swift", "sh", "bash", "zsh", "bat", "cmd", "ps1", "r", "m", "tex", "bib",
  "srt", "vtt", "diff", "patch", "gitignore", "editorconfig", "dockerfile", "makefile", "rst", "adoc", "org", "nfo", "eml-texte",
];
const HTML = ["html", "htm", "xhtml"];
/** Ouverts PAR L'ÉDITEUR OFFICE — les formats « anciens » ou « pas configurés » du rapport (lecture, ou édition si le format se réécrit). */
const CONVERTI = [
  // Word et apparentés
  "doc", "dot", "dotx", "dotm", "docm", "rtf", "odt", "ott", "fodt", "wps", "wpt", "pages", "sxw", "stw", "hwp", "hwpx", "epub", "fb2", "djvu", "xps", "oxps", "mht", "mhtml", "wri",
  // Excel et apparentés
  "xls", "xlsm", "xlsb", "xlt", "xltx", "xltm", "ods", "ots", "fods", "numbers", "et", "sxc", "stc",
  // PowerPoint et apparentés
  "ppt", "pps", "ppsx", "ppsm", "pot", "potx", "potm", "pptm", "odp", "otp", "fodp", "key", "dps", "sxi", "sti",
];
const CSV = ["csv"];

const nature = new Map<string, NatureApercu>();
for (const e of IMAGE) nature.set(e, "image");
for (const e of VIDEO) nature.set(e, "video");
for (const e of AUDIO) nature.set(e, "audio");
for (const e of TEXTE) nature.set(e, "texte");
for (const e of HTML) nature.set(e, "html");
for (const e of CONVERTI) nature.set(e, "converti");
for (const e of CSV) nature.set(e, "xlsx");
nature.set("pdf", "pdf");
nature.set("docx", "docx");
nature.set("xlsx", "xlsx");
nature.set("pptx", "pptx");
nature.set("zip", "zip");

export function extensionDe(nom: string): string {
  const m = nom.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/** La nature d'un fichier, d'après son nom (et son type MIME à défaut d'extension connue). */
export function natureApercu(nom: string, mime?: string | null): NatureApercu {
  const par = nature.get(extensionDe(nom));
  if (par) return par;
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/")) return m === "text/html" ? "html" : "texte";
  if (m === "application/json" || m === "application/xml" || m === "application/x-yaml") return "texte";
  return "autre";
}

/** Ce fichier s'ouvre-t-il dans l'ÉDITEUR OFFICE (Word, Excel, PowerPoint et leurs anciens formats) ? */
export const ouvrableDansLEditeur = (nom: string, mime?: string | null): boolean => {
  const n = natureApercu(nom, mime);
  return n === "converti" || n === "docx" || n === "xlsx" || n === "pptx";
};

/**
 * LA VISIONNEUSE DE SECOURS du navigateur (lecture seule), quand l'éditeur Office n'est pas joignable — `null` : aucune.
 *
 * Un MODÈLE Word (.dotx), un Word à macros (.docm), un modèle Excel (.xltx), un modèle PowerPoint (.potx)… sont le
 * MÊME format que .docx / .xlsx / .pptx (une archive OOXML) : la visionneuse du navigateur les lit aussi. Seuls les
 * trois formats modernes en avaient une, et « Attestation de travail.dotx » tombait sur « téléchargez le fichier » dès
 * que l'éditeur était injoignable. SheetJS lit en plus les tableurs anciens (.xls, .xlsb, .ods).
 */
const SECOURS_WORD = new Set(["docx", "dotx", "docm", "dotm"]);
const SECOURS_TABLEUR = new Set(["xlsx", "csv", "xlsm", "xltx", "xltm", "xlsb", "xls", "ods"]);
const SECOURS_DIAPORAMA = new Set(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"]);
export function visionneuseDeSecours(nom: string): "docx" | "xlsx" | "pptx" | null {
  const e = extensionDe(nom);
  if (SECOURS_WORD.has(e)) return "docx";
  if (SECOURS_TABLEUR.has(e)) return "xlsx";
  if (SECOURS_DIAPORAMA.has(e)) return "pptx";
  return null;
}

/** Les extensions que l'éditeur Office ouvre (anciens formats compris) — pour dire ce qui est admis dans un refus. */
export const EXTENSIONS_CONVERTIBLES: readonly string[] = CONVERTI;

/** Peut-on afficher quelque chose (autre que « téléchargez ») ? */
export const apercuPossible = (nom: string, mime?: string | null): boolean => natureApercu(nom, mime) !== "autre";

/** Au-delà, un fichier texte s'ouvre tronqué : le navigateur n'a pas à avaler 50 Mo de journal. */
export const TAILLE_MAX_TEXTE_OCTETS = 1_000_000;
