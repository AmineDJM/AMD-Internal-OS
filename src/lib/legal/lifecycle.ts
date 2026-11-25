/**
 * LE CYCLE DE VIE D'UN ENGAGEMENT — contrat, bon de commande, assurance, bail.
 *
 * Trois règles, et une seule question derrière : **qu'est-ce qui va me tomber dessus ?**
 *
 *   1. UN DOCUMENT PEUT N'AVOIR AUCUNE DATE. Des statuts, une police à tacite reconduction, un
 *      accord-cadre sans terme : ils n'expirent jamais et ne doivent JAMAIS déclencher de
 *      rappel. Traiter « pas de date » comme « échéance inconnue » produit une alerte perpétuelle
 *      que tout le monde apprend à ignorer — et c'est ainsi qu'on rate la vraie.
 *   2. UN DOCUMENT ANNULÉ OU RENOUVELÉ NE RAPPELLE PLUS. Son échéance existe encore, mais elle ne
 *      concerne plus personne : la suite vit ailleurs (le renouvellement) ou nulle part.
 *   3. LE RAPPEL EST GRADUÉ. À trois mois on prévoit, à un mois on agit, le jour même c'est
 *      urgent, après c'est un problème. Un seuil unique ne sait dire que « bientôt ».
 *   4. UN ENGAGEMENT PONCTUEL SE TERMINE, IL N'ÉCHOIT PAS (Super Admin, 25/11/2026). Une convention
 *      d'orateur d'un jour, une prestation d'une semaine : sa date de fin passée, il est « Terminé »
 *      (gris), sans rappel, sans ligne dans « Aujourd'hui », sans « dépassée » — il n'y a rien à
 *      renouveler. Seuls les engagements DURABLES alertent (avant leur fin, puis l'oubli).
 *
 * Module PUR — testé, sans base ni date « maintenant » implicite : `today` est toujours passé en
 * paramètre, sinon les tests dépendraient du jour où on les lance.
 */

export type LegalStatus = "ACTIVE" | "EXPIRED" | "RENEWED" | "CANCELLED";

/** L'urgence d'une échéance, du plus lointain au plus grave. */
export type ExpiryLevel = "NONE" | "SCHEDULED" | "SOON" | "IMMINENT" | "OVERDUE";

/** Seuils de rappel, en jours avant l'échéance. */
export const REMIND_SOON_DAYS = 90; // on prévoit
export const REMIND_IMMINENT_DAYS = 30; // on agit

const DAY_MS = 86_400_000;

/** Nombre de jours entiers entre deux dates (négatif si la seconde est passée). */
export function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / DAY_MS);
}

export interface LegalDocLike {
  status: LegalStatus;
  /** `null` = SANS ÉCHÉANCE — le document ne se périme pas. */
  endDate: Date | null;
  /**
   * Le début — il dit la DURÉE, donc si l'engagement est ponctuel (`estPonctuel`). Absent ou `null` : durée inconnue,
   * l'engagement est traité comme durable (on ne tait pas une alerte faute de date).
   */
  startDate?: Date | null;
}

/** Au-delà de cette durée (fin − début, en jours), un engagement est DURABLE ; jusque-là, PONCTUEL. */
export const DUREE_PONCTUELLE_MAX_JOURS = 31;

/**
 * UN ENGAGEMENT PONCTUEL — début et fin connus, au plus `DUREE_PONCTUELLE_MAX_JOURS` d'écart (une convention d'un jour :
 * début = fin). Sans début, on ne sait pas : durable.
 */
export function estPonctuel(doc: Pick<LegalDocLike, "startDate" | "endDate">): boolean {
  if (!doc.startDate || !doc.endDate) return false;
  const duree = daysBetween(doc.startDate, doc.endDate);
  return duree >= 0 && duree <= DUREE_PONCTUELLE_MAX_JOURS;
}

/**
 * TERMINÉ — un engagement ponctuel dont la date de fin est passée, ni annulé ni renouvelé. Il ne rappelle plus rien et ne
 * compte pas parmi les échus : il a simplement eu lieu.
 */
export function estTermine(doc: LegalDocLike, today: Date): boolean {
  if (!doc.endDate || doc.status === "CANCELLED" || doc.status === "RENEWED") return false;
  return estPonctuel(doc) && daysBetween(today, doc.endDate) < 0;
}

/**
 * À quel point l'échéance presse-t-elle, aujourd'hui ?
 *
 * `NONE` couvre les cas où il n'y a rien à dire : pas de date de fin, document déjà sorti du jeu
 * (annulé, renouvelé), ou engagement ponctuel terminé (`estTermine`). Les distinguer ici
 * n'apporterait rien — dans tous les cas, on ne rappelle pas.
 */
export function expiryLevel(doc: LegalDocLike, today: Date): ExpiryLevel {
  if (!doc.endDate) return "NONE";
  if (doc.status === "CANCELLED" || doc.status === "RENEWED") return "NONE";
  if (estTermine(doc, today)) return "NONE";
  const days = daysBetween(today, doc.endDate);
  if (days < 0) return "OVERDUE";
  if (days <= REMIND_IMMINENT_DAYS) return "IMMINENT";
  if (days <= REMIND_SOON_DAYS) return "SOON";
  return "SCHEDULED";
}

/** Jours restants avant l'échéance ; `null` quand il n'y en a pas. */
export function daysLeft(doc: LegalDocLike, today: Date): number | null {
  return doc.endDate ? daysBetween(today, doc.endDate) : null;
}

/**
 * Le statut EFFECTIF, échéance comprise.
 *
 * Un contrat dont le terme est passé est expiré, même si personne n'a rouvert la fiche pour le
 * dire. On ne l'écrit pas en base à la lecture (ce serait une écriture furtive) : on le CALCULE,
 * et un balayage périodique aligne la base quand il passe. Un engagement ponctuel terminé est EXPIRED en base aussi :
 * c'est son AFFICHAGE qui diffère (`statutLegalAffiche`).
 */
export function effectiveStatus(doc: LegalDocLike, today: Date): LegalStatus {
  if (doc.status === "CANCELLED" || doc.status === "RENEWED") return doc.status;
  return expiryLevel(doc, today) === "OVERDUE" || estTermine(doc, today) ? "EXPIRED" : doc.status;
}

/** Le statut tel que l'écran le montre : celui du calendrier, et « Terminé » (gris) pour un ponctuel arrivé à sa fin. */
export type StatutLegalAffiche = LegalStatus | "TERMINE";

export function statutLegalAffiche(doc: LegalDocLike, today: Date): StatutLegalAffiche {
  return estTermine(doc, today) ? "TERMINE" : effectiveStatus(doc, today);
}

/**
 * Faut-il rappeler cette échéance aujourd'hui ?
 *
 * On rappelle à l'entrée dans une zone (90 j, puis 30 j, puis le dépassement) et pas tous les
 * jours : `lastRemindedAt` retient le dernier envoi, et l'on ne renvoie que si le NIVEAU a
 * changé depuis. Sans cela, une échéance à trois mois produit quatre-vingt-dix notifications et
 * la personne coupe les notifications — pas seulement celle-ci, toutes.
 */
export function shouldRemind(
  doc: LegalDocLike & { lastRemindedAt: Date | null },
  today: Date,
): boolean {
  const level = expiryLevel(doc, today);
  if (level === "NONE" || level === "SCHEDULED") return false;
  if (!doc.lastRemindedAt) return true;
  // Même niveau qu'au dernier rappel → déjà dit.
  return expiryLevel(doc, doc.lastRemindedAt) !== level;
}

/**
 * CE QUE DIT LE RAPPEL — le titre et le corps de la notification.
 *
 * Le titre doit se suffire à lui-même : il est lu dans une cloche, et sur un téléphone verrouillé
 * où il n'y a que lui. « Échéance proche » ne dit ni quoi, ni quand, ni s'il faut se lever de sa
 * chaise. Le NOMBRE DE JOURS y figure donc toujours, et le dépassement est nommé pour ce qu'il
 * est : un engagement qui court peut-être encore sans couverture.
 */
export function expiryMessage(
  level: ExpiryLevel,
  days: number | null,
  title: string,
): { title: string; body: string } | null {
  if (level === "NONE" || level === "SCHEDULED" || days === null) return null;
  const name = title.trim() || "Document sans titre";
  if (level === "OVERDUE") {
    const late = Math.abs(days);
    return {
      title: `Échéance DÉPASSÉE depuis ${late} jour${late > 1 ? "s" : ""}`,
      body: `« ${name} » est arrivé à terme. Renouvelez-le, ou clôturez-le s'il n'a plus lieu d'être.`,
    };
  }
  const when = days === 0 ? "aujourd'hui" : days === 1 ? "demain" : `dans ${days} jours`;
  return {
    title: level === "IMMINENT" ? `Échéance ${when}` : `Échéance ${when} — à préparer`,
    body: `« ${name} » arrive à terme ${when}.`,
  };
}

/** Peut-on encore renouveler / annuler ce document ? Une fois sorti du jeu, non. */
export function canRenew(status: LegalStatus): boolean {
  return status === "ACTIVE" || status === "EXPIRED";
}
export function canCancel(status: LegalStatus): boolean {
  return status === "ACTIVE" || status === "EXPIRED";
}

/**
 * RÉTABLIR un document annulé (audit 360°, L04) : l'annulation n'avait aucun retour, alors qu'elle se
 * déclenchait jusqu'ici sur un simple geste d'abandon. Un document rétabli reprend l'état que sa date
 * de fin lui donne — en vigueur, ou arrivé à terme —, jamais un état qu'aucune date ne dit.
 */
export function canRestore(status: LegalStatus): boolean {
  return status === "CANCELLED";
}
export function statutRetabli(endDate: Date | null, now: Date = new Date()): "ACTIVE" | "EXPIRED" {
  return endDate && endDate.getTime() < now.getTime() ? "EXPIRED" : "ACTIVE";
}

/**
 * Les dates d'un renouvellement, proposées à partir de l'ancien document.
 *
 * Le nouveau départ est le LENDEMAIN du terme précédent (pas le jour même : on ne veut pas deux
 * contrats en vigueur le même jour), et la durée reconduite est celle qu'on avait — c'est ce que
 * les gens font à la main, en se trompant d'un jour une fois sur trois.
 */
export function proposeRenewalDates(
  previous: { startDate: Date | null; endDate: Date | null },
): { startDate: Date | null; endDate: Date | null } {
  if (!previous.endDate) return { startDate: null, endDate: null };
  const start = new Date(previous.endDate.getTime() + DAY_MS);
  if (!previous.startDate) return { startDate: start, endDate: null };
  const span = daysBetween(previous.startDate, previous.endDate);
  return { startDate: start, endDate: new Date(start.getTime() + span * DAY_MS) };
}

/** Contrôle des dates avant écriture : un terme AVANT le début n'est pas une faute de frappe rare. */
export function validateDates(
  startDate: Date | null,
  endDate: Date | null,
): { ok: true } | { ok: false; error: string } {
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    return { ok: false, error: "La date de fin est antérieure à la date de début." };
  }
  return { ok: true };
}
