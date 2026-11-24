/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REMISE DE CAISSE D'AVANCE PASSE PAR LE CENTRE DE PAIEMENT, PUIS PAR LES FINANCES (§118.176).
 *
 * « La caisse qui est donnée mensuellement aux moyens généraux […] doit dorénavant aussi passer
 * par le centre de paiement et attendre la validation » — la Direction, 01/10/2026.
 *
 * ── LE CIRCUIT (Super Admin, 24/11/2026) ────────────────────────────────────────────────────
 *
 * « Quand on remet une somme : c'est envoyé au centre de paiement ; s'il refuse, ça affiche Refusé ;
 * s'il accepte, ça va aux Finances (Banque & paiements) ; les Finances mettent payé ou non payé ;
 * quand les Finances marquent payé, ET que le caissier confirme la réception, c'est à ce moment-là
 * que la somme compte dans la caisse. »
 *
 *   remise → EN_ATTENTE (centre) → REFUSEE, ou A_VERSER (Finances) → VERSEE (payée, à confirmer)
 *          → confirmée par le caissier (`RECEIVED`) : alors seulement elle compte dans le solde.
 *
 * La règle du 28/10/2026 — l'autorisation du centre créditait la caisse aussitôt, sans Finances ni
 * confirmation — est retirée : l'argent ne compte qu'une fois sorti de la banque ET reçu en main.
 * Confirmer avoir reçu une somme que personne n'a encore payée, c'est attester un fait qui n'a pas
 * eu lieu (§118.15).
 *
 * ── UNE REMISE QUI ATTEND N'EST PAS DANS LE FOND ────────────────────────────────────────────
 *
 * « Remis (non soldé) » compte ce qui a été REMIS. Une somme demandée au centre ne l'a pas été :
 * la compter ferait annoncer « 20 000 DZD remis, à confirmer » à une détentrice qui n'a rien vu
 * venir — et qu'on relancerait pour une confirmation impossible. Elle est montrée À PART, avec ce
 * qu'elle attend, et elle ne se solde pas avec le fond : la solder ferait payer par les Finances une
 * remise déjà close, que personne ne pourrait plus recevoir.
 *
 * ── L'HISTORIQUE RESTE LISIBLE ──────────────────────────────────────────────────────────────
 *
 * Une remise d'AVANT la règle n'a pas d'ordre : elle est versée, et se confirme comme avant. Une
 * remise déjà créditée sous la règle du 28/10 est `RECEIVED` : elle reste dans le fond, telle quelle.
 *
 * Module PUR — testé, sans base de données.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { PETTY_CASH_STATUS_LABEL, type PettyCashStatus } from "@/lib/petty-cash";

/** Où en est une remise, côté argent. */
export type EtatRemise = "EN_ATTENTE" | "A_VERSER" | "VERSEE" | "REFUSEE" | "ANNULEE";

export interface RemiseBrute {
  /** La remise porte-t-elle un ordre de dépense ? Non = remise d'avant la règle. */
  aUnOrdre: boolean;
  /** L'ordre, quand il existe encore. */
  ordre: { status: string; centralStatus: string } | null;
  /** L'écriture de la remise — posée au versement. */
  transactionId: string | null;
}

/**
 * L'ÉTAT D'UNE REMISE.
 *
 * Une écriture posée vaut versement, quoi que dise l'ordre : c'est le livre qui fait foi sur
 * l'argent sorti. Un ordre réglé dont le crochet n'a pas encore posé l'écriture est versé aussi —
 * le croire « à verser » ferait relancer les Finances pour un paiement qu'elles ont fait.
 */
export function etatRemise(r: RemiseBrute): EtatRemise {
  if (!r.aUnOrdre) return "VERSEE";
  if (r.transactionId) return "VERSEE";
  const o = r.ordre;
  // Un ordre disparu sans écriture n'a rien versé.
  if (!o) return "ANNULEE";
  if (o.status === "PAID") return "VERSEE";
  if (o.status === "CANCELLED") return "ANNULEE";
  if (o.centralStatus === "REFUSED") return "REFUSEE";
  if (o.centralStatus === "APPROVED" || o.centralStatus === "NOT_REQUIRED") return "A_VERSER";
  return "EN_ATTENTE";
}

export const ETAT_REMISE_LABEL: Record<EtatRemise, { label: string; tone: "warning" | "success" | "neutral" | "danger" }> = {
  EN_ATTENTE: { label: "En attente du centre de paiement", tone: "warning" },
  A_VERSER: { label: "Autorisée — à payer par les Finances", tone: "warning" },
  VERSEE: { label: "Versée", tone: "success" },
  REFUSEE: { label: "Refusé", tone: "danger" },
  ANNULEE: { label: "Annulée", tone: "neutral" },
};

/** La remise attend-elle encore l'argent ? Elle n'est alors ni dans le fond, ni à solder. */
export function remiseEnAttente(etat: EtatRemise): boolean {
  return etat === "EN_ATTENTE" || etat === "A_VERSER";
}

/** Payée par les Finances, pas encore confirmée par le caissier : hors du solde, en attente de son geste. */
export const LIBELLE_A_CONFIRMER = "Versée — à confirmer par le caissier";

/**
 * LE LIBELLÉ D'UNE REMISE, argent ET réception confondus — une seule lecture pour le bandeau et
 * l'historique. Versée mais non confirmée, elle ne se dit pas « versée » tout court : la somme n'est
 * pas encore dans la caisse, et c'est le caissier qu'on attend.
 */
export function libelleRemise(etat: EtatRemise, status: PettyCashStatus): { label: string; tone: "warning" | "success" | "neutral" | "danger" } {
  if (etat !== "VERSEE") return ETAT_REMISE_LABEL[etat];
  if (status === "ALLOTTED") return { label: LIBELLE_A_CONFIRMER, tone: "warning" };
  return PETTY_CASH_STATUS_LABEL[status];
}

/**
 * LE STATUT QUE LE FOND RETIENT POUR UNE REMISE — ou `null` quand elle reste hors du fond.
 *
 * Versée (ou d'avant la règle) : son statut, tel quel. Qui attend l'argent sans avoir jamais été reçue
 * reste dehors. Mais une remise CONFIRMÉE dont les Finances ont défait le paiement (« non payé » après
 * « payé ») n'est plus en main : elle compte comme « à confirmer » — sa somme sort du solde, et les
 * dépenses déjà faites dessus restent comptées (l'argent dépensé est sorti du tiroir, quoi qu'il arrive
 * au paiement). L'ignorer tout à fait ferait disparaître ces dépenses avec elle.
 */
export function statutPourLeFond(etat: EtatRemise, status: string, nbDepenses: number): string | null {
  if (!remiseEnAttente(etat)) return status;
  if (status === "RECEIVED" || nbDepenses > 0) return "ALLOTTED";
  return null;
}

/**
 * Le préfixe que le refus du centre écrit dans la note de la remise (`suitesDuRefus`, finances/actions-centre.ts) —
 * d'où l'écran relit le motif. Les deux phrases sont tenues ensemble par le banc `centre-paie-caisse-flow`.
 */
export const PREFIXE_REFUS_REMISE = "Refusée par le centre de paiement : ";

/** Le motif du refus, relu dans la note de la remise — `null` quand elle n'en porte pas. */
export function motifDuRefus(note: string | null): string | null {
  if (!note) return null;
  const i = note.lastIndexOf(PREFIXE_REFUS_REMISE);
  if (i < 0) return null;
  return note.slice(i + PREFIXE_REFUS_REMISE.length).trim() || null;
}

/**
 * POURQUOI LA DÉTENTRICE NE PEUT PAS ENCORE CONFIRMER — ou `null` quand elle le peut.
 *
 * Chaque refus nomme ce qu'on attend, et de qui : « impossible » ferait chercher une panne là où
 * il n'y a qu'une étape en cours.
 */
export function refusConfirmationRemise(etat: EtatRemise): string | null {
  switch (etat) {
    case "VERSEE": return null;
    case "EN_ATTENTE":
      return "Cette remise attend encore l'autorisation du centre de paiement : la somme n'est pas partie, vous ne pouvez pas confirmer l'avoir reçue.";
    case "A_VERSER":
      return "Le centre de paiement a autorisé cette remise ; les Finances doivent encore la payer. Vous confirmerez sa réception une fois la somme en main.";
    case "REFUSEE":
      return "Le centre de paiement a refusé cette remise : il n'y a rien à recevoir.";
    case "ANNULEE":
      return "Cette remise a été annulée : il n'y a rien à recevoir.";
  }
}
