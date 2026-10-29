/**
 * Smoke fournisseur — LA MESURE : plafond, maillons de la chaîne (fournisseur → mission), états
 * stables et replanifiables, formes des résultats, et le verdict « lecture seule » (aucune écriture
 * exécutée, effets des étapes, artefacts recensés).
 */
import { prisma } from "@/lib/prisma";
import { EFFECT_RANK, capabilityMeta, type Effect } from "@/lib/missions/registry/capability-meta";
import { effetDuNoeud } from "@/lib/missions/registry/node-effect";
import { lireRecu } from "@/lib/missions/runtime/receipt";
import { RESOLVER_WRITE_NAMES } from "@/lib/assistant";
import type { Cascade } from "@/platform/in-process/missions/provider-waterfall";
import type { Precondition } from "./scenarios";

/** Le plafond d'effet. Au-delà, la mission n'est PAS exécutée. */
export const PLAFOND: Effect = "ANALYZE";

/** Les maillons de la chaîne FOURNISSEUR — ceux qui prouvent qu'un vrai modèle a travaillé. */
export const MAILLONS_FOURNISSEUR = [
  "PROVIDER_CALL", "PLANNER_REAL_MODEL", "MISSION_PLAN_SCHEMA", "COMPILER", "MISSION_PERSISTED",
] as const;

/** Les maillons de la chaîne MISSION — ceux qui prouvent qu'elle va au bout et conclut. */
export const MAILLONS_MISSION = [
  "READ_ONLY_EXECUTION", "TERMINAL_STATE", "QA_GOAL_SATISFACTION",
] as const;

export const MAILLONS = [...MAILLONS_FOURNISSEUR, ...MAILLONS_MISSION] as const;

export type Maillon = (typeof MAILLONS)[number];

export type Etat = "PASS" | "FAIL";

export type Chaine = Record<Maillon, Etat>;

/**
 * LES ÉTATS OÙ L'ON S'ARRÊTE LÉGITIMEMENT.
 *
 * `COMPLETED` conclut. Les attentes attendent quelque chose que le diagnostic ne fournira pas —
 * un accord humain, un événement — et insister ne changerait rien. `CANCELLED` est une décision.
 * Tout le reste laisse une porte : on la pousse.
 */
export const ETATS_STABLES = new Set(["COMPLETED", "CANCELLED", "AWAITING_APPROVAL", "WAITING_INPUT", "WAITING_EVENT"]);

/** Les états d'où le mécanisme canonique de replanification a un sens. */
export const ETATS_REPLANIFIABLES = new Set(["FAILED", "BLOCKED", "PARTIAL"]);

export interface ResultatMission {
  genre: string;
  demande: string;
  verite: string;
  missionId: string | null;
  /** L'état où la mission s'est immobilisée, et POURQUOI on s'est arrêté là. */
  statutFinal: string | null;
  stable: boolean;
  motifArret: string;
  toursMoteur: number;
  replanifications: number;
  versionPlan: number | null;
  recoursObserves: number;
  etapesCompilees: number | null;
  etapesTerminees: number;
  etapesEnEchec: number;
  /**
   * ── POLITIQUE ET OBSERVATION NE SE CONFONDENT PAS ──────────────────────────────────
   *
   * `effetMaxAutorise` est ce que la POLITIQUE permet — le plafond, connu avant de lancer.
   * `effetMaxPlanifie` est ce que le PLAN écrit contient — connu après compilation.
   * `effetMaxExecute` est ce qui a RÉELLEMENT tourné — connu seulement après coup, et lu sur
   * les étapes qui ont bougé, reçus à l'appui.
   *
   * Le diagnostic dérivait son vert du seul catalogue filtré (« les capacités interdites sont
   * absentes de la liste, donc rien d'interdit n'a pu tourner »). C'est un raisonnement sur une
   * INTENTION, et il a affiché `READ_ONLY_EXECUTION PASS` pendant que des XLSX partaient dans le
   * Drive de production. Un banc ne conclut pas d'un filtre qu'il a été respecté : il regarde.
   */
  effetMaxAutorise: Effect;
  effetMaxPlanifie: Effect | null;
  effetMaxExecute: Effect | null;
  capacitesHorsPlafond: string[];
  /**
   * CE QUE LA MISSION A LAISSÉ DERRIÈRE ELLE. Sous plafond de lecture, la seule réponse
   * acceptable est « rien ». `null` = non mesuré, jamais 0 par défaut.
   */
  artefactsAvant: number | null;
  artefactsApres: number | null;
  /** Les artefacts APPARUS pendant ce scénario, nommés. Non vide ⇒ le plafond a été franchi. */
  artefactsCrees: string[];
  /**
   * COMBIEN D'APPELS DE MODÈLE, ET POUR QUOI — `mission.plan`, `mission.judge`,
   * `mission.worker`… Le nombre de replanifications dit COMBIEN de fois le moteur a renoncé ;
   * cette ventilation dit ce que ces renoncements ont COÛTÉ. Les deux ensemble permettent de
   * juger si une correction a réduit le travail inutile — sans quoi « c'est plus rapide » reste
   * une impression.
   */
  appelsParUsage: Record<string, number>;
  /** L'état de la vérité terrain AVANT lancement. `null` quand le scénario n'en exige pas. */
  precondition: Precondition | null;
  /** Vrai quand le BANC est invalide (vérité terrain fausse) — et non la mission en échec. */
  setupEchoue: boolean;
  qaPassed: boolean | null;
  goalSatisfied: boolean | null;
  goalVerdict: string | null;
  cascade: Cascade | null;
}

export interface ResultatSmoke {
  horodatage: string;
  chaine: Chaine;
  /** Le fournisseur est-il réellement à l'œuvre ? Question 1, indépendante. */
  providerProven: boolean;
  /** Une mission atteint-elle un état terminal avec un jugement cohérent ? Question 2. */
  missionE2eProven: boolean;
  premierEchecFournisseur: Maillon | null;
  premierEchecMission: Maillon | null;
  raison: string | null;
  cleDisponible: boolean;
  modele: string | null;
  /**
   * LES JETONS DE TOUS LES APPELS DU DIAGNOSTIC — pas seulement ceux des trois planifications
   * initiales, comme c'était le cas jusqu'à un run qui a montré l'écart : 11 521 annoncés en
   * entrée pour 52 463 facturés.
   */
  jetonsEntree: number;
  jetonsSortie: number;
  /** `null` quand aucun appel n'a distingué la réflexion — jamais zéro, qui serait une affirmation. */
  jetonsReflexion: number | null;
  /** Combien d'appels de modèle le diagnostic entier a émis, toutes familles confondues. */
  appelsModele: number;
  capacitesOuvertes: number | null;
  /** Le jeton de CE run — ce qui rend ses scénarios impossibles à confondre avec ceux d'un autre. */
  jeton: string;
  /** Faux quand au moins une vérité terrain était fausse : le BANC est invalide, pas la mission. */
  setupValide: boolean;
  raisonSetup: string | null;
  /** Les artefacts apparus pendant le diagnostic alors qu'aucun n'était permis. Vide = propre. */
  artefactsInattendus: string[];
  scenarios: ResultatMission[];
  latenceTotaleMs: number;
  /**
   * LES MISSIONS DE DIAGNOSTIC ARRÊTÉES À LA FIN DU DIAGNOSTIC (§118.132). Ce banc tourne dans
   * le Shell Render, donc en PRODUCTION : une mission de diagnostic laissée BLOCKED y était
   * reprise par le battement à chaque passage, replanifiée jusqu'au plafond, et NOTIFIAIT le
   * dirigeant à chaque version de plan — « Bloqué — Diagnostic — … » sans arrêt. Une mesure
   * finie ne laisse pas son instrument tourner.
   */
  missionsArretees: number;
}

const estEcriture = (n: string): boolean => RESOLVER_WRITE_NAMES.has(n);

/**
 * L'EFFET D'UNE ÉTAPE — capacité ou non, et SANS `if (!capability) continue`.
 *
 * La table des types de nœud vit dans `registry/node-effect.ts` et non plus ici : le diagnostic
 * en tenait une copie manuscrite « la même que le compilateur, et c'est voulu ». Deux tables
 * identiques le jour où on les écrit divergent le jour où un type de nœud s'ajoute, et c'est
 * toujours celle qui garde qui reste en arrière.
 */
export function effetDeLEtape(e: { capability: string | null; nodeType: string }): Effect {
  return effetDuNoeud(e.nodeType, e.capability ? capabilityMeta(e.capability, estEcriture).effect : null);
}

/**
 * LES ÉTATS QUI SIGNIFIENT « CETTE ÉTAPE A RÉELLEMENT TOURNÉ ».
 *
 * `FAILED` en fait partie, et ce n'est pas une erreur : une écriture peut avoir eu lieu avant
 * que l'étape échoue. Compter le seul `DONE` sous-estimerait l'effet exécuté — précisément dans
 * le sens qui arrange le banc.
 */
const ETATS_EXECUTES = new Set(["DONE", "FAILED"]);

/**
 * L'EFFET RÉELLEMENT EXÉCUTÉ — une OBSERVATION, pas une politique.
 *
 * Lu sur les étapes qui ont bougé, et en priorité sur leur REÇU (`receiptData.effect`), qui est
 * le constat écrit au moment de l'appel. À défaut de reçu — les nœuds natifs n'en produisent
 * pas — la table des types de nœud tranche.
 *
 * Rend `null` quand AUCUNE étape n'a tourné : « rien n'a été exécuté » n'est pas « l'effet
 * exécuté vaut READ ». Le premier est une absence de mesure, le second une affirmation (§78).
 */
export function effetExecute(
  etapes: { capability: string | null; nodeType: string; status: string; receiptData: unknown }[],
): Effect | null {
  const tournees = etapes.filter((e) => ETATS_EXECUTES.has(e.status));
  if (tournees.length === 0) return null;
  let max: Effect = "READ";
  for (const e of tournees) {
    const recu = lireRecu(e.receiptData);
    const eff = recu?.effect ?? effetDeLEtape(e);
    if (EFFECT_RANK[eff] > EFFECT_RANK[max]) max = eff;
  }
  return max;
}

/**
 * LE RECENSEMENT DES ARTEFACTS — avant, puis après.
 *
 * Un plafond de lecture qui laisse un fichier derrière lui n'est pas un plafond. La différence
 * se mesure en NOMBRE et par les TITRES apparus, parce qu'un compte égal peut cacher une
 * création suivie d'une suppression, et parce qu'un titre nommé est diagnosticable.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * LE VERDICT DE LECTURE SEULE — une fonction PURE, parce qu'un verdict doit être testable.
 *
 * ── LE FAUX VERT QUE CETTE FONCTION REMPLACE ──────────────────────────────────────────
 *
 * La condition était : « au moins une étape n'est plus PENDING ni READY ». Elle ne dit
 * strictement rien de l'EFFET exécuté — elle dit que le moteur a démarré. Sur un run réel, elle
 * a affiché PASS pendant que deux missions déposaient des classeurs XLSX dans le Drive de
 * production. Un banc qui dérive son vert du catalogue filtré mesure une INTENTION.
 *
 * Trois conditions, toutes des observations :
 *
 *   1. quelque chose a TOURNÉ           — sans quoi il n'y a rien à attester ;
 *   2. l'effet EXÉCUTÉ tient sous le plafond, lu sur les reçus des étapes qui ont bougé ;
 *   3. AUCUN artefact n'est apparu      — la trace matérielle, indépendante des reçus.
 *
 * La 3 n'est pas redondante avec la 2 : elle observe le MONDE, pas le journal du moteur. Si les
 * deux divergent, c'est le monde qui a raison, et c'est exactement le cas qu'on veut attraper —
 * un fichier écrit par un chemin que l'instrumentation ne voit pas.
 *
 * `effetExecute: null` NE PASSE PAS. « Non mesuré » n'est pas « inoffensif » (§78) : un moteur
 * qui ne sait pas ce qu'il a exécuté ne peut pas attester qu'il n'a rien écrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════
 */
export function verdictLectureSeule(obs: {
  aTourne: boolean;
  effetExecute: Effect | null;
  artefactsCrees: string[];
}): { etat: Etat; raison: string | null } {
  if (!obs.aTourne) return { etat: "FAIL", raison: null };
  const raisons = [
    obs.effetExecute === null
      ? `EFFET EXÉCUTÉ non mesuré — sans mesure, aucune attestation de lecture seule`
      : EFFECT_RANK[obs.effetExecute] > EFFECT_RANK[PLAFOND]
        ? `EFFET EXÉCUTÉ ${obs.effetExecute} > plafond ${PLAFOND}`
        : "",
    obs.artefactsCrees.length > 0
      ? `ARTEFACT(S) CRÉÉ(S) malgré le plafond : ${obs.artefactsCrees.join(", ")}`
      : "",
  ].filter(Boolean);
  return raisons.length === 0
    ? { etat: "PASS", raison: null }
    : { etat: "FAIL", raison: raisons.join(" | ") };
}

export async function recenserArtefacts(userId: string): Promise<{ compte: number; titres: string[] } | null> {
  try {
    const rows = await prisma.assistantArtifact.findMany({
      where: { ownerId: userId }, select: { id: true, title: true }, orderBy: { createdAt: "desc" }, take: 200,
    });
    return { compte: rows.length, titres: rows.map((r) => `${r.id}|${r.title}`) };
  } catch {
    // NON MESURÉ. On ne rend pas `{ compte: 0 }` : un recensement impossible n'est pas un Drive
    // vide, et l'écrire ferait passer une mesure ratée pour une garantie tenue.
    return null;
  }
}
