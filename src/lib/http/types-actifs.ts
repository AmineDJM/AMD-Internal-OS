/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN FICHIER DÉPOSÉ NE S'EXÉCUTE JAMAIS DANS LE DOMAINE DE L'ERP (audit 2026-10-24).
 *
 * ── LE DÉFAUT ────────────────────────────────────────────────────────────────────────────
 *
 * Les pièces étaient servies « en ligne » avec le type enregistré au dépôt (celui que le
 * navigateur de l'auteur a déclaré). La politique de sécurité globale ne restreint pas les scripts
 * (`next.config.mjs` : Next.js injecte les siens). Un `.html` ou un `.svg` porteur d'un script,
 * déposé par n'importe quel compte, s'exécutait donc dans l'ERP — avec la session de qui l'ouvrait,
 * un Super Admin compris. La règle existait déjà pour les pièces jointes Microsoft
 * (`api/mail/ms/attachment`) ; elle ne valait pas pour les fichiers de l'ERP lui-même (§118.5).
 *
 * ── LA RÈGLE (durcie le 24/11/2026, audit Drive F1) ─────────────────────────────────────
 *
 * On ne liste plus ce qui est DANGEREUX : on liste ce qui est SÛR. Seule une liste FERMÉE de types
 * passifs (PDF, PNG/JPEG/GIF/WebP, audio, vidéo, texte brut) est servie en ligne sans bac à sable :
 * c'est ce que le navigateur affiche dans sa visionneuse, et le bac à sable bloquerait celle du PDF.
 * TOUT le reste — HTML, SVG, XML, l'inconnu, un type mal formé — part avec
 * `Content-Security-Policy: sandbox` : le document s'affiche (ou se télécharge), mais dans une origine
 * opaque, sans script, sans formulaire, sans accès aux cookies de l'ERP.
 *
 * Pourquoi la liste fermée : l'ancienne liste des types ACTIFS laissait passer ce qu'elle ne
 * connaissait pas. `text/plain,text/html` (un type déposé par un navigateur trafiqué) n'était coupé
 * que sur `;` : il échappait au bac à sable, et le navigateur retenait `text/html`. Un type ne
 * passe désormais que s'il est BIEN FORMÉ (`type/sous-type`, rien d'autre) ET dans la liste.
 * `X-Content-Type-Options: nosniff` accompagne toute pièce : le navigateur ne devine jamais un autre type.
 *
 * Une adresse signée vers le bucket ne peut pas porter le bac à sable : hors liste passive, elle force
 * le téléchargement (`dispositionPourBucket`).
 *
 * Module PUR, sans import : lisible de partout, navigateur compris.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les types servis EN LIGNE sans bac à sable — liste FERMÉE : ce qui n'y est pas n'y est pas. */
const PASSIFS = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

/** Un type bien formé : `type/sous-type`, en minuscules, sans virgule, sans espace, sans paramètre résiduel. */
const TYPE_BIEN_FORME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

/**
 * Le type de base, sans paramètres ni casse (`Text/HTML; charset=utf-8` → `text/html`). Un type MAL FORMÉ
 * (`text/plain,text/html`, `text/html x`) rend `""` : il ne correspond à aucune liste, donc au bac à sable.
 */
export function typeDeBase(mime: string | null | undefined): string {
  const t = (mime ?? "").split(";")[0].trim().toLowerCase();
  return TYPE_BIEN_FORME.test(t) ? t : "";
}

/** Le navigateur peut-il afficher ce type en ligne SANS bac à sable ? Seulement la liste fermée. */
export function estTypePassif(mime: string | null | undefined): boolean {
  const t = typeDeBase(mime);
  return PASSIFS.has(t) || t.startsWith("audio/") || t.startsWith("video/");
}

/** Tout ce qui n'est pas passif — HTML, SVG, XML, l'inconnu, un type mal formé — se sert sous bac à sable. */
export function estTypeActif(mime: string | null | undefined): boolean {
  return !estTypePassif(mime);
}

/**
 * Le `Content-Type` à ÉMETTRE : le type de base bien formé (avec son `charset` s'il en a un, sans quoi un
 * texte s'afficherait en mojibake), sinon `application/octet-stream`. Jamais la chaîne déposée telle quelle.
 */
export function typeAEmettre(mime: string | null | undefined): string {
  const t = typeDeBase(mime);
  if (!t) return "application/octet-stream";
  const charset = /;\s*charset="?([a-z0-9._-]+)"?/i.exec(mime ?? "")?.[1];
  return charset ? `${t}; charset=${charset.toLowerCase()}` : t;
}

/** La politique posée hors liste passive : rien ne se charge, rien ne s'exécute, origine opaque. */
export const CSP_BAC_A_SABLE = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/**
 * En-têtes à AJOUTER à la réponse qui sert un fichier de type `mime` : `nosniff` toujours ; le bac à sable
 * en plus hors liste passive. À étaler dans les en-têtes de la réponse.
 */
export function entetesAntiExecution(mime: string | null | undefined): Record<string, string> {
  if (estTypePassif(mime)) return { "X-Content-Type-Options": "nosniff" };
  return { "Content-Security-Policy": CSP_BAC_A_SABLE, "X-Content-Type-Options": "nosniff" };
}

/** Une adresse signée vers le bucket ne porte pas de CSP : hors liste passive, elle se télécharge, toujours. */
export function dispositionPourBucket(mime: string | null | undefined, voulue: "inline" | "attachment"): "inline" | "attachment" {
  return estTypePassif(mime) ? voulue : "attachment";
}
