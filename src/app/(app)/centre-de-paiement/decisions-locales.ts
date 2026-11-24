import { awaitsCentre, type CentralStatus } from "@/modules/finances/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LE CENTRE VIENT DE DÉCIDER, MONTRÉ AUSSITÔT (recette sponsoring, 23/11/2026).
 *
 * ── LE DÉFAUT ────────────────────────────────────────────────────────────────────────────────
 *
 * Le DG autorisait un paiement : la décision était écrite, la feuille se refermait… et la carte
 * restait « En attente du centre de paiement », avec son bouton « Autoriser », les compteurs
 * immobiles, jusqu'au rechargement complet. Il recliquait sur la même ligne. L'action invalide
 * pourtant la page (`revalidatePath`) et l'écran la redemande (`useRafraichir`, §118.172) : le
 * circuit était complet. Mais tout l'écran attendait ce SECOND aller-retour — et la page du centre
 * est lourde (toutes les sociétés, les dossiers, les doublons, la coque) :
 * entre la fermeture de la feuille et l'arrivée des nouvelles données, l'écran montrait l'état
 * d'AVANT comme s'il était l'état présent, sans rien qui dise qu'une mise à jour était en route.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────────
 *
 * Une décision RÉUSSIE (l'action a répondu « ok ») se montre tout de suite : la carte prend son
 * nouvel état, ses boutons tombent, les compteurs bougent. On ne devine rien : on n'affiche que ce
 * que le serveur vient de confirmer avoir écrit. Et on ne double rien : la décision locale ne vaut
 * que tant que le serveur montre ENCORE l'état d'où elle est partie (`depuis`) — dès que ses
 * nouvelles données arrivent, ce sont elles qui parlent, et le compteur ne compte pas deux fois.
 *
 * Module PUR : la carte et les compteurs le lisent, le banc l'éprouve sans navigateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une décision prise depuis cet écran et confirmée par le serveur. */
export interface DecisionLocale {
  /** L'état que l'écran montrait quand on a décidé — la décision ne vaut que tant qu'il le montre encore. */
  depuis: CentralStatus;
  /** L'état que la décision a posé. */
  statut: CentralStatus;
  /** Le montant de l'ordre, pour le « montant en attente ». */
  montant: number;
}

export type DecisionsLocales = Readonly<Record<string, DecisionLocale>>;

/** L'état À MONTRER : celui de la décision locale tant que le serveur montre encore l'état d'avant. */
export function statutAffiche(id: string, statutServeur: CentralStatus, decisions: DecisionsLocales): CentralStatus {
  const d = decisions[id];
  return d && d.depuis === statutServeur ? d.statut : statutServeur;
}

export interface BilanCentre {
  enAttente: number;
  montantEnAttente: number;
  autorises: number;
  refuses: number;
}

const poids = (s: CentralStatus) => ({
  attente: awaitsCentre(s) ? 1 : 0,
  autorise: s === "APPROVED" ? 1 : 0,
  refuse: s === "REFUSED" ? 1 : 0,
});

/**
 * LES COMPTEURS DE L'ENTITÉ, corrigés des décisions que le serveur ne reflète pas encore.
 *
 * `statutsServeur` : l'état de chaque ordre affiché, tel que le serveur l'a rendu avec CE bilan — les
 * deux viennent du même rendu, donc une décision déjà comptée par le serveur n'y montre plus son
 * `depuis` et n'est pas recomptée. Une décision sur un ordre absent de la vue est ignorée.
 */
export function bilanAffiche(
  bilan: BilanCentre, statutsServeur: Readonly<Record<string, CentralStatus>>, decisions: DecisionsLocales,
): BilanCentre {
  const out = { ...bilan };
  for (const [id, d] of Object.entries(decisions)) {
    if (statutsServeur[id] !== d.depuis || d.statut === d.depuis) continue;
    const avant = poids(d.depuis);
    const apres = poids(d.statut);
    out.enAttente += apres.attente - avant.attente;
    out.montantEnAttente += (apres.attente - avant.attente) * d.montant;
    out.autorises += apres.autorise - avant.autorise;
    out.refuses += apres.refuse - avant.refuse;
  }
  // Jamais négatif : un compteur faux d'une unité se corrige à l'arrivée des données, un « −1 » se lirait comme une panne.
  return {
    enAttente: Math.max(0, out.enAttente),
    montantEnAttente: Math.max(0, out.montantEnAttente),
    autorises: Math.max(0, out.autorises),
    refuses: Math.max(0, out.refuses),
  };
}
