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

/** Un type DÉCLARÉ acceptable : `type/sous-type`, rien d'autre — ni virgule, ni espace (les paramètres sont retirés avant). */
const TYPE_DECLARE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

/**
 * LE TYPE ENREGISTRÉ AU DÉPÔT (audit Drive F1, 24/11/2026). Le type annoncé par le navigateur n'est
 * qu'une DÉCLARATION : un client trafiqué peut envoyer `text/plain,text/html`, qu'on resservait tel
 * quel. On ne garde la déclaration que si elle est bien formée ; sinon le type vient du NOM
 * (`mimeFromName`), et `repli` quand le nom ne dit rien (une note vocale sans extension…).
 */
export function typeDeDepot(nom: string | null | undefined, declare: string | null | undefined, repli?: string): string {
  // Les paramètres (`audio/webm;codecs=opus`) tombent ; ce qui reste doit être un type, et un seul.
  const t = (declare ?? "").split(";")[0].trim().toLowerCase();
  if (TYPE_DECLARE.test(t)) return t;
  const parNom = mimeFromName(nom ?? "");
  return parNom === "application/octet-stream" && repli ? repli : parNom;
}

/**
 * UN NOM DE FICHIER QUI ENTRE DANS UNE CLÉ DE STOCKAGE (audit Drive F6). Le nom vient du navigateur :
 * `../../etc/passwd` ou `a\b` ne doivent jamais fabriquer un chemin. On garde le DERNIER segment
 * (basename, `/` et `\` comptent), sans caractère de contrôle, sans `..`, borné ; vide → `fichier`.
 * Le nom AFFICHÉ (colonne `name`) reste celui du dépôt : seule la clé est nettoyée.
 */
export function nomPourCle(nom: string | null | undefined): string {
  const dernier = String(nom ?? "").split(/[/\\]/).pop() ?? "";
  const propre = dernier
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\.{2,}/g, ".")
    .trim()
    .slice(0, 180);
  return propre && propre !== "." ? propre : "fichier";
}
