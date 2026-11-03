import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { avancerMission } from "@/platform/in-process/missions/runtime";
import { compile } from "@/lib/missions/compiler/compile";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";
import { materialiser } from "@/lib/missions/runtime/store";
import type { CapabilityCatalog, MissionActor, Reasoner, ReasonRequest } from "@/lib/missions/ports";
import type { MissionPlan } from "@/lib/missions/planner/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE DÉPENDANCE CONTOURNÉE NE RETIENT PERSONNE — le POINT FIXE du run Render 2026-08-29.
 *
 * Le scénario RECOURS s'était immobilisé en WAITING_DEPENDENCY, NON STABLE : « plus aucune
 * étape à exécuter, objectif non jugé atteint, et WAITING_DEPENDENCY n'ouvre ni recours ni
 * replanification ». La chaîne exacte : une étape du plan v1 échoue DÉFINITIVEMENT ; le plan
 * suivant la CONTOURNE (FAILED n'est pas ACQUIS → `supersededAt` posé, journal : « elles ne
 * bloquent plus ») ; or sa descendante, reprise par le nouveau plan, attendait une dépendance
 * qui n'est NI terminale (FAILED ∉ STEP_TERMINAL) NI exécutable (contournée) — pour toujours.
 *
 * Ce banc reproduit l'état EXACT que `store.ts` écrit au replan (statut + `supersededAt`,
 * mêmes champs, mêmes valeurs) puis repart du vrai point d'entrée (`avancerMission`) :
 * la descendante DOIT partir, et la mission DOIT conclure.
 *
 * Et le SABOTAGE inversé : la même panne NON contournée (elle appartient toujours au plan)
 * doit continuer de retenir sa descendante — le correctif n'ouvre pas plus qu'il ne promet.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__bypassdep${Date.now()}`;

const catalogue: CapabilityCatalog = {
  // Une lecture réelle est CONNUE du catalogue : le compilateur refuse un plan fait uniquement de
  // travaux de modèle (il ne pourrait répondre que de mémoire). Ce qui est testé ici — la
  // dépendance contournée — ne change pas d'un iota.
  has: (n) => n === "directory_list",
  allowed: () => true,
  meta: (n) => capabilityMeta(n),
  brief: () => [],
};

const SCHEMA_NOTE = {
  type: "object",
  properties: { note: { type: "string", description: "La note rédigée." } },
  required: ["note"],
  additionalProperties: false,
};

const planPrepareConclut = (objectif: string): MissionPlan => ({
  objective: objectif,
  acceptance: ["[REGLE:AUCUNE_ECRITURE] Aucun effet au-delà d'ANALYZE — mission d'analyse pure."],
  complexity: "B",
  scale: "S",
  steps: [
    { key: "source", title: "Lire l'annuaire", capability: "directory_list", input: {}, dependsOn: [], approvalRequirement: "NONE", reasoningRequirement: "NONE" },
    { key: "preparer", title: "Préparer le matériau", nodeType: "WORKER", dependsOn: [], approvalRequirement: "NONE", reasoningRequirement: "LIGHT", expectedOutputSchema: SCHEMA_NOTE },
    { key: "conclure", title: "Conclure malgré tout", nodeType: "WORKER", dependsOn: ["preparer"], approvalRequirement: "NONE", reasoningRequirement: "LIGHT", expectedOutputSchema: SCHEMA_NOTE },
  ],
  workstreams: [],
  expectedArtifacts: [],
  approvalStrategy: "BUNDLE",
  gaps: [],
});

/** Un raisonneur scripté : répond CONFORME aux workers, note chaque purpose, refuse tout plan. */
function scribe() {
  const purposes: string[] = [];
  const reasoner: Reasoner = {
    configured: () => true,
    reason: async <T>(req: ReasonRequest) => {
      purposes.push(req.purpose);
      if (req.purpose === "mission.worker") {
        return { ok: true, data: { note: "note rédigée sans l'amont" } as T, usage: null, latencyMs: 1 };
      }
      return { ok: false, data: null as T, error: "scribe : aucun plan", usage: null, latencyMs: 1 };
    },
  };
  return { reasoner, purposes };
}

suite("le point fixe de la dépendance contournée — et son sabotage inversé", () => {
  let user: CurrentUser;
  const missions: string[] = [];

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    user = {
      id: u.id, name: u.name, email: u.email, role: u.role,
      access: (await getAccess(u.id, u.role)) as EffectiveAccess,
      mustChangePassword: false,
    };
  }, 60_000);

  afterAll(async () => {
    await prisma.missionWorkerRun.deleteMany({ where: { missionId: { in: missions } } }).catch(() => {});
    await prisma.missionEvent.deleteMany({ where: { missionId: { in: missions } } }).catch(() => {});
    await prisma.missionStep.deleteMany({ where: { missionId: { in: missions } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { id: { in: missions } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  /** L'état exact d'après-replan : « preparer » a échoué définitivement, contournée ou non. */
  async function missionAmontEnPanne(titre: string, contournee: boolean): Promise<string> {
    const acteur: MissionActor = { userId: user.id, label: user.name, isAgent: false };
    const r = compile(planPrepareConclut(`${titre} — objectif d'analyse`), catalogue, acteur);
    if (!r.ok) throw new Error(`fixture non compilable : ${JSON.stringify(r.issues)}`);
    const id = await materialiser(r.mission, {
      ownerId: user.id, title: titre, goalRaw: `${titre} — objectif d'analyse`, maxConcurrency: 2,
    });
    missions.push(id);
    // Les MÊMES champs que `store.ts` écrit : statut d'échec définitif, et `supersededAt`
    // quand le plan suivant a cessé de porter l'étape (FAILED n'est pas ACQUIS).
    await prisma.missionStep.updateMany({
      where: { missionId: id, key: "preparer" },
      data: { status: "FAILED", attempt: 99, error: "panne définitive de fixture", ...(contournee ? { supersededAt: new Date() } : {}) },
    });
    return id;
  }

  it("l'amont FAILED **contourné** ne retient plus « conclure » : elle part, la mission CONCLUT", async () => {
    const id = await missionAmontEnPanne(`${TAG} contournée`, true);
    const { reasoner, purposes } = scribe();

    await avancerMission(user, id, { reasoner });

    const conclure = await prisma.missionStep.findFirst({
      where: { missionId: id, key: "conclure" }, select: { status: true },
    });
    expect(conclure?.status, "la descendante d'une étape contournée doit s'exécuter").toBe("DONE");
    expect(purposes).toContain("mission.worker");

    // Critères tout-règles : la mission conclut sans juge, malgré l'épave restée au dossier.
    const m = await prisma.mission.findUnique({ where: { id }, select: { status: true, goalSatisfied: true } });
    expect(m?.status).toBe("COMPLETED");
    expect(m?.goalSatisfied).toBe(true);
  }, 30_000);

  it("SABOTAGE inversé — le même échec NON contourné retient sa descendante : rien ne part", async () => {
    const id = await missionAmontEnPanne(`${TAG} vivante`, false);
    const { reasoner, purposes } = scribe();

    await avancerMission(user, id, { reasoner });

    const conclure = await prisma.missionStep.findFirst({
      where: { missionId: id, key: "conclure" }, select: { status: true },
    });
    expect(conclure?.status, "une panne que le plan porte ENCORE doit retenir sa descendante").not.toBe("DONE");
    expect(purposes.filter((p) => p === "mission.worker")).toHaveLength(0);

    const m = await prisma.mission.findUnique({ where: { id }, select: { status: true } });
    expect(m?.status).not.toBe("COMPLETED");
  }, 30_000);
});
