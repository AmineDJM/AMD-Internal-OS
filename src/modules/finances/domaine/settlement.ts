/**
 * LE RÈGLEMENT — trois états, et RIEN D'AUTRE.
 *
 * ── CE QU'ON RETIRE, ET POURQUOI ─────────────────────────────────────────────────────────────
 *
 * Les Finances disposaient, sur un ordre à régler, de quatre gestes : régler, ANNULER, DEMANDER
 * UNE RÉVISION DE BUDGET, et (côté Direction) trancher cette révision. Trois de ces gestes
 * défaisaient une décision déjà prise ailleurs : l'ordre arrive ici **autorisé par le centre de
 * paiement**, qui a vu le montant, la file entière et l'engagement. Le rouvrir au décaissement,
 * c'est donner le dernier mot à celui qui n'a que la caisse sous les yeux — et faire porter à
 * l'écran comptable un arbitrage qui appartient au centre.
 *
 * Il ne reste donc que la question du décaissement, qui n'a que trois réponses :
 *
 *   • `UNPAID`   — non payé. L'état par DÉFAUT : l'argent n'est pas sorti, il doit sortir.
 *   • `DEFERRED` — paiement reporté à une date. L'argent doit toujours sortir ; on dit quand.
 *   • `PAID`     — payé. L'écriture de trésorerie existe.
 *
 * ── POURQUOI « REPORTÉ » EST UNE DATE ET NON UN STATUT ───────────────────────────────────────
 *
 * Un statut `DEFERRED` obligerait quelqu'un à le remettre à « non payé » le jour venu. Ce
 * quelqu'un oublierait — c'est un travail de secrétariat, et un travail de secrétariat finit
 * toujours par être oublié (même raisonnement que `statusFromPieces`). Une DATE, elle, expire
 * seule : le 12 au matin, l'ordre reporté au 12 est de nouveau simplement dû, sans que personne
 * n'ait rien à faire. C'est la règle ci-dessous, et c'est tout ce qu'il y a à retenir.
 *
 * Un report n'est jamais un classement : il ne retire pas l'ordre de la file, il le date. Un
 * ordre reporté reste visible, compté et sommé — sans quoi « reporter » deviendrait le moyen
 * commode de faire disparaître ce qu'on ne veut pas payer.
 *
 * Module PUR — testé sans base.
 */

import { deadlineNatureOf, deferralNeedsReason } from "./deadline-nature";

export type SettlementState = "UNPAID" | "DEFERRED" | "PAID";

export const SETTLEMENT_LABEL: Record<SettlementState, string> = {
  UNPAID: "Non payé",
  DEFERRED: "Paiement reporté",
  PAID: "Payé",
};

export interface SettlementLike {
  /** Le statut de l'ordre en base — `PAID` fait foi, tout le reste est « pas encore payé ». */
  status: string;
  /** La date à laquelle le paiement a été reporté, quand il l'a été. */
  deferredUntil: Date | string | null;
}

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * L'ÉTAT RÉEL DU DÉCAISSEMENT, à cet instant.
 *
 * `now` est un paramètre et non `new Date()` figé : c'est ce qui rend l'expiration du report
 * vérifiable — et vérifiée.
 */
export function settlementState(order: SettlementLike, now: Date = new Date()): SettlementState {
  if (order.status === "PAID") return "PAID";
  const until = asDate(order.deferredUntil);
  // Un report ÉCHU n'est plus un report : la date est passée, l'ordre est dû. On ne nettoie rien
  // en base — la date reste, elle raconte qu'il y a eu un report et jusqu'à quand.
  if (until && until.getTime() > now.getTime()) return "DEFERRED";
  return "UNPAID";
}

/** Le report est-il encore en cours ? (Le contraire d'un report échu.) */
export function deferralIsActive(order: SettlementLike, now: Date = new Date()): boolean {
  return settlementState(order, now) === "DEFERRED";
}

export interface DeferralInput {
  /** L'ordre visé. */
  order: SettlementLike;
  /** La date saisie (au format d'un `<input type="date">`, ou une Date). */
  until: Date | string | null;
  /** Le motif saisi — obligatoire seulement quand l'échéance est fixe non négociable. */
  reason: string | null;
  /** La nature de l'échéance déclarée par le demandeur. */
  deadlineNature: string | null;
}

export interface DeferralCheck {
  ok: boolean;
  reason?: string;
  /** La date retenue, une fois validée. */
  until?: Date;
}

/**
 * PEUT-ON REPORTER, ET À QUELLE DATE ?
 *
 * Les refus sont motivés, jamais silencieux : un bouton grisé sans explication envoie ouvrir un
 * ticket.
 */
export function checkDeferral(input: DeferralInput, now: Date = new Date()): DeferralCheck {
  if (input.order.status === "PAID") return { ok: false, reason: "Cet ordre est déjà réglé." };
  const until = asDate(input.until);
  if (!until) return { ok: false, reason: "Indiquez la date à laquelle le paiement est reporté." };
  // Reporter au passé ne reporte rien : l'ordre serait immédiatement dû, et l'écran afficherait
  // « non payé » juste après avoir dit « reporté ». C'est le genre de contradiction qui fait
  // douter de tout l'écran.
  if (until.getTime() <= now.getTime()) {
    return { ok: false, reason: "La date de report doit être à venir — un report au passé ne reporte rien." };
  }
  const motif = (input.reason ?? "").trim();
  if (deferralNeedsReason(input.deadlineNature) && !motif) {
    return {
      ok: false,
      reason: "Le demandeur a déclaré cette échéance FIXE et non négociable : dites pourquoi elle est reportée. C'est ce qu'il devra expliquer au bénéficiaire.",
    };
  }
  return { ok: true, until };
}

/**
 * CE QUE L'ÉCRAN ÉCRIT SUR UN ORDRE REPORTÉ — ou `null` s'il n'y a rien à écrire.
 *
 * Un report échu se DIT lui aussi : « reporté au 3 septembre » sur un ordre qu'on croit encore
 * en pause, alors que la date est passée, est précisément ce qui fait qu'on ne le paie jamais.
 */
export function deferralNote(
  order: SettlementLike & { deferredReason?: string | null },
  formatDate: (d: Date) => string,
  now: Date = new Date(),
): string | null {
  const until = asDate(order.deferredUntil);
  if (!until || order.status === "PAID") return null;
  const motif = order.deferredReason ? ` — ${order.deferredReason}` : "";
  return until.getTime() > now.getTime()
    ? `Paiement reporté au ${formatDate(until)}${motif}`
    : `Report échu le ${formatDate(until)} : ce paiement est de nouveau dû${motif}`;
}

/**
 * L'ORDRE DE LA FILE À RÉGLER.
 *
 * Ce qui presse d'abord, et la question « qu'est-ce qui presse » n'a pas la même réponse selon
 * qu'un report a été posé : un ordre reporté au 20 n'a rien à faire au-dessus d'un ordre dû
 * aujourd'hui, même si son échéance d'origine était plus proche. On classe donc, dans l'ordre :
 *
 *   1. ce qui est DÛ avant ce qui est reporté ;
 *   2. la date qui compte — celle du report s'il y en a un, l'échéance sinon ;
 *   3. la NATURE de l'échéance : à date égale, le fixe non négociable passe devant ;
 *   4. l'ancienneté, pour que l'ordre soit stable.
 */
export interface SettlementSortable extends SettlementLike {
  dueDate: Date | string | null;
  deadlineNature: string | null;
  createdAt: Date | string;
}

export function sortForSettlement<T extends SettlementSortable>(rows: readonly T[], now: Date = new Date()): T[] {
  const key = (r: T): [number, number, number, number] => {
    const reporte = settlementState(r, now) === "DEFERRED";
    const date = reporte ? asDate(r.deferredUntil) : asDate(r.dueDate);
    return [
      reporte ? 1 : 0,
      date ? date.getTime() : Number.MAX_SAFE_INTEGER,
      deadlineNatureOf(r.deadlineNature) === "FIXED" ? 0 : deadlineNatureOf(r.deadlineNature) === "IMPORTANT" ? 1 : 2,
      asDate(r.createdAt)?.getTime() ?? 0,
    ];
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}
