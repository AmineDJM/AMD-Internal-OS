import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { ReasonRequest } from "@/lib/missions/ports";
import { lancerMission, replanifierMission } from "@/platform/in-process/missions/runtime";
import { conduireMission } from "@/platform/in-process/missions/sweep";
import { RaisonneurScripte, planScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { missionsAFaireAvancer } from "@/lib/missions/events/router";
import { PLANS_MAX_PLAT, REFUS_JUGE } from "@/lib/missions/runtime/replan";
import { journaliser } from "@/lib/missions/runtime/store";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BOUCLE JUGE → REPLAN → JUGE → NOTIFICATION, ET CE QUI L'ARRÊTE (§118.132).
 *
 * MESURÉ EN PRODUCTION : une mission de banc dont toutes les étapes aboutissaient et que le juge
 * refusait était replanifiée à chaque battement — chaque refus de juge passait pour un « motif
 * neuf » — jusqu'au plafond de douze plans, avec une notification « Bloqué » PAR VERSION DE
 * PLAN. Le dirigeant a fini par demander à bloquer tout Adam.
 *
 * Ce banc joue la séquence par le VRAI chemin du battement (`conduireMission`) avec un juge
 * scripté qui refuse toujours, et exige : un plan de correction et UN SEUL, deux notifications
 * au plus (une par plan jugé), puis la porte FERMÉE (`replanBloque`) — c'est-à-dire la sortie de
 * la sélection du battement. Le sabotage nommé : repasser `null` au lieu de `REFUS_JUGE` dans
 * `replanifierMissionInterne` fait grimper la version de plan à chaque tour.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__rjuge${Date.now()}`;
// UN CRITÈRE JUGÉ, PAS UNE RÈGLE : `[REGLE:AUCUNE_ECRITURE]` se vérifie arithmétiquement sur les
// reçus et l'objectif serait déclaré atteint SANS appeler le juge — le premier décor de ce banc
// l'a fait, et le scénario « le juge refuse » ne s'est jamais joué (§118.92).
const criteres = ["L'absence est démontrée par des preuves négatives distinctes pour Regulatory, PCH et Drive."];

/** Un juge qui REFUSE toujours, avec un recours suggéré — le cas exact du run de production. */
const jugeRefuse = pour("mission.judge", (_req: ReasonRequest) => ({
  ok: true,
  data: {
    satisfied: false, confidence: 0.9,
    criteria: criteres.map((c) => ({ criterion: c, status: "NON_DEMONTRE", evidenceRefs: [] })),
    missing: ["une recherche PCH effective avec la chaîne exacte"],
    contradictions: ["La conclusion d'absence est plus large que les preuves négatives disponibles."],
    suggestedRecovery: "Exécuter et tracer une recherche PCH effective, puis produire une conclusion révisée.",
  },
}));

const plan = () => planScripte({
  goal: "Prouver l'absence.", reasoningComplexity: "B", executionScale: "S", acceptanceCriteria: criteres, workstreams: [],
  steps: [
    { key: "liste", title: "Chercher", nodeType: "CAPABILITY", capability: "directory_list", inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "10" }], dependsOn: [], completionCondition: "la recherche est faite" },
    { key: "controle", title: "Contrôle", nodeType: "QA", dependsOn: ["liste"], completionCondition: "fini" },
  ],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteres[0], gaps: [], rationale: "banc",
});

let pdg: CurrentUser;
/** Le journal d'une mission, en une ligne par événement — ce qu'un échec doit MONTRER (§118.92). */
const journal = async (missionId: string): Promise<string> => {
  const rows = await prisma.missionEvent.findMany({ where: { missionId }, orderBy: { at: "asc" }, select: { kind: true, summary: true } });
  return rows.map((r) => `${r.kind}: ${r.summary.slice(0, 160)}`).join(" | ");
};
const notificationsBloque = (missionId: string) => prisma.missionEvent.count({
  where: { missionId, kind: "NOTIFIED", detail: { path: ["cle"], string_starts_with: "MISSION_BLOCKED:" } },
});

suite("un juge qui refuse deux fois de suite FERME la replanification — plus de boucle, plus de notification par plan", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
  }, 60_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("LE CAS DE PRODUCTION, PAR LE BATTEMENT : un replan, deux notifications au plus, puis la porte fermée", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan() })), jugeRefuse]);
    const r = await lancerMission(pdg, "Prouve qu'il n'y a rien sur cette molécule.", { reasoner: cerveau, lectureSeule: true, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    const id = r.missionId;
    const plansAuLancement = cerveau.appelsPour("mission.plan");
    expect(plansAuLancement).toBe(1);

    // TOUR 1 — le plan v1 est jugé et refusé ; le battement replanifie UNE fois ; le plan v2 est
    // jugé et refusé à son tour. C'est le tour que la production a joué douze fois.
    const t1 = await conduireMission(pdg, id, { reasoner: cerveau, maxTours: 25 });
    expect(t1.replanifie, `le premier refus de juge mérite une correction — journal : ${await journal(id)}`).toBe(true);
    let m = await prisma.mission.findUnique({ where: { id }, select: { status: true, planVersion: true, replanRefus: true, replanBloque: true } });
    expect(m?.status).toBe("BLOCKED");
    expect(m?.planVersion).toBe(2);
    expect(m?.replanRefus, "la cause du plan v2 est mémorisée pour reconnaître son retour").toBe(REFUS_JUGE);
    expect(m?.replanBloque).toBe(false);
    expect(cerveau.appelsPour("mission.plan")).toBe(plansAuLancement + 1);

    // TOUR 2 — le juge refuse le plan corrigé comme le précédent : RÉPÉTITION. Aucun plan de
    // plus n'est payé, la porte s'écrit, et le journal le dit.
    const t2 = await conduireMission(pdg, id, { reasoner: cerveau, maxTours: 25 });
    expect(t2.replanifie).toBe(false);
    m = await prisma.mission.findUnique({ where: { id }, select: { status: true, planVersion: true, replanRefus: true, replanBloque: true } });
    expect(m?.planVersion, "AUCUN troisième plan : le sabotage « null au lieu de REFUS_JUGE » ferait 3").toBe(2);
    expect(m?.replanBloque).toBe(true);
    expect(cerveau.appelsPour("mission.plan")).toBe(plansAuLancement + 1);
    const ferme = await prisma.missionEvent.findFirst({ where: { missionId: id, kind: "REPLAN_BLOCKED" }, select: { detail: true } });
    expect(ferme).toBeTruthy();
    expect((ferme?.detail as { motif?: string } | null)?.motif).toBe("REPETITION");

    // LA SÉLECTION DU BATTEMENT NE LA VOIT PLUS : c'est la fin de la boucle, comme propriété de la base.
    const candidates = await missionsAFaireAvancer(5000);
    expect(candidates).not.toContain(id);

    // TOUR 3 — un battement de plus ne change RIEN : ni plan, ni version, ni notification nouvelle.
    const notifsApresT2 = await notificationsBloque(id);
    await conduireMission(pdg, id, { reasoner: cerveau, maxTours: 25 });
    const m3 = await prisma.mission.findUnique({ where: { id }, select: { planVersion: true } });
    expect(m3?.planVersion).toBe(2);
    expect(cerveau.appelsPour("mission.plan")).toBe(plansAuLancement + 1);
    expect(await notificationsBloque(id)).toBe(notifsApresT2);

    // DEUX NOTIFICATIONS AU PLUS — une par plan jugé — là où la production en envoyait une par
    // version jusqu'à douze.
    expect(notifsApresT2).toBeLessThanOrEqual(2);
    expect(notifsApresT2, "le premier refus doit être signalé au moins une fois").toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("LE PLAFOND opérationnel FERME aussi la porte : sans cette écriture, la mission restait candidate à chaque battement", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan() })), jugeRefuse]);
    const r = await lancerMission(pdg, "Prouve encore qu'il n'y a rien.", { reasoner: cerveau, lectureSeule: true, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    const id = r.missionId;
    // L'état exact d'une mission arrivée au plafond : toutes les étapes abouties, BLOCKED, douze plans.
    await prisma.missionStep.updateMany({ where: { missionId: id }, data: { status: "DONE" } });
    await prisma.mission.update({ where: { id }, data: { status: "BLOCKED", planVersion: PLANS_MAX_PLAT, replanBloque: false } });
    await journaliser(id, "GOAL_UNSATISFIED", "Objectif NON atteint.", { qa: true, recoursSuggere: "encore une piste" });

    const avant = cerveau.appelsPour("mission.plan");
    const rp = await replanifierMission(pdg, id, { reasoner: cerveau });
    expect(rp.replanifie).toBe(false);
    expect(rp.raison).toMatch(/plafond/i);
    expect(cerveau.appelsPour("mission.plan"), "au plafond, aucun plan n'est payé").toBe(avant);
    const m = await prisma.mission.findUnique({ where: { id }, select: { replanBloque: true } });
    expect(m?.replanBloque, "le plafond s'ÉCRIT, sinon le battement reprend la mission pour la refuser à chaque minute").toBe(true);
    expect(await prisma.missionEvent.count({ where: { missionId: id, kind: "REPLAN_BLOCKED" } })).toBe(1);
  }, 120_000);

  it("« aucun recours » du juge FERME la porte, au lieu de réécrire la même ligne de journal à chaque battement", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan() })), jugeRefuse]);
    const r = await lancerMission(pdg, "Prouve une dernière fois qu'il n'y a rien.", { reasoner: cerveau, lectureSeule: true, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    const id = r.missionId;
    await prisma.missionStep.updateMany({ where: { missionId: id }, data: { status: "DONE" } });
    await prisma.mission.update({ where: { id }, data: { status: "BLOCKED" } });
    await journaliser(id, "GOAL_UNSATISFIED", "Objectif NON atteint — aucun recours.", { qa: true, recoursSuggere: null });

    const rp = await replanifierMission(pdg, id, { reasoner: cerveau });
    expect(rp.replanifie).toBe(false);
    expect(rp.raison).toMatch(/aucun recours/);
    const m = await prisma.mission.findUnique({ where: { id }, select: { replanBloque: true, replanRefus: true } });
    expect(m?.replanBloque).toBe(true);
    expect(m?.replanRefus).toBe(REFUS_JUGE);
    expect(await missionsAFaireAvancer(5000)).not.toContain(id);
  }, 120_000);
});
