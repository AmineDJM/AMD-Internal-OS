/**
 * ON NE TRANCHE PAS SA PROPRE DEMANDE RH (audit sécurité 27/10, SECURITE-ACCES-06).
 *
 * Le circuit de congé le disait déjà (`approval-chain.ts` : « On ne valide pas sa propre demande »),
 * mais les décisions prises AU GUICHET RH ne le vérifiaient pas : un membre des RH accordait sa propre
 * avance sur salaire (ce qui émet un ordre de dépense), validait sa note de frais, accordait son congé
 * (débit du solde) ou réécrivait, après coup, un congé déjà décidé — jours et solde compris.
 *
 * Module PUR, sans import : la règle se lit d'un coup d'œil et se teste sans base.
 */
export function refusDecisionSurSoi(demandeurUserId: string | null | undefined, decideurId: string): string | null {
  if (!demandeurUserId || demandeurUserId !== decideurId) return null;
  return "On ne tranche pas sa propre demande : un autre membre des RH doit la traiter.";
}
