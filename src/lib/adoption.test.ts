import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAdoptionScores, captureAdoptionSnapshots, getUserScoreHistory, type AdoptionScore } from "./adoption";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__adopttest__";
const comp = (s: AdoptionScore, key: string) => s.components.find((c) => c.key === key)!.score;

suite("Score d'adoption — robustesse au gaming", () => {
  let churnerId = "", workerId = "", regularId = "", bursterId = "";

  beforeAll(async () => {
    const mk = (s: string) => prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: "VIEWER", passwordHash: "x" } });
    const [a, b, c, d] = await Promise.all([mk("churner"), mk("worker"), mk("regular"), mk("burster")]);
    churnerId = a.id; workerId = b.id; regularId = c.id; bursterId = d.id;

    const now = Date.now();

    // CHURNER : crée puis supprime 50 tâches → seulement des traces d'audit
    // CREATE/DELETE, AUCUNE tâche survivante (le gaming classique).
    await prisma.auditLog.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        actorId: churnerId, action: (i % 2 === 0 ? "CREATE" : "DELETE") as never,
        module: "Espace de travail", entityType: "TASK" as never, createdAt: new Date(now - 3600000),
      })),
    });

    // WORKER : 10 tâches RÉELLEMENT terminées (lignes survivantes, completedAt).
    await prisma.task.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        title: `${TAG} done ${i}`, assignedToId: workerId, createdById: workerId,
        status: "DONE" as never, completedAt: new Date(now - 86400000),
      })),
    });

    // REGULAR : actif sur 15 jours DISTINCTS (1 vue par jour).
    await prisma.activityLog.createMany({
      data: Array.from({ length: 15 }, (_, i) => ({
        userId: regularId, type: "PAGE_VIEW", module: "DASHBOARD", createdAt: new Date(now - i * 86400000),
      })),
    });

    // BURSTER : 100 vues le MÊME jour (tentative de gonfler par le volume).
    await prisma.activityLog.createMany({
      data: Array.from({ length: 100 }, () => ({
        userId: bursterId, type: "PAGE_VIEW", module: "DASHBOARD", createdAt: new Date(now - 3600000),
      })),
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("créer puis supprimer des tâches ne crédite AUCUN travail durable", async () => {
    const { scores } = await getAdoptionScores();
    const churner = scores.find((s) => s.userId === churnerId)!;
    const worker = scores.find((s) => s.userId === workerId)!;
    // Le churner a 50 actions d'audit mais 0 tâche survivante → durable = 0.
    expect(comp(churner, "durable")).toBe(0);
    // Le worker a 10 tâches réellement terminées → durable > 0.
    expect(comp(worker, "durable")).toBeGreaterThan(0);
    // Accomplir un vrai travail bat le churn.
    expect(worker.score).toBeGreaterThan(churner.score);
  });

  it("la régularité compte les JOURS distincts, pas le volume d'un seul jour", async () => {
    const { scores } = await getAdoptionScores();
    const regular = scores.find((s) => s.userId === regularId)!;
    const burster = scores.find((s) => s.userId === bursterId)!;
    expect(regular.activeDays).toBe(15);
    expect(burster.activeDays).toBe(1); // 100 vues, un seul jour
    expect(comp(regular, "regularity")).toBeGreaterThan(comp(burster, "regularity"));
    expect(regular.score).toBeGreaterThan(burster.score);
  });

  it("tous les scores sont bornés 0–100 et la moyenne est calculée", async () => {
    const { scores, average } = await getAdoptionScores();
    for (const s of scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
    expect(average).toBeGreaterThanOrEqual(0);
    expect(average).toBeLessThanOrEqual(100);
  });
});

const HTAG = "__adopthist__";
const mkScore = (userId: string, score: number): AdoptionScore => ({
  userId, name: "x", email: "x", role: "VIEWER", isActive: true,
  score, label: "", tone: "neutral", activeDays: 0, lastSeen: null, trend: 0, scoreTrend: 0, components: [],
});

suite("Score d'adoption — historique stocké (monte ET descend)", () => {
  let uid = "";
  const dayUtc = (back: number) => { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - back)); };

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${HTAG}u`, email: `${HTAG}u@t.dz`, role: "VIEWER", passwordHash: "x" } });
    uid = u.id;
  });
  afterAll(async () => {
    await prisma.adoptionSnapshot.deleteMany({ where: { userId: uid } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: HTAG } } }).catch(() => {});
  });

  it("capture idempotente : un seul instantané par jour, mis à jour", async () => {
    await captureAdoptionSnapshots([mkScore(uid, 40)]);
    await captureAdoptionSnapshots([mkScore(uid, 55)]); // même jour → upsert
    const today = dayUtc(0);
    const rows = await prisma.adoptionSnapshot.findMany({ where: { userId: uid, day: today } });
    expect(rows.length).toBe(1);
    expect(rows[0].score).toBe(55);
  });

  it("l'historique reflète une BAISSE puis une HAUSSE", async () => {
    // Jours antérieurs : 60 (J-2) → 30 (J-1) → 55 (aujourd'hui, déjà capturé).
    await prisma.adoptionSnapshot.create({ data: { userId: uid, day: dayUtc(2), score: 60, activeDays: 0 } });
    await prisma.adoptionSnapshot.create({ data: { userId: uid, day: dayUtc(1), score: 30, activeDays: 0 } });
    const hist = await getUserScoreHistory(uid, 30);
    const vals = hist.map((h) => h.value);
    expect(vals).toEqual([60, 30, 55]); // ordonné par jour croissant
    const hasDrop = vals.some((v, i) => i > 0 && v < vals[i - 1]);
    const hasRise = vals.some((v, i) => i > 0 && v > vals[i - 1]);
    expect(hasDrop).toBe(true);
    expect(hasRise).toBe(true);
  });
});
