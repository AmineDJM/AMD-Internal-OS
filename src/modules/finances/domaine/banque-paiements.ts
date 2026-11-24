import { jourAlger } from "./tresorerie";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BANQUE & PAIEMENTS — les règles de l'écran refait (Super Admin, 24/11/2026 — BanquePaiements.dc.html).
 *
 * Trois questions, une règle chacune, lues par l'écran ET par le serveur :
 *   • la SAISIE DU PAIEMENT (date, mode, référence) — `lireSaisieReglement` : un paiement ne se date pas dans le
 *     futur (l'argent n'est pas encore parti), son mode est l'un de ceux du livre, sa référence est facultative ;
 *   • l'ÉTAT D'UNE LIGNE DE L'HISTORIQUE — « Payé le … » ou « Annulé », jamais « Non payé » pour un ordre annulé ;
 *   • la QUESTION DES FINANCES au demandeur — `etatQuestion`, lue sur le fil du dossier (un seul fil, ses événements) :
 *     en attente du demandeur, réponse reçue (non lue), ou rien.
 *
 * Module PUR : il ne lit rien, l'appelant lui donne ce qu'il sait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ───────────────────────────── Les onglets ─────────────────────────────

export type VueBanque = "a-payer" | "reportes" | "payes";

/** `?vue=` → l'onglet ; tout autre texte ouvre « À payer », la file du jour. */
export function lireVueBanque(v: string | null | undefined): VueBanque {
  return v === "reportes" || v === "payes" ? v : "a-payer";
}

// ───────────────────────────── La saisie du paiement ─────────────────────────────

/** Les modes proposés au règlement — un sous-ensemble de l'enum du livre (`FinanceMethod`). */
export const MODES_REGLEMENT = [
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHEQUE", label: "Chèque" },
  { value: "CASH", label: "Espèces" },
] as const;
export type ModeReglement = (typeof MODES_REGLEMENT)[number]["value"];

/** Une référence de virement tient sur une ligne : au-delà, c'est un commentaire. */
export const REFERENCE_MAX = 80;

export interface SaisieReglement {
  /** L'instant écrit sur l'écriture et sur l'ordre. */
  date: Date;
  mode: ModeReglement;
  reference: string | null;
  /** Payé aujourd'hui (l'instant exact), ou un jour passé (midi UTC). */
  duJour: boolean;
}

/**
 * LA SAISIE DU PANNEAU « PAYER », jugée. Champs vides = les défauts (aujourd'hui, virement — espèces pour une
 * remise de caisse, que son écrivain sort toujours en liquide).
 *
 * La date du jour garde l'instant exact (`now`) ; un jour passé s'écrit à midi UTC — 13 h à Alger, le même jour
 * civil pour la trésorerie, qui compte les écritures par jour d'Alger (`jourAlger`).
 */
export function lireSaisieReglement(
  saisie: { date?: string | null; mode?: string | null; reference?: string | null },
  opts: { now?: Date; remise?: boolean } = {},
): { ok: true; saisie: SaisieReglement } | { ok: false; error: string } {
  const now = opts.now ?? new Date();
  const aujourdhui = jourAlger(now);
  const jour = (saisie.date ?? "").trim() || aujourdhui;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour) || Number.isNaN(new Date(`${jour}T12:00:00Z`).getTime())) {
    return { ok: false, error: "Date du paiement illisible : choisissez-la dans le calendrier." };
  }
  if (jour > aujourdhui) {
    return { ok: false, error: "La date du paiement ne peut pas être dans le futur : marquez-le payé le jour où l'argent part (ou reportez-le)." };
  }
  const brut = (saisie.mode ?? "").trim();
  const defaut: ModeReglement = opts.remise ? "CASH" : "BANK_TRANSFER";
  const mode = (brut || defaut) as ModeReglement;
  if (!MODES_REGLEMENT.some((m) => m.value === mode)) {
    return { ok: false, error: "Mode de paiement inconnu : choisissez virement, chèque ou espèces." };
  }
  const reference = (saisie.reference ?? "").trim() || null;
  if (reference && reference.length > REFERENCE_MAX) {
    return { ok: false, error: `Référence trop longue (${REFERENCE_MAX} caractères au plus) : gardez le numéro du virement ou du chèque.` };
  }
  const date = jour === aujourdhui ? now : new Date(`${jour}T12:00:00Z`);
  return { ok: true, saisie: { date, mode, reference, duJour: jour === aujourdhui } };
}

/** La référence, telle qu'elle s'écrit dans les notes de l'écriture (la colonne « Réf. facture » est celle de la facture). */
export function noteDeReference(reference: string | null): string | null {
  return reference ? `Référence du paiement : ${reference}` : null;
}

// ───────────────────────────── L'historique ─────────────────────────────

/** « 2026-11-18 » → « 18/11/2026 ». */
export function jourFr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [a, m, j] = iso.slice(0, 10).split("-");
  return `${j}/${m}/${a}`;
}

/** L'état d'une ligne de « Payés » : un ordre ANNULÉ dit « Annulé » — « Non payé » laissait croire qu'il restait dû. */
export function etatHistorique(o: { status: string; paidDate: Date | string | null }): string {
  if (o.status === "CANCELLED") return "Annulé";
  if (o.status === "PAID") {
    const d = o.paidDate ? (o.paidDate instanceof Date ? o.paidDate : new Date(o.paidDate)) : null;
    return d && !Number.isNaN(d.getTime()) ? `Payé le ${jourFr(jourAlger(d))}` : "Payé";
  }
  return "Non payé";
}

// ───────────────────────────── La question des Finances au demandeur ─────────────────────────────

/** Les événements du fil du dossier que la question écrit (`PaymentRequestEvent.kind`). */
export const EVT_QUESTION = "QUESTION_FINANCES";
export const EVT_REPONSE = "REPONSE_FINANCES";
export const EVT_RAPPEL = "RAPPEL_QUESTION";
export const EVT_REPONSE_LUE = "REPONSE_LUE";

/** Le délai avant le rappel automatique au demandeur, en jours (`FINANCES_RAPPEL_QUESTION_JOURS`, 3 par défaut). */
export function joursAvantRappel(brut: string | null | undefined): number {
  const n = Number(brut);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.floor(n) : 3;
}

export interface EvenementFil {
  kind: string;
  actorId: string | null;
  at: Date;
}

export type EtatQuestion = "EN_ATTENTE_DEMANDEUR" | "REPONSE_RECUE";

export interface LectureQuestion {
  etat: EtatQuestion | null;
  /** La dernière question posée, quand il y en a une. */
  questionLe: Date | null;
  /** Qui l'a posée — celui qu'on prévient de la réponse. */
  questionPar: string | null;
  /** Le dernier signe des Finances (question ou rappel) : le rappel automatique part N jours après. */
  dernierSigne: Date | null;
}

/**
 * OÙ EN EST LA QUESTION — lue sur le fil, sans colonne de plus.
 *
 * La réponse est un message du DEMANDEUR (réponse ou message libre) postérieur à la dernière question ; « lue » est
 * l'ouverture du panneau par les Finances après cette réponse. Une nouvelle question rouvre l'attente.
 */
export function etatQuestion(events: readonly EvenementFil[], demandeurId: string | null): LectureQuestion {
  const tri = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  let question: EvenementFil | null = null;
  for (const e of tri) if (e.kind === EVT_QUESTION) question = e;
  if (!question) return { etat: null, questionLe: null, questionPar: null, dernierSigne: null };
  const q = question;
  const apres = tri.filter((e) => e.at.getTime() > q.at.getTime());
  const reponse = apres.find((e) => (e.kind === EVT_REPONSE || e.kind === "COMMENT") && e.actorId !== null && e.actorId === demandeurId);
  const rappels = apres.filter((e) => e.kind === EVT_RAPPEL);
  const dernierSigne = rappels.length > 0 ? rappels[rappels.length - 1].at : q.at;
  const base = { questionLe: q.at, questionPar: q.actorId, dernierSigne };
  if (!reponse) return { etat: "EN_ATTENTE_DEMANDEUR", ...base };
  const lue = apres.some((e) => e.kind === EVT_REPONSE_LUE && e.at.getTime() >= reponse.at.getTime());
  return { etat: lue ? null : "REPONSE_RECUE", ...base };
}

/** Le rappel automatique est-il dû ? La question attend, et le dernier signe date de N jours ou plus. */
export function rappelDu(l: LectureQuestion, jours: number, now: Date = new Date()): boolean {
  if (l.etat !== "EN_ATTENTE_DEMANDEUR" || !l.dernierSigne) return false;
  return now.getTime() - l.dernierSigne.getTime() >= jours * 86_400_000;
}

/** Un rappel manuel des Finances : un par jour, sinon c'est une sonnerie. */
export function refusRappelManuel(l: LectureQuestion, now: Date = new Date()): string | null {
  if (l.etat !== "EN_ATTENTE_DEMANDEUR") return "Aucune question n'attend de réponse sur ce paiement : posez-en une d'abord.";
  if (l.dernierSigne && now.getTime() - l.dernierSigne.getTime() < 86_400_000) {
    return "Le demandeur a été sollicité il y a moins de 24 heures : laissez-lui le temps de répondre.";
  }
  return null;
}

// ───────────────────────────── Les relances du demandeur ─────────────────────────────

/** « Relancé 2 fois — dernière relance le 23/11/2026 », ou rien. */
export function phraseRelances(relances: readonly Date[]): string | null {
  if (relances.length === 0) return null;
  const derniere = relances.reduce((m, d) => (d > m ? d : m), relances[0]);
  return `Relancé ${relances.length} fois par le demandeur — dernière relance le ${jourFr(jourAlger(derniere))}`;
}
