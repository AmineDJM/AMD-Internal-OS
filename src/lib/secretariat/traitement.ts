/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TRAITEMENT D'UNE DEMANDE AU SECRÉTARIAT — DEUX GESTES (Direction, 10/2026).
 *
 * « Une nouvelle demande va directement à l'assistante de direction. Elle n'a que deux gestes :
 * Commencer le traitement, et Fin du traitement. » Les étapes intermédiaires posées à la main
 * (en attente d'un tiers, d'un document, bloquée), les validations demandées depuis la fiche, les
 * missions chauffeur et la demande multiple sont retirées.
 *
 * CE QUI N'EST PAS RÉÉCRIT : les valeurs restent dans l'énumération Prisma. Une demande déjà posée
 * dans un statut retiré se LIT « En cours » (`statutAffiche`) et se termine par « Fin du
 * traitement » — l'action accepte toute demande ouverte. Une demande « Mission chauffeur » déjà
 * posée se lit, en lecture seule ; on n'en crée plus.
 *
 * Module PUR (aucun import) : l'action, la page serveur et le tableau client lisent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les types qu'on ne crée plus — gardés pour RELIRE les demandes déjà posées. */
export const TYPES_RETIRES: readonly string[] = ["DRIVER", "HR_SIMPLE"];

export function typeRetire(type: string): boolean {
  return TYPES_RETIRES.includes(type);
}

/** Les statuts intermédiaires qu'on ne pose plus : une demande qui les porte se lit « En cours ». */
const INTERMEDIAIRES_RETIRES: readonly string[] = ["AWAITING_EXTERNAL", "AWAITING_DOCUMENT"];

/**
 * Le statut tel qu'on l'AFFICHE. Un blocage posé à la main (il porte son motif) était une étape
 * intermédiaire : il se lit « En cours ». Le refus d'un validateur (sans motif de blocage) reste
 * « Bloquée » — c'est une décision, pas une étape du traitement.
 */
export function statutAffiche(status: string, blockedReason?: string | null): string {
  if (INTERMEDIAIRES_RETIRES.includes(status)) return "IN_PROGRESS";
  if (status === "BLOCKED" && blockedReason) return "IN_PROGRESS";
  return status;
}

/** Où en est la demande, et chez qui — `null` quand le statut se suffit. */
export function chezQui(statut: string): string | null {
  if (statut === "NEW" || statut === "IN_PROGRESS") return "chez l'assistante de direction";
  return null;
}

/** Les statuts proposés au filtre du tableau (ceux qu'on peut encore lire). */
export const STATUTS_FILTRABLES: readonly string[] = [
  "NEW", "IN_PROGRESS", "AWAITING_VALIDATION", "AWAITING_PAYMENT", "BLOCKED", "DONE", "CANCELLED",
];

/**
 * Les deux gestes de l'assistante, selon l'état. « Fin » suit « Commencer ». Une demande passée
 * « en cours » sans avoir été commencée (l'accord d'un N+1 la remet en cours) se commence encore.
 */
export function gestesDuTraitement(status: string, commencee: boolean): { commencer: boolean; terminer: boolean } {
  if (status === "DONE" || status === "CANCELLED") return { commencer: false, terminer: false };
  const commencer = status === "NEW" || (status === "IN_PROGRESS" && !commencee);
  return { commencer, terminer: !commencer };
}

/** Les participants ajoutés par le demandeur (`fields.participantIds`), sans doublon. */
export function lireParticipants(fields: unknown): string[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  const v = (fields as Record<string, unknown>).participantIds;
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))];
}

/**
 * « FIN DU TRAITEMENT » APRÈS UNE DÉCISION (audit 14/10/2026). La DERNIÈRE approbation de la demande dit si l'achat
 * est autorisé :
 *   • EN ATTENTE — on n'achète pas avant la réponse ;
 *   • REFUSÉE — la demande est close par le refus : elle s'ANNULE, elle ne se termine pas (un achat refusé se
 *     terminait, et son montant s'imputait au budget d'un département) ;
 *   • MODIFICATION DEMANDÉE — le demandeur corrige, et sa correction repart chez le même validateur
 *     (`editOwnRequest`) : terminer avant reviendrait à acheter sans nouvelle validation.
 * `null` : rien n'empêche de terminer (aucune approbation, ou la dernière est accordée).
 */
export function refusFinApresDecision(derniere: { status: string } | null): string | null {
  if (!derniere) return null;
  if (derniere.status === "PENDING") return "Une validation est en attente sur cette demande : attendez la réponse avant de terminer.";
  if (derniere.status === "REJECTED") return "Cette demande a été refusée par son validateur : elle ne se termine pas, elle s'annule (« Annuler la demande », avec le motif).";
  if (derniere.status === "CHANGES_REQUESTED") return "Le validateur a demandé une modification : le demandeur corrige sa demande, qui repart chez lui. Elle se termine une fois validée.";
  return null;
}

/**
 * Une demande de devis de matériel promotionnel se termine quand la RETRANSCRIPTION est faite (audit 14/10/2026) :
 * « Fin » fermait la demande alors que le dossier attendait toujours ses devis (« devis demandés »).
 */
export function refusFinDevisPromo(etatDuDossier: string | null): string | null {
  if (etatDuDossier !== "QUOTE_REQUESTED") return null;
  return "Le dossier de matériel promotionnel attend toujours ses devis : retranscrivez-les et cliquez « Retranscription terminée » sur le dossier — la demande se clôt alors d'elle-même.";
}
