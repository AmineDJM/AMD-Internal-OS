/**
 * OÙ MÈNENT LES NOTIFICATIONS DE L'ESPACE PERSONNEL — tâches et missions, écrites une fois.
 *
 * Module PUR — aucune importation. Le navigateur et le serveur le lisent.
 */

export const CHEMIN_TACHES = "/mon-espace/taches";

/** Les vues de « Mon espace › Tâches » qu'une notification désigne (miroir de `VueTaches`). */
export type VueTacheLien = "a-faire" | "demandees" | "partagees" | "terminees";

/**
 * UNE TÂCHE, son panneau ouvert dans « Mon espace › Tâches ». La vue est celle où la tâche se range
 * POUR LE DESTINATAIRE : à faire pour qui la reçoit, « Demandées » pour qui l'a demandée, « Partagées »
 * pour un participant. Si elle n'y est pas (vue changée entre-temps), l'onglet ouvre sa fiche.
 */
export function lienTache(id: string, vue?: VueTacheLien): string {
  const q = new URLSearchParams();
  if (vue && vue !== "a-faire") q.set("vue", vue);
  q.set("tache", id);
  return `${CHEMIN_TACHES}?${q.toString()}`;
}

/** La vue où une tâche se range pour CETTE personne : la sienne à faire, celle qu'elle a demandée, ou partagée. */
export function vueTachePour(
  userId: string,
  tache: { assignedToId: string | null; createdById: string | null },
): VueTacheLien | undefined {
  if (userId === tache.assignedToId) return undefined;
  if (userId === tache.createdById) return "demandees";
  return "partagees";
}

/** « Mes missions » — invitations, ordre de mission, étapes. */
export const CHEMIN_MES_MISSIONS = "/mon-espace/missions";
/**
 * UNE MISSION DE L'ÉQUIPE ADVENTUM, ouverte : la fiche de participation, les versions et le fil, puis la mission
 * (billet, hôtel, notes de frais, rapport, clôture). La même page pour la personne et pour l'organisateur.
 */
export function lienMission(id: string, ancre?: "frais" | "rapport" | "reservation" | "fil"): string {
  return `${CHEMIN_MES_MISSIONS}/${encodeURIComponent(id)}${ancre ? `#${ancre}` : ""}`;
}
/** Les ordres de mission qui attendent la signature du N+1. */
export const LIEN_MISSIONS_A_VALIDER = `${CHEMIN_MES_MISSIONS}#a-valider`;

/**
 * L'AGENDA, ouvert sur le MOIS du rendez-vous (`?y=&m=`, heure d'Alger) — une invitation pour le mois
 * prochain ouvrait le mois courant, où le rendez-vous n'est pas.
 */
export function lienCalendrier(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "/calendar";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Algiers", year: "numeric", month: "numeric" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return y && m ? `/calendar?y=${y}&m=${Number(m)}` : "/calendar";
}

/** « Mon bilan » (KPI) — sur la période dont parle la notification, pas sur la période courante. */
export function lienBilanKpi(periode?: string | null): string {
  return periode ? `/mon-espace/bilan?periode=${encodeURIComponent(periode)}` : "/mon-espace/bilan";
}

/** « Mon équipe › KPI » du responsable — déclarations à valider, revues à signer — sur la période. */
export function lienKpiEquipe(periode?: string | null): string {
  return periode ? `/mon-equipe?vue=kpi&periode=${encodeURIComponent(periode)}` : "/mon-equipe?vue=kpi";
}

/** Une conversation de la messagerie interne, ouverte. */
export function lienConversation(conversationId: string | null | undefined): string {
  return conversationId ? `/messages?c=${encodeURIComponent(conversationId)}` : "/messages";
}
