import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { ReasonRequest } from "@/lib/missions/ports";
import { avancerMission, lancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, planScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { chargerEtat } from "@/lib/missions/runtime/store";
import { PLANNER_PROMPT_VERSION } from "@/lib/missions/planner/plan";
import { enseigner } from "@/platform/ia/teach/store";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { setTurnContext, summarize, withTurn } from "@/lib/models/telemetry";
import { ADAM_PROMPT_VERSION } from "@/lib/assistant/prompt-version";
import { consignerMesure } from "@/lib/evals/registre";
import { CHAMPS_ACTION, observabiliteMission } from "./observabilite";

/**
 * L'OBSERVABILITÉ PAR ACTION (§33), depuis le VRAI point d'entrée : une mission lancée par
 * `lancerMission`, conduite par `avancerMission`, puis relue par `observabiliteMission`. Chaque
 * action porte les treize champs du mandat — constatés, pas déduits : la version du prompt qui a
 * planifié, les règles enseignées servies, l'outil, la source et l'issue du reçu, la latence entre
 * les deux horodatages du reçu, la décision de permission, la certitude que le reçu autorise.
 * Côté conversation : un outil refusé par le droit est COMPTÉ sur le tour, et le tour porte la
 * version du prompt système.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__obs${Date.now().toString(36)}`;
let pdg: CurrentUser;
let lecteur: CurrentUser;
const criteres = ["L'annuaire a été lu."];

const juge = pour("mission.judge", (req: ReasonRequest) => {
  const cles = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return { ok: true, data: { satisfied: true, confidence: 0.9, criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: cles.slice(0, 3) })), missing: [], contradictions: [], suggestedRecovery: null } };
});

const plan = () => planScripte({
  goal: "Lire l'annuaire du service, puis contrôler.",
  reasoningComplexity: "A", executionScale: "S", acceptanceCriteria: criteres, workstreams: [],
  steps: [
    { key: "lecture", title: "Lire l'annuaire", nodeType: "CAPABILITY", capability: "directory_list",
      inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "20" }], dependsOn: [], completionCondition: "la liste est chargée" },
    { key: "controle", title: "Contrôle", nodeType: "QA", dependsOn: ["lecture"], completionCondition: "la lecture a eu lieu" },
  ],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteres[0], gaps: [], rationale: "banc de l'observabilité",
});

suite("observabilité par action — les treize champs, constatés depuis l'entrée de production", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const v = await prisma.user.create({ data: { name: `${TAG} Lecteur`, email: `${TAG}lecteur@amd.dz`, passwordHash: "x", role: "VIEWER" }, select: { id: true, name: true, email: true, role: true } });
    lecteur = { id: v.id, name: v.name, email: v.email, role: v.role, access: (await getAccess(v.id, v.role)) as EffectiveAccess, mustChangePassword: false };
    // Une règle enseignée : elle doit se retrouver dans « règle utilisée » de chaque action.
    const r = await enseigner(pdg, { statement: `${TAG} Toute lecture d'annuaire se limite aux comptes actifs.`, kind: "WORKFLOW", scope: "PERSON" });
    if (!r.ok) throw new Error(r.motif);
  }, 60_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.adamRule.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [pdg.id, lecteur.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("une mission conduite jusqu'au bout : chaque action porte les treize champs, la version du prompt, la règle servie, la décision de permission et la certitude du reçu", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan() })), juge]);
    const r = await lancerMission(pdg, "Lis l'annuaire du service, puis contrôle.", { reasoner: cerveau, sansEnquete: true });
    if (!r.ok) throw new Error(r.error);
    let etat = await chargerEtat(r.missionId);
    for (let tour = 0; tour < 15 && etat && !["COMPLETED", "FAILED", "CANCELLED", "BLOCKED", "PARTIAL"].includes(etat.status); tour++) {
      await avancerMission(pdg, r.missionId, { reasoner: cerveau });
      etat = await chargerEtat(r.missionId);
    }
    const journal = await prisma.missionEvent.findMany({ where: { missionId: r.missionId }, orderBy: { at: "asc" }, select: { kind: true, summary: true } });
    expect(etat?.status, `${JSON.stringify(etat?.steps.map((s) => [s.key, s.status, s.error]))}\n${journal.map((e) => `${e.kind} : ${e.summary}`).join("\n")}`).toBe("COMPLETED");

    const obs = await observabiliteMission(r.missionId, pdg.id);
    expect(obs).not.toBeNull();
    if (!obs) return;
    expect(obs.champs).toEqual(CHAMPS_ACTION);
    expect(obs.champs).toHaveLength(13);
    expect(obs.promptVersion).toBe(PLANNER_PROMPT_VERSION);
    expect(obs.reglesUtilisees.some((p) => p.includes(TAG))).toBe(true);
    expect(obs.actions.length).toBeGreaterThanOrEqual(2);

    const lecture = obs.actions.find((a) => a.etape === "lecture")!;
    expect(lecture).toMatchObject({ outil: "directory_list", statut: "DONE", nodeType: "CAPABILITY", decisionPermission: "ACCORDEE", certitude: "CERTAIN", erreur: null, promptVersion: PLANNER_PROMPT_VERSION });
    expect(lecture.tentatives).toBeGreaterThanOrEqual(1);
    expect(lecture.source).toBeTruthy();
    expect(["SUCCES", "VIDE"]).toContain(lecture.issue);
    expect(lecture.debut && lecture.fin).toBeTruthy();
    expect(lecture.latenceMs).not.toBeNull();
    expect(lecture.latenceMs!).toBeGreaterThanOrEqual(0);
    expect(lecture.reglesUtilisees.some((p) => p.includes(TAG))).toBe(true);
    const controle = obs.actions.find((a) => a.etape === "controle")!;
    expect(controle.decisionPermission).toBe("SANS_OBJET");

    // LA MESURE §33 : chaque action porte les treize champs (présents, même quand la valeur est un `null` constaté).
    const completes = obs.actions.filter((a) => CHAMPS_ACTION.every((c) => c in a));
    expect(completes).toHaveLength(obs.actions.length);
    consignerMesure("observabilite_actions", { n: obs.actions.length, ok: completes.length }, "platform/in-process/missions/observabilite.test.ts");

    // Cloisonnement : le journal d'une mission n'est lisible que par son propriétaire.
    expect(await observabiliteMission(r.missionId, lecteur.id)).toBeNull();
  }, 120_000);

  it("côté conversation : un outil refusé par le droit est compté sur le tour, et le tour porte la version du prompt système", async () => {
    expect(ADAM_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const resume = await withTurn("text", async (trace) => {
      setTurnContext({ userId: lecteur.id, feature: "assistant", promptVersion: ADAM_PROMPT_VERSION });
      const refus = await executePowerTool("executive_alerts", {}, lecteur);
      expect(refus).toMatch(/ne vous est pas ouvert/);
      return summarize(trace);
    });
    expect(resume.permissionsRefusees).toBe(1);
    expect(resume.context.promptVersion).toBe(ADAM_PROMPT_VERSION);
    const propre = await withTurn("text", async (trace) => { await executePowerTool("executive_alerts", {}, pdg); return summarize(trace); });
    expect(propre.permissionsRefusees).toBe(0);
  }, 60_000);
});
