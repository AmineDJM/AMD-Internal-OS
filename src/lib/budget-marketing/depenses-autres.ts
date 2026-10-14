/**
 * BUDGET MARKETING › DÉPENSES — « AUTRES DÉPENSES DE L'ENVELOPPE » : ce qui n'est PAS déjà dans le tableau des postes.
 *
 * Le tableau 1 (« Postes Ad & Pro à bon de commande signé ») porte chaque poste — les postes « Historique 2026 » du lot
 * d'intégration comme les postes à BC signé — et, sur la ligne du poste, l'écriture que son ordre a réglée. La section
 * « Déjà imputé » qui suit ne montre donc QUE les dépenses hors postes : écritures de trésorerie imputées à la main,
 * lignes budgétaires, moyens généraux… Les répéter (Direction, 14/10/2026 : « Déjà imputé (45) » relistait les 39 postes
 * historiques) faisait croire à un double compte — les chiffres, eux, ne comptaient qu'une fois (vue d'ensemble).
 *
 * Module PUR, sans import.
 */

export const TITRE_DEJA_IMPUTE_HORS_POSTES = "Déjà imputé hors postes Ad & Pro";

/**
 * Les dépenses « déjà imputées » qui ne sont pas des postes Ad & Pro : sans les postes historiques (`HISTORIQUE`), ni
 * les écritures de trésorerie réglées par l'ordre d'un poste du tableau (`ecrituresDesPostes`).
 */
export function horsPostesAdPro<T extends { kind: string; id: string }>(dejaImputees: readonly T[], ecrituresDesPostes: ReadonlySet<string>): T[] {
  return dejaImputees.filter((x) => x.kind !== "HISTORIQUE" && !(x.kind === "FINANCE" && ecrituresDesPostes.has(x.id)));
}
