import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { Reasoner, ReasonRequest, ReasonResult } from "@/lib/missions/ports";
import { estPanneTransitoire, finaliserLancementDifere, lancerMission } from "@/platform/in-process/missions/runtime";
import { planScripte } from "@/platform/in-process/missions/fake-reasoner";

/**
 * LA DEMANDE N'EST JAMAIS PERDUE — le repli sur talon quand le fournisseur lâche.
 *
 * Au banc, cinq missions sur neuf n'ont pas été lancées : « Erreur IA (HTTP 502) : upstream
 * request failed » pendant la planification, et la réponse au dirigeant était « la mission n'a
 * PAS été lancée ». Une panne de réseau devenait sa charge. Ce fichier fixe le contrat : une
 * panne TRANSITOIRE retient la demande (talon PLANNING, journal PLANNING_DEFERRED) et la
 * planification reprend ; un refus DURABLE clôt honnêtement.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `res${Date.now().toString(36)}`;
let pdg: CurrentUser;

const PLAN = planScripte({
  goal: "Retrouver ce que l'entreprise sait du sujet.",
  reasoningComplexity: "A", executionScale: "S",
  acceptanceCriteria: ["Une recherche a été faite."],
  workstreams: [{ id: "lecture", title: "Lecture", outcome: "La recherche est faite." }],
  steps: [{
    key: "recherche", title: "Chercher", workstream: "lecture", nodeType: "CAPABILITY", capability: "search_everything",
    inputs: [{ key: "query", kind: "TEXT", value: TAG }], dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
    waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
    outputFields: [], completionCondition: "La recherche a rendu quelque chose ou rien, mais elle a eu lieu.",
    reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
  }],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: "La recherche a eu lieu.", gaps: [], rationale: "lecture nue",
});

/** Un raisonneur qui LÂCHE n fois (panne transitoire) puis rend le plan. */
function raisonneurCapricieux(pannes: number, message: string): Reasoner & { appels: number } {
  return {
    appels: 0,
    configured: () => true,
    async reason<T>(req: ReasonRequest): Promise<ReasonResult<T>> {
      this.appels += 1;
      if (req.purpose === "mission.plan" && this.appels <= pannes) {
        return { ok: false, data: null, error: message, usage: null, latencyMs: 5 };
      }
      if (req.purpose === "mission.plan") return { ok: true, data: PLAN as unknown as T, usage: null, latencyMs: 5 };
      return { ok: true, data: { satisfied: true, confidence: 1, criteria: [], missing: [], contradictions: [] } as unknown as T, usage: null, latencyMs: 1 };
    },
  };
}

suite("résilience du lancement — une panne transitoire retient la demande", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
  }, 60_000);
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: pdg.id } }).catch(() => {});
  }, 60_000);

  it("lancement direct : HTTP 502 pendant la planification → talon PLANNING, PLANNING_DEFERRED, rien de perdu", async () => {
    const cerveau = raisonneurCapricieux(1, "Erreur IA (HTTP 502) : upstream request failed");
    const r = await lancerMission(pdg, `Occupe-toi du sujet ${TAG}.`, { reasoner: cerveau, sansEnquete: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.differe).toBe(true);
    expect(r.etapes).toBe(0);
    const m = await prisma.mission.findUnique({ where: { id: r.missionId }, select: { status: true, goalRaw: true, steps: { select: { id: true } } } });
    expect(m?.status).toBe("PLANNING");
    expect(m?.goalRaw).toContain(TAG);
    expect(m?.steps).toHaveLength(0);
    const journal = await prisma.missionEvent.findMany({ where: { missionId: r.missionId }, select: { kind: true } });
    expect(journal.map((e) => e.kind)).toContain("PLANNING_DEFERRED");

    // LA REPRISE, par l'entrée que le battement emploie : le fournisseur répond, la mission naît.
    const f = await finaliserLancementDifere(r.missionId, pdg, `Occupe-toi du sujet ${TAG}.`, { reasoner: cerveau, sansEnquete: true });
    expect(f.finalise).toBe(true);
    const apres = await prisma.mission.findUnique({ where: { id: r.missionId }, select: { status: true, steps: { select: { key: true } } } });
    expect(apres?.steps.map((s) => s.key)).toContain("recherche");
    expect(apres?.status).not.toBe("PLANNING");
  }, 120_000);

  it("finalisation différée : une panne transitoire laisse le talon PLANNING ; un refus durable le passe FAILED", async () => {
    const talon = await prisma.mission.create({
      data: { kind: "RUNTIME", status: "PLANNING", title: "talon", objective: `sujet ${TAG}`, goalRaw: `sujet ${TAG}`, ownerId: pdg.id, planVersion: 0 },
      select: { id: true },
    });
    const transitoire = raisonneurCapricieux(99, "fetch failed: ECONNRESET");
    const f1 = await finaliserLancementDifere(talon.id, pdg, `sujet ${TAG}`, { reasoner: transitoire, sansEnquete: true });
    expect(f1.finalise).toBe(false);
    expect((await prisma.mission.findUnique({ where: { id: talon.id }, select: { status: true } }))?.status).toBe("PLANNING");

    const durable = raisonneurCapricieux(99, "Le planificateur n'a rien rendu d'exploitable.");
    const f2 = await finaliserLancementDifere(talon.id, pdg, `sujet ${TAG}`, { reasoner: durable, sansEnquete: true });
    expect(f2.finalise).toBe(false);
    expect((await prisma.mission.findUnique({ where: { id: talon.id }, select: { status: true } }))?.status).toBe("FAILED");
  }, 120_000);
});

describe("résilience du lancement — la classification est une table, pas une humeur", () => {
  it("reconnaît les pannes transitoires et laisse passer les refus durables", () => {
    for (const m of [
      "Erreur IA (HTTP 502) : upstream request failed", "HTTP 503 Service Unavailable", "HTTP 429 rate limit exceeded",
      "fetch failed", "socket hang up", "request timed out", "Délai dépassé", "ECONNRESET", "The model is overloaded",
    ]) expect(estPanneTransitoire(m), m).toBe(true);
    for (const m of [
      "Le planificateur n'a rien rendu d'exploitable.", "le plan proposé reste refusé après correction : UNKNOWN_CAPABILITY",
      "Aucun fournisseur de modèle n'est configuré", null, undefined, "",
    ]) expect(estPanneTransitoire(m), String(m)).toBe(false);
  });
});
