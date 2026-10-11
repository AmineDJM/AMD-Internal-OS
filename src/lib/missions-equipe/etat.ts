import { RELANCE_DELAI_MS } from "@/lib/tasks/request-flow";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MISSIONS AD & PRO RELIÉES AU PROFIL (Direction, 10/2026) — les règles, PURES.
 *
 * Une assignation (accompagnant, délégué de référence) est une INVITATION : rien ne se demande avant
 * « Je confirme ». Une mission confirmée est une liste d'étapes où SEUL l'ordre de mission paraît
 * d'office — « ils ne sont pas obligés de demander transport, hôtellerie etc. : ça ne doit même pas
 * s'afficher tant qu'ils n'ont pas cliqué » (Direction). L'ordre de mission suit le circuit RH unique,
 * précédé de la marche du N+1 : « l'ordre de mission doit être validé par le N+1 avant d'arriver chez
 * les RH ».
 *
 * Module SANS IMPORT lourd : l'écran (client) et le serveur lisent les MÊMES règles, et un test les
 * joue sans base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ReponseMission = "INVITEE" | "CONFIRMEE" | "DECLINEE";
export type Ton = "neutral" | "info" | "success" | "warning" | "danger" | "purple";
export interface Etat { texte: string; ton: Ton }

// ─────────────────────────────── La réponse ───────────────────────────────

/** Qui peut répondre, et quoi : la personne invitée, une seule fois, et un refus porte son motif. */
export function refusReponse(
  a: { userId: string; response: ReponseMission; archivedAt: Date | string | null },
  userId: string,
  decision: "CONFIRMER" | "DECLINER",
  motif: string | null,
): string | null {
  if (a.archivedAt) return "Cette mission a été retirée par l'organisateur.";
  if (a.userId !== userId) return "Seule la personne invitée répond à l'invitation.";
  if (a.response === "CONFIRMEE" && decision === "CONFIRMER") return "Vous avez déjà confirmé cette mission.";
  if (a.response === "DECLINEE") return "Vous avez décliné cette mission : l'organisateur peut vous réinviter.";
  if (decision === "DECLINER" && !(motif ?? "").trim()) return "Dites pourquoi vous déclinez : l'organisateur doit pouvoir vous remplacer.";
  return null;
}

/** La réponse, lue par l'organisateur : « confirmée », « en attente — n j », « déclinée — motif ». */
export function etatReponse(
  a: { response: ReponseMission; createdAt: Date | string; declineReason: string | null },
  now: number = Date.now(),
): Etat {
  if (a.response === "CONFIRMEE") return { texte: "confirmée", ton: "success" };
  if (a.response === "DECLINEE") return { texte: a.declineReason ? `déclinée — « ${a.declineReason} »` : "déclinée", ton: "danger" };
  const jours = Math.max(0, Math.floor((now - new Date(a.createdAt).getTime()) / 86_400_000));
  return { texte: jours > 0 ? `en attente — ${jours} j` : "en attente", ton: "warning" };
}

/**
 * RELANCER une invitation — la règle des tâches : quatre heures depuis l'invitation ou la dernière
 * relance. Seule une invitation sans réponse se relance.
 */
export function peutRelancerInvitation(
  a: { response: ReponseMission; createdAt: Date | string; lastNudgeAt: Date | string | null; archivedAt: Date | string | null },
  now: number = Date.now(),
): { ok: true } | { ok: false; raison: string } {
  if (a.archivedAt) return { ok: false, raison: "Cette mission a été retirée." };
  if (a.response !== "INVITEE") return { ok: false, raison: "La personne a déjà répondu." };
  const base = Math.max(new Date(a.createdAt).getTime(), a.lastNudgeAt ? new Date(a.lastNudgeAt).getTime() : 0);
  const prochaine = base + RELANCE_DELAI_MS;
  if (now < prochaine) {
    const heures = Math.max(1, Math.ceil((prochaine - now) / 3_600_000));
    return { ok: false, raison: `Trop tôt : vous pourrez relancer dans ${heures} h.` };
  }
  return { ok: true };
}

/** Une assignation se RETIRE en l'archivant dès qu'elle porte une trace (pièce, fil, demande) ; sinon elle s'efface. */
export function retraitSouple(traces: { documents: number; commentaires: number; demandes: number }): boolean {
  return traces.documents + traces.commentaires + traces.demandes > 0;
}

// ─────────────────────────────── Les étapes ───────────────────────────────

export const ETAPES_FACULTATIVES = ["TRANSPORT", "HEBERGEMENT", "MATERIEL", "NOTE_FRAIS"] as const;
export type EtapeFacultative = (typeof ETAPES_FACULTATIVES)[number];

export const LIBELLE_ETAPE: Record<EtapeFacultative, string> = {
  TRANSPORT: "Transport",
  HEBERGEMENT: "Hébergement",
  MATERIEL: "Matériel promotionnel",
  NOTE_FRAIS: "Note de frais",
};

/**
 * Le SOUS-TYPE posé sur la demande au secrétariat (TRAVEL) d'une mission : c'est lui qui dit, en clair
 * sur la fiche du secrétariat comme ici, si la demande est le transport ou l'hébergement.
 */
export const SOUS_TYPE_SECRETARIAT: Record<"TRANSPORT" | "HEBERGEMENT", string> = {
  TRANSPORT: "Transport — mission Ad & Pro",
  HEBERGEMENT: "Hébergement — mission Ad & Pro",
};

export function estEtapeFacultative(v: string | null | undefined): v is EtapeFacultative {
  return v != null && (ETAPES_FACULTATIVES as readonly string[]).includes(v);
}

/**
 * LES ÉTAPES À L'ÉCRAN : l'ordre de mission toujours ; une étape facultative SEULEMENT si la personne
 * l'a ajoutée — ou si une demande y est déjà liée (on ne cache pas ce qui est parti). Ordre fixe.
 */
export function etapesVisibles(ajoutees: readonly string[], liees: readonly EtapeFacultative[] = []): EtapeFacultative[] {
  const vues = new Set<string>([...ajoutees, ...liees]);
  return ETAPES_FACULTATIVES.filter((e) => vues.has(e));
}

/** Ce que le menu « ⋯ › Ajouter » propose encore. */
export function etapesAAjouter(ajoutees: readonly string[], liees: readonly EtapeFacultative[] = []): EtapeFacultative[] {
  const vues = new Set(etapesVisibles(ajoutees, liees));
  return ETAPES_FACULTATIVES.filter((e) => !vues.has(e));
}

/** On n'ajoute une étape qu'à une mission CONFIRMÉE et active. */
export function refusAjoutEtape(a: { response: ReponseMission; archivedAt: Date | string | null }, etape: string | null): string | null {
  if (a.archivedAt) return "Cette mission a été retirée.";
  if (a.response !== "CONFIRMEE") return "Confirmez d'abord la mission.";
  if (!estEtapeFacultative(etape)) return "Étape inconnue.";
  return null;
}

/** La note de frais vient APRÈS la mission : le jour du retour (ou du départ, à défaut), pas avant. */
export function noteFraisOuverte(dateRetour: Date | string | null, dateDepart: Date | string | null, now: number = Date.now()): boolean {
  const ref = dateRetour ?? dateDepart;
  if (!ref) return true;
  const fin = new Date(ref);
  // Le jour du retour compte : on ouvre dès son début (UTC), sans se battre avec les fuseaux.
  const jour = Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth(), fin.getUTCDate());
  return now >= jour;
}

// ─────────────────────────────── L'ordre de mission ───────────────────────────────

export type HrStatut = "PENDING" | "IN_PROGRESS" | "READY" | "DELIVERED" | "APPROVED" | "REJECTED" | "CANCELLED";
export type GateN1 = "PENDING" | "APPROVED" | "REJECTED";
export type EtatOM = "AUCUN" | "CHEZ_N1" | "CHEZ_RH" | "EMIS" | "REFUSE_N1" | "REFUSE_RH";

/**
 * La marche de départ : le N+1 quand il existe (et a un compte), sinon directement les RH — et
 * l'écran le DIT. On ne valide pas son propre ordre.
 */
export function marcheInitiale(managerUserId: string | null, demandeurUserId: string): { gate: GateN1 | null; message: string } {
  if (managerUserId && managerUserId !== demandeurUserId) {
    return { gate: "PENDING", message: "Ordre de mission demandé — chez votre N+1, puis les RH." };
  }
  return { gate: null, message: "Ordre de mission demandé — aucun N+1 n'est rattaché à votre fiche : il part directement aux RH." };
}

/**
 * L'ÉTAT DU CIRCUIT, lu sur la demande RH liée. Sans demande : un ordre déjà ÉMIS à l'ancienne
 * (simple marqueur posé par l'organisateur) reste émis — compatibilité ; sinon, rien n'est demandé.
 */
export function etatOrdreMission(
  req: { status: HrStatut; managerGate: GateN1 | null } | null,
  legacyOrderStatus: "NONE" | "REQUESTED" | "ISSUED",
): EtatOM {
  if (!req) return legacyOrderStatus === "ISSUED" ? "EMIS" : "AUCUN";
  if (req.status === "CANCELLED") return legacyOrderStatus === "ISSUED" ? "EMIS" : "AUCUN";
  if (req.managerGate === "REJECTED") return "REFUSE_N1";
  if (req.status === "REJECTED") return "REFUSE_RH";
  if (req.managerGate === "PENDING") return "CHEZ_N1";
  if (req.status === "READY" || req.status === "DELIVERED" || req.status === "APPROVED") return "EMIS";
  return "CHEZ_RH";
}

/** « état — chez qui ». */
export function libelleOrdreMission(etat: EtatOM, n1: string | null = null): Etat {
  switch (etat) {
    case "AUCUN": return { texte: "à demander", ton: "neutral" };
    case "CHEZ_N1": return { texte: n1 ? `à valider — chez ${n1} (N+1)` : "à valider — chez le N+1", ton: "warning" };
    case "CHEZ_RH": return { texte: "en préparation — chez les RH", ton: "info" };
    case "EMIS": return { texte: "émis", ton: "success" };
    case "REFUSE_N1": return { texte: "refusé par le N+1", ton: "danger" };
    case "REFUSE_RH": return { texte: "refusé par les RH", ton: "danger" };
  }
}

/** Une nouvelle demande d'ordre est possible quand rien n'est en cours ni émis. */
export function peutDemanderOrdre(etat: EtatOM): boolean {
  return etat === "AUCUN" || etat === "REFUSE_N1" || etat === "REFUSE_RH";
}

/** Retirer sa demande : tant que les RH ne l'ont pas produite. */
export function peutRetirerOrdre(etat: EtatOM): boolean {
  return etat === "CHEZ_N1" || etat === "CHEZ_RH";
}

/** La décision du N+1 : la sienne, sur une marche ouverte, et un refus porte son motif. */
export function refusDecisionN1(
  req: { type: string; status: HrStatut; managerGate: GateN1 | null },
  estN1: boolean,
  decision: "VALIDER" | "REFUSER",
  motif: string | null,
): string | null {
  if (req.type !== "MISSION_ORDER") return "Cette demande n'est pas un ordre de mission.";
  if (req.managerGate !== "PENDING" || req.status !== "PENDING") return "Cet ordre de mission n'attend plus la décision du N+1.";
  if (!estN1) return "Seul le N+1 de la personne valide son ordre de mission.";
  if (decision === "REFUSER" && !(motif ?? "").trim()) return "Dites pourquoi vous refusez : la personne doit savoir quoi faire.";
  return null;
}

/** Les RH ne traitent pas une demande (ordre de mission, note de frais de mission) que le N+1 n'a pas encore validée (ou a refusée). */
export function refusTraitementRh(managerGate: GateN1 | null): string | null {
  // Vaut aussi pour la note de frais d'une mission de l'équipe, qui monte au N+1 avant les RH.
  if (managerGate === "PENDING") return "Cette demande attend encore la validation du N+1.";
  if (managerGate === "REJECTED") return "Le N+1 a refusé cette demande.";
  return null;
}

// ─────────────────────────────── Les autres circuits, relus ───────────────────────────────

/** Transport / hébergement : la demande au secrétariat (TRAVEL), relue. */
export function etatDemandeSecretariat(status: string | null): Etat {
  switch (status) {
    case null: return { texte: "à demander", ton: "neutral" };
    case "NEW": return { texte: "envoyée — chez le secrétariat", ton: "info" };
    case "DONE": return { texte: "réservé", ton: "success" };
    case "CANCELLED": return { texte: "annulée", ton: "neutral" };
    case "BLOCKED": return { texte: "bloquée — chez le secrétariat", ton: "danger" };
    case "AWAITING_VALIDATION": return { texte: "en validation", ton: "warning" };
    default: return { texte: "en cours — chez le secrétariat", ton: "info" };
  }
}

/** Matériel promotionnel : la demande au magasin, relue. */
export function etatDemandeMateriel(statut: string | null): Etat {
  switch (statut) {
    case null: return { texte: "à demander", ton: "neutral" };
    case "OUVERTE": return { texte: "envoyée — chez le magasin", ton: "info" };
    case "SERVIE": return { texte: "servie — à confirmer à réception", ton: "success" };
    case "REFUSEE": return { texte: "refusée par le magasin", ton: "danger" };
    default: return { texte: "annulée", ton: "neutral" };
  }
}

/** Note de frais : la demande RH, relue. */
export function etatNoteFrais(status: string | null): Etat {
  switch (status) {
    case null: return { texte: "à déposer", ton: "neutral" };
    case "PENDING": case "IN_PROGRESS": return { texte: "déposée — chez les RH", ton: "info" };
    case "READY": case "DELIVERED": case "APPROVED": return { texte: "validée", ton: "success" };
    case "REJECTED": return { texte: "refusée par les RH", ton: "danger" };
    default: return { texte: "annulée", ton: "neutral" };
  }
}

/** Une demande « vivante » bloque d'en refaire une : on n'en ouvre une autre que si celle-ci est annulée ou refusée. */
export function demandeRelancable(statut: string | null): boolean {
  return statut === null || statut === "CANCELLED" || statut === "ANNULEE" || statut === "REFUSEE" || statut === "REJECTED";
}

// ─────────────────────────────── Le pré-remplissage ───────────────────────────────

/** `AAAA-MM-JJ` d'une date (ou ""), pour un champ `<input type="date">`. */
export function jourIso(d: Date | string | null | undefined): string {
  if (!d) return "";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "" : x.toISOString().slice(0, 10);
}

/** L'objet de l'ordre — « ayant pour but … » — tiré de la demande Ad & Pro. */
export function objetOrdreMission(role: "ACCOMPAGNANT" | "DELEGATE_REFERENCE", libelleDemande: string): string {
  return role === "DELEGATE_REFERENCE"
    ? `de représenter la société en qualité de délégué de référence — ${libelleDemande}`
    : `d'accompagner la délégation — ${libelleDemande}`;
}

/** Les frais d'une ligne « équipe » à intégrer au budget : un montant saisi à la main, positif. */
export function refusMontantFrais(montant: number | null): string | null {
  if (montant == null || !Number.isFinite(montant)) return "Indiquez le montant exact.";
  if (montant <= 0) return "Le montant doit être supérieur à zéro.";
  return null;
}
