import type { CentralStatus } from "@/modules/finances/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LE CENTRE VIENT DE DÉCIDER, MONTRÉ AUSSITÔT (recette sponsoring, 23/11/2026).
 *
 * ── LE DÉFAUT ────────────────────────────────────────────────────────────────────────────────
 *
 * Le DG autorisait un paiement : la décision était écrite, la feuille se refermait… et la carte
 * restait « En attente du centre de paiement », avec son bouton « Autoriser », jusqu'au
 * rechargement complet. Il recliquait sur la même ligne. L'action invalide
 * pourtant la page (`revalidatePath`) et l'écran la redemande (`useRafraichir`, §118.172) : le
 * circuit était complet. Mais tout l'écran attendait ce SECOND aller-retour — et la page du centre
 * est lourde (toutes les sociétés, les dossiers, les doublons, la coque) :
 * entre la fermeture de la feuille et l'arrivée des nouvelles données, l'écran montrait l'état
 * d'AVANT comme s'il était l'état présent, sans rien qui dise qu'une mise à jour était en route.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────────
 *
 * Une décision RÉUSSIE (l'action a répondu « ok ») se montre tout de suite : la carte prend son
 * nouvel état, ses boutons tombent, la fiche suivante s'ouvre. On ne devine rien : on n'affiche que ce
 * que le serveur vient de confirmer avoir écrit. Et on ne double rien : la décision locale ne vaut
 * que tant que le serveur montre ENCORE l'état d'où elle est partie (`depuis`) — dès que ses
 * nouvelles données arrivent, ce sont elles qui parlent, et le compteur ne compte pas deux fois.
 *
 * Module PUR : la file et la fiche le lisent, le banc l'éprouve sans navigateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une décision prise depuis cet écran et confirmée par le serveur. */
export interface DecisionLocale {
  /** L'état que l'écran montrait quand on a décidé — la décision ne vaut que tant qu'il le montre encore. */
  depuis: CentralStatus;
  /** L'état que la décision a posé. */
  statut: CentralStatus;
  /** Le montant de l'ordre décidé. */
  montant: number;
}

export type DecisionsLocales = Readonly<Record<string, DecisionLocale>>;

/** L'état À MONTRER : celui de la décision locale tant que le serveur montre encore l'état d'avant. */
export function statutAffiche(id: string, statutServeur: CentralStatus, decisions: DecisionsLocales): CentralStatus {
  const d = decisions[id];
  return d && d.depuis === statutServeur ? d.statut : statutServeur;
}
