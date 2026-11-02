/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VIE D'UNE RECETTE (J10, décision 0028) — pur. RIEN N'EST APPRIS EN SILENCE.
 *
 * L'extraction PROPOSE ; seul le responsable du processus (un rôle, ou une personne, désigné par la Direction) valide,
 * corrige, rejette ou retire. L'assistant ne lit que la version VALIDÉE. Une version validée n'est jamais réécrite :
 * une correction est une version de plus, l'ancienne passe REMPLACÉE — l'historique se relit.
 *
 *   recette  : PROPOSEE → VALIDEE ⇄ (nouvelle proposition, la validée reste en usage) → RETIREE
 *                       ↘ REJETEE (aucune version validée)
 *   version  : PROPOSEE → VALIDEE → REMPLACEE | RETIREE ;  PROPOSEE → REJETEE | REMPLACEE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const STATUTS_RECETTE = ["PROPOSEE", "VALIDEE", "REJETEE", "RETIREE"] as const;
export type StatutRecette = (typeof STATUTS_RECETTE)[number];
export const STATUTS_VERSION = ["PROPOSEE", "VALIDEE", "REJETEE", "REMPLACEE", "RETIREE"] as const;
export type StatutVersion = (typeof STATUTS_VERSION)[number];

export const LIBELLE_STATUT_RECETTE: Record<StatutRecette, string> = {
  PROPOSEE: "proposée", VALIDEE: "validée", REJETEE: "rejetée", RETIREE: "retirée",
};
export const LIBELLE_STATUT_VERSION: Record<StatutVersion, string> = {
  PROPOSEE: "proposée", VALIDEE: "validée", REJETEE: "rejetée", REMPLACEE: "remplacée", RETIREE: "retirée",
};

/** Le seuil d'occurrences par défaut : en dessous, aucune recette n'est proposée. */
export const SEUIL_OCCURRENCES_DEFAUT = 5;
export const SEUIL_OCCURRENCES_MIN = 3;

export interface Designation {
  role: string | null;
  userId: string | null;
}

/** Le responsable du processus : la personne désignée, ou un porteur du rôle désigné. Personne d'autre — pas même le Super Admin. */
export function estResponsable(user: { id: string; role: string; secondaryRole?: string | null }, d: Designation | null | undefined): boolean {
  if (!d) return false;
  return (!!d.userId && d.userId === user.id) || (!!d.role && (d.role === user.role || d.role === user.secondaryRole));
}

/** Désigner les responsables : la Direction (Super Admin, Direction). */
export const peutDesigner = (user: { role: string }): boolean => user.role === "SUPER_ADMIN" || user.role === "DIRECTION";

export type DecisionExtraction = "CREER" | "RIEN" | "RAFRAICHIR" | "REMPLACER_PROPOSITION" | "NOUVELLE_VERSION";

/**
 * CE QUE FAIT UNE NOUVELLE EXTRACTION — idempotente : la même façon de faire ne propose rien de neuf.
 * `derniere` : la version au plus haut numéro ; `validee` : la signature de la version en usage, s'il y en a une.
 */
export function decisionExtraction(
  recette: { statut: StatutRecette } | null, derniere: { statut: StatutVersion; signature: string } | null, signature: string,
): DecisionExtraction {
  if (!recette || !derniere) return "CREER";
  if (recette.statut === "RETIREE") return "RIEN";
  if (derniere.statut === "PROPOSEE") return derniere.signature === signature ? "RAFRAICHIR" : "REMPLACER_PROPOSITION";
  return derniere.signature === signature ? "RIEN" : "NOUVELLE_VERSION";
}

/** Le statut d'une recette, relu de ses versions. */
export function statutDeLaRecette(versions: readonly { statut: StatutVersion }[], retiree: boolean): StatutRecette {
  if (retiree) return "RETIREE";
  if (versions.some((v) => v.statut === "VALIDEE")) return "VALIDEE";
  if (versions.some((v) => v.statut === "PROPOSEE")) return "PROPOSEE";
  return "REJETEE";
}
