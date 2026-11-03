import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { replanifierMission } from "@/platform/in-process/missions/runtime";
import { compile } from "@/lib/missions/compiler/compile";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";
import { materialiser, journaliser } from "@/lib/missions/runtime/store";
import type { CapabilityCatalog, MissionActor, Reasoner } from "@/lib/missions/ports";
import type { MissionPlan } from "@/lib/missions/planner/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE DÉTERMINISTE AVANT LE REPLAN (§13, chantier latence) — prouvée par l'espion.
 *
 * Un run réel a payé 7,9 s et 5 718 jetons pour que la replanification découvre qu'il n'y
 * avait rien à replanifier — le juge avait DÉJÀ dit « aucun recours ». Ce banc prouve les
 * deux faces : quand le dernier refus journalisé porte `recoursSuggere: null`, AUCUN appel de
 * modèle ne part (l'espion compte) ; quand le signal est ABSENT, la porte reste ouverte —
 * l'absence de mesure n'est pas une mesure (§78), et fermer sur le silence casserait toutes
 * les missions antérieures au champ.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__replangate${Date.now()}`;

const CAPS = ["read_hr_overview", "directory_list"];
const catalogue: CapabilityCatalog = {
  has: (n) => CAPS.includes(n),
  allowed: () => true,
  meta: (n) => capabilityMeta(n),
  brief: () => CAPS.map((id) => {
    const m = capabilityMeta(id);
    return { id, domain: m.domain, effect: m.effect, batchable: m.batchable, summary: id };
  }),
};

const planLecture = (objectif: string): MissionPlan => ({
  objective: objectif,
  acceptance: ["La lecture a fondé la réponse."],
  complexity: "A",
  scale: "S",
  steps: [
    { key: "lire", title: "Lire", nodeType: "CAPABILITY", capability: "read_hr_overview", dependsOn: [], approvalRequirement: "NONE", reasoningRequirement: "NONE" },
    { key: "repondre", title: "Répondre", nodeType: "WORKER", dependsOn: ["lire"], approvalRequirement: "NONE", reasoningRequirement: "LIGHT" },
  ],
  workstreams: [],
  expectedArtifacts: [],
  approvalStrategy: "BUNDLE",
  gaps: [],
});

function espionReasoner() {
  let appels = 0;
  const reasoner: Reasoner = {
    configured: () => true,
    reason: async () => {
      appels += 1;
      return { ok: false, data: null, error: "espion : aucun plan", usage: null, latencyMs: 1 };
    },
  };
  return { reasoner, compte: () => appels };
}

suite("la porte de replan — aucun modèle payé quand le juge a dit « aucun recours »", () => {
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
    await prisma.missionEvent.deleteMany({ where: { missionId: { in: missions } } }).catch(() => {});
    await prisma.missionStep.deleteMany({ where: { missionId: { in: missions } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { id: { in: missions } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  /** Une mission BLOCKED, toutes étapes DONE — l'état exact du run réel qui a payé pour rien. */
  async function missionBloquee(titre: string): Promise<string> {
    const acteur: MissionActor = { userId: user.id, label: user.name, isAgent: false };
    const r = compile(planLecture(`${titre} — objectif`), catalogue, acteur);
    if (!r.ok) throw new Error("le plan de fixture ne compile pas");
    const id = await materialiser(r.mission, {
      ownerId: user.id, title: titre, goalRaw: `${titre} — objectif`, maxConcurrency: 2,
    });
    missions.push(id);
    await prisma.missionStep.updateMany({ where: { missionId: id }, data: { status: "DONE" } });
    await prisma.mission.update({ where: { id }, data: { status: "BLOCKED" } });
    return id;
  }

  it("recoursSuggere: null au journal → refus SANS appel de modèle, raison dite", async () => {
    const id = await missionBloquee(`${TAG} porte fermée`);
    await journaliser(id, "GOAL_UNSATISFIED", "Objectif NON atteint — refus du juge.",
      { qa: true, recoursSuggere: null });

    const { reasoner, compte } = espionReasoner();
    const r = await replanifierMission(user, id, { reasoner });

    expect(r.replanifie).toBe(false);
    expect(r.raison).toContain("aucun recours");
    expect(compte(), "la porte doit refuser AVANT tout appel de planificateur").toBe(0);

    // La décision est JOURNALISÉE — un refus silencieux serait invisible au diagnostic.
    const trace = await prisma.missionEvent.findFirst({ where: { missionId: id, kind: "REPLAN_SKIPPED" } });
    expect(trace).toBeTruthy();
  });

  it("signal ABSENT du journal → la porte reste OUVERTE : le planificateur est bien appelé", async () => {
    const id = await missionBloquee(`${TAG} porte ouverte`);
    // Le refus antérieur ne porte PAS le champ : mission d'avant le signal, ou juge en panne.
    await journaliser(id, "GOAL_UNSATISFIED", "Objectif NON atteint.", { qa: true });

    const { reasoner, compte } = espionReasoner();
    const r = await replanifierMission(user, id, { reasoner });

    // L'espion rend un échec : la replanification échoue proprement — mais elle a EU LIEU.
    expect(r.replanifie).toBe(false);
    expect(compte(), "sans signal, on ne ferme pas : l'absence de mesure n'est pas une mesure").toBeGreaterThanOrEqual(1);
  });

  it("un recours SUGGÉRÉ (chaîne non vide) laisse aussi la porte ouverte", async () => {
    const id = await missionBloquee(`${TAG} recours présent`);
    await journaliser(id, "GOAL_UNSATISFIED", "Objectif NON atteint.",
      { qa: true, recoursSuggere: "chercher aussi dans les courriers" });

    const { reasoner, compte } = espionReasoner();
    await replanifierMission(user, id, { reasoner });
    expect(compte()).toBeGreaterThanOrEqual(1);
  });
});
