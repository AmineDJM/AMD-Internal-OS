/**
 * UNE CELLULE DE CSV QUI NE S'EXÉCUTE PAS (audit Drive F15, 24/11/2026).
 *
 * Un tableur (Excel, LibreOffice, Google Sheets) lit une cellule qui commence par `=`, `+`, `-`, `@`, une
 * tabulation ou un retour chariot comme une FORMULE. Un nom de client, un commentaire, une désignation
 * saisis dans l'ERP (`=HYPERLINK("http://…";"Cliquez")`, `=cmd|' /C calc'!A0`) devenaient ainsi du code
 * dans le fichier exporté, ouvert ensuite par un collègue. Toute valeur TEXTE qui commence par l'un de
 * ces caractères est préfixée d'une apostrophe : le tableur l'affiche comme du texte.
 *
 * Un NOMBRE (type `number`) n'est jamais touché : `-12,5` reste un montant négatif, pas une formule.
 *
 * Module PUR, SANS IMPORT : il sert aussi aux exports faits dans le navigateur (client-bundle-guard).
 */

const DEBUT_DE_FORMULE = /^[=+\-@\t\r]/;

/** Le texte, neutralisé s'il commencerait une formule dans un tableur. */
export function neutraliserFormuleCsv(texte: string): string {
  return DEBUT_DE_FORMULE.test(texte) ? `'${texte}` : texte;
}

export interface OptionsCellule {
  /** Le séparateur du fichier (défaut `;`, celui d'Excel en français) : une valeur qui le contient est mise entre guillemets. */
  separateur?: string;
  /** Mettre TOUTE valeur entre guillemets (exports qui le faisaient déjà). */
  guillemets?: "si-besoin" | "toujours";
}

/**
 * UNE CELLULE PRÊTE À ÉCRIRE : vide pour `null`/`undefined`, un nombre tel quel, un texte neutralisé
 * (`neutraliserFormuleCsv`) puis échappé (guillemets doublés, entre guillemets s'il contient le
 * séparateur, un guillemet ou un saut de ligne).
 */
export function celluleCsv(v: unknown, o: OptionsCellule = {}): string {
  const separateur = o.separateur ?? ";";
  const texte = v === null || v === undefined ? ""
    : typeof v === "number" || typeof v === "bigint" ? String(v)
    : neutraliserFormuleCsv(String(v));
  const entourer = o.guillemets === "toujours" || texte.includes(separateur) || /["\r\n]/.test(texte);
  return entourer ? `"${texte.replace(/"/g, '""')}"` : texte;
}
