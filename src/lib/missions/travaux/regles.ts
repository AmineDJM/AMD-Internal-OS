/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÈGLES PURES DES TRAVAUX (J2) — zéro import : le serveur ET le panneau « Travaux » (composant
 * client) les lisent. Ce qu'un travail AFFICHE se décide ici, une fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le motif de pause posé quand un plafond de dépense est atteint : le travail DORT, il ne meurt pas. */
export const MOTIF_BUDGET = "BUDGET_HOLD";
/** Le motif de pause posé quand la personne a perdu le droit de faire travailler l'assistant. */
export const MOTIF_DROITS = "DROITS";

/** L'état AFFICHÉ d'un travail — le statut du moteur, plus le cas du plafond (une pause d'un genre à part). */
export type EtatTravail =
  | "A_APPROUVER" | "EN_COURS" | "EN_ATTENTE" | "BUDGET_HOLD" | "EN_PAUSE" | "BLOQUE" | "TERMINE" | "ANNULE" | "ECHEC";

export function etatTravail(status: string, pausedReason: string | null | undefined): EtatTravail {
  if (status === "AWAITING_APPROVAL") return "A_APPROUVER";
  if (status === "PAUSED") return pausedReason?.startsWith(MOTIF_BUDGET) ? "BUDGET_HOLD" : "EN_PAUSE";
  if (status === "COMPLETED") return "TERMINE";
  if (status === "CANCELLED") return "ANNULE";
  if (status === "FAILED") return "ECHEC";
  if (status === "BLOCKED" || status === "PARTIAL") return "BLOQUE";
  if (status === "WAITING_EVENT" || status === "WAITING_INPUT" || status === "WAITING_DEPENDENCY") return "EN_ATTENTE";
  return "EN_COURS";
}

export const LIBELLE_ETAT: Record<EtatTravail, string> = {
  A_APPROUVER: "Plan à approuver",
  EN_COURS: "En cours",
  EN_ATTENTE: "En attente",
  BUDGET_HOLD: "Plafond atteint",
  EN_PAUSE: "En pause",
  BLOQUE: "Bloqué",
  TERMINE: "Terminé",
  ANNULE: "Annulé",
  ECHEC: "Échec",
};

export const peutPauser = (e: EtatTravail): boolean => e === "EN_COURS" || e === "EN_ATTENTE";
export const peutReprendre = (e: EtatTravail): boolean => e === "EN_PAUSE" || e === "BUDGET_HOLD" || e === "BLOQUE";
export const peutAnnuler = (e: EtatTravail): boolean => !["TERMINE", "ANNULE"].includes(e);

/** « 2 jours », « 3 h », « 12 min » — la durée d'une attente, telle que le panneau la dit. */
export function duree(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} jours`;
}

/** « attend la signature du BC depuis 2 jours » — le titre de l'étape qui attend, et depuis quand. */
export function phraseAttente(titreEtape: string, depuis: Date, maintenant: Date): string {
  const t = titreEtape.trim().replace(/^attendre\s+/i, "").replace(/^attente\s+(de\s+|du\s+|des\s+)?/i, "");
  return `attend « ${t} » depuis ${duree(maintenant.getTime() - depuis.getTime())}`;
}

/** Les plafonds : le travail doit-il dormir ? Rend le motif dit à la personne, ou `null`. */
export function motifPlafond(p: {
  coutTravailUsd: number; plafondTravailUsd: number; depenseMoisUsd: number; plafondMensuelUsd: number; jourAtteint: boolean;
}): string | null {
  const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
  if (p.coutTravailUsd >= p.plafondTravailUsd) {
    return `plafond du travail atteint (${usd(p.coutTravailUsd)} sur ${usd(p.plafondTravailUsd)}) — relevez-le dans la console, ou reprenez après l'avoir ajusté`;
  }
  if (p.depenseMoisUsd >= p.plafondMensuelUsd) {
    return `plafond mensuel de la personne atteint (${usd(p.depenseMoisUsd)} sur ${usd(p.plafondMensuelUsd)}) — le travail reprendra le mois prochain ou quand la console le relèvera`;
  }
  if (p.jourAtteint) return "plafond de jetons du jour atteint — le travail reprendra demain";
  return null;
}
