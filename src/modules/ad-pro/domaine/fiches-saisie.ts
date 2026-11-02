/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES SAISIES DANS LE FORMULAIRE D'AJOUT D'UN POSTE — module PUR, zéro import.
 *
 * « Quand on AJOUTE un poste "Prise en charge de la billetterie" ou "de l'hôtellerie", on saisit
 * DIRECTEMENT les fiches (voyageurs ; personnes logées) dans le même formulaire — pas "créer le
 * poste, puis ajouter les fiches". » (Direction, 10/2026)
 *
 * Le formulaire d'ajout porte donc N fiches, chacune sous un PRÉFIXE (`fiche0_nom`, `fiche0_passeport`…),
 * avec les MÊMES noms de champs que le formulaire d'une fiche seule (préfixe vide) : un seul jeu de
 * champs côté écran, une seule lecture côté serveur (`lireVoyageur` / `lireHebergement`). Ce module dit
 * le préfixe — écrit une fois, lu par l'écran et par l'action.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le champ qui énumère les fiches du formulaire (une valeur par fiche : son préfixe). */
export const CHAMP_FICHES = "fiches" as const;

/** Plus de fiches qu'une opération réaliste n'en compte : au-delà, c'est un formulaire forgé. */
export const FICHES_MAX = 60;

const FORME_PREFIXE = /^fiche\d{1,4}_$/;

/** Le préfixe des champs de la fiche n° `i` (0, 1, 2…). */
export function prefixeFiche(i: number): string {
  return `fiche${Math.max(0, Math.trunc(i))}_`;
}

/**
 * Les préfixes reçus, dans l'ordre, sans doublon ni forme inattendue — un préfixe forgé ne fait pas lire
 * un autre champ du formulaire. `null` : il y en a trop.
 */
export function prefixesRecus(valeurs: readonly unknown[]): string[] | null {
  const vus = new Set<string>();
  for (const v of valeurs) {
    if (typeof v !== "string" || !FORME_PREFIXE.test(v)) continue;
    vus.add(v);
  }
  return vus.size > FICHES_MAX ? null : [...vus];
}

/** La phrase d'un refus de fiche : laquelle, et pourquoi — « Fiche 2 (Haddad) : … ». */
export function refusDeFiche(rang: number, nom: string | null, raison: string): string {
  return `Fiche ${rang}${nom ? ` (${nom})` : ""} : ${raison} Le poste n'a pas été créé.`;
}
