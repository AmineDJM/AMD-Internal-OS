/**
 * ═════════════════════════════════════════════════════════════════
 * L'AVOIR — ce qui reste à créditer sur une facture émise, et le net qu'elle porte (§118.195 — audit 360°, R15).
 *
 * Une facture émise ne se réécrit pas : un avoir la corrige, en totalité ou en partie, sous son propre numéro.
 * Deux faits en découlent, et ils se calculent ici, une fois : un avoir ne crédite jamais plus que ce que la
 * facture porte encore (avoirs déjà émis compris), et le NET de la facture — ce que le client doit vraiment —
 * est son TTC moins ses avoirs actifs. La fabrique, la fiche et le règlement lisent ces deux lectures : deux
 * copies finiraient par arrondir différemment, et le règlement encaisserait un montant que la fiche ne montre
 * pas (§118.5).
 *
 * Module PUR, zéro import — et AU SOCLE : le règlement (Finances), le compte « à régler » (Legal), la règle qualité, la
 * fabrique et la fiche le lisent, et Finances n'a pas à traverser vers Legal pour savoir ce qu'une facture doit encore
 * (le cliquet des traversées a refusé la première version, 70 pour 68 — §118.114). Les montants se comptent en
 * CENTIMES : une somme de flottants dérive au centime.
 * ═════════════════════════════════════════════════════════════════
 */

const centimes = (n: number): number => Math.round(n * 100);

/** Le net d'une facture : son TTC moins ses avoirs ACTIFS — jamais négatif. */
export function netDeLaFacture(ttcFacture: number, avoirsActifs: readonly number[]): number {
  return Math.max(0, centimes(ttcFacture) - avoirsActifs.reduce((s, a) => s + centimes(a), 0)) / 100;
}

/**
 * Une facture ENTIÈREMENT créditée par ses avoirs : il n'y reste rien à régler. Elle quitte « à régler » — le compte,
 * le total et le filtre de la liste la lisent ensemble, sinon le compte et la liste diraient deux choses (§118.51).
 * Un montant INCONNU n'est jamais « crédité » : sans avoir, une facture garde sa place parmi celles à régler, comme
 * avant cette règle — la retirer parce qu'on ne connaît pas son montant serait un refus à tort (§118.27).
 */
export function entierementCreditee(ttcFacture: number | null, totalAvoirsActifs: number): boolean {
  return centimes(totalAvoirsActifs) > 0 && netDeLaFacture(ttcFacture ?? 0, [totalAvoirsActifs]) === 0;
}

const dzd = (n: number): string => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DZD`;

/**
 * Le refus d'un avoir qui dépasserait ce qui reste à créditer — `null` quand il tient. La phrase dit les deux
 * nombres : « refusé » sans le reste ferait chercher à tâtons le montant qui passe.
 */
export function refusPlafondAvoir(numeroFacture: string, ttcAvoir: number, reste: number): string | null {
  if (centimes(ttcAvoir) <= centimes(reste)) return null;
  if (centimes(reste) === 0) return `La facture ${numeroFacture} est déjà entièrement créditée par ses avoirs : il n'y reste rien à créditer.`;
  return `Cet avoir (${dzd(ttcAvoir)}) dépasse ce qui reste à créditer sur la facture ${numeroFacture} (${dzd(reste)}) : un avoir ne crédite pas plus que la facture, avoirs déjà émis compris.`;
}
