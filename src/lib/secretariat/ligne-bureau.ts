/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE LIGNE DU BUREAU DU SECRÉTARIAT — le contrat commun à toutes les familles (Super Admin, 24/11/2026).
 *
 * Le bureau devient UN SEUL tableau : demandes du secrétariat, fiches billet/hôtel Ad & Pro, prospection
 * d'agences, bons de commande de poste, chiffrage et achats des prises en charge… Chaque famille fournit
 * ses lignes sous CETTE forme ; l'écran ne connaît qu'elle. Module pur, sans import : il est lu par le
 * tableau côté navigateur comme par les requêtes côté serveur.
 *
 * L'état parle UN SEUL vocabulaire pour tous les types : la famille traduit ses statuts vers `EtatBureau`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ETATS_BUREAU = [
  "A_PRENDRE",
  "EN_COURS",
  "EN_VALIDATION",
  "EN_PAIEMENT",
  "CHEZ_LE_DEMANDEUR",
  "TERMINEE",
  "ANNULEE",
] as const;

export type EtatBureau = (typeof ETATS_BUREAU)[number];

export const LIBELLE_ETAT_BUREAU: Record<EtatBureau, string> = {
  A_PRENDRE: "À prendre",
  EN_COURS: "En cours",
  EN_VALIDATION: "En validation",
  EN_PAIEMENT: "En paiement",
  CHEZ_LE_DEMANDEUR: "Chez le demandeur",
  TERMINEE: "Terminée",
  ANNULEE: "Annulée",
};

/** Une ligne est « ouverte » tant qu'elle attend encore un geste de quelqu'un. */
export function estOuverte(etat: EtatBureau): boolean {
  return etat !== "TERMINEE" && etat !== "ANNULEE";
}

export interface LigneBureau {
  /** Unique dans tout le tableau : `<famille>:<id>`. */
  cle: string;
  /** La famille qui a fourni la ligne (« demande », « fiche-voyage », « agence », « bc-poste », « pec-chiffrage », « pec-achat »…). */
  famille: string;
  /** Le type affiché en première colonne (« Billet », « Prospection d'agence », « Bon de commande », « Chiffrage »…). */
  type: string;
  /** L'objet de la demande, lisible seul. */
  objet: string;
  /** La référence affichée sous l'objet (ou null). */
  reference: string | null;
  /** Le nom du demandeur (ou null). */
  demandeur: string | null;
  /** Ce que la demande concerne dans le temps, déjà formaté (« 11 → 14 déc. », « Octobre »…), ou null. */
  dates: string | null;
  etat: EtatBureau;
  /** Chez qui en est la demande, en une phrase courte (« Vous », « Finances · signature »…), ou null. */
  chezQui: string | null;
  /** Échéance ISO 8601, ou null. */
  echeance: string | null;
  /** Date ISO 8601 depuis laquelle la ligne attend (dépôt, envoi…) : sert au tri et à « depuis n j ». */
  depuis: string;
  /** Le chemin de la fiche adaptée à ce type de demande. */
  href: string;
  /** Close (terminée ou annulée) : depuis quand, ISO — les closes de plus de 30 jours se masquent. Absent : `depuis`. */
  termineeLe?: string | null;
  /** Ce que la recherche lit en plus de l'objet, de la référence et du demandeur (la personne concernée, le poste…). */
  recherche?: string | null;
  /**
   * L'objet MÉTIER que la ligne désigne (« poste:<id>:bc »…) : deux familles qui voient le même objet n'en
   * montrent qu'UNE ligne — la première famille de l'assemblage l'emporte.
   */
  cleMetier?: string | null;
}

/**
 * LE TRI DU TABLEAU : les ouvertes d'abord ; parmi elles l'échéance la plus proche (les retards en tête),
 * puis l'attente la plus longue ; les terminées et annulées en bas, les plus récentes d'abord.
 */
export function trierLignesBureau(lignes: readonly LigneBureau[]): LigneBureau[] {
  return [...lignes].sort((a, b) => {
    const oa = estOuverte(a.etat), ob = estOuverte(b.etat);
    if (oa !== ob) return oa ? -1 : 1;
    if (!oa) return b.depuis.localeCompare(a.depuis);
    if (a.echeance && b.echeance && a.echeance !== b.echeance) return a.echeance.localeCompare(b.echeance);
    if (a.echeance && !b.echeance) return -1;
    if (!a.echeance && b.echeance) return 1;
    return a.depuis.localeCompare(b.depuis);
  });
}
