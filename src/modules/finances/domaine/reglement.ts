/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « LE PAIEMENT DE CE DOSSIER EST FAIT » — la règle qui autorise à le DIRE (§118.148).
 *
 * « Concernant les paiements, c'est clair, tous passent par le centre de paiements. » (Direction,
 * 09/2026). Le centre ne voit un paiement que s'il existe un ORDRE DE DÉPENSE : c'est l'ordre
 * qui naît « en attente du centre » et que `canDisburse` refuse de régler sans son autorisation.
 *
 * ── CE QUE LA MESURE A TROUVÉ ───────────────────────────────────────────────────────────────
 *
 * Trois gestes déclaraient un paiement FAIT sans qu'aucun ordre ne l'ait été :
 *   • le chantier « Paiement » du matériel promotionnel se refermait d'un clic — aucune pièce,
 *     aucun ordre, aucun centre ;
 *   • « Paiement effectué » (ancien parcours) passait le dossier à PAYMENT_DONE pendant que son
 *     ordre attendait encore le centre ;
 *   • « Régler la facture » (ancien parcours) CRÉAIT l'ordre et, dans le même clic, déclarait le
 *     dossier « réglé et clôturé » — un ordre que le centre pouvait encore refuser.
 * Aucune étape en échec, aucun signal : le dossier disait « payé », la trésorerie disait autre
 * chose, et c'est le dossier qu'on lisait.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────────
 *
 * Le paiement d'un dossier est fait quand il existe AU MOINS UN règlement rattaché et que TOUS
 * sont réglés. Un seul en attente — au centre, aux Finances, ou pas encore envoyé — suffit à
 * tenir le chantier ouvert : clore sur « deux sur trois » serait déclarer payé ce qui ne l'est pas.
 * Le refus NOMME chaque pièce et où elle en est (§118.30).
 *
 * Module PUR — zéro import. Il ne lit rien : l'appelant lui donne les états.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Où en est un règlement rattaché au dossier. */
export type EtatReglement =
  | "REGLE"         // l'ordre est payé (ou la facture enregistrée comme déjà réglée)
  | "AU_CENTRE"     // l'ordre attend le centre de paiement (ou une réponse du demandeur au centre)
  | "REFUSE"        // le centre a refusé l'ordre
  | "AUX_FINANCES"  // autorisé, pas encore réglé par les Finances
  | "NON_ENVOYE";   // une facture qui n'est pas partie au règlement, ou dont l'ordre a été annulé

export const LIBELLE_ETAT_REGLEMENT: Record<EtatReglement, string> = {
  REGLE: "réglé",
  AU_CENTRE: "en attente du centre de paiement",
  REFUSE: "refusé par le centre de paiement",
  AUX_FINANCES: "autorisé, à régler par les Finances",
  NON_ENVOYE: "pas envoyé au règlement",
};

/**
 * L'état d'un ORDRE DE DÉPENSE, lu sur ses deux colonnes.
 *
 * `status` dit si l'argent est parti ; `centralStatus` dit où en est l'autorisation. PAYÉ l'emporte
 * sur tout : un ordre réglé l'a été après l'autorisation (`canDisburse`). Un ordre ANNULÉ ne règle
 * rien — la facture qu'il portait reste à envoyer.
 */
export function etatDeLOrdre(o: { status: string; centralStatus: string }): EtatReglement {
  if (o.status === "PAID") return "REGLE";
  if (o.status === "CANCELLED") return "NON_ENVOYE";
  if (o.centralStatus === "REFUSED") return "REFUSE";
  if (o.centralStatus === "AWAITING" || o.centralStatus === "CHANGES_REQUESTED" || o.centralStatus === "INFO_REQUESTED") {
    return "AU_CENTRE";
  }
  return "AUX_FINANCES";
}

/** Une pièce de règlement rattachée au dossier : ce qu'on en affiche, et où elle en est. */
export interface PieceDeReglement {
  libelle: string;
  etat: EtatReglement;
}

/**
 * LE CHANTIER « PAIEMENT » PEUT-IL SE CLORE ?
 *
 * Aucune pièce : refus qui nomme le chemin — enregistrer la facture dans « Pièces liées », puis
 * l'envoyer au règlement ; c'est ce chemin qui fait passer le paiement par le centre.
 */
export function chantierPaiementClos(pieces: readonly PieceDeReglement[]): { ok: true } | { ok: false; raison: string } {
  if (pieces.length === 0) {
    return {
      ok: false,
      raison: "Aucun règlement n'est rattaché à ce dossier. Enregistrez la facture de l'agence dans « Pièces liées » "
        + "(Engagement › Facture), puis envoyez-la au règlement depuis sa fiche : elle passe par le centre de paiement, "
        + "et le chantier se clôt une fois réglée.",
    };
  }
  const restants = pieces.filter((p) => p.etat !== "REGLE");
  if (restants.length > 0) {
    const detail = restants.map((p) => `${p.libelle} (${LIBELLE_ETAT_REGLEMENT[p.etat]})`).join(", ");
    return { ok: false, raison: `Paiement pas encore fait : ${detail}. Le chantier se clôt une fois tout réglé.` };
  }
  return { ok: true };
}
