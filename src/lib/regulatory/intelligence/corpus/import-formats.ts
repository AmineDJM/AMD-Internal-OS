/**
 * FORMATS ACCEPTÉS À L'IMPORT DU CORPUS — module volontairement PUR.
 *
 * Ces constantes servent des deux côtés de la frontière : l'écran d'import les affiche et s'en
 * sert pour l'attribut `accept` du sélecteur de fichiers ; le serveur les utilise pour refuser un
 * format avec son motif.
 *
 * Elles vivent donc ICI, et non dans `ingest-file.ts` : ce dernier importe Prisma et l'extraction
 * de texte (qui lit des fichiers via `node:fs`). Un composant `"use client"` qui l'importerait —
 * même pour une simple liste de chaînes — ferait échouer la compilation de production avec
 * « Module not found: Can't resolve 'fs' », une erreur que le typecheck ne voit pas.
 *
 * `src/lib/client-bundle-guard.test.ts` a détecté exactement cette chaîne d'import ; ce fichier
 * est la réponse. Ne rien y ajouter qui lise des fichiers, interroge la base ou importe un module
 * lourd.
 */

/**
 * LES IMAGES SONT DES SOURCES. Un arrêté photographié ou une page du Journal officiel scannée en
 * PNG portent exactement le même droit qu'un PDF ; les refuser à l'extension revenait à décider
 * qu'une connaissance existe selon le format dans lequel quelqu'un l'a reçue. Le moteur OCR du
 * dossier voisin les lit — la porte s'ouvre donc aussi pour elles.
 */
export const CORPUS_OCR_EXTS = ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"] as const;

export const CORPUS_IMPORT_EXTS = [
  "pdf", "docx", "txt", "md", "html", "htm", "csv", "xlsx", "xls", ...CORPUS_OCR_EXTS,
] as const;

/**
 * La liste des formats, DITE — pour que le motif de refus ne puisse pas mentir. Elle était
 * écrite à la main dans deux messages (« PDF, DOCX, TXT, MD, HTML, XLSX ») et avait déjà cessé
 * d'être vraie : ni CSV ni XLS n'y figuraient, alors qu'ils passaient.
 */
export function libelleFormats(): string {
  return CORPUS_IMPORT_EXTS.map((e) => e.toUpperCase()).join(", ");
}

export type FileIngestStatus = "INGESTED" | "UNCHANGED" | "FAILED";

export interface FileIngestResult {
  filename: string;
  status: FileIngestStatus;
  sourceVersionId?: string;
  sections?: number;
  chars?: number;
  /** Motif d'échec, en clair — c'est ce qui dit quoi corriger avant de réessayer. */
  error?: string;
  /**
   * D'où vient le texte. Un scan reconnu par OCR n'est pas une lecture de la loi : l'écran le
   * DIT, sans quoi une source citée à 63 % de confiance ressemble à un texte natif (§104.15).
   */
  methode?: "texte" | "ocr";
  /** Confiance moyenne de l'OCR (0-100). Absente pour un texte natif. */
  confiance?: number;
  /** Vrai quand l'OCR juge que des pages méritent une relecture humaine. */
  aRelire?: boolean;
}

/** Extension en minuscules, sans le point. Vide si le nom n'en porte pas. */
export function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

export function isImportableExt(ext: string): boolean {
  return (CORPUS_IMPORT_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Titre lisible déduit du nom de fichier : on retire l'extension, les soulignés et l'horodatage
 * que les téléchargements collent devant. Évite une liste de « document_final_v3(2).pdf » dans un
 * corpus réglementaire. Fonction PURE — testée.
 */
export function titleFromFilename(filename: string): string {
  const noExt = filename.replace(/\.[a-z0-9]+$/i, "");
  const cleaned = noExt
    .replace(/^\d{4}[-_]?\d{2}[-_]?\d{2}[-_\s]*/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return (cleaned || noExt || "Document sans nom").slice(0, 200);
}

/**
 * Code de source stable, dérivé du titre. Deux versions successives du MÊME texte doivent tomber
 * sur le même code, sinon l'historique se disperse en autant de sources que d'imports — et la
 * détection de doublon ne servirait plus à rien. Fonction PURE — testée.
 */
export function codeFromTitle(title: string): string {
  const slug = title
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (slug || "DOC").slice(0, 60);
}
