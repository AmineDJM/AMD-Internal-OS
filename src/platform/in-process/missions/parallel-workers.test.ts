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
 * DEUX WORKERS D'UNE MÊME VAGUE SE CHEVAUCHENT RÉELLEMENT (§9, chantier latence).
 *
 * Le run réel n° 6 affichait « parallélisme entre appels : NON » — mais il n'avait qu'UN
 * worker : le séquentiel y était structurel entre phases, pas un défaut d'ordonnanceur. Ce
 * banc prouve la propriété qui n'avait jamais été MESURÉE : deux étapes WORKER sans
 * dépendance, plafond MODELE à 2 → leurs appels de modèle se RECOUVRENT dans le temps.
 *
 * Et le SABOTAGE (§22) : la même mission avec un plafond de 1 perd tout chevauchement — si
 * quelqu'un casse la classe MODELE de l'ordonnanceur, c'est le premier test qui tombe ; si
 * quelqu'un fait mentir le plafond, c'est le second.
 *
 * Le raisonneur est un RETARDATEUR maison : il note début/fin de chaque appel et répond une
 * sortie CONFORME au schéma demandé après un délai fixe. On prouve la STRUCTURE (le
 * recouvrement), jamais une latence réelle — celle-ci se mesure sur Render (§21 : aucun mock
 * présenté comme latence réelle).
 *
 * Les critères de la mission sont TOUT-RÈGLES : elle doit CONCLURE sans que le purpose
 * `mission.judge` n'atteigne jamais le raisonneur — le juge hybride (L2), prouvé cette fois
 * dans le moteur COMPLET, depuis le vrai point d'entrée (§14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__parwork${Date.now()}`;

const catalogue: CapabilityCatalog = {
  // Une lecture réelle est CONNUE du catalogue : le compilateur refuse un plan fait uniquement de
  // travaux de modèle (il ne pourrait répondre que de mémoire). Elle ne touche pas ce qu'on mesure
  // ici — la lecture n'est pas de classe MODELE, elle ne prend donc rien au plafond des workers.
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

const planDeuxWorkers = (objectif: string): MissionPlan => ({
  objective: objectif,
  acceptance: ["[REGLE:AUCUNE_ECRITURE] Aucun effet au-delà d'ANALYZE — mission d'analyse pure."],
  complexity: "B",
  scale: "S",
  steps: [
    { key: "source", title: "Lire l'annuaire", capability: "directory_list", input: {}, dependsOn: [], approvalRequirement: "NONE", reasoningRequirement: "NONE" },
    { key: "note-a", title: "Rédiger la note A", nodeType: "WORKER", dependsOn: [], approvalRequirement: "NONE", reasoningRequirement: "LIGHT", expectedOutputSchema: SCHEMA_NOTE },
    { key: "note-b", title: "Rédiger la note B", nodeType: "WORKER", dependsOn: [], approvalRequirement: "NONE", reasoningRequirement: "LIGHT", expectedOutputSchema: SCHEMA_NOTE },
  ],
  workstreams: [],
  expectedArtifacts: [],
  approvalStrategy: "BUNDLE",
  gaps: [],
});

/** Le RETARDATEUR : répond conforme après `delaiMs`, et note chaque fenêtre d'appel. */
function retardateur(delaiMs: number) {
  const fenetres: { purpose: string; debut: number; fin: number }[] = [];
  const reasoner: Reasoner = {
    configured: () => true,
    reason: async <T>(req: ReasonRequest) => {
      const debut = Date.now();
      await new Promise((r) => setTimeout(r, delaiMs));
      const fin = Date.now();
      fenetres.push({ purpose: req.purpose, debut, fin });
      return { ok: true, data: { note: `note (${req.purpose})` } as T, usage: null, latencyMs: fin - debut };
    },
  };
  return { reasoner, fenetres };
}

const chevauchent = (xs: { debut: number; fin: number }[]): boolean =>
  xs.some((a, i) => xs.some((b, j) => i !== j && a.debut < b.fin && b.debut < a.fin));

suite("le parallélisme MODÈLE, mesuré — et son sabotage", () => {
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

  async function missionDeuxWorkers(titre: string, maxConcurrency: number): Promise<string> {
    const acteur: MissionActor = { userId: user.id, label: user.name, isAgent: false };
    const r = compile(planDeuxWorkers(`${titre} — objectif d'analyse`), catalogue, acteur);
    if (!r.ok) throw new Error(`fixture non compilable : ${JSON.stringify(r.issues)}`);
    const id = await materialiser(r.mission, {
      ownerId: user.id, title: titre, goalRaw: `${titre} — objectif d'analyse`, maxConcurrency,
    });
    missions.push(id);
    return id;
  }

  it("plafond MODELE à 2 : les deux appels worker se RECOUVRENT, la mission conclut SANS juge", async () => {
    const id = await missionDeuxWorkers(`${TAG} parallèle`, 2);
    const { reasoner, fenetres } = retardateur(200);

    await avancerMission(user, id, { reasoner });

    const workers = fenetres.filter((f) => f.purpose === "mission.worker");
    expect(workers).toHaveLength(2);
    expect(chevauchent(workers), "deux workers indépendants d'une même vague doivent partir de front").toBe(true);

    // Le juge hybride, depuis le VRAI moteur : critères tout-règles → `mission.judge` n'a
    // jamais atteint le raisonneur, et la mission a quand même CONCLU.
    expect(fenetres.map((f) => f.purpose)).not.toContain("mission.judge");
    const m = await prisma.mission.findUnique({ where: { id }, select: { status: true, goalSatisfied: true } });
    expect(m?.status).toBe("COMPLETED");
    expect(m?.goalSatisfied).toBe(true);
  }, 30_000);

  it("SABOTAGE — plafond MODELE à 1 : le chevauchement disparaît, la durée s'additionne", async () => {
    const id = await missionDeuxWorkers(`${TAG} séquentiel`, 1);
    const { reasoner, fenetres } = retardateur(200);

    await avancerMission(user, id, { reasoner });

    const workers = fenetres.filter((f) => f.purpose === "mission.worker");
    expect(workers).toHaveLength(2);
    expect(chevauchent(workers), "avec un plafond de 1, aucun appel ne doit en recouvrir un autre").toBe(false);
  }, 30_000);
});
