/**
 * TOUTE SORTIE D'ARGENT A UN DOSSIER — d'où qu'elle vienne, et sans que personne l'ouvre.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Un ordre de dépense né d'une **demande de paiement** portait un dossier : ses pièces, ses
 * verdicts pièce par pièce, son fil, et un libellé CLIQUABLE dans la file du décaissement. Un
 * ordre né d'ailleurs — matériel promotionnel, bon de versement, sponsoring, congrès, dossier
 * réglementaire, demande au secrétariat, avance sur salaire, poste Ad&Pro — n'en portait aucun.
 * Même écran, même file, même argent : la moitié des lignes s'ouvraient, l'autre était du texte
 * mort. Pour joindre une facture à celles-là, il fallait retrouver le module d'origine, y avoir
 * accès, et savoir que c'était là qu'il fallait chercher.
 *
 * Ce n'était pas un défaut d'affichage. Le dossier n'existait pas.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────────
 *
 * **Un ordre de dépense, un dossier.** À la naissance de l'ordre, s'il n'en a pas déjà un, on
 * l'ouvre — automatiquement, sans geste humain. Le dossier n'invente rien : il reprend le
 * libellé, le montant, le bénéficiaire, l'échéance et l'entité de l'ordre, et il PORTE le
 * rattachement à la demande d'origine, qui reste ouvrable d'un clic.
 *
 * ── CE QUE LE DOSSIER COMPAGNON N'EST PAS ───────────────────────────────────────────────────
 *
 * Ce n'est pas une seconde décision. L'ordre est arrivé là parce que son circuit d'origine
 * l'avait validé, et c'est le CENTRE DE PAIEMENT qui autorise la sortie d'argent. Si le dossier
 * compagnon rouvrait un « bon à payer », le même paiement se déciderait à deux endroits — et la
 * question « qui a autorisé ? » n'aurait plus de réponse unique. Le compagnon est donc l'endroit
 * où l'on RASSEMBLE : les pièces, les demandes de pièces, la discussion, la relance. Le verdict,
 * lui, reste là où il a toujours été.
 *
 * D'où la colonne `origin` : `REQUEST` (quelqu'un a demandé un paiement, et sa décision crée
 * l'ordre) ou `EXPENSE_ORDER` (l'ordre existait, le dossier s'est ouvert derrière lui). Deux
 * dossiers identiques à l'écran, deux règles de décision opposées : les distinguer par une
 * heuristique — « il a un `entityType`, donc… » — aurait fini par se tromper le jour où une
 * demande native en porterait un aussi.
 *
 * Module PUR : ni base, ni session. Testé.
 */

/** D'où vient un dossier de paiement. */
export type DossierOrigin = "REQUEST" | "EXPENSE_ORDER";

export const DOSSIER_ORIGINS: readonly DossierOrigin[] = ["REQUEST", "EXPENSE_ORDER"];

/**
 * Une valeur inconnue vaut `REQUEST` — le comportement HISTORIQUE.
 *
 * C'est le repli sûr : tous les dossiers antérieurs à cette colonne sont des demandes natives,
 * et se tromper dans l'autre sens retirerait leur bouton « bon à payer » à des dossiers qui en
 * dépendent.
 */
export function dossierOriginOf(raw: string | null | undefined): DossierOrigin {
  return raw === "EXPENSE_ORDER" ? "EXPENSE_ORDER" : "REQUEST";
}

/** Ce dossier a-t-il été ouvert PAR un ordre de dépense, plutôt que l'inverse ? */
export function isCompanionDossier(origin: string | null | undefined): boolean {
  return dossierOriginOf(origin) === "EXPENSE_ORDER";
}

/**
 * FAUT-IL OUVRIR UN DOSSIER POUR CET ORDRE ?
 *
 * Une seule exception, et elle est structurelle : un ordre né d'une **demande de paiement** a
 * DÉJÀ son dossier — c'est la demande elle-même. En ouvrir un second dédoublerait les pièces et
 * le fil sur le même paiement, et l'on ne saurait plus lequel fait foi.
 *
 * Tout le reste — y compris une source inconnue ou absente — reçoit son dossier. Une liste
 * blanche des sources « qui y ont droit » se serait complétée en l'oubliant : c'est exactement
 * ce qui a produit le défaut d'origine.
 */
export function needsCompanionDossier(sourceType: string | null | undefined): boolean {
  return sourceType !== "PAYMENT_REQUEST";
}

/**
 * L'ÉTAT DU DOSSIER COMPAGNON, DÉDUIT DE L'ORDRE — jamais saisi.
 *
 * Le dossier n'a pas de vie propre : il décrit un ordre. Un ordre à régler est un dossier chez
 * les Finances (`SUBMITTED`) ; un ordre réglé est un dossier soldé (`APPROVED`) ; un ordre annulé
 * est un dossier annulé. Lui laisser un état indépendant garantissait la divergence — un dossier
 * « en cours » sous un paiement fait il y a six mois.
 */
export function companionStatusForOrder(orderStatus: string | null | undefined): "SUBMITTED" | "APPROVED" | "CANCELLED" {
  if (orderStatus === "PAID") return "APPROVED";
  if (orderStatus === "CANCELLED") return "CANCELLED";
  return "SUBMITTED";
}

/**
 * À QUI L'ARGENT VA — et le dossier exige une réponse (`payee` n'est pas nullable).
 *
 * Beaucoup d'ordres n'ont pas de bénéficiaire nommé : une avance sur salaire, un versement à une
 * autorité. Écrire « — » serait un faux ; on écrit ce qu'on sait, c'est-à-dire le libellé, qui
 * dit au moins de quoi il s'agit.
 */
export function companionPayee(beneficiary: string | null | undefined, label: string): string {
  const b = (beneficiary ?? "").trim();
  if (b) return b;
  const l = label.trim();
  return l || "Bénéficiaire non précisé";
}

/**
 * CE QUE LE DOSSIER DIT DE LUI-MÊME, en tête, avant qu'on cherche le bouton qui n'existe pas.
 *
 * Sans cette phrase, un comptable ouvre le dossier d'un matériel promotionnel, n'y trouve pas de
 * « bon à payer », et en conclut qu'il lui manque un droit. Le silence d'une interface se lit
 * toujours comme une panne.
 */
export function companionNotice(orderReference: string | null | undefined): string {
  const ref = (orderReference ?? "").trim();
  return `Ce dossier accompagne l'ordre de dépense${ref ? ` ${ref}` : ""} : il rassemble les pièces, les demandes de pièces et la discussion. Le paiement, lui, se décide au centre de paiement puis se règle aux Finances — pas ici.`;
}

/**
 * PEUT-ON TRANCHER DEPUIS LE DOSSIER ?
 *
 * Non sur un compagnon, et le refus NOMME l'endroit où la décision se prend. Un bouton grisé
 * sans explication envoie ouvrir un ticket ; une phrase envoie au bon écran.
 */
export function canDecideFromDossier(origin: string | null | undefined): { ok: boolean; reason?: string } {
  if (!isCompanionDossier(origin)) return { ok: true };
  return {
    ok: false,
    reason: "Ce paiement se décide au centre de paiement, puis se règle aux Finances — ce dossier en rassemble les pièces.",
  };
}

// ───────────────────────── La relance et l'urgence ─────────────────────────

/**
 * CE QUE LE DEMANDEUR PEUT FAIRE QUAND SA DEMANDE EST « CHEZ LES FINANCES ».
 *
 * Rien, jusqu'ici — et c'est le moment où il en a le plus besoin : son fournisseur rappelle, sa
 * quittance a une date, et l'écran ne lui offre qu'un statut à regarder. Il décrochait donc son
 * téléphone, et la relance n'existait nulle part : ni trace, ni file, ni preuve qu'elle a eu lieu.
 *
 * Deux gestes, et ils ne disent pas la même chose :
 *   • **RELANCER** — « où en est-on ? ». Le dossier remonte, personne n'est pris en faute.
 *   • **SIGNALER UNE URGENCE** — « ce paiement est devenu pressant, et voici pourquoi ». Il
 *     REMONTE la priorité du dossier, ce qui n'est pas gratuit : d'où le commentaire exigé.
 *
 * Les confondre en un seul bouton « relancer » aurait fait de chaque relance une urgence, et une
 * file où tout est urgent n'a plus de priorité du tout.
 */
export type NudgeKind = "REMINDER" | "URGENT";

export function nudgeKindOf(raw: string | null | undefined): NudgeKind {
  return raw === "URGENT" ? "URGENT" : "REMINDER";
}

export const NUDGE_LABEL: Record<NudgeKind, string> = {
  REMINDER: "Relance",
  URGENT: "Urgence de paiement signalée",
};

/**
 * LE DÉLAI DE COURTOISIE — on ne relance pas deux fois dans la même heure.
 *
 * Ce n'est pas une bride sur le demandeur : c'est ce qui empêche la relance de devenir du bruit.
 * Trois relances en cinq minutes ne font pas payer plus vite ; elles apprennent aux Finances à
 * ignorer la notification, et la quatrième — la vraie — passe inaperçue.
 */
export const NUDGE_COOLDOWN_MINUTES = 60;

export interface NudgeCheck {
  /** L'état du dossier — la relance n'a de sens que s'il est chez les Finances. */
  status: string;
  kind: NudgeKind;
  /** Le commentaire saisi. */
  comment: string | null | undefined;
  /** Quand la dernière relance de MÊME nature a été envoyée, s'il y en a eu une. */
  lastNudgeAt?: Date | string | null;
  now?: Date;
}

/**
 * Une urgence sans motif n'est pas une urgence : c'est une case cochée. Le motif est ce que les
 * Finances liront pour arbitrer entre deux dossiers pressants — et ce que le demandeur devra
 * assumer si les deux ne l'étaient pas.
 */
export function canNudge(input: NudgeCheck): { ok: boolean; reason?: string } {
  const chezFinances = input.status === "SUBMITTED" || input.status === "UNDER_REVIEW" || input.status === "ON_HOLD";
  if (!chezFinances) {
    return { ok: false, reason: "La relance n'a de sens que sur une demande en cours chez les Finances." };
  }
  const texte = (input.comment ?? "").trim();
  if (input.kind === "URGENT" && texte.length === 0) {
    return { ok: false, reason: "Dites pourquoi ce paiement est devenu urgent — c'est ce qui permet d'arbitrer entre deux dossiers pressants." };
  }
  const delai = refusDelaiDeCourtoisie(input.lastNudgeAt, input.now);
  if (delai) return { ok: false, reason: delai };
  return { ok: true };
}

/**
 * LE DÉLAI DE COURTOISIE, seul — lu par la relance du dossier (`canNudge`) ET par la relance unifiée d'un paiement
 * (`finance/relance-paiement.ts`, Direction 14/10) : une seule règle, un seul délai. Rend le refus, ou `null`.
 */
export function refusDelaiDeCourtoisie(lastAt: Date | string | null | undefined, now: Date = new Date()): string | null {
  if (!lastAt) return null;
  const last = lastAt instanceof Date ? lastAt : new Date(lastAt);
  if (Number.isNaN(last.getTime())) return null;
  const minutes = (now.getTime() - last.getTime()) / 60000;
  if (minutes >= NUDGE_COOLDOWN_MINUTES) return null;
  const reste = Math.max(1, Math.ceil(NUDGE_COOLDOWN_MINUTES - minutes));
  return `Vous avez déjà relancé il y a moins d'une heure — réessayez dans ${reste} min.`;
}

/** Le message porté par la notification, tel que les Finances le liront. */
export function nudgeMessage(kind: NudgeKind, reference: string, comment: string | null | undefined): string {
  const texte = (comment ?? "").trim();
  const tete = kind === "URGENT" ? `${reference} — paiement signalé URGENT` : `${reference} — relance du demandeur`;
  return texte ? `${tete} : ${texte}` : tete;
}
