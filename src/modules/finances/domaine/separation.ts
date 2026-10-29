/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SÉPARATION DES TÂCHES AU CENTRE DE PAIEMENT (audit 27/10/2026, ARGENT-06).
 *
 * Trois gestes font sortir l'argent : DEMANDER (une demande de paiement, une décision qui émet un
 * ordre), AUTORISER (un siège du centre de paiement), RÉGLER (la comptabilité). L'audit a montré
 * qu'un même compte `DIRECTION` pouvait tenir les trois : déposer une demande à un bénéficiaire de
 * son choix, l'autoriser au centre, puis la régler depuis « Banque & paiements ». Trois gestes,
 * une personne — et le journal disait seulement que c'était permis.
 *
 * La règle, appliquée dans sa forme la plus prudente (décision de Direction en attente) :
 *   - on n'AUTORISE pas un paiement qu'on a soi-même demandé ;
 *   - on ne RÈGLE pas un paiement qu'on a demandé ou autorisé.
 * Refuser son propre paiement reste permis : refuser n'engage rien.
 *
 * Elle se suspend par un réglage (`AppSetting.separationTachesPaiement`, vrai par défaut) que seul
 * le Super Admin touche, depuis Réglages & diffusion — par exemple le temps qu'un second siège soit
 * nommé. La suspension est journalisée.
 *
 * Module PUR : aucun import. Lu par `decidePayment` et `settleExpenseOrder` ; le testé est ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type GesteDArgent = "AUTORISER" | "REGLER";

export interface OrdreAuxMains {
  requestedById: string | null;
  centralDecidedById: string | null;
}

export const REFUS_AUTORISER_SA_DEMANDE =
  "Vous avez demandé ce paiement : un autre siège du centre de paiement l'autorise (séparation des tâches).";
export const REFUS_REGLER_SA_DEMANDE =
  "Vous avez demandé ce paiement : un autre membre de la comptabilité le règle (séparation des tâches).";
export const REFUS_REGLER_SON_AUTORISATION =
  "Vous avez autorisé ce paiement au centre : un autre membre de la comptabilité le règle (séparation des tâches).";

/** La phrase du refus, ou `null` quand le geste est permis. `active` = le réglage du Super Admin. */
export function refusSeparationDesTaches(geste: GesteDArgent, ordre: OrdreAuxMains, acteurId: string, active: boolean): string | null {
  if (!active) return null;
  if (geste === "AUTORISER") return ordre.requestedById === acteurId ? REFUS_AUTORISER_SA_DEMANDE : null;
  if (ordre.requestedById === acteurId) return REFUS_REGLER_SA_DEMANDE;
  if (ordre.centralDecidedById === acteurId) return REFUS_REGLER_SON_AUTORISATION;
  return null;
}
