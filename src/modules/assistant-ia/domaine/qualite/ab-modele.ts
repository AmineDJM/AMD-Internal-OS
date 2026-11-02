/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PROTOCOLE A/B D'UN MODÈLE (J14, décision 0022) — règle PURE : ce changement est-il permis ?
 *
 * Changer le modèle d'un rôle (rapide, standard, raisonnement — `platform/ia/modeles-roles.ts`) n'est possible
 * qu'avec un BANC VERT ENREGISTRÉ pour ce candidat exact : un passage A/B terminé, vert (rien n'a régressé par
 * rapport à la référence, aucune écriture sans carte), qui a tourné AVEC ce modèle et cet effort pour ce rôle,
 * il y a moins de 14 jours. Le retour à la configuration de l'environnement (la référence), lui, est toujours
 * permis : c'est la voie de secours.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ROLES_MODELE = ["rapide", "standard", "raisonnement"] as const;
export type RoleModeleAb = (typeof ROLES_MODELE)[number];
export const EFFORTS_MODELE = ["none", "minimal", "low", "medium", "high"] as const;
export const VALIDITE_BANC_JOURS = 14;

export interface Candidat {
  role: RoleModeleAb;
  modelId: string;
  effort: string;
}

export interface PassageAb {
  id: string;
  statut: string;
  vert: boolean | null;
  candidat: unknown;
  finLe: Date | null;
}

/** Un nom de modèle plausible : lettres, chiffres, points, tirets, deux-points, barre — jamais une phrase. */
export const MODELE_VALIDE = /^[a-z0-9][a-z0-9._:/-]{1,63}$/i;

export function lireCandidat(x: unknown): Candidat | null {
  if (!x || typeof x !== "object") return null;
  const c = x as Record<string, unknown>;
  const role = String(c.role ?? "");
  const modelId = String(c.modelId ?? "").trim();
  const effort = String(c.effort ?? "").trim();
  if (!(ROLES_MODELE as readonly string[]).includes(role) || !MODELE_VALIDE.test(modelId) || !(EFFORTS_MODELE as readonly string[]).includes(effort)) return null;
  return { role: role as RoleModeleAb, modelId, effort };
}

const memeCandidat = (a: Candidat, b: Candidat) => a.role === b.role && a.modelId === b.modelId && a.effort === b.effort;

/** Le passage vert qui autorise ce candidat — ou la raison du refus. */
export function autorisationChangement(candidat: Candidat, passages: readonly PassageAb[], maintenant: Date): { ok: true; passageId: string } | { ok: false; raison: string } {
  const limite = maintenant.getTime() - VALIDITE_BANC_JOURS * 86_400_000;
  const pour = passages.filter((p) => { const c = lireCandidat(p.candidat); return c && memeCandidat(c, candidat); });
  const vert = pour
    .filter((p) => p.statut === "TERMINE" && p.vert === true && p.finLe && p.finLe.getTime() >= limite)
    .sort((a, b) => (b.finLe?.getTime() ?? 0) - (a.finLe?.getTime() ?? 0))[0];
  if (vert) return { ok: true, passageId: vert.id };
  const qui = `${candidat.modelId} (effort ${candidat.effort}) pour le rôle « ${candidat.role} »`;
  if (!pour.length) return { ok: false, raison: `Aucun banc A/B n'a éprouvé ${qui} : lancez-le d'abord, le changement n'est permis que sur un banc vert.` };
  if (pour.some((p) => p.statut === "DEMANDE" || p.statut === "EN_COURS")) return { ok: false, raison: `Le banc A/B de ${qui} n'est pas terminé.` };
  if (pour.some((p) => p.statut === "TERMINE" && p.vert === true)) return { ok: false, raison: `Le banc vert de ${qui} a plus de ${VALIDITE_BANC_JOURS} jours : relancez-le.` };
  return { ok: false, raison: `Le banc A/B de ${qui} n'est pas vert : le changement est refusé.` };
}
