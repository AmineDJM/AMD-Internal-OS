import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { ADAM_AGENT_NAME, agentPour, humainPour, tracerAction, tracesPour, verifierAvantAgir } from "./principal";
import { avancer } from "@/lib/missions/runtime/engine";
import { chargerEtat, materialiser } from "@/lib/missions/runtime/store";
import { compile } from "@/lib/missions/compiler/compile";
import type { MissionPlan } from "@/lib/missions/planner/contract";
import type { CapabilityCall, CapabilityCatalog, CapabilityOutcome } from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * §29-30 — L'AGENT NE PEUT PAS S'OUVRIR DE DROITS, ET L'AUDIT SAIT QUI A DEMANDÉ.
 *
 * Le test qui compte le plus est celui de la SECONDE garde : une étape interdite insérée
 * directement en base, sans passer par le compilateur, doit être refusée au moment d'agir.
 * C'est le scénario d'une réparation, d'une reprise, ou d'un chemin qu'on ouvrira plus tard.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__agent__${Date.now()}`;
let ownerId = "";

describe("l'identité de l'agent (pure)", () => {
  it("un acteur agent naît d'un MANDAT, jamais de rien", () => {
    const a = agentPour({ initiatedBy: "u1", executedBy: "u1", label: "le PDG" });
    expect(a.isAgent).toBe(true);
    expect(a.userId).toBe("u1");
    expect(a.label).toContain(ADAM_AGENT_NAME);
    expect(a.label).toContain("le PDG");
  });

  it("l'humain qui agit lui-même n'est PAS un agent", () => {
    expect(humainPour("u1", "le PDG").isAgent).toBe(false);
  });

  it("`isAgent` RETIRE des capacités, il n'en donne aucune", () => {
    const adam = agentPour({ initiatedBy: "u1", executedBy: "u1", label: "le PDG" });
    const pdg = humainPour("u1", "le PDG");

    expect(verifierAvantAgir("grant_permission", "SECURITY_ADMIN", adam).ok).toBe(false);
    // Le MÊME compte, sans le drapeau d'agent, y a droit : le drapeau ne fait que restreindre.
    expect(verifierAvantAgir("grant_permission", "SECURITY_ADMIN", pdg).ok).toBe(true);
  });

  it("le refus porte sa raison, exploitable par l'humain", () => {
    const adam = agentPour({ initiatedBy: "u1", executedBy: "u1", label: "le PDG" });
    const r = verifierAvantAgir("update_role", "INTERNAL_REVERSIBLE_WRITE", adam);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raison).toMatch(/modifier un rôle|SUPER_ADMIN/);
  });

  it("les capacités métier restent ouvertes à l'agent", () => {
    const adam = agentPour({ initiatedBy: "u1", executedBy: "u1", label: "le PDG" });
    for (const c of ["send_email", "employee_360", "directory_list", "create_task"]) {
      expect(verifierAvantAgir(c, "EXTERNAL_COMMUNICATION", adam).ok, c).toBe(true);
    }
  });
});

suite("§29-30 — la garde au moment d'agir, et la double signature", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    ownerId = u.id;
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("UNE ÉTAPE INTERDITE INSÉRÉE EN BASE est refusée à l'exécution, pas exécutée", async () => {
    const appels: CapabilityCall[] = [];
    const runner = {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        appels.push(call);
        return { ok: true, output: { ok: true } };
      },
    };

    // On compile un plan SAIN — le compilateur n'a rien à refuser.
    const catalogue: CapabilityCatalog = {
      has: (n) => ["directory_list", "grant_permission"].includes(n),
      allowed: () => true,
      meta: (n) => (n === "grant_permission"
        ? { ...capabilityMeta(n), effect: "SECURITY_ADMIN" as const }
        : capabilityMeta(n)),
      brief: () => [],
    };
    const plan: MissionPlan = {
      objective: "insertion directe", acceptance: ["fait"], complexity: "A", scale: "S",
      steps: [{ key: "sain", title: "Sain", capability: "directory_list" }],
    };
    const r = compile(plan, catalogue, humainPour(ownerId, "le PDG"));
    if (!r.ok) throw new Error("le plan sain aurait dû compiler");
    const id = await materialiser(r.mission, { ownerId, title: "Insertion", goalRaw: "x" });

    // PUIS on insère à la main une étape interdite — le chemin que le compilateur ne voit pas.
    await prisma.missionStep.create({
      data: {
        missionId: id, key: "interdite", title: "S'ouvrir des droits",
        nodeType: "CAPABILITY", capability: "grant_permission", status: "PENDING",
      },
    });

    const adam = agentPour({ initiatedBy: ownerId, executedBy: ownerId, label: "le PDG" });
    await avancer(id, adam, { runner, catalog: catalogue });

    // L'ÉTAPE SAINE EST PARTIE, L'INTERDITE NON.
    expect(appels.map((a) => a.capability)).toEqual(["directory_list"]);
    const etat = await chargerEtat(id);
    const interdite = etat!.steps.find((s) => s.key === "interdite")!;
    expect(interdite.status).toBe("FAILED");
    expect(interdite.errorKind).toBe("MISSING_PERMISSION");
    expect(interdite.error).toMatch(/structurellement interdite/);
    // NON REJOUABLE : insister ne fera pas apparaître le droit.
    expect(interdite.attempt).toBe(interdite.maxAttempts);
  }, 60_000);

  it("SANS catalogue, le moteur ne prétend PAS garder — et le laisse passer", async () => {
    const appels: CapabilityCall[] = [];
    const runner = {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        appels.push(call);
        return { ok: true, output: {} };
      },
    };
    const plan: MissionPlan = {
      objective: "sans catalogue", acceptance: ["fait"], complexity: "A", scale: "S",
      steps: [{ key: "a", title: "A", capability: "directory_list" }],
    };
    const cat: CapabilityCatalog = {
      has: (n) => n === "directory_list", allowed: () => true,
      meta: (n) => capabilityMeta(n), brief: () => [],
    };
    const r = compile(plan, cat, humainPour(ownerId, "le PDG"));
    if (!r.ok) throw new Error("plan refusé");
    const id = await materialiser(r.mission, { ownerId, title: "Sans catalogue", goalRaw: "x" });
    await prisma.missionStep.create({
      data: {
        missionId: id, key: "interdite", title: "Droits",
        nodeType: "CAPABILITY", capability: "grant_permission", status: "PENDING",
      },
    });

    const adam = agentPour({ initiatedBy: ownerId, executedBy: ownerId, label: "le PDG" });
    await avancer(id, adam, { runner });

    // LA LIMITE EST DITE, PAS CACHÉE : sans catalogue, la seconde garde n'existe pas, et seul
    // le compilateur protège. C'est pour cela que le champ est documenté comme il l'est.
    expect(appels.map((a) => a.capability).sort()).toEqual(["directory_list", "grant_permission"]);
  }, 60_000);

  it("§30 — la trace porte QUI A DEMANDÉ et QUI A EXÉCUTÉ, et se relit", async () => {
    const plan: MissionPlan = {
      objective: "trace", acceptance: ["fait"], complexity: "A", scale: "S",
      steps: [{ key: "a", title: "A", capability: "directory_list" }],
    };
    const cat: CapabilityCatalog = {
      has: () => true, allowed: () => true, meta: (n) => capabilityMeta(n), brief: () => [],
    };
    const r = compile(plan, cat, humainPour(ownerId, "le PDG"));
    if (!r.ok) throw new Error("plan refusé");
    const id = await materialiser(r.mission, { ownerId, title: "Trace", goalRaw: "x" });

    await tracerAction({
      mandat: { initiatedBy: ownerId, executedBy: ownerId, label: "le PDG" },
      missionId: id, stepKey: "a", capability: "send_email", receipt: "MSG-77",
    });

    const traces = await tracesPour(ownerId, id);
    expect(traces).toHaveLength(1);
    const d = traces[0].detail as Record<string, unknown>;
    expect(d.initiatedBy).toBe(ownerId);
    expect(d.executedBy).toBe(`${ADAM_AGENT_NAME}:${ownerId}`);
    expect(d.missionId).toBe(id);
    expect(d.capability).toBe("send_email");
    expect(d.receipt).toBe("MSG-77");
    expect(traces[0].summary).toMatch(/demandé par le PDG, exécuté par Adam/);
  }, 60_000);

  it("les traces d'un autre ne se lisent pas", async () => {
    const autre = await prisma.user.create({
      data: { name: `${TAG}b`, email: `${TAG}b@t.dz`, passwordHash: "x", role: "DIRECTION" },
    });
    expect(await tracesPour(autre.id)).toEqual([]);
    await prisma.user.delete({ where: { id: autre.id } });
  }, 30_000);
});
