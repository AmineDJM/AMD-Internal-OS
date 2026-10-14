/**
 * DEMANDER UNE PIÈCE À QUELQU'UN.
 *
 * La pièce qui manque n'est presque jamais chez celui qui en a besoin : la facture est chez le
 * commercial, le devis chez l'assistante, l'attestation chez le comptable. Sans mécanisme, on la
 * réclame par message — et l'on perd la trace de ce qu'on attend, de qui, et depuis quand.
 * Le dossier finit par bloquer sans que personne sache pourquoi.
 *
 * Ce module porte les RÈGLES : qui peut faire quoi, et dans quel ordre. Elles vivent ici et non
 * dans les boutons parce que « celui à qui on demande peut-il refuser ? » est une question de
 * règle — dispersée dans quatre écrans, elle finit par se contredire d'un écran à l'autre.
 *
 * Trois principes gouvernent tout :
 *
 *   1. **celui à qui l'on demande dépose, celui qui a demandé accepte.** Accepter sa propre
 *      pièce viderait la demande de son sens ;
 *   2. **un refus n'est pas une fin** : il rouvre la demande, avec son motif. C'est le cas le
 *      plus fréquent — ce n'était pas la bonne pièce — et il ne doit pas obliger à tout
 *      recommencer ;
 *   3. **une demande close le reste.** Sans quoi une pièce acceptée pourrait être « re-déposée »
 *      après coup, et l'on ne saurait plus laquelle a servi à la décision.
 *
 * Module PUR — testé.
 */

export type DocRequestState = "PENDING" | "SUBMITTED" | "ACCEPTED" | "DECLINED" | "CANCELLED";

export type DocRequestMove =
  /** Celui à qui l'on demande signale avoir déposé. */
  | "SUBMIT"
  /** Celui qui a demandé reconnaît la pièce reçue. */
  | "ACCEPT"
  /** Ce n'était pas la bonne pièce : on redemande, avec un motif. */
  | "DECLINE"
  /** On n'en a plus besoin. */
  | "CANCEL";

const MOVES: Record<DocRequestState, Partial<Record<DocRequestMove, DocRequestState>>> = {
  PENDING: { SUBMIT: "SUBMITTED", CANCEL: "CANCELLED" },
  SUBMITTED: { ACCEPT: "ACCEPTED", DECLINE: "DECLINED", CANCEL: "CANCELLED" },
  // Un refus RELANCE la demande : on redépose sans avoir à en créer une nouvelle, et l'historique
  // reste attaché au même fil.
  DECLINED: { SUBMIT: "SUBMITTED", CANCEL: "CANCELLED" },
  ACCEPTED: {},
  CANCELLED: {},
};

export function nextDocRequestStatus(from: string, move: DocRequestMove): DocRequestState | null {
  const table = MOVES[from as DocRequestState];
  return table ? table[move] ?? null : null;
}

export interface DocRequestActor {
  askedById: string;
  askedToId: string;
  status: string;
}

/**
 * Celui à qui l'on demande — lui seul dépose ; ou SON INTÉRIMAIRE, quand la demande le permet (`ouverteALInterim`) et
 * que l'appelant a établi l'intérim (`remplace` = `actsForUser(userId, askedToId)`).
 */
export function canSubmit(req: DocRequestActor, userId: string, remplace = false): boolean {
  return (req.askedToId === userId || remplace) && nextDocRequestStatus(req.status, "SUBMIT") !== null;
}

/**
 * UNE DEMANDE QUE L'INTÉRIMAIRE PEUT TENIR (audit Assistante de direction, 10/2026) : le BON DE COMMANDE d'un poste
 * Ad & Pro, demandé à une assistante NOMMÉE. Absente, la demande restait figée chez elle — le poste attendait son
 * BC trois semaines. Les autres demandes de pièce (une attestation, une pièce personnelle) restent à la personne.
 */
export function ouverteALInterim(req: { entityType: string; kind: string | null }): boolean {
  return req.entityType === "AD_PRO_ITEM" && req.kind === "PURCHASE_ORDER";
}

/** Les états d'une demande de BC qui peut encore changer d'assistante : la pièce n'est pas encore déposée. */
export const STATUTS_PIECE_REAFFECTABLES = ["PENDING", "DECLINED"] as const;

/**
 * POURQUOI LA DEMANDE NE CHANGE PAS D'ASSISTANTE — `null` si elle change (audit Assistante de direction, 10/2026).
 * Le BC d'un poste Ad & Pro, encore à déposer ; réaffecté par qui l'a demandé, la vue globale, ou l'assistante
 * sollicitée elle-même (et son intérimaire) qui le passe à une collègue.
 */
export function refusReaffectation(
  req: DocRequestActor & { entityType: string; kind: string | null },
  acteur: { id: string; vueGlobale: boolean; remplace: boolean },
  cibleId: string,
): string | null {
  if (!ouverteALInterim(req)) return "Seul le bon de commande d'un poste Ad & Pro change d'assistante.";
  if (!(STATUTS_PIECE_REAFFECTABLES as readonly string[]).includes(req.status)) {
    return req.status === "SUBMITTED" ? "Le bon de commande est déposé : il se vérifie, il ne change plus d'assistante." : "Cette demande est close.";
  }
  const peut = acteur.vueGlobale || req.askedById === acteur.id || req.askedToId === acteur.id || acteur.remplace;
  if (!peut) return "La demande change d'assistante par qui l'a faite, par l'assistante sollicitée ou par la Direction.";
  if (cibleId === req.askedToId) return "Cette assistante tient déjà la demande.";
  return null;
}

/**
 * Celui qui a demandé — lui seul tranche.
 *
 * Laisser le déposant accepter sa propre pièce viderait la demande de son sens : elle existe
 * précisément pour qu'un TIERS confirme avoir reçu ce qu'il attendait.
 */
export function canDecide(req: DocRequestActor, userId: string): boolean {
  return req.askedById === userId && nextDocRequestStatus(req.status, "ACCEPT") !== null;
}

/**
 * POURQUOI LA DEMANDE NE S'ANNULE PAS — `null` si elle s'annule (décision de la Direction, 04/10 :
 * « on annule sa demande tant que l'autre ne l'a pas exécutée »). Le DÉPÔT de la pièce par la personne
 * sollicitée VAUT exécution : une pièce déposée se juge — on l'accepte ou on la refuse —, elle ne
 * s'annule plus sous les yeux de celle qui vient de la fournir. Refusée (`DECLINED`), la balle revient
 * à la personne sollicitée et la demande s'annule de nouveau.
 */
export function refusAnnulationPiece(req: DocRequestActor, userId: string, vueGlobale = false): string | null {
  if (req.status === "SUBMITTED") return "La pièce est déposée : refusez-la ou acceptez-la — la demande ne s'annule plus.";
  if (nextDocRequestStatus(req.status, "CANCEL") === null) return "Cette demande est close : elle ne s'annule plus.";
  if (req.askedById !== userId && !vueGlobale) return "Annulation réservée à la personne qui a demandé.";
  return null;
}

/** Annuler : celui qui a demandé, tant que la pièce n'est ni déposée ni close. */
export function canCancel(req: DocRequestActor, userId: string): boolean {
  return refusAnnulationPiece(req, userId) === null;
}

/** Les états d'où une annulation s'écrit — l'écriture conditionnelle les relit. */
export const STATUTS_PIECE_ANNULABLES = ["PENDING", "DECLINED"] as const;

/** Une demande encore vivante — c'est ce qui bloque un dossier, et ce qu'il faut compter. */
export function isOutstanding(status: string): boolean {
  return status === "PENDING" || status === "SUBMITTED" || status === "DECLINED";
}

/** En retard : attendue, et la date est passée. Une pièce déjà déposée n'est plus en retard. */
export function isLate(req: { status: string; dueDate: Date | string | null }, now: Date = new Date()): boolean {
  if (req.status !== "PENDING" && req.status !== "DECLINED") return false;
  if (!req.dueDate) return false;
  const due = req.dueDate instanceof Date ? req.dueDate : new Date(req.dueDate);
  return !Number.isNaN(due.getTime()) && due < now;
}

/**
 * Ce que l'écran doit dire de l'état d'une demande — du point de vue de CELUI QUI REGARDE.
 *
 * « En attente de votre dépôt » et « En attente de leur dépôt » décrivent le même statut, mais
 * l'un appelle une action et l'autre non. Une seule phrase pour les deux obligerait chacun à
 * traduire.
 */
export function docRequestSummary(req: DocRequestActor, userId: string): string {
  const mine = req.askedToId === userId;
  switch (req.status) {
    case "PENDING": return mine ? "On attend votre dépôt" : "En attente du dépôt";
    case "SUBMITTED": return mine ? "Déposé — en attente de confirmation" : "Déposé — à confirmer";
    case "DECLINED": return mine ? "À redéposer" : "Refusé — redemandé";
    case "ACCEPTED": return "Pièce reçue";
    case "CANCELLED": return "Demande annulée";
    default: return "État inconnu";
  }
}
