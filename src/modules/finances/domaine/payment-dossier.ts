/**
 * CE QU'UNE DEMANDE DE PAIEMENT DOIT PORTER POUR PARTIR — et l'exception du bon de versement.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────────
 *
 * Jusqu'ici, une demande transmise devait porter « au moins une pièce ». C'était trop faible :
 * un bon de livraison seul, une photo, une capture d'écran satisfaisaient la règle, et le centre
 * de paiement se retrouvait à autoriser une sortie d'argent sans savoir NI ce qui est dû, NI
 * comment le payer. D'où deux exigences, et deux seulement :
 *
 *   1. **Un BON DE COMMANDE, une FACTURE ou un DEVIS.** Ce sont les pièces qui disent ce que la
 *      société doit, à qui, et pour combien. Le bon de livraison n'en est pas une — il dit ce
 *      qu'on a REÇU, jamais ce qu'on doit —, ni le justificatif, ni « autre pièce ». N'importe
 *      laquelle des trois suffit : exiger le bon ET la facture bloquerait les fournisseurs qui
 *      facturent sans bon, et les commandes payées d'avance.
 *
 *      LE DEVIS EN FAIT PARTIE, et c'est une correction assumée : beaucoup de dépenses se règlent
 *      sur devis accepté, la facture n'arrivant qu'APRÈS le paiement. L'exclure obligeait à
 *      inventer un bon de commande pour satisfaire l'écran — c'est-à-dire à fabriquer une pièce
 *      pour passer une règle, exactement ce qu'une règle doit empêcher.
 *   2. **Le MOYEN DE PAIEMENT figure sur le document, et le demandeur le déclare.** C'est le
 *      détail qui coûte le plus cher en bas de chaîne : la facture arrive, elle est conforme,
 *      elle est autorisée — et la comptabilité ne sait pas sur quel compte virer. Un aller-retour
 *      de trois jours pour un RIB. La case n'invente rien : elle demande à celui qui a la pièce
 *      sous les yeux de confirmer qu'elle porte le RIB, le chèque ou l'espèce convenue.
 *
 * Tout le reste — autres pièces jointes, notes, commentaires, contact — reste FACULTATIF. Ce
 * n'est pas de la tolérance : rendre obligatoire ce qui n'est pas toujours pertinent apprend à
 * remplir les champs pour rien, et c'est ainsi qu'on cesse de lire ceux qui comptent.
 *
 * ── L'EXCEPTION : LE BON DE VERSEMENT ────────────────────────────────────────────────────────
 *
 * Un BV (information médicale) n'a ni bon de commande ni facture, et ne peut pas en avoir : c'est
 * l'entreprise qui verse à une autorité sanitaire, sur la base d'un bon qu'elle a elle-même fait
 * valider en interne. La quittance, elle, n'existe qu'APRÈS le versement — l'exiger avant
 * reviendrait à exiger la preuve d'un paiement pour autoriser ce paiement. Le BV est donc exempté
 * des deux règles, et de la pièce jointe elle-même.
 *
 * Cette exemption n'est pas un trou : le BV a déjà été validé par le N+1, la Direction Marketing et
 * le centre de validations avant d'arriver ici. Il porte SA garantie, ailleurs.
 *
 * Module PUR — testé sans base.
 */

/** Les pièces qui disent ce que la société doit, à qui et pour combien. */
export const JUSTIFYING_KINDS: readonly string[] = ["INVOICE", "PURCHASE_ORDER", "QUOTE"];

export interface DossierPiece {
  kind: string;
}

export function hasJustifyingPiece(pieces: readonly DossierPiece[]): boolean {
  return pieces.some((p) => JUSTIFYING_KINDS.includes(p.kind));
}

/**
 * EST-CE UN BON DE VERSEMENT ?
 *
 * Le rattachement à une déclaration d'information médicale, et lui seul : c'est ce que pose
 * `requestMedicalInfoQuittance` au moment où elle crée la demande. Aucune heuristique sur le
 * titre — « bon de versement » écrit dans l'objet d'une demande fournisseur ordinaire ouvrirait
 * l'exemption à qui saurait la formule. Le rattachement lui-même se PROUVE à la création
 * (`createPaymentRequest` → `bonDeVersementRattache`, audit 10/2026) : la déclaration existe, le
 * demandeur la voit, et la demande naît d'un de ses bons. Ce module pur lit un fait déjà vérifié.
 */
export function isBonDeVersement(req: { entityType?: string | null }): boolean {
  return req.entityType === "MEDICAL_INFO_DECLARATION";
}

export interface DossierGate {
  /** Le rattachement de la demande — c'est lui qui décide de l'exemption. */
  entityType?: string | null;
  pieces: readonly DossierPiece[];
  /** La case cochée par le demandeur : le moyen de paiement figure sur le document. */
  paymentMethodStated: boolean;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * LA DEMANDE PEUT-ELLE PARTIR AU CENTRE DE PAIEMENT ?
 *
 * On répond par un motif lisible, et on ne cumule pas les reproches : dire les trois manques à la
 * fois transforme un formulaire en liste de fautes. On dit le premier — celui qu'il faut régler
 * maintenant.
 *
 * Un BROUILLON n'est pas concerné : il n'engage rien, il se garde incomplet, c'est sa raison
 * d'être. Cette règle ne vaut qu'au moment de TRANSMETTRE.
 */
export function canSubmitDossier(gate: DossierGate): GateResult {
  if (isBonDeVersement(gate)) return { ok: true };

  if (gate.pieces.length === 0) {
    return {
      ok: false,
      reason: "Joignez au moins un bon de commande, une facture ou un devis : c'est ce que le centre de paiement doit pouvoir lire avant d'autoriser.",
    };
  }
  if (!hasJustifyingPiece(gate.pieces)) {
    return {
      ok: false,
      reason: "Il manque la pièce qui dit ce qui est dû : un BON DE COMMANDE, une FACTURE ou un DEVIS. Un bon de livraison ne la remplace pas — il dit ce qu'on a reçu, pas ce qu'on doit.",
    };
  }
  if (!gate.paymentMethodStated) {
    return {
      ok: false,
      reason: "Confirmez que le MOYEN DE PAIEMENT figure sur le document (RIB, chèque, espèces). Sans lui, la comptabilité sait quoi payer mais pas comment, et le dossier repart pour trois jours.",
    };
  }
  return { ok: true };
}

/**
 * CE QU'ON DIT DANS LE FORMULAIRE, AVANT D'ESSAYER.
 *
 * Une contrainte qu'on n'apprend qu'en la heurtant se vit comme une panne. Le formulaire annonce
 * donc ce qui manque pendant qu'on le remplit — c'est le même calcul, rendu en une phrase courte.
 */
export function dossierHint(gate: DossierGate): string | null {
  if (isBonDeVersement(gate)) return null;
  const check = canSubmitDossier(gate);
  return check.ok ? null : check.reason ?? null;
}
