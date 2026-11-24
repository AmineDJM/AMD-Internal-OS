/**
 * VERSIONS D'UN DOCUMENT — la part PURE, lisible par le navigateur (aucun import) : la ligne affichée par le petit
 * « Versions » de la fiche d'un document, et le nom sous lequel une ancienne version se télécharge.
 * La part serveur (écriture, lecture, libération) vit dans `document-versions.ts`.
 */

export interface LigneVersionDocument {
  version: number;
  /** Octets, quand on les connaît. */
  taille: number | null;
  auteur: string | null;
  /** ISO 8601. */
  date: string;
  /** La version que montre le document aujourd'hui. */
  courante: boolean;
  /** Enregistrement FORCÉ de l'éditeur Office (bouton « Enregistrer » pendant la session). */
  forcee: boolean;
}

/** « contrat.docx », version 2 → « contrat (v2).docx » : deux versions téléchargées ne s'écrasent pas sur le poste. */
export function nomDeVersion(nom: string, version: number): string {
  const m = nom.match(/^(.*?)(\.[^./\\]+)?$/);
  const base = m?.[1] || nom;
  const ext = m?.[2] ?? "";
  return `${base} (v${version})${ext}`;
}
