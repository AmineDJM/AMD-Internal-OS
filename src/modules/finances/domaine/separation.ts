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
 * La règle, PERSONNE PAR PERSONNE (et non plus par convention de rôle) :
 *   - on n'AUTORISE pas un paiement qu'on a soi-même demandé ;
 *   - on n'AUTORISE pas un paiement dont on a APPROUVÉ la demande en amont — une étape de validation, un visa, une
 *     décision de circuit (garde-fous de l'argent, Super Admin 24/11/2026 : « qui décide n'autorise pas au centre ») ;
 *   - on ne RÈGLE pas un paiement qu'on a demandé ou autorisé.
 * Refuser son propre paiement reste permis : refuser n'engage rien.
 *
 * Le centre n'a que deux sièges (le Directeur Général et le Super Admin) : quand l'un est écarté, l'autre autorise. Les
 * phrases le disent — un refus qui ne nomme pas qui peut agir fait chercher (§118.30).
 *
 * Elle se suspend par un réglage (`AppSetting.separationTachesPaiement`, vrai par défaut) que seul
 * le Super Admin touche, depuis Réglages & diffusion — par exemple le temps qu'un second siège soit
 * nommé. La suspension est journalisée.
 *
 * LE SUPER ADMIN N'Y EST PAS SOUMIS (décision de la Direction, 03/11/2026 : « enlève-moi cette histoire de si c'est
 * moi qui fais une demande, je ne peux pas la valider… je suis super admin ») : il autorise et règle ses propres
 * demandes. La règle reste entière pour tous les autres comptes, Direction comprise.
 *
 * Module PUR : aucun import. Lu par `decidePayment` et `settleExpenseOrder` (qui couvre aussi `verserLaRemise`, appelée
 * seulement derrière lui) ; le testé est ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type GesteDArgent = "AUTORISER" | "REGLER";

export interface OrdreAuxMains {
  requestedById: string | null;
  centralDecidedById: string | null;
  /**
   * Qui a APPROUVÉ la demande en amont (étapes de validation, visas, décisions de circuit) — lu par
   * `approbateursEnAmont` (infra). Absent = personne de connu : la règle ne refuse alors rien à ce titre.
   */
  approbateursEnAmont?: readonly string[];
}

export const REFUS_AUTORISER_SA_DEMANDE =
  "Vous avez demandé ce paiement : un autre membre de la Direction générale (le Directeur Général ou le Super Admin) "
  + "doit l'autoriser (séparation des tâches).";
export const REFUS_AUTORISER_SON_APPROBATION =
  "Vous avez approuvé cette demande en amont (validation ou visa) : un autre membre de la Direction générale (le "
  + "Directeur Général ou le Super Admin) doit l'autoriser au centre (séparation des tâches).";
export const REFUS_REGLER_SA_DEMANDE =
  "Vous avez demandé ce paiement : un autre membre des Finances doit le marquer payé (séparation des tâches).";
export const REFUS_REGLER_SON_AUTORISATION =
  "Vous avez autorisé ce paiement au centre : un autre membre des Finances doit le marquer payé (séparation des tâches).";

/**
 * La phrase du refus, ou `null` quand le geste est permis. `active` = le réglage du Super Admin ; `superAdmin` = l'acteur
 * EST le Super Admin (le compte réel, jamais une « Vue exacte » : ces gestes d'écriture y sont déjà refusés).
 */
export function refusSeparationDesTaches(geste: GesteDArgent, ordre: OrdreAuxMains, acteurId: string, active: boolean, superAdmin = false): string | null {
  if (!active || superAdmin) return null;
  if (geste === "AUTORISER") {
    if (ordre.requestedById === acteurId) return REFUS_AUTORISER_SA_DEMANDE;
    return ordre.approbateursEnAmont?.includes(acteurId) ? REFUS_AUTORISER_SON_APPROBATION : null;
  }
  if (ordre.requestedById === acteurId) return REFUS_REGLER_SA_DEMANDE;
  if (ordre.centralDecidedById === acteurId) return REFUS_REGLER_SON_AUTORISATION;
  return null;
}
