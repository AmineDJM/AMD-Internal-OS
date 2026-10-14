import { refusDelaiDeCourtoisie } from "@/lib/finance/dossier-auto";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RELANCE D'UN PAIEMENT, UNIFIÉE — « les relances de demandes de paiement doivent être possibles, y compris depuis
 * Ad & Pro quand une demande de paiement y a été faite » (Direction, 14/10/2026).
 *
 * Un paiement attend à un seul endroit à la fois : au CENTRE DE PAIEMENT (qui autorise), chez les FINANCES (qui règlent),
 * ou chez le DEMANDEUR (à qui le centre ou les Finances ont rendu le dossier). La relance va à QUI A LA MAIN — prévenir
 * les Finances d'un dossier encore au centre leur annonçait un travail qu'elles ne pouvaient pas commencer, et noyait
 * l'alerte du centre.
 *
 * L'état se lit sur l'ORDRE DE DÉPENSE quand il existe (c'est lui que le centre autorise et que les Finances règlent),
 * sur la demande de paiement sinon (anciennes demandes). Un paiement réglé, annulé ou refusé n'attend personne : rien à
 * relancer. Le délai de courtoisie est celui de la relance du dossier (`refusDelaiDeCourtoisie`, une heure).
 *
 * Module PUR, lu par l'action (`relance-paiement-actions.ts`), par le blocage d'une facture déjà connue et par les
 * écrans qui proposent le bouton.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatPaiement = "CENTRE" | "FINANCES" | "DEMANDEUR" | "PAYE" | "CLOS" | "HORS_PAIEMENT";

export interface OrdrePourEtat {
  status: string;
  centralStatus: string;
}

export interface DemandePourEtat {
  status: string;
}

/** OÙ ATTEND CE PAIEMENT — l'ordre d'abord, la demande ensuite ; ni l'un ni l'autre : hors paiement. */
export function etatDuPaiement(i: { ordre?: OrdrePourEtat | null; demande?: DemandePourEtat | null }): EtatPaiement {
  const o = i.ordre;
  if (o) {
    if (o.status === "PAID") return "PAYE";
    if (o.status === "CANCELLED" || o.centralStatus === "REFUSED") return "CLOS";
    if (o.centralStatus === "AWAITING") return "CENTRE";
    if (o.centralStatus === "CHANGES_REQUESTED" || o.centralStatus === "INFO_REQUESTED") return "DEMANDEUR";
    return "FINANCES";
  }
  const d = i.demande;
  if (d) {
    if (d.status === "SUBMITTED" || d.status === "UNDER_REVIEW" || d.status === "ON_HOLD" || d.status === "APPROVED") return "FINANCES";
    if (d.status === "CHANGES_REQUESTED") return "DEMANDEUR";
    if (d.status === "CANCELLED" || d.status === "REJECTED") return "CLOS";
  }
  return "HORS_PAIEMENT";
}

/** « elle est … » — la suite de la phrase de blocage, et l'état lu sur l'écran des doublons. */
export const PHRASE_ETAT_PAIEMENT: Record<EtatPaiement, string> = {
  CENTRE: "en cours de traitement — au centre de paiement",
  FINANCES: "en cours de traitement — chez les Finances",
  DEMANDEUR: "en cours de traitement — chez le demandeur, à qui le dossier a été renvoyé",
  PAYE: "déjà payée",
  CLOS: "dans un paiement annulé ou refusé",
  HORS_PAIEMENT: "déjà enregistrée — son paiement n'est pas encore demandé",
};

/** Qui a la main, en clair. */
export const QUI_A_LA_MAIN: Record<EtatPaiement, string | null> = {
  CENTRE: "le centre de paiement",
  FINANCES: "les Finances",
  DEMANDEUR: "le demandeur",
  PAYE: null,
  CLOS: null,
  HORS_PAIEMENT: null,
};

/** Y a-t-il quelqu'un à relancer ? Seulement quand le paiement ATTEND quelqu'un. */
export function relancable(etat: EtatPaiement): boolean {
  return etat === "CENTRE" || etat === "FINANCES" || etat === "DEMANDEUR";
}

/**
 * LA RELANCE EST-ELLE POSSIBLE ? — le refus, ou `null`.
 *   • rien n'attend : payé, clos, ou pas encore demandé — le refus dit lequel ;
 *   • le dossier est chez le demandeur et c'est lui qui relance : c'est à lui d'agir ;
 *   • déjà relancé par la même personne il y a moins d'une heure.
 */
export function refusDeRelance(i: {
  etat: EtatPaiement; parLeDemandeur: boolean; derniereRelance?: Date | string | null; now?: Date;
}): string | null {
  if (i.etat === "PAYE") return "Ce paiement est déjà réglé : il n'y a rien à relancer.";
  if (i.etat === "CLOS") return "Ce paiement a été annulé ou refusé : il n'y a personne à relancer.";
  if (i.etat === "HORS_PAIEMENT") return "Aucun paiement n'est en attente sur ce dossier : il n'y a personne à relancer.";
  if (i.etat === "DEMANDEUR" && i.parLeDemandeur) {
    return "Le dossier vous a été renvoyé : c'est à vous d'agir — répondez au centre de paiement ou aux Finances depuis la fiche.";
  }
  return refusDelaiDeCourtoisie(i.derniereRelance ?? null, i.now ?? new Date());
}

/** Le commentaire facultatif, borné : une relance n'est pas un second dossier. */
export const COMMENTAIRE_RELANCE_MAX = 500;

export function commentaireDeRelance(brut: string | null | undefined): string | null {
  const t = (brut ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, COMMENTAIRE_RELANCE_MAX) : null;
}

/**
 * LE MESSAGE DE LA RELANCE, tel que qui a la main le lira — la référence, qui relance, POURQUOI (le demandeur qui
 * attend, ou quelqu'un qui a voulu déposer la même facture ailleurs), et le commentaire s'il y en a un.
 */
export function messageDeRelance(i: {
  reference: string; auteur: string; parLeDemandeur: boolean; factureDejaConnue: boolean; commentaire: string | null;
}): string {
  const pourquoi = i.factureDejaConnue
    ? `relancé par ${i.auteur}, qui a voulu déposer la même facture ailleurs et a été arrêté(e) : elle est déjà en cours de traitement ici`
    : i.parLeDemandeur ? `relance du demandeur (${i.auteur})` : `relancé par ${i.auteur}`;
  return `${i.reference} — ${pourquoi}${i.commentaire ? ` : « ${i.commentaire} »` : "."}`;
}
