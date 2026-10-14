/**
 * LES BONS DE VERSEMENT — un par MATÉRIEL, validés ensemble, payés séparément.
 *
 * ── CE QU'ON CORRIGE ────────────────────────────────────────────────────────────────────────
 *
 * Il n'y avait qu'UN bon de versement par dossier. Or un dossier de matériel promotionnel en
 * porte plusieurs : un présentoir, un jeu de posters, une vidéo — chacun son support, chacun sa
 * taxe, chacun sa quittance. Avec un seul bon, on additionnait les montants pour n'en demander
 * qu'un, et l'on perdait ce que le guichet exige : le versement se fait matériel par matériel.
 * Ceux qui n'entraient pas dans la case se réglaient hors ERP.
 *
 * ── DEUX TEMPS, ET C'EST TOUT LE SUJET ──────────────────────────────────────────────────────
 *
 *   1. UNE VALIDATION POUR LE LOT. Le pharmacien sépare le dossier en matériels, chiffre chaque
 *      bon, et fait valider le DÉPÔT de ces bons — une fois, pas une par matériel. Faire signer
 *      cinq fois la même décision n'ajoute aucune sécurité : cela ajoute quatre relances.
 *   2. UN PAIEMENT PAR BON. La validation acquise, chaque quittance se demande SÉPARÉMENT — son
 *      montant réel, sa pièce, son passage au centre de paiement, son règlement, sa remise. Les
 *      grouper obligerait à attendre le dernier pour déposer le premier.
 *
 * ── LA REMISE, ENCORE ───────────────────────────────────────────────────────────────────────
 *
 * « Payé » ne veut pas dire « le pharmacien a le papier ». C'est la quittance qu'on dépose au
 * guichet : chaque bon reste ouvert jusqu'à ce que les Finances la lui REMETTENT — un geste, pas
 * un état déduit.
 *
 * Module PUR : ni base, ni session. Testé.
 */

/**
 * OÙ EN EST LE LOT — la validation du dépôt des bons, en une seule signature pour tous.
 *
 * Un seul état à la fois, et il commande ce que l'on peut faire : tant qu'il n'est pas accordé,
 * la liste des matériels se modifie et aucune quittance ne se demande ; une fois accordé, la
 * liste est figée et chaque bon suit sa propre route.
 */
export type SlipsLotStage =
  | "A_DEMANDER"
  | "EN_VALIDATION"
  | "VALIDATION_A_REVOIR"
  | "VALIDATION_REFUSEE"
  | "QUITTANCE_A_DEMANDER";

export function slipsLotStage(i: { validationId: string | null; validationStatus: string | null }): SlipsLotStage {
  if (!i.validationId) return "A_DEMANDER";
  switch (i.validationStatus) {
    // ANNULÉE : plus de demande — la lire « en validation » figeait le lot à vie (audit 360°, I9).
    case "CANCELLED": return "A_DEMANDER";
    case "REJECTED": return "VALIDATION_REFUSEE";
    case "CHANGES_REQUESTED": return "VALIDATION_A_REVOIR";
    case "APPROVED": return "QUITTANCE_A_DEMANDER";
    default: return "EN_VALIDATION";
  }
}

export const SLIPS_LOT_LABEL: Record<SlipsLotStage, string> = {
  A_DEMANDER: "Matériels à séparer, dépôt à faire valider",
  EN_VALIDATION: "Dépôt des bons en validation",
  VALIDATION_A_REVOIR: "Dépôt à revoir",
  VALIDATION_REFUSEE: "Dépôt refusé — à reprendre",
  QUITTANCE_A_DEMANDER: "Dépôt validé — quittances à demander",
};

/** Où en est UN bon de versement, une fois le lot validé. */
export type SlipStage =
  | "A_DEMANDER"   // le lot est validé : la quittance de ce bon reste à demander
  | "AU_CENTRE"    // demandée, en attente du centre de paiement
  | "RENVOYE"      // le centre a rendu la main au demandeur
  | "REFUSE"       // le centre a refusé CE règlement
  | "ANNULE"       // la demande ou son ordre a été annulé / refusé : rien ne paiera ce bon
  | "AUX_FINANCES" // autorisé, pas encore réglé
  | "PAYE"         // réglé, quittance pas encore remise
  | "REMIS";       // quittance remise au bureau du pharmacien

export interface SlipInput {
  /** La demande de paiement de la quittance existe-t-elle ? */
  requestId: string | null;
  /** État de l'ordre au centre de paiement (`CentralStatus`), ou `null`. */
  centralStatus: string | null;
  /** État de l'ordre de dépense (`ExpenseOrderStatus`), ou `null`. */
  orderStatus: string | null;
  deliveredAt: Date | null;
  /**
   * L'état de la DEMANDE DE PAIEMENT elle-même (`PaymentRequestStatus`), ou `null` — `"INTROUVABLE"`
   * quand le bon la désigne et qu'elle n'existe plus. Facultatif : les écrans d'avant ne le passaient pas.
   */
  requestStatus?: string | null;
}

/** La prise du bon pendant qu'on crée sa demande de paiement (`requestSlipPayment`) — un jeton, pas une demande. */
export const PRISE_DU_BON = "prise:";

export function slipStage(i: SlipInput): SlipStage {
  // La REMISE prime sur tout : une fois la quittance en main, l'état des circuits ne rouvre plus
  // la question.
  if (i.deliveredAt) return "REMIS";
  if (!i.requestId) return "A_DEMANDER";
  // UNE DEMANDE EN COURS DE CRÉATION : le bon est pris, personne d'autre ne le redemande.
  if (i.requestId.startsWith(PRISE_DU_BON)) return "AU_CENTRE";
  // UN PAIEMENT MORT NE BLOQUE PLUS LE BON (audit 10/2026). L'ordre ANNULÉ (la source retirée,
  // `payments/annulation.ts`), la demande refusée ou annulée, la demande disparue : le bon restait
  // « autorisé — à régler » à vie, sans que rien ne puisse plus le payer ni le rouvrir.
  if (i.orderStatus === "CANCELLED" || i.requestStatus === "CANCELLED" || i.requestStatus === "REJECTED" || i.requestStatus === "INTROUVABLE") {
    return "ANNULE";
  }
  switch (i.centralStatus) {
    case "REFUSED": return "REFUSE";
    case "CHANGES_REQUESTED":
    case "INFO_REQUESTED": return "RENVOYE";
    case "AWAITING": return "AU_CENTRE";
    default: break;
  }
  return i.orderStatus === "PAID" ? "PAYE" : "AUX_FINANCES";
}

/**
 * Le pharmacien peut-il demander le paiement de CE bon ?
 *
 * Un REFUS du centre rouvre cette porte, et elle seule : le lot reste validé — ce qui a été
 * refusé, c'est ce règlement-ci. Renvoyer le pharmacien à la validation du lot lui ferait refaire
 * signer cinq matériels pour un montant à corriger sur un seul.
 */
export function canRequestSlipPayment(i: SlipInput): boolean {
  const s = slipStage(i);
  return s === "A_DEMANDER" || s === "REFUSE" || s === "ANNULE";
}

/**
 * LE BON N'A AUCUN PAIEMENT VIVANT — jamais demandé, ou demandé puis refusé / annulé. C'est ce qui
 * permet, même après la validation du lot, de le RETIRER ou de déclarer le dossier « sans versement » :
 * rien n'est en route, rien n'est payé, aucune signature ne porte sur un argent qui circule.
 */
export function slipSansPaiementVivant(i: SlipInput): boolean {
  const s = slipStage(i);
  return s === "A_DEMANDER" || s === "REFUSE" || s === "ANNULE";
}

/** Les Finances peuvent-elles remettre CETTE quittance ? Une fois réglée, et une seule fois. */
export function canDeliverSlip(i: SlipInput): boolean {
  return slipStage(i) === "PAYE";
}

export const SLIP_STAGE_LABEL: Record<SlipStage, string> = {
  A_DEMANDER: "Quittance à demander",
  AU_CENTRE: "Au centre de paiement",
  RENVOYE: "Rendu au demandeur",
  REFUSE: "Refusé par le centre",
  ANNULE: "Paiement annulé — à redemander",
  AUX_FINANCES: "Autorisé — à régler",
  PAYE: "Réglé — quittance à remettre",
  REMIS: "Quittance remise",
};

export interface SlipLike extends SlipInput {
  id: string;
  label: string;
  amount: number | null;
}

export interface SlipsSummary {
  count: number;
  /** Le total ANNONCÉ, celui qu'on soumet à la validation du lot. */
  announced: number;
  /** Combien de quittances sont revenues au bureau du pharmacien. */
  delivered: number;
  /** Combien restent à demander. */
  toRequest: number;
  /** Tous les bons sont-ils remis ? C'est ce qui referme le volet « versements ». */
  allDelivered: boolean;
}

export function slipsSummary(slips: readonly SlipLike[]): SlipsSummary {
  const delivered = slips.filter((s) => slipStage(s) === "REMIS").length;
  const toRequest = slips.filter((s) => canRequestSlipPayment(s)).length;
  return {
    count: slips.length,
    announced: slips.reduce((a, s) => a + (s.amount ?? 0), 0),
    delivered,
    toRequest,
    // ZÉRO BON N'EST PAS « TOUT REMIS ». Un dossier dont on n'a pas encore séparé les matériels
    // n'a rien versé : conclure l'inverse ouvrirait la suite sur un dossier vide.
    allDelivered: slips.length > 0 && delivered === slips.length,
  };
}

/**
 * UN MATÉRIEL PEUT-IL ENCORE ÊTRE AJOUTÉ OU RETIRÉ ?
 *
 * Tant que le lot n'est pas parti en validation. Après, la liste est CE QUI A ÉTÉ SIGNÉ : y
 * ajouter un sixième bon après coup ferait payer un versement que personne n'a vu passer, et
 * en retirer un laisserait une signature portant sur autre chose que ce qui existe.
 */
export function canEditSlips(lotStage: SlipsLotStage): boolean {
  // À REVOIR se corrige ICI et se resoumet (audit 360°, I9) : la demande de validation n'a aucun
  // geste de reprise, et la resoumission clôt la précédente.
  return lotStage === "A_DEMANDER" || lotStage === "VALIDATION_REFUSEE" || lotStage === "VALIDATION_A_REVOIR";
}

/**
 * LE LOT PEUT-IL PARTIR EN VALIDATION ?
 *
 * Il faut au moins un matériel : faire signer une liste vide, c'est faire signer une intention.
 */
export function canRequestSlipsValidation(lotStage: SlipsLotStage, slips: readonly SlipLike[]): { ok: boolean; reason?: string } {
  if (!canEditSlips(lotStage)) return { ok: false, reason: "Le dépôt des bons est déjà soumis à validation." };
  if (slips.length === 0) {
    return { ok: false, reason: "Séparez d'abord le dossier en matériels : un bon de versement se demande matériel par matériel." };
  }
  return { ok: true };
}

/** Ce que l'écran dit du lot de bons — l'état, et le geste attendu. */
export function slipsMessage(lotStage: SlipsLotStage, s: SlipsSummary): string {
  switch (lotStage) {
    case "A_DEMANDER":
      return s.count === 0
        ? "Séparez ce dossier en matériels : un bon de versement par matériel. Vous ferez ensuite valider leur dépôt en une seule fois."
        : `${s.count} matériel(s) listé(s). Faites valider le dépôt de ces bons : une validation couvre le lot entier.`;
    case "EN_VALIDATION":
      return "Le dépôt des bons est en validation chez le Directeur des Opérations (à défaut, le Super Admin). Rien à faire tant qu'il n'a pas tranché.";
    case "VALIDATION_A_REVOIR":
      return "Un validateur demande une modification : lisez son commentaire dans la demande de validation, corrigez la liste des matériels et redemandez ici — la demande précédente sera close.";
    case "VALIDATION_REFUSEE":
      return "Le dépôt de ces bons a été refusé. Lisez le motif, corrigez la liste des matériels, puis redemandez.";
    default:
      if (s.allDelivered) return "Toutes les quittances vous ont été remises.";
      if (s.toRequest > 0) return `Dépôt validé. Demandez le paiement de chaque quittance séparément — ${s.toRequest} reste(nt) à demander.`;
      return `Dépôt validé. ${s.delivered} quittance(s) remise(s) sur ${s.count} — les autres suivent leur règlement.`;
  }
}
