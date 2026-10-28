/**
 * LA DEMANDE DE PAIEMENT — les règles d'un dossier qui fait des allers-retours.
 *
 * Une demande de paiement n'est pas une validation ordinaire. Une validation ordinaire se
 * tranche une fois : oui, non. Un dossier de paiement, lui, revient — parce qu'une facture est
 * illisible, parce que le bon de commande manque, parce que le montant ne correspond pas au
 * devis. Le modéliser comme un « oui/non » oblige à tout redéposer au moindre détail, et l'on
 * finit par contourner l'outil.
 *
 * D'où trois principes, qui gouvernent tout ce fichier :
 *
 *   1. **Le verdict se donne PIÈCE PAR PIÈCE.** Refuser un dossier entier parce qu'une facture
 *      est floue oblige à redéposer le bon de commande, le devis et le bon de livraison qui,
 *      eux, allaient très bien. On ne reprend que ce qui est en cause.
 *   2. **L'état du dossier se DÉDUIT de ses pièces.** Personne ne coche « à revoir » en même
 *      temps qu'il refuse une facture : c'est un travail de secrétariat, et un travail de
 *      secrétariat finit par être oublié. L'état suit les verdicts, mécaniquement.
 *   3. **« En attente » n'est pas « refusée ».** La première reviendra, la seconde non. Les
 *      confondre, c'est relancer les finances pour rien, ou laisser mourir un dossier qui
 *      attendait une simple trésorerie.
 *
 * Module PUR — testé.
 */

import type { PaymentPieceKind, PaymentUrgency } from "@prisma/client";
import { canSubmitDossier, isBonDeVersement, type DossierPiece } from "./payment-dossier";
import { deadlineNatureRank } from "./deadline-nature";

export type PaymentState =
  | "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "ON_HOLD"
  | "CHANGES_REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";

export type PaymentMove =
  /** Le demandeur envoie son dossier aux Finances. */
  | "SUBMIT"
  /** Les Finances ouvrent l'instruction. */
  | "REVIEW"
  /** Les Finances suspendent, avec un motif. */
  | "HOLD"
  /** On reprend une demande suspendue. */
  | "RESUME"
  /** Les Finances renvoient le dossier au demandeur. */
  | "REQUEST_CHANGES"
  /** Bon à payer. */
  | "APPROVE"
  /** Refus définitif. */
  | "REJECT"
  /** Le demandeur retire sa demande. */
  | "CANCEL";

const MOVES: Record<PaymentState, Partial<Record<PaymentMove, PaymentState>>> = {
  DRAFT: { SUBMIT: "SUBMITTED", CANCEL: "CANCELLED" },
  SUBMITTED: { REVIEW: "UNDER_REVIEW", HOLD: "ON_HOLD", REQUEST_CHANGES: "CHANGES_REQUESTED", APPROVE: "APPROVED", REJECT: "REJECTED", CANCEL: "CANCELLED" },
  UNDER_REVIEW: { HOLD: "ON_HOLD", REQUEST_CHANGES: "CHANGES_REQUESTED", APPROVE: "APPROVED", REJECT: "REJECTED", CANCEL: "CANCELLED" },
  // Une demande suspendue reprend là où elle en était, et peut aussi être tranchée directement :
  // la trésorerie débloquée n'oblige pas à refaire un tour d'instruction.
  ON_HOLD: { RESUME: "UNDER_REVIEW", APPROVE: "APPROVED", REJECT: "REJECTED", REQUEST_CHANGES: "CHANGES_REQUESTED", CANCEL: "CANCELLED" },
  // Renvoyée au demandeur : elle repart chez les Finances dès qu'il a corrigé — sur le MÊME
  // dossier. Créer une deuxième demande couperait le fil et perdrait l'historique des refus.
  CHANGES_REQUESTED: { SUBMIT: "SUBMITTED", CANCEL: "CANCELLED" },
  APPROVED: {},
  REJECTED: {},
  CANCELLED: {},
};

export function nextPaymentStatus(from: string, move: PaymentMove): PaymentState | null {
  const table = MOVES[from as PaymentState];
  return table ? table[move] ?? null : null;
}

/** Le dossier est-il encore entre les mains des Finances ? */
export function isWithFinance(status: string): boolean {
  return status === "SUBMITTED" || status === "UNDER_REVIEW" || status === "ON_HOLD";
}

/** Le demandeur a-t-il la main — pour compléter, corriger, renvoyer ? */
export function isWithRequester(status: string): boolean {
  return status === "DRAFT" || status === "CHANGES_REQUESTED";
}

/** Un dossier clos ne bouge plus : ni pièce ajoutée, ni verdict changé. */
export function isClosed(status: string): boolean {
  return status === "APPROVED" || status === "REJECTED" || status === "CANCELLED";
}

export interface PieceLike { status: string }

/**
 * CE QUE PORTE UNE PIÈCE quand la question est « le dossier est-il complet ? » — sa nature, pas
 * son verdict. Les deux questions sont distinctes : un dossier peut être complet et ses pièces
 * refusées, ou incomplet et tout ce qu'il contient accepté.
 */
export type PieceFull = PieceLike & DossierPiece;

export interface PieceTally {
  total: number;
  pending: number;
  accepted: number;
  toFix: number;
  rejected: number;
}

export function tallyPieces(pieces: readonly PieceLike[]): PieceTally {
  const t: PieceTally = { total: pieces.length, pending: 0, accepted: 0, toFix: 0, rejected: 0 };
  for (const p of pieces) {
    if (p.status === "ACCEPTED") t.accepted += 1;
    else if (p.status === "CHANGES_REQUESTED") t.toFix += 1;
    else if (p.status === "REJECTED") t.rejected += 1;
    else t.pending += 1;
  }
  return t;
}

/**
 * L'ÉTAT QUE LE DOSSIER DEVRAIT AVOIR, d'après ses pièces.
 *
 * Dès qu'une pièce est à revoir, la balle est dans le camp du demandeur — et l'écran doit le
 * dire sans attendre que quelqu'un pense à changer le statut à la main. `null` = les verdicts
 * ne dictent rien, on garde l'état courant (les Finances peuvent instruire pièce par pièce sans
 * que le dossier change de camp à chaque clic).
 */
export function statusFromPieces(current: string, pieces: readonly PieceLike[]): PaymentState | null {
  if (isClosed(current)) return null;
  // UN BROUILLON NE CHANGE PAS DE CAMP (§118.191) : il n'a jamais été transmis. Un verdict posé sur
  // une de ses pièces le faisait passer « à revoir », puis « transmis » de lui-même une fois la pièce
  // reprise — sans que son demandeur l'ait envoyé, et sans l'ordre de dépense que la transmission
  // fait naître. Les Finances n'examinent plus les pièces d'un brouillon (`reviewPaymentPiece`) ;
  // cette ligne tient la même règle au niveau de la donnée.
  if (current === "DRAFT") return null;
  const t = tallyPieces(pieces);
  if (t.toFix > 0 || t.rejected > 0) {
    return current === "CHANGES_REQUESTED" ? null : "CHANGES_REQUESTED";
  }
  // Plus rien à corriger et le dossier était renvoyé : il retourne aux Finances de lui-même.
  if (current === "CHANGES_REQUESTED" && t.total > 0 && t.pending + t.accepted === t.total) return "SUBMITTED";
  return null;
}

/**
 * Peut-on donner le bon à payer ?
 *
 * Un paiement autorisé alors qu'une pièce est refusée serait un paiement sans justificatif —
 * exactement ce que le dossier existe pour empêcher. On répond par un motif lisible plutôt que
 * par un bouton grisé sans explication.
 */
export function canApprove(
  request: { status: string; amount: number | null; entityType?: string | null; paymentMethodStated?: boolean },
  pieces: readonly PieceFull[],
): { ok: boolean; reason?: string } {
  if (isClosed(request.status)) return { ok: false, reason: "Ce dossier est déjà clos." };
  if (request.amount == null || request.amount <= 0) return { ok: false, reason: "Le montant doit être renseigné." };

  // LA COMPLÉTUDE DU DOSSIER SE JUGE AU MÊME ENDROIT QU'AU DÉPÔT — bon de commande ou facture,
  // moyen de paiement déclaré, et l'exemption du bon de versement. Deux règles séparées auraient
  // divergé : on aurait fini par autoriser au bon à payer ce que la transmission refusait.
  const dossier = canSubmitDossier({
    entityType: request.entityType ?? null,
    pieces,
    paymentMethodStated: request.paymentMethodStated ?? false,
  });
  if (!dossier.ok) return dossier;

  const t = tallyPieces(pieces);
  if (t.rejected > 0) return { ok: false, reason: `${t.rejected} pièce(s) refusée(s) — le dossier ne peut pas être payé en l'état.` };
  if (t.toFix > 0) return { ok: false, reason: `${t.toFix} pièce(s) à revoir — attendez la reprise du demandeur.` };
  // Un BON DE VERSEMENT peut n'avoir aucune pièce du tout : exiger une pièce ACCEPTÉE le rendrait
  // impayable, alors qu'il a déjà été validé en amont (N+1, Direction Marketing, centre).
  if (t.accepted === 0 && !isBonDeVersement(request)) return { ok: false, reason: "Aucune pièce validée pour l'instant." };
  return { ok: true };
}

/** Le demandeur peut-il renvoyer son dossier ? */
export function canResubmit(
  request: { status: string; entityType?: string | null; paymentMethodStated?: boolean },
  pieces: readonly PieceFull[],
): { ok: boolean; reason?: string } {
  if (!isWithRequester(request.status)) return { ok: false, reason: "Le dossier est chez les Finances." };
  // Renvoyer, c'est transmettre : la même exigence qu'au premier dépôt, à la même adresse.
  const dossier = canSubmitDossier({
    entityType: request.entityType ?? null,
    pieces,
    paymentMethodStated: request.paymentMethodStated ?? false,
  });
  if (!dossier.ok) return dossier;
  const t = tallyPieces(pieces);
  if (t.toFix > 0) return { ok: false, reason: `${t.toFix} pièce(s) restent à corriger.` };
  if (t.rejected > 0) return { ok: false, reason: `${t.rejected} pièce(s) refusée(s) : remplacez-les avant de renvoyer.` };
  return { ok: true };
}

/** Une pièce se remplace tant qu'elle est en cause — pas une fois acceptée. */
export function needsReplacement(status: string): boolean {
  return status === "CHANGES_REQUESTED" || status === "REJECTED";
}

/**
 * QUI REMPLACE UNE PIÈCE, ET QUAND (§118.191, audit 360° R04).
 *
 * Une pièce MISE EN CAUSE se remplace — par le demandeur comme par les Finances, l'originale restant
 * dans le dossier : c'est elle qui explique pourquoi il y a eu un second tour. Mais une pièce ne se
 * remplaçait QUE si les Finances l'avaient signalée : un brouillon qui portait la mauvaise facture
 * n'avait pas d'issue, et un dossier renvoyé parce que « le montant a changé » ne pouvait pas recevoir
 * la facture corrigée à la place d'une ancienne déjà acceptée. Tant que le dossier est CHEZ LE
 * DEMANDEUR, il remplace donc aussi une pièce que personne n'a mise en cause — et la remplaçante
 * repart à l'examen : rien n'est accordé d'avance, la pièce remplacée sort du décompte
 * (`piecesEnVigueur`) au lieu d'être déclarée acceptée.
 *
 * Chez les Finances, la règle d'avant tient : une pièce qu'elles n'ont pas mise en cause ne change pas
 * sous leurs yeux.
 */
export function refusDeRemplacement(input: {
  pieceStatus: string; dejaRemplacee: boolean; dossierStatus: string; parLeDemandeur: boolean;
}): string | null {
  // Une pièce déjà reprise ne l'est pas deux fois : la chaîne des versions se dédoublerait, et l'on ne
  // saurait plus laquelle fait foi.
  if (input.dejaRemplacee) return "Cette pièce a déjà été remplacée.";
  if (needsReplacement(input.pieceStatus)) return null;
  if (isWithRequester(input.dossierStatus)) {
    return input.parLeDemandeur ? null : "Cette pièce n'a pas été mise en cause : tant que le dossier est chez le demandeur, c'est lui qui la remplace.";
  }
  return "Cette pièce n'a pas été mise en cause : elle se remplace quand les Finances la signalent, ou quand elles vous renvoient le dossier.";
}

/**
 * LES PIÈCES QUI COMPTENT — celles qu'aucune autre n'a remplacées.
 *
 * Une pièce remplacée était déclarée « acceptée » pour cesser de bloquer : elle entrait alors dans le
 * décompte des pièces validées, et un dossier dont la seule vraie pièce n'avait jamais été examinée
 * passait le « aucune pièce validée » du bon à payer. Elle sort du décompte, tout simplement — son
 * verdict reste ce qu'il était, l'historique ne ment plus.
 */
export function piecesEnVigueur<T extends { replacedBy?: { id: string } | null; replacedById?: string | null }>(pieces: readonly T[]): T[] {
  return pieces.filter((p) => !p.replacedBy && !p.replacedById);
}

// ───────────────────────── Priorité : la date, sinon l'urgence ─────────────────────────

/** Plus le rang est bas, plus c'est pressé. */
const URGENCY_RANK: Record<string, number> = { URGENT: 0, THIS_WEEK: 1, THIS_MONTH: 2, WHEN_POSSIBLE: 3 };

export function urgencyRank(urgency: string): number {
  return URGENCY_RANK[urgency] ?? 3;
}

/**
 * Ce que l'écran écrit dans la colonne « échéance ».
 *
 * Une demande sans date n'est pas une demande sans priorité : sans cette phrase, elle finit
 * systématiquement au bas de la pile parce que la colonne est vide.
 */
export function deadlineLabel(req: { dueDate: Date | string | null; urgency: string }, urgencyLabels: Record<string, string>): string {
  if (req.dueDate) {
    const d = req.dueDate instanceof Date ? req.dueDate : new Date(req.dueDate);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("fr-FR");
  }
  return urgencyLabels[req.urgency] ?? "Dès que possible";
}

/** En retard : une échéance convenue, dépassée, sur un dossier encore ouvert. */
export function isOverdue(req: { status: string; dueDate: Date | string | null }, now: Date = new Date()): boolean {
  if (isClosed(req.status) || !req.dueDate) return false;
  const d = req.dueDate instanceof Date ? req.dueDate : new Date(req.dueDate);
  return !Number.isNaN(d.getTime()) && d < now;
}

export interface SortableRequest {
  status: string;
  dueDate: Date | string | null;
  urgency: string;
  createdAt: Date | string;
  /** `FIXED`, `IMPORTANT`, `MODERATE` — facultatif : les demandes anciennes n'en portent pas. */
  deadlineNature?: string | null;
}

/**
 * L'ordre de la file des Finances : **ce qui presse d'abord**.
 *
 * Un tri par date de création enterre l'urgence de ce matin sous les dossiers du mois dernier.
 * On classe donc par échéance réelle — une date dépassée passe devant tout, puis les dates
 * proches, puis la NATURE de l'échéance (à date égale, un engagement non négociable passe avant
 * un repère), puis l'urgence déclarée, puis l'ancienneté.
 */
export function sortByPriority<T extends SortableRequest>(rows: readonly T[], now: Date = new Date()): T[] {
  const key = (r: T): [number, number, number, number, number] => {
    const overdue = isOverdue(r, now) ? 0 : 1;
    const due = r.dueDate ? new Date(r.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    return [overdue, due, deadlineNatureRank(r.deadlineNature), urgencyRank(r.urgency), new Date(r.createdAt).getTime()];
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

// ── La saisie : ce qu'un formulaire envoie, ramené aux valeurs admises ─────────────────────

/** Une date saisie, ou `null` si elle est vide ou illisible. */
export const dateOf = (raw: string | null): Date | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** L'urgence saisie ; toute autre valeur retombe sur « quand possible ». */
export const urgencyOf = (raw: string | null): PaymentUrgency => {
  const allowed: PaymentUrgency[] = ["WHEN_POSSIBLE", "THIS_MONTH", "THIS_WEEK", "URGENT"];
  return allowed.includes(raw as PaymentUrgency) ? (raw as PaymentUrgency) : "WHEN_POSSIBLE";
};

/** La nature d'une pièce déposée ; toute autre valeur retombe sur « autre ». */
export const kindOf = (raw: string | null): PaymentPieceKind => {
  const allowed: PaymentPieceKind[] = ["INVOICE", "PURCHASE_ORDER", "QUOTE", "DELIVERY_NOTE", "CONTRACT", "PROOF", "OTHER"];
  return allowed.includes(raw as PaymentPieceKind) ? (raw as PaymentPieceKind) : "OTHER";
};

// ── Ce que les actions écrivent et disent — une seule rédaction pour chaque geste ──────────────

/** La demande telle que la lit l'action qui en fait un ordre de dépense. */
export interface DemandeEnOrdre {
  id: string; reference: string; title: string; payee: string; amount: number;
  requesterId: string; dueDate: Date | null; deadlineNature: string | null;
}

/**
 * L'ORDRE DE DÉPENSE QU'OUVRE UNE DEMANDE — à sa transmission, ou au bon à payer d'un dossier
 * antérieur à l'ordre-à-la-soumission. Le même libellé, la même catégorie, le même bénéficiaire
 * dans les deux cas : c'est ce que le centre de paiement lit avant d'autoriser.
 */
export function ordreDeLaDemande(req: DemandeEnOrdre, notes: string | null) {
  return {
    label: `${req.reference} — ${req.title}`,
    amount: req.amount,
    category: "FOURNISSEUR" as const,
    beneficiary: req.payee,
    sourceType: "PAYMENT_REQUEST" as const,
    sourceId: req.id,
    requestedById: req.requesterId,
    dueDate: req.dueDate,
    deadlineNature: req.deadlineNature,
    notes,
  };
}

/** Le titre de la notification qu'envoie au demandeur chaque décision des Finances (`REVIEW` n'en envoie pas). */
export const TITRE_DECISION_DEMANDE: Record<string, string> = {
  HOLD: "Demande de paiement mise en attente",
  RESUME: "Demande de paiement reprise",
  REQUEST_CHANGES: "Demande de paiement — pièces à revoir",
  APPROVE: "Bon à payer accordé",
  REJECT: "Demande de paiement refusée",
};

/** Ce que dit l'écran après une correction : l'ordre rouvert au centre, le dossier à renvoyer, ou rien de plus. */
export function messageDeCorrection(rouvert: boolean, status: string): string {
  return rouvert
    ? "Demande corrigée — le paiement repasse au centre de paiement, qui doit l'autoriser de nouveau."
    : status === "CHANGES_REQUESTED"
      ? "Demande corrigée — renvoyez-la aux Finances quand votre correction est complète."
      : "Demande corrigée.";
}

/** Ce que dit l'écran après le dépôt d'une pièce : garder la main chez le demandeur, puis les avertissements. */
export function messageDeDepot(input: { resteChezLui: boolean; remplace: boolean; avertissement: string | undefined }): string {
  const phrase = input.resteChezLui
    ? `${input.remplace ? "Pièce remplacée" : "Pièce ajoutée"} — renvoyez le dossier aux Finances quand votre correction est complète.`
    : null;
  return [phrase, input.avertissement].filter(Boolean).join(" ");
}
