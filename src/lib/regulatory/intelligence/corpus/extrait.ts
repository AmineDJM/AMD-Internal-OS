import type { Segment } from "@/modules/bibliotheque/partage";

/**
 * L'EXTRAIT SURLIGNÉ D'UNE CITATION DU CORPUS — module PUR (aucun import d'exécution : l'écran
 * d'administration, composant client, le lit).
 *
 * `ts_headline` entoure par défaut les termes trouvés de `<b>…</b>` et recopie le reste du texte
 * TEL QUEL. Ce texte vient de pages de régulateurs téléchargées : l'injecter comme HTML exécutait
 * dans la session du Super Admin toute balise qu'une page y avait glissée (audit sécurité, XSS
 * stockée). On demande donc à Postgres des marqueurs SENTINELLES qui ne sont pas du HTML — deux
 * caractères de contrôle que l'ingestion retire du texte stocké, donc sans ambiguïté — puis on
 * découpe ici l'extrait en SEGMENTS (texte, fort) que l'écran rend en JSX. Aucun HTML ne traverse.
 */

/** Début / fin d'un terme surligné dans la sortie de `ts_headline` (STX / ETX). */
export const DEBUT_SURLIGNE = "\u0002";
export const FIN_SURLIGNE = "\u0003";

/** Options de `ts_headline` : mêmes bornes qu'avant, marqueurs sentinelles au lieu de `<b>`. */
export const OPTIONS_TS_HEADLINE_SQL = `'MaxWords=42, MinWords=16, ShortWord=2, StartSel=' || chr(2) || ', StopSel=' || chr(3)`;

// Caractères de contrôle hors saut de ligne et tabulation : ils n'ont rien à faire dans un texte
// réglementaire et deux d'entre eux servent de marqueurs.
const CONTROLES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Retire les caractères de contrôle d'un texte à stocker (garde \n et \t). */
export function sansControles(texte: string): string {
  return (texte ?? "").replace(CONTROLES, "");
}

/**
 * Découpe un extrait marqué en segments. Tolérant : un marqueur orphelin ou en double ne casse
 * rien, il ne fait qu'ouvrir ou fermer le surlignage. Segments vides retirés, voisins fusionnés.
 */
export function segmentsExtrait(brut: string): Segment[] {
  const out: Segment[] = [];
  let fort = false;
  let courant = "";
  const pousser = () => {
    const texte = sansControles(courant);
    courant = "";
    if (!texte) return;
    const dernier = out[out.length - 1];
    if (dernier && dernier.fort === fort) dernier.texte += texte;
    else out.push({ texte, fort });
  };
  for (const c of brut ?? "") {
    if (c === DEBUT_SURLIGNE || c === FIN_SURLIGNE) {
      pousser();
      fort = c === DEBUT_SURLIGNE;
    } else {
      courant += c;
    }
  }
  pousser();
  return out;
}

/** L'extrait à plat (pour les invites des agents, les exports) : marqueurs et contrôles retirés. */
export function texteExtrait(brut: string): string {
  return sansControles(brut);
}
