/**
 * Acceptance du Run 4 — LE BANC : statuts et formes des résultats, assertions, échelle de temps,
 * juge scripté, plans de mission à la main, conduite d'une mission jusqu'à son état.
 */
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { Reasoner, ReasonRequest } from "@/lib/missions/ports";
import { type RaisonneurScripte, pour, planScripte, type Script } from "@/platform/in-process/missions/fake-reasoner";
import { avancerMission } from "@/platform/in-process/missions/runtime";
import { sansBloquer } from "@/lib/journal";

export type StatutAcceptance = "PASS" | "FAIL" | "NOT_PROVEN_LIVE" | "ECARTE";

export interface ScenarioAcceptance {
  code: string;
  capacite: string;
  titre: string;
  /** Vrai quand le scénario exige le fournisseur réel (OPENAI_API_KEY). */
  live: boolean;
  statut: StatutAcceptance;
  mesures: Record<string, unknown>;
  preuve: string;
  dureeMs: number;
}

export interface ResultatAcceptance {
  jeton: string;
  liveDisponible: boolean;
  scenarios: ScenarioAcceptance[];
  compte: { pass: number; fail: number; nonProuveLive: number; ecartes: number };
  dureeMs: number;
}

/* ────────────────────────────── LES OUTILS DU BANC ────────────────────────────── */

/** Une attente vérifiée. Son échec nomme la propriété contredite — c'est la preuve du FAIL. */
export function attendre(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** L'échelle de relances, relue depuis la colonne JSON — des nombres, jamais crus sur parole. */
export const echelleDe = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];

/** Un raisonneur RALENTI — même réponses, latence artificielle : ce que remplace le réseau. */
export const ralenti = (reel: Reasoner, ms: number): Reasoner => ({
  configured: () => reel.configured(),
  reason: async (req) => {
    await new Promise((r) => setTimeout(r, ms));
    return reel.reason(req);
  },
});

/**
 * LE JUGE SCRIPTÉ — satisfait, avec des preuves EXTRAITES du compte rendu réellement reçu
 * (même mécanique que le banc E2E) : si le runtime n'envoyait pas les clés d'étapes au juge,
 * la liste serait vide et la normalisation ferait tomber la conclusion — comme il se doit.
 */
export const jugePour = (criteres: readonly string[]): Script =>
  pour("mission.judge", (req: ReasonRequest) => {
    const clesVues = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
    return {
      ok: true,
      data: {
        satisfied: true,
        confidence: 0.9,
        criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: clesVues.slice(0, 3) })),
        missing: [],
        contradictions: [],
        suggestedRecovery: null,
      },
    };
  });

export interface EtapeLibre { [k: string]: unknown }

/** Un plan scripté à la forme stricte, avec le tronc commun rempli. */
export function planDe(goal: string, echelle: string, criteres: string[], steps: EtapeLibre[]): Record<string, unknown> {
  return planScripte({
    goal,
    reasoningComplexity: "B",
    executionScale: echelle,
    acceptanceCriteria: criteres,
    workstreams: [],
    steps,
    expectedArtifacts: [],
    approvalStrategy: "BUNDLE",
    completionCriteria: criteres[0] ?? "",
    gaps: [],
    rationale: "plan scripté du banc d'acceptance — vérifié contre le schéma de production",
  });
}

export const lecture = (key: string, dependsOn: string[] = [], limit = 5): EtapeLibre => ({
  key, title: `Lecture ${key}`, nodeType: "CAPABILITY", capability: "directory_list",
  inputs: [{ key: "limit", kind: "NUMBER", value: String(limit) }],
  dependsOn, completionCondition: "la liste est rendue",
});

export const controle = (dependsOn: string[]): EtapeLibre => ({
  key: "controle", title: "Contrôle final", nodeType: "QA", capability: null,
  dependsOn, completionCondition: "toutes les étapes attendues sont abouties",
});

/**
 * CONDUIT une mission jusqu'à un état STABLE — le même geste que l'ordonnanceur, en boucle :
 * `avancerMission` (le point d'entrée de production), puis relecture. On s'arrête sur un état
 * terminal, ou quand deux tours consécutifs ne changent plus rien (attente, blocage).
 */
export async function conduire(acteur: CurrentUser, missionId: string, cerveau: Reasoner, tours = 12): Promise<string> {
  let precedent = "";
  for (let i = 0; i < tours; i++) {
    await avancerMission(acteur, missionId, { reasoner: cerveau, lectureSeule: true, maxTours: 25 }).catch(sansBloquer("acceptance.conduire.avancerMission", null));
    const m = await prisma.mission.findUnique({
      where: { id: missionId },
      select: { status: true, steps: { select: { key: true, status: true } } },
    });
    if (!m) return "ABSENTE";
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(m.status)) return m.status;
    const signature = `${m.status}|${m.steps.map((s) => `${s.key}:${s.status}`).sort().join(",")}`;
    if (signature === precedent) return m.status;
    precedent = signature;
  }
  return (await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true } }))?.status ?? "ABSENTE";
}

export async function etatEtape(missionId: string, key: string): Promise<{ status: string; receipt: string | null; attempt: number } | null> {
  const s = await prisma.missionStep.findFirst({
    where: { missionId, key },
    select: { status: true, receipt: true, attempt: true },
  });
  return s ?? null;
}

/**
 * LE CONTEXTE D'UN RUN — ce que les familles de scénarios lisent de `executerAcceptance` (ce qui était
 * la fermeture de la fonction) : le jeton du run, le compte du banc, et les deux gestes communs.
 */
export interface ContexteAcceptance {
  /** Le jeton de ce run : il marque tout ce que le run crée, pour le nettoyage. */
  TAG: string;
  /** Le préfixe des titres de mission de ce run. */
  PREFIXE: string;
  /** Le fournisseur réel est-il joignable (clé présente, ou `inclureLive`) ? */
  live: boolean;
  acteur: CurrentUser;
  /** Les missions créées par ce run — nettoyées à la fin, quoi qu'il arrive. */
  missionsCreees: Set<string>;
  /** Joue UN scénario : mesure, statut, preuve — une exception du corps devient un FAIL. */
  jouerScenario: (
    code: string, capacite: string, titre: string, exigeLive: boolean,
    corps: () => Promise<{ mesures: Record<string, unknown>; preuve: string; statut?: StatutAcceptance }>,
  ) => Promise<void>;
  /** Lance une mission scriptée par le POINT D'ENTRÉE de production et l'enregistre au nettoyage. */
  lancer: (
    objectif: string, plan: Record<string, unknown>, criteres: string[],
    options?: { demarrer?: boolean; titre?: string; cerveau?: RaisonneurScripte },
  ) => Promise<{ missionId: string; cerveau: RaisonneurScripte }>;
}
