/**
 * Les phrases du stockage objet — module PUR, lu par le serveur ET par le navigateur (un refus
 * dit avant l'envoi doit être mot pour mot celui que le serveur aurait rendu).
 */

/** Variables à poser pour activer le stockage objet — un refus doit les NOMMER. */
export const VARIABLES_STOCKAGE = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_REGION"] as const;

/**
 * Le refus d'un TRÈS gros fichier quand aucun stockage objet n'est configuré. Jamais d'écriture
 * en base d'un fichier de cette taille : elle remplirait Postgres (≈ 1 Go sur l'offre gratuite)
 * et ferait tomber l'application entière.
 *
 * DEUX PHRASES (audit Drive, C5) : un employé lit une phrase simple, qui lui dit quoi faire ; la
 * marche à suivre technique (variables, Render, redéploiement) n'est servie qu'au Super Admin
 * (`technique`) — c'est lui seul qui peut agir.
 */
export function refusSansStockageObjet(taille: number, maxSansObjetMo: number, technique = false): string {
  const mo = Math.round(taille / (1024 * 1024));
  if (!technique) {
    return `Ce fichier (${mo} Mo) dépasse ${maxSansObjetMo} Mo, la taille maximale acceptée pour le moment. `
      + `Compressez-le ou découpez-le, ou demandez au Super Admin d'activer le stockage des gros fichiers.`;
  }
  return `Ce fichier (${mo} Mo) dépasse ${maxSansObjetMo} Mo : il doit aller dans un stockage objet, `
    + `qui n'est pas configuré. Dans Render → votre service → Environment, ajoutez ${VARIABLES_STOCKAGE.slice(0, 4).join(", ")} `
    + `(et S3_REGION, « auto » pour Cloudflare R2), puis redéployez — voir docs/stockage-gros-fichiers.md. `
    + `Administration → Stockage → « Tester la connexion » confirme le réglage.`;
}

/**
 * Au-delà, sans stockage objet, un fichier est REFUSÉ au lieu d'être écrit en base (Postgres
 * ≈ 1 Go sur l'offre gratuite). Réglable par `MAX_DB_UPLOAD_MB` (lu côté serveur seulement ; le
 * navigateur reçoit la valeur par `/api/uploads/limites`).
 */
export const MAX_SANS_STOCKAGE_OBJET_MO = Math.max(1, Number(typeof process !== "undefined" ? process.env.MAX_DB_UPLOAD_MB ?? 100 : 100));
