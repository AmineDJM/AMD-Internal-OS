/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TRANCHER UNE VALIDATION AU SECRÉTARIAT — la règle, lue par l'action ET par les écrans
 * (lot E5 — audit des managers, M14 et M15).
 *
 * Une approbation (`AdminApproval`) a trois issues : valider, refuser, demander une modification. Les deux
 * dernières renvoient la balle au demandeur — sans motif, il ne sait ni pourquoi on lui dit non, ni quoi
 * corriger. Les boutons partaient d'un clic, sans un mot, et l'action ne l'exigeait pas.
 *
 * Et la décision ne disait pas QUI l'avait prise : le validateur nommé, son intérimaire, l'assistante ou la
 * Direction (droit « Valider » du module) tranchent la même approbation, et la fiche ne montrait que
 * « Validateur : X » — un achat accordé par quelqu'un d'autre se lisait accordé par X.
 *
 * Module PUR (zéro import) : le composant client et l'action serveur lisent la même liste (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type DecisionApprobation = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

const DECISIONS: readonly DecisionApprobation[] = ["APPROVED", "REJECTED", "CHANGES_REQUESTED"];

/**
 * Une décision LISIBLE. « PENDING », une faute de frappe, un champ perdu en route : refusés — jamais lus comme
 * un accord (§118.192a), jamais envoyés tels quels à la base, qui les rejetait en erreur brute.
 */
export function estDecisionDApprobation(v: string | null | undefined): v is DecisionApprobation {
  return typeof v === "string" && (DECISIONS as readonly string[]).includes(v);
}

/** Refuser et demander une modification renvoient la balle au demandeur : il doit savoir pourquoi. */
export function exigeMotif(d: DecisionApprobation): boolean {
  return d !== "APPROVED";
}

/**
 * Le refus d'une décision sans motif, avec ce qu'il faut écrire (§118.30) — `null` quand le motif est là,
 * ou n'est pas exigé. Appelé APRÈS les gardes d'état (§118.18). Le motif arrive déjà nettoyé (`fdStr` rend
 * `null` pour un champ vide ou fait d'espaces).
 */
export function refusSansMotif(d: DecisionApprobation, motif: string | null): string | null {
  if (!exigeMotif(d) || motif !== null) return null;
  return d === "REJECTED"
    ? "Dites pourquoi vous refusez : c'est ce que lira le demandeur."
    : "Dites ce qu'il faut modifier : c'est ce que lira le demandeur.";
}

/**
 * ON NE TRANCHE PAS SA PROPRE DEMANDE — la règle des circuits de congé et de formation (`approval-chain.ts` :
 * « personne d'autre ne s'auto-valide »), que l'approbation au secrétariat n'appliquait qu'à l'intérimaire :
 * un détenteur du droit « Valider » — l'assistante de direction, le Directeur des opérations — validait son
 * propre achat. Le sommet garde la main, pour la raison des circuits : il est parfois le seul au-dessus.
 */
export function interditSurSaPropreDemande(a: { estDemandeur: boolean; sommet: boolean }): boolean {
  return a.estDemandeur && !a.sommet;
}

/** Le titre que lit le demandeur — sans abréviation ni énumération brute (§104.17). */
export const LIBELLE_DECISION: Record<DecisionApprobation, string> = {
  APPROVED: "Validation accordée",
  REJECTED: "Validation refusée",
  CHANGES_REQUESTED: "Modification demandée",
};

/** Ce qu'est la parole de celui qui tranche, selon sa décision. */
export function libelleMotif(statut: string): string {
  if (statut === "REJECTED") return "Motif du refus";
  if (statut === "CHANGES_REQUESTED") return "À modifier";
  return "Note";
}

/**
 * QUI A TRANCHÉ, tel que la fiche le dit (M14). `null` tant que rien n'est tranché. Une décision d'avant cet
 * enregistrement — ou dont le compte a été supprimé — n'a pas d'auteur connu : on le DIT, plutôt que de laisser
 * « Validateur : X » se lire comme sa signature.
 */
export function decideurAffiche(a: { status: string; decidedAt: Date | string | null; decidedByName: string | null }): string | null {
  if (a.status === "PENDING" || !a.decidedAt) return null;
  return a.decidedByName ? `Décision prise par ${a.decidedByName}` : "Décision prise — auteur inconnu";
}

/**
 * QUI TRANCHE UNE APPROBATION (audit assistante & PRIM, 14/10/2026 — Direction : « corrige tout de suite »).
 *
 * Le validateur NOMMÉ, son INTÉRIMAIRE, ou le SOMMET (`isTopManagement`) — et personne d'autre. Le droit « Valider »
 * du module suffisait : l'assistante de direction (ou tout détenteur du droit) approuvait l'achat adressé au N+1 d'un
 * autre, et une approbation chiffrée émet un ordre de dépense. L'assistante relance ; elle ne décide plus à sa place.
 * La règle de l'auto-validation (`interditSurSaPropreDemande`) s'applique EN PLUS.
 */
export function peutTrancherApprobation(a: { estValidateur: boolean; parInterim: boolean; sommet: boolean }): boolean {
  return a.estValidateur || a.parInterim || a.sommet;
}

/**
 * UNE PIÈCE CHIFFRÉE NE SE VALIDE PAS PAR CELUI QUI LA PORTE (audit 14/10/2026). Soumettre une pièce avec un montant,
 * c'est demander un ordre de dépense : le demandeur qui se choisissait validateur, saisissait 450 000 DZD et validait
 * faisait partir un paiement à son nom. Dès qu'un montant est saisi, ni le soumetteur, ni le demandeur, ni l'assistante
 * qui traite ne valident. Sans montant, la validation reste un AVIS, et se l'adresser reste permis.
 * `null` quand le choix tient.
 */
export function refusValidateursPieceChiffree(a: {
  montant: number | null;
  validateurs: readonly string[];
  soumetteurId: string;
  demandeurId: string | null;
  traitanteId: string | null;
}): string | null {
  if (a.montant === null || a.montant <= 0) return null;
  const exclus = new Set([a.soumetteurId, a.demandeurId, a.traitanteId].filter((v): v is string => Boolean(v)));
  if (!a.validateurs.some((v) => exclus.has(v))) return null;
  return "Une pièce chiffrée émet un paiement à sa validation : ni vous, ni le demandeur, ni l'assistante qui traite la demande ne pouvez la valider. Choisissez un autre validateur, ou retirez le montant.";
}
