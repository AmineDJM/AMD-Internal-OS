/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FORMAT, LE TITRE, LE REPLI — ce que la fiche affiche et filtre (J1). Pur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const FORMATS = {
  pdf: "PDF",
  "traitement-texte": "Traitement de texte",
  tableur: "Tableur",
  presentation: "Présentation",
  texte: "Texte",
  image: "Image",
  audio: "Audio",
  video: "Vidéo",
  archive: "Archive",
  autre: "Autre",
} as const;
export type Format = keyof typeof FORMATS;
export const NOMS_FORMATS = Object.keys(FORMATS) as Format[];

export function estFormat(f: string): f is Format {
  return Object.prototype.hasOwnProperty.call(FORMATS, f);
}

/** L'extension d'un nom de fichier, en minuscules, sans point (`""` sans extension). */
export function extensionDuNom(nom: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec((nom ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

const PAR_EXTENSION: Record<string, Format> = {
  pdf: "pdf",
  doc: "traitement-texte", docx: "traitement-texte", odt: "traitement-texte", rtf: "traitement-texte",
  xls: "tableur", xlsx: "tableur", xlsm: "tableur", ods: "tableur", csv: "tableur", tsv: "tableur",
  ppt: "presentation", pptx: "presentation", odp: "presentation",
  txt: "texte", md: "texte", json: "texte", xml: "texte", html: "texte", htm: "texte", log: "texte",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", tif: "image", tiff: "image", bmp: "image", heic: "image",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", webm: "audio", aac: "audio", flac: "audio",
  mp4: "video", mov: "video", mkv: "video", avi: "video",
  zip: "archive", rar: "archive", "7z": "archive", gz: "archive", tar: "archive",
};

/** Le format d'une pièce : l'extension d'abord (le type MIME annoncé par un navigateur ment souvent), puis le MIME. */
export function formatDe(nom: string, mime: string | null | undefined): Format {
  const parExt = PAR_EXTENSION[extensionDuNom(nom)];
  if (parExt) return parExt;
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("text/")) return "texte";
  if (m.includes("spreadsheet") || m.includes("excel")) return "tableur";
  if (m.includes("presentation") || m.includes("powerpoint")) return "presentation";
  if (m.includes("wordprocessing") || m.includes("msword")) return "traitement-texte";
  if (m.includes("zip")) return "archive";
  return "autre";
}

/** L'extension à donner aux lecteurs : celle du nom, sinon celle qu'annonce le type MIME. */
export function extensionPourLecture(nom: string, mime: string | null | undefined): string {
  const e = extensionDuNom(nom);
  if (e) return e;
  const m = (mime ?? "").toLowerCase();
  const table: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt", "text/csv": "csv", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "audio/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "video/mp4": "mp4",
  };
  return table[m] ?? "";
}

/** Minuscules, sans accents, blancs simples : « Règlement Intérieur » → « reglement interieur ». */
export function plier(texte: string): string {
  return (texte ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .trim();
}

/** Le titre affiché : le nom sans extension, tirets et soulignés lus comme des blancs, borné. */
export function titreDe(nom: string): string {
  const sansExt = (nom ?? "").trim().replace(/\.[a-z0-9]{1,8}$/i, "");
  const t = sansExt.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return (t || "Sans titre").slice(0, 300);
}
