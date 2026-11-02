/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUEL CERVEAU POUR QUEL TRAVAIL (§4) — deux axes, jamais confondus.
 *
 * ── LA RÈGLE, ET LA FAUTE QU'ELLE EMPÊCHE ────────────────────────────────────────────────
 *
 * La difficulté de RAISONNEMENT (A/B/C) et la quantité de TRAVAIL (S→MASSIVE) sont
 * indépendantes. « Le même message à trente-trois salariés » est B + MASSIVE : le plan est
 * évident, l'exécution est massive. Router sur le nombre d'étapes enverrait cette mission au
 * modèle le plus cher pour rien — et, symétriquement, une question à une seule étape mais
 * réellement difficile partirait sur le modèle le moins cher.
 *
 * D'où la seule règle de ce fichier : **l'échelle n'entre JAMAIS dans le choix du rôle.**
 * `roles.test.ts` le vérifie en balayant les quinze couples (complexité × échelle).
 *
 * ── AUCUN NOM DE MODÈLE ICI, ET C'EST LE POINT ───────────────────────────────────────────
 *
 * Ce fichier ne nomme que des RÔLES métier. La correspondance rôle → modèle vit dans la
 * passerelle (`src/lib/models/registry.ts`), du côté d'Adam, réglable par variable
 * d'environnement. Le runtime des missions n'a donc aucun moyen de nommer un modèle, ce qui
 * rend impossible la dérive habituelle : un `gpt-…` écrit en dur au milieu d'une règle métier,
 * qu'on ne retrouve plus le jour où le modèle change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Complexity, Scale } from "@/lib/missions/planner/contract";

/**
 * LES CINQ RÔLES. Ce sont des NIVEAUX D'EXIGENCE, pas des modèles.
 *
 * `EXCEPTIONAL_PLANNER` existe pour le petit nombre de missions où le plan lui-même est le
 * problème — un objectif contradictoire, une contrainte implicite, un arbitrage. Le distinguer
 * de `COMPLEX_PLANNER` permet de le brancher plus tard sur un modèle plus cher sans toucher au
 * runtime, et de MESURER combien de missions y vont réellement.
 */
export const MISSION_MODEL_ROLES = [
  "CHEAP_WORKER",
  "STANDARD_WORKER",
  "PRIMARY_REASONER",
  "COMPLEX_PLANNER",
  "EXCEPTIONAL_PLANNER",
] as const;
export type MissionModelRole = (typeof MISSION_MODEL_ROLES)[number];

/**
 * CE QU'UNE ÉTAPE DEMANDE COMME RÉFLEXION — déclaré par le plan, étape par étape.
 *
 * `NONE` n'est pas « sans modèle » : c'est « extraire, classer, reformuler », le travail où la
 * réponse est dans l'entrée. `HEAVY` est « arbitrer, juger, rédiger quelque chose qu'on signe ».
 */
export const REASONING_REQUIREMENTS = ["NONE", "LIGHT", "HEAVY"] as const;
export type ReasoningRequirement = (typeof REASONING_REQUIREMENTS)[number];

/**
 * LE RÔLE DU PLANIFICATEUR — fonction de la COMPLEXITÉ SEULE.
 *
 * L'échelle n'est pas un paramètre de cette fonction, et ce n'est pas un oubli : c'est la
 * garantie. Une signature qui ne reçoit pas l'échelle ne peut pas s'en servir.
 */
export function rolePourPlanification(complexity: Complexity): MissionModelRole {
  if (complexity === "C") return "EXCEPTIONAL_PLANNER";
  if (complexity === "B") return "COMPLEX_PLANNER";
  return "PRIMARY_REASONER";
}

/** LE RÔLE D'UN WORKER — fonction de l'exigence de CETTE étape, pas de la taille de la mission. */
export function rolePourEtape(besoin: ReasoningRequirement): MissionModelRole {
  if (besoin === "HEAVY") return "PRIMARY_REASONER";
  if (besoin === "LIGHT") return "STANDARD_WORKER";
  return "CHEAP_WORKER";
}

/**
 * LE RÔLE DU JUGE (§12). Toujours au moins `PRIMARY_REASONER` : c'est lui qui a le dernier mot
 * sur « l'objectif est-il atteint ? ». L'économiser reviendrait à économiser sur la seule
 * question qui décide de conclure ou non.
 */
export function rolePourJugement(complexity: Complexity): MissionModelRole {
  return complexity === "C" ? "COMPLEX_PLANNER" : "PRIMARY_REASONER";
}

/** Le rôle du compacteur de mémoire (§23) : du résumé fidèle, pas de l'arbitrage. */
export const ROLE_COMPACTION: MissionModelRole = "STANDARD_WORKER";

/**
 * CE QUE L'ÉCHELLE DÉCIDE VRAIMENT — la CONCURRENCE, pas le cerveau.
 *
 * L'axe « quantité de travail » a un effet réel, mais il porte sur le dispatcher : combien
 * d'étapes on ose lancer de front. C'est une limite OPÉRATIONNELLE (§2 de la doctrine), et
 * elle porte sa raison ici plutôt que dans une constante anonyme.
 */
export const CONCURRENCE_PAR_ECHELLE: Record<Scale, number> = {
  // Une poignée d'étapes : la parallélisation ne rapporte rien et complique la lecture du fil.
  S: 2,
  M: 4,
  L: 6,
  // Au-delà, on est limité par les quotas du fournisseur et par la base, pas par l'architecture.
  XL: 8,
  MASSIVE: 8,
};
