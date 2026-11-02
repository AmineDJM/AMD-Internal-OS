/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APERÇU D'UN FICHIER OFFICE S'AFFICHE ISOLÉ (audit 27/10/2026, SA-12).
 *
 * Mammoth (Word) et SheetJS (Excel) convertissent un fichier DÉPOSÉ PAR QUELQU'UN D'AUTRE en HTML. Ce HTML était
 * injecté dans la page (`dangerouslySetInnerHTML`) sans assainisseur — mammoth le documente : il recopie les
 * hyperliens tels quels. Un `.docx` portant un lien `javascript:` s'exécutait dans l'origine de l'ERP au clic d'un
 * collègue, avec sa session : toutes ses actions serveur appelables.
 *
 * Le HTML ne touche plus la page : il va dans un `<iframe sandbox>` SANS `allow-scripts` ni `allow-same-origin`.
 *   - aucun script ne s'y exécute (ni balise, ni attribut `on…`, ni lien `javascript:`) ;
 *   - le cadre a une origine opaque : ni cookie, ni stockage, ni accès à la page qui l'héberge ;
 *   - une CSP en tête ferme tout chargement externe (image espion, feuille distante) : seules les images
 *     incorporées (`data:`, comme mammoth les produit) et le style en ligne passent.
 * C'est plus sûr qu'un assainisseur — rien à maintenir à jour, rien à oublier — et sans dépendance.
 *
 * Module PUR : aucun import. Le composant (`office-viewers.tsx`) le lit ; le testé est ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le bac à sable du cadre : vide = toutes les restrictions (pas de script, origine opaque, ni formulaire ni popup). */
export const SANDBOX_APERCU = "";

/** La politique du document isolé : rien d'externe, seulement les images incorporées et le style en ligne. */
export const CSP_APERCU = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

/** La mise en page du document isolé — les classes Tailwind de la page ne traversent pas le cadre. */
const STYLE_APERCU = `
  body { margin: 0; padding: 12px 16px; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: #171717; background: #fff; overflow-wrap: anywhere; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 .5rem; }
  h2 { font-size: 1.125rem; font-weight: 600; margin: .75rem 0 .5rem; }
  h3 { font-weight: 600; }
  p { margin: .5rem 0; }
  a { color: #2563eb; }
  img { max-width: 100%; height: auto; }
  li { margin-left: 1.25rem; }
  table { border-collapse: collapse; margin: .75rem 0; }
  td, th { border: 1px solid #d4d4d4; padding: 4px 8px; }
  th { background: #f5f5f5; }
  .tableur td { white-space: nowrap; }
`;

/** Le document complet confié au cadre isolé (`srcDoc`). `tableur` : cellules d'Excel sur une ligne. */
export function documentApercuIsole(html: string, options: { tableur?: boolean } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${CSP_APERCU}">`
    + `<style>${STYLE_APERCU}</style></head>`
    + `<body${options.tableur ? ` class="tableur"` : ""}>${html}</body></html>`;
}
