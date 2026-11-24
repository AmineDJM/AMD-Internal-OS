/**
 * LA COUVERTURE DU PANEL PAR LETTRE, EN TÊTE DU PLAN DE TOURNÉE (interface du délégué, maquette VALIDÉE le 24/11/2026).
 *
 * Pour chaque lettre de segmentation : combien de visites le plan PRÉVOIT chez les praticiens de cette lettre, et combien
 * leur fréquence en DEMANDE par cycle (le requis unique, `requisDuPraticien` — lu par le chargeur, jamais recalculé ici).
 * Ce module ne convertit aucun requis à une autre maille : l'écran dit « requis par cycle », ce qui est la règle.
 *
 * Module PUR — aucune importation de valeur.
 */

export const ORDRE_LETTRES = ["H", "A", "B", "C", "D", "NA"] as const;
export type LettreCouverte = (typeof ORDRE_LETTRES)[number];

export interface CouvertureLettre {
  lettre: LettreCouverte;
  prevues: number;
  requises: number;
  /** 0-100, plafonné ; 100 quand rien n'est requis. */
  pct: number;
  manque: number;
}

/**
 * `paires` = les visites du plan, `AAAA-MM-JJ|doctorId` (une par visite). Une lettre sans aucun praticien du panel ne
 * s'affiche pas ; un praticien hors segmentation (lettre nulle ou « NC ») ne compte nulle part.
 */
export function couvertureParLettre(
  praticiens: readonly { id: string; lettre: string | null; requis: number }[],
  paires: readonly string[],
): CouvertureLettre[] {
  const lettreDe = new Map(praticiens.map((p) => [p.id, p.lettre]));
  return ORDRE_LETTRES.flatMap((lettre) => {
    const duPanel = praticiens.filter((p) => p.lettre === lettre);
    if (duPanel.length === 0) return [];
    const requises = duPanel.reduce((s, p) => s + Math.max(0, p.requis), 0);
    const prevues = paires.filter((c) => lettreDe.get(c.slice(c.indexOf("|") + 1)) === lettre).length;
    return [{
      lettre, prevues, requises,
      pct: requises === 0 ? 100 : Math.min(100, Math.round((prevues / requises) * 100)),
      manque: Math.max(0, requises - prevues),
    }];
  });
}
