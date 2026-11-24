/**
 * LE TYPE D'UN FICHIER D'APRÈS SON NOM — quand le navigateur ne l'a pas dit (dépôt de dossier, archive
 * décompressée, pièce relue en base). Module PUR : sorti du miroir Regulatory (Direction, 06/10) pour
 * que le rangement des dossiers produits s'en serve sans importer le miroir qui l'appelle.
 */

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv", txt: "text/plain", md: "text/markdown", json: "application/json", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
  zip: "application/zip",
};

export function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

/** L'extension d'un type MIME connu (« application/pdf » → « pdf »), ou `null`. La première de la table gagne (jpg avant jpeg). */
export function extensionDuMime(mime: string): string | null {
  const m = mime.split(";")[0].trim().toLowerCase();
  return Object.entries(EXT_MIME).find(([, v]) => v === m)?.[0] ?? null;
}
