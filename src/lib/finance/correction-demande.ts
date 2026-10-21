/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CORRIGER SA DEMANDE DE PAIEMENT (§118.191 — audit 360°, R04).
 *
 * Mesuré par l'audit : le montant, le bénéficiaire et l'objet d'une demande de paiement ne se
 * corrigeaient JAMAIS — pas même en brouillon. `updatePaymentRequestDetails` ne réécrivait que le
 * moyen de paiement et le contact. Une faute de frappe sur le montant ne laissait que deux issues :
 * transmettre un chiffre faux, ou retirer la demande et tout ressaisir, pièces comprises. Et quand les
 * Finances renvoyaient un dossier parce que « la facture dit 450 000, la demande 500 000 », le
 * demandeur recevait un renvoi qu'il ne pouvait pas honorer.
 *
 * ── QUAND ──────────────────────────────────────────────────────────────────────────────────
 *
 * Tant que le dossier est CHEZ LE DEMANDEUR — brouillon, ou renvoyé pour correction. Chez les
 * Finances, il ne bouge pas sous leurs yeux : elles examinent des pièces contre un montant, et le
 * changer pendant qu'elles lisent leur ferait accorder un bon à payer sur un chiffre qu'elles n'ont
 * pas vu. Le chemin y existe : elles le renvoient, il se corrige, il repart.
 *
 * ── CE QUI NE SE CORRIGE PAS ICI ───────────────────────────────────────────────────────────
 *
 *   • un dossier COMPAGNON — il accompagne un ordre né ailleurs (congrès, poste, bon de versement) :
 *     son montant et son bénéficiaire se corrigent dans son circuit d'origine, qui fait suivre ;
 *   • un dossier clos ;
 *   • un paiement déjà RÉGLÉ — l'argent est parti ;
 *   • un paiement REFUSÉ par le centre — corriger le chiffre ne lève pas un refus, et la phrase du
 *     centre le dit déjà : un refus se reprend par une nouvelle demande, corrigée ;
 *   • l'ENTITÉ et l'URGENCE après transmission : la première décide de la file et de la société qui
 *     paie (elle se choisit avant d'engager) ; la seconde se relève par « Signaler une urgence », avec
 *     son motif, que les Finances lisent pour arbitrer — la changer d'ici contournerait ce motif.
 *
 * Module PUR — l'action et l'écran lisent la même règle : un bouton offert à qui l'action refusera
 * fait chercher une panne qui n'existe pas (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les champs que la correction réécrit — et elle seule. */
export type ChampCorrigeable =
  | "title" | "payee" | "amount" | "description" | "dueDate" | "deadlineNature" | "urgency" | "companyId";

/** Ce qui ne se corrige qu'avant la PREMIÈRE transmission. */
export const CHAMPS_DU_BROUILLON: readonly ChampCorrigeable[] = ["companyId", "urgency"];

const CLOS = new Set(["APPROVED", "REJECTED", "CANCELLED"]);
const CHEZ_LE_DEMANDEUR = new Set(["DRAFT", "CHANGES_REQUESTED"]);

export interface EtatPourCorrection {
  /** Le statut du dossier (`PaymentRequestStatus`). */
  status: string;
  /** Le dossier accompagne-t-il un ordre né dans un autre circuit ? (`isCompanionDossier`) */
  compagnon: boolean;
  /** L'ordre de dépense derrière le dossier, s'il existe déjà. */
  ordre?: { status: string; centralStatus: string } | null;
}

/**
 * Pourquoi la demande ne peut PAS être corrigée maintenant — `null` si elle le peut.
 *
 * L'ordre des refus est celui de l'état (§118.18) : la nature du dossier, puis sa place dans le
 * circuit, puis l'argent. Chacun nomme le geste qui reste.
 */
export function refusDeCorrection(e: EtatPourCorrection): string | null {
  if (e.compagnon) {
    return "Ce dossier accompagne un ordre de dépense né dans un autre circuit : son montant et son bénéficiaire se corrigent là-bas, et le paiement suit.";
  }
  if (CLOS.has(e.status)) return "Ce dossier est clos : il ne se corrige plus.";
  if (!CHEZ_LE_DEMANDEUR.has(e.status)) {
    return "Le dossier est chez les Finances : il se corrige quand elles vous le renvoient. Écrivez-leur ce qui doit changer, ou retirez la demande.";
  }
  if (e.ordre?.status === "PAID") return "Ce paiement est déjà réglé : l'argent est parti, la demande ne se corrige plus. Si le montant était faux, voyez les Finances.";
  if (e.ordre?.centralStatus === "REFUSED") {
    return "Le centre de paiement a refusé ce paiement : corriger la demande ne lève pas un refus. Retirez-la et déposez-en une nouvelle, corrigée.";
  }
  return null;
}

/** Peut-on corriger CE champ à ce stade ? `null` si oui, sinon la raison. */
export function refusDuChamp(status: string, champ: ChampCorrigeable): string | null {
  if (status === "DRAFT" || !CHAMPS_DU_BROUILLON.includes(champ)) return null;
  return champ === "companyId"
    ? "L'entité ne change plus une fois la demande transmise : c'est la société qui paie, et sa file. Retirez la demande et déposez-la sous la bonne entité."
    : "L'urgence se relève par « Signaler une urgence », avec son motif — c'est lui que les Finances lisent pour arbitrer entre deux dossiers pressants.";
}

export interface ValeursDemande {
  title: string;
  payee: string;
  amount: number;
  description: string | null;
  /** `YYYY-MM-DD`, ou `null`. */
  dueDate: string | null;
  deadlineNature: string;
  urgency: string;
  companyId: string | null;
}

const LIBELLE: Record<ChampCorrigeable, string> = {
  title: "Objet",
  payee: "Bénéficiaire",
  amount: "Montant",
  description: "Contexte",
  dueDate: "Échéance",
  deadlineNature: "Nature de l'échéance",
  urgency: "Urgence",
  companyId: "Entité",
};

export interface Ecart { champ: ChampCorrigeable; libelle: string; avant: string; apres: string }

const ORDRE: readonly ChampCorrigeable[] = ["title", "payee", "amount", "description", "dueDate", "deadlineNature", "urgency", "companyId"];

const montant = (n: number) => `${n.toLocaleString("fr-FR")} DZD`;
const texte = (s: string | null) => (s && s.trim() ? `« ${s.trim()} »` : "—");

/**
 * CE QUI CHANGE, champ par champ, dans l'ordre où la fiche les montre — et rien de plus.
 *
 * `apres` ne porte que les champs que le formulaire ENVOIE (§118.152c) : un champ absent ne change
 * pas, il n'est pas « vidé ». Les libellés lisibles (`noms`) remplacent les identifiants et les codes
 * (entité, nature, urgence) — le fil se lit par des humains.
 */
export function ecartsDeCorrection(
  avant: ValeursDemande,
  apres: Partial<ValeursDemande>,
  noms: Partial<Record<ChampCorrigeable, (v: string | null) => string>> = {},
): Ecart[] {
  const out: Ecart[] = [];
  for (const champ of ORDRE) {
    const a = avant[champ];
    // Un champ ABSENT (ou laissé `undefined`) ne change pas — une seule garde pour les deux formes.
    const b = apres[champ] as ValeursDemande[typeof champ] | undefined;
    if (b === undefined) continue;
    const egal = champ === "amount" ? Number(a) === Number(b) : (a ?? null) === (b ?? null);
    if (egal) continue;
    const lire = (v: unknown): string => {
      if (champ === "amount") return montant(Number(v));
      const nom = noms[champ];
      if (nom) return nom((v as string | null) ?? null);
      return texte((v as string | null) ?? null);
    };
    out.push({ champ, libelle: LIBELLE[champ], avant: lire(a), apres: lire(b) });
  }
  return out;
}

/** La phrase du fil : ce qui a changé, puis pourquoi. */
export function phraseDeCorrection(ecarts: readonly Ecart[], motif: string | null): string {
  const quoi = ecarts.map((e) => `${e.libelle} : ${e.avant} → ${e.apres}`).join(" ; ");
  return motif ? `Demande corrigée — ${quoi}. Ce qui a changé : ${motif}` : `Demande corrigée — ${quoi}.`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RETIRER SA DEMANDE DE PAIEMENT TANT QUE L'ARGENT N'EST PAS PARTI (décision de la Direction, 04/10).
 *
 * « On peut annuler sa demande tant qu'elle n'a pas été exécutée par l'autre. » Pour un paiement,
 * l'exécution est le RÈGLEMENT, pas le bon à payer : une demande APPROUVÉE dont l'ordre n'est pas
 * réglé se retire encore — son ordre est annulé par l'écrivain commun (`annulerOrdreNonRegle`), et
 * le centre n'a plus rien à autoriser. Avant, `APPROVED` n'avait aucune transition : le demandeur
 * qui apprenait que la facture était fausse ne pouvait plus rien, et l'ordre partait.
 *
 * Une règle, deux lecteurs : l'action et le bouton de la fiche (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface EtatPourRetrait {
  status: string;
  compagnon: boolean;
  ordre?: { status: string } | null;
}

export const REFUS_RETRAIT_COMPAGNON =
  "Ce dossier accompagne un ordre de dépense : le retirer n'annulerait pas le paiement. Passez par le circuit d'origine.";

/** Pourquoi la demande ne se retire PAS — `null` si elle se retire. */
export function refusDeRetrait(e: EtatPourRetrait): string | null {
  if (e.compagnon) return REFUS_RETRAIT_COMPAGNON;
  if (e.status === "CANCELLED") return "Cette demande est déjà retirée.";
  if (e.status === "REJECTED") return "Cette demande a été refusée : il n'y a plus rien à retirer.";
  if (e.ordre?.status === "PAID") {
    return "Ce paiement est déjà réglé : l'argent est parti, la demande ne se retire plus. Si ce règlement est une erreur, voyez les Finances.";
  }
  return null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER DÉFINITIVEMENT UNE DEMANDE RETIRÉE (Direction, 19/10/2026).
 *
 * Retirée, la demande restait dans la liste de son demandeur pour toujours : rien ne l'en ôtait. Elle
 * se supprime désormais — par la corbeille commune (`supprimerReversible`, restaurable par le Super
 * Admin), avec son ordre de dépense annulé, ses pièces et son fil.
 *
 * Ce qui ne se supprime pas : un dossier encore VIVANT (on le retire d'abord — c'est le retrait qui
 * annule l'ordre au centre), un dossier COMPAGNON (il part avec la dépense qui l'a fait naître), et
 * tout dossier dont le paiement est SORTI — l'argent est parti, la demande en est la justification.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface EtatPourSuppression {
  status: string;
  compagnon: boolean;
  ordre?: { status: string; reference?: string | null; transactionId?: string | null; paidDate?: Date | string | null } | null;
}

/** Ce qui se supprime : le brouillon (jamais transmis) et la demande retirée. */
const SUPPRIMABLES = new Set(["DRAFT", "CANCELLED"]);

/** Pourquoi la demande ne se supprime PAS — `null` si elle se supprime. */
export function refusDeSuppression(e: EtatPourSuppression): string | null {
  if (e.compagnon) return "Ce dossier accompagne un ordre de dépense : il disparaît avec la dépense qui l'a fait naître, pas d'ici.";
  if (e.ordre && (e.ordre.status === "PAID" || e.ordre.transactionId || e.ordre.paidDate)) {
    return `Le paiement${e.ordre.reference ? ` ${e.ordre.reference}` : ""} est déjà sorti : la demande en est la justification, elle ne se supprime pas.`;
  }
  if (!SUPPRIMABLES.has(e.status)) {
    return e.status === "REJECTED"
      ? "Cette demande a été refusée par les Finances : elle reste, avec le motif du refus."
      : "Retirez d'abord la demande : c'est le retrait qui annule son paiement au centre. Elle se supprime ensuite.";
  }
  if (e.ordre && e.ordre.status !== "CANCELLED") {
    return "Son ordre de dépense est encore ouvert au centre de paiement : retirez la demande d'abord.";
  }
  return null;
}
