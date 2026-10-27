/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE DU DIRECTEUR GÉNÉRAL SUR LE TOTAL D'UNE DEMANDE Ad & Pro — module PUR au socle, zéro import.
 *
 * Décision de la Direction, 27/10/2026 :
 *   « Le directeur général valide uniquement à la fin, le TOTAL — le devis total du stand, de la prise
 *   en charge… Aucun engagement ne peut être fait, aucun bon de commande ne peut être généré si ça
 *   dépasse le seuil. Le seuil, ce n'est pas 1 million par poste : c'est pour toute la demande, la
 *   somme des postes. » Et : « ce qui compte, c'est la proposition faite réellement dans les postes,
 *   pas ce que demande le délégué. »
 *
 * Le TOTAL est donc la somme des postes de la demande (accordé quand il l'est, sinon estimé ; un poste
 * refusé ne compte pas) — calculée à UN endroit (`ad-pro/porte-dg.ts`), comparée ici au seuil global
 * des réglages, par la même règle stricte que partout (`porteDgRequise` : « à partir de X » se lit
 * strictement au-dessus de X ; seuil nul ⇒ aucune porte).
 *
 * Quatre états, et ce que chacun permet :
 *   • NON_REQUISE — total ≤ seuil (ou aucun poste, ou aucun seuil) : les postes acceptés s'engagent ;
 *   • EN_ATTENTE  — total > seuil et pas (ou plus) couvert par une validation du DG : RIEN ne s'engage ;
 *   • A_REVOIR    — le DG a renvoyé CE total en révision : rien ne s'engage tant qu'il n'a pas changé ;
 *   • VALIDEE     — le DG a validé un total ≥ au total actuel : les postes acceptés s'engagent.
 *
 * UNE RALLONGE ROUVRE LA PORTE (décision #25) : un poste qui fait passer le total au-dessus de ce que
 * le DG a validé la remet EN_ATTENTE ; une baisse, elle, reste couverte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatPorteDg = "NON_REQUISE" | "EN_ATTENTE" | "A_REVOIR" | "VALIDEE";

/** La dernière décision du DG sur la demande, telle qu'elle est gardée en base. */
export interface DecisionDg {
  statut: "VALIDEE" | "A_REVOIR";
  /** Le total sur lequel il a statué. */
  montant: number;
}

export function etatPorteDg(total: number, seuil: number | null | undefined, decision: DecisionDg | null): EtatPorteDg {
  if (seuil == null || !(seuil > 0)) return "NON_REQUISE";
  if (!(total > 0) || total <= seuil) return "NON_REQUISE";
  if (decision?.statut === "VALIDEE" && decision.montant >= total) return "VALIDEE";
  // Renvoyé pour CE total : il le reste tant que les postes n'ont pas changé.
  if (decision?.statut === "A_REVOIR" && Math.abs(decision.montant - total) < 0.005) return "A_REVOIR";
  return "EN_ATTENTE";
}

/** La porte laisse-t-elle engager (BC, ordre de dépense, paiement) ? */
export function porteDgOuverte(etat: EtatPorteDg): boolean {
  return etat === "NON_REQUISE" || etat === "VALIDEE";
}

const dzd = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/** La phrase de la porte — la même partout (carte du poste, fiche, centre, refus de l'action). */
export function phrasePorteDg(etat: EtatPorteDg, total: number, seuil: number | null | undefined, decision: DecisionDg | null): string | null {
  if (etat === "NON_REQUISE") return null;
  const s = seuil != null && seuil > 0 ? dzd(seuil) : "—";
  if (etat === "VALIDEE") return `Total de ${dzd(total)} validé par le Directeur Général (seuil ${s}).`;
  if (etat === "A_REVOIR") return `Total de ${dzd(total)} renvoyé en révision par le Directeur Général (seuil ${s}).`;
  if (decision?.statut === "VALIDEE") {
    return `Total porté à ${dzd(total)}, au-delà des ${dzd(decision.montant)} validés par le Directeur Général : sa validation est de nouveau requise (seuil ${s}).`;
  }
  return `Total de ${dzd(total)} au-dessus du seuil de ${s} : la validation du Directeur Général est requise avant tout bon de commande ou paiement.`;
}

/** Le refus d'une action qui engagerait de l'argent porte fermée — `null` quand elle est ouverte. */
export function refusPorteDg(etat: EtatPorteDg, total: number, seuil: number | null | undefined, decision: DecisionDg | null): string | null {
  if (porteDgOuverte(etat)) return null;
  return `${phrasePorteDg(etat, total, seuil, decision)} Aucun bon de commande, engagement ni paiement n'est possible d'ici là.`;
}
