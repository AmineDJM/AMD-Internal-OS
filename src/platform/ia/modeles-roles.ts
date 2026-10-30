/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BON MODÈLE POUR CHAQUE GESTE (lot J4, décision 0018) — une petite passerelle de RÔLES, pure.
 *
 * Un seul fournisseur (OpenAI, décision 0010) ; trois rôles :
 *
 *   rapide        résumer, classer, extraire — hors du chemin du premier mot (résumé roulant du fil) ;
 *   standard      la conversation : le modèle de l'assistant, effort de raisonnement BAS par défaut ;
 *   raisonnement  un travail à plusieurs étapes, une analyse, une comparaison : même modèle, effort plus haut.
 *
 * MESURÉ le 30/10 (Responses API, depuis le conteneur, un classement d'une phrase) : `gpt-6-luna` 1,8 à 2,5 s ;
 * `gpt-6.1-terra` effort `low` 1,0 s, `medium` 1,5 s. Le modèle léger n'est donc PAS plus rapide pour un geste court :
 * il sert là où il est moins CHER (le résumé, qui ne retarde personne), jamais pour classer avant le tour — la
 * présélection des outils est une règle (`selection-outils.ts`), 0 ms.
 *
 * Chaque rôle se change dans l'environnement, sans redéploiement de code : `ASSISTANT_IA_MODEL` (standard et
 * raisonnement), `ASSISTANT_IA_MODEL_RAPIDE`, `ASSISTANT_IA_MODEL_RAISONNEMENT` (J14 : un modèle à part pour le
 * raisonnement), `ASSISTANT_IA_EFFORT` / `ASSISTANT_IA_EFFORT_RAISONNEMENT`.
 *
 * J14 (décision 0022) : au-dessus de l'environnement, le choix FAIT À L'ÉCRAN (Administration › Qualité IA) — permis
 * seulement sur un banc vert — arrive en `surcharges`. Ce module reste pur : l'appelant les lit en base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type RoleModele = "rapide" | "standard" | "raisonnement";
export type EffortRaisonnement = "none" | "minimal" | "low" | "medium" | "high";

export interface ChoixModele {
  role: RoleModele;
  modelId: string;
  effort: EffortRaisonnement;
}

export const MODELE_STANDARD_DEFAUT = "gpt-6.1-terra";
export const MODELE_RAPIDE_DEFAUT = "gpt-6-luna";

const EFFORTS: readonly EffortRaisonnement[] = ["none", "minimal", "low", "medium", "high"];
const effortLu = (v: string | undefined, defaut: EffortRaisonnement): EffortRaisonnement => {
  const e = v?.trim().toLowerCase();
  return e && (EFFORTS as readonly string[]).includes(e) ? (e as EffortRaisonnement) : defaut;
};

export type SurchargesModeles = Partial<Record<RoleModele, { modelId: string; effort: EffortRaisonnement }>>;

export function modelePourRole(role: RoleModele, env: Record<string, string | undefined> = process.env, surcharges?: SurchargesModeles): ChoixModele {
  const s = surcharges?.[role];
  if (s) return { role, modelId: s.modelId, effort: effortLu(s.effort, "low") };
  const standard = env.ASSISTANT_IA_MODEL?.trim() || MODELE_STANDARD_DEFAUT;
  if (role === "rapide") return { role, modelId: env.ASSISTANT_IA_MODEL_RAPIDE?.trim() || MODELE_RAPIDE_DEFAUT, effort: effortLu(env.ASSISTANT_IA_EFFORT_RAPIDE, "low") };
  if (role === "raisonnement") return { role, modelId: env.ASSISTANT_IA_MODEL_RAISONNEMENT?.trim() || standard, effort: effortLu(env.ASSISTANT_IA_EFFORT_RAISONNEMENT, "medium") };
  return { role, modelId: standard, effort: effortLu(env.ASSISTANT_IA_EFFORT, "low") };
}

/** Les trois rôles, tels qu'en service — l'écran et le banc les enregistrent avec chaque passage. */
export const ROLES_MODELE: readonly RoleModele[] = ["rapide", "standard", "raisonnement"];

/** L'environnement d'un processus (le banc) qui doit tourner avec EXACTEMENT ces modèles. */
export function envDesModeles(m: Record<RoleModele, { modelId: string; effort: EffortRaisonnement }>): Record<string, string> {
  return {
    ASSISTANT_IA_MODEL: m.standard.modelId, ASSISTANT_IA_EFFORT: m.standard.effort,
    ASSISTANT_IA_MODEL_RAPIDE: m.rapide.modelId, ASSISTANT_IA_EFFORT_RAPIDE: m.rapide.effort,
    ASSISTANT_IA_MODEL_RAISONNEMENT: m.raisonnement.modelId, ASSISTANT_IA_EFFORT_RAISONNEMENT: m.raisonnement.effort,
  };
}

/** Une demande qui ANALYSE, COMPARE ou parcourt « toutes » les pièces d'un ensemble. */
const RAISONNE = /\b(analys\w*|compar\w*|synth[eè]s\w*|rapport|bilan|toutes? les|tous les|chaque|plan d'action|strat[ée]gi\w*|pourquoi|explique|[ée]value\w*|audit\w*)\b/i;

/**
 * L'EFFORT ADAPTATIF : le rôle d'un tour selon ce qu'il porte. Un « bonjour » ou « qui est Assia » n'a pas besoin de
 * raisonner ; un rapport sur l'année, si. Un tour de fond (fil) qui demande une analyse passe en raisonnement.
 */
export function roleDuTour(d: { texte: string; pieces?: number; travail?: boolean }): RoleModele {
  if (d.travail) return "raisonnement";
  if (RAISONNE.test(d.texte)) return "raisonnement";
  if ((d.pieces ?? 0) > 1) return "raisonnement";
  return "standard";
}
