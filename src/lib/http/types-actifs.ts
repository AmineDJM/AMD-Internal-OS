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
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
 *
 * Un type ACTIF (HTML, XHTML, SVG, tout XML — ce qu'un navigateur interprète comme un document
 * capable de script) part avec `Content-Security-Policy: sandbox` : le document s'affiche, mais
 * dans une origine opaque, sans script, sans formulaire, sans accès aux cookies de l'ERP. Il reste
 * lisible ; il ne peut plus rien faire. Les types PASSIFS (PDF, images bitmap, vidéo, Office…) ne
 * sont pas touchés : le bac à sable bloquerait la visionneuse PDF du navigateur.
 *
 * Une adresse signée vers le bucket ne peut pas porter cet en-tête : pour un type actif, elle force
 * le téléchargement (`dispositionPourBucket`).
 *
 * Module PUR, sans import : lisible de partout, navigateur compris.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ACTIFS = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/xsl",
  "application/xslt+xml",
  "application/mathml+xml",
  "application/rdf+xml",
]);

/** Le type de base, sans paramètres ni casse (`Text/HTML; charset=utf-8` → `text/html`). */
export function typeDeBase(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

/** Un navigateur interpréterait-il ce type comme un document capable d'exécuter un script ? */
export function estTypeActif(mime: string | null | undefined): boolean {
  const t = typeDeBase(mime);
  return ACTIFS.has(t) || t.endsWith("+xml");
}

/** La politique posée sur un type actif : rien ne se charge, rien ne s'exécute, origine opaque. */
export const CSP_BAC_A_SABLE = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/**
 * En-têtes à AJOUTER à la réponse qui sert un fichier de type `mime` : rien pour un type passif ;
 * le bac à sable et `nosniff` pour un type actif. À étaler dans les en-têtes de la réponse.
 */
export function entetesAntiExecution(mime: string | null | undefined): Record<string, string> {
  if (!estTypeActif(mime)) return {};
  return { "Content-Security-Policy": CSP_BAC_A_SABLE, "X-Content-Type-Options": "nosniff" };
}

/** Une adresse signée vers le bucket ne porte pas de CSP : un type actif s'y télécharge, toujours. */
export function dispositionPourBucket(mime: string | null | undefined, voulue: "inline" | "attachment"): "inline" | "attachment" {
  return estTypeActif(mime) ? "attachment" : voulue;
}
