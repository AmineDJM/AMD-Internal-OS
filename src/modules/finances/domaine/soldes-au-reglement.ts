/**
 * LES STATUTS D'UN SPONSORING QU'UN RÈGLEMENT SOLDE — et ceux-là seulement.
 *
 * Lu par `settleExpenseOrder` ; venu d'`ad-pro/domaine/cloture-sponsoring.ts` (fusion du 29/10/2026) : c'est le
 * règlement qui le lit, et le module finances ne lit jamais ad-pro — la carte reste sans cycle.
 *
 * Régler un ordre de dépense dont la source est un sponsoring le passait `PAID`, sans condition.
 * Or l'ordre d'un POSTE porte lui aussi le sponsoring comme source : sous la règle de la tenue
 * (§118.151), le premier poste réglé faisait donc « payer » la demande entière — elle sautait sa
 * clôture, quittait les listes du travail en cours et s'affichait terminée avec un seul poste
 * payé ; réglé APRÈS la clôture, il la faisait repasser de « clôturée » à « payée ». Seul un
 * accord à montant GLOBAL (l'ancien circuit) se solde par un règlement : c'est la seule forme où
 * un ordre porte toute la demande.
 */
export const STATUTS_SOLDES_PAR_UN_REGLEMENT: readonly string[] = ["APPROVED", "ACCEPTED"];
