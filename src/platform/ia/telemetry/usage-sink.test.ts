import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { withTurn, setTurnContext, recordModelCall, summarize } from "@/lib/models/telemetry";
import { compteurs, viderTampon } from "./usage-sink";

async function dbOk(): Promise<boolean> {
  try { await prisma.$queryRaw`SELECT 1`; return true; } catch { return false; }
}

const usage = (over: Partial<Parameters<typeof recordModelCall>[0]> = {}) => ({
  role: "orchestrator" as const, model: "gpt-5.6-terra", provider: "openai" as const,
  inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 600, reasoningTokens: 20,
  costUsd: 0.002, ms: 250, attempts: 1, ...over,
});

describe("puits d'usage — chaque appel de modèle devient une ligne, signée par son tour", () => {
  let ok = false;
  const turnIds: string[] = [];
  beforeAll(async () => { ok = await dbOk(); });
  afterAll(async () => {
    if (turnIds.length) await prisma.modelCallLog.deleteMany({ where: { turnId: { in: turnIds } } }).catch(() => undefined);
  });

  it("un appel DANS un tour porte personne, fil, mission et usage ; le résumé du tour additionne", async () => {
    if (!ok) return;
    const avant = compteurs.recues;
    const resume = await withTurn("text", async (trace) => {
      setTurnContext({ userId: "u-test", threadId: "t-test", feature: "assistant" });
      recordModelCall(usage());
      recordModelCall(usage({ role: "bulk", model: "gpt-5.6-luna", costUsd: 0.0001 }));
      turnIds.push(trace.turnId);
      return summarize(trace);
    });
    expect(compteurs.recues - avant).toBe(2);
    expect(resume.costUsd).toBeCloseTo(0.0021, 6);
    expect(resume.context).toEqual({ userId: "u-test", threadId: "t-test", feature: "assistant" });
    await viderTampon();
    const lignes = await prisma.modelCallLog.findMany({ where: { turnId: resume.turnId }, orderBy: { model: "asc" } });
    expect(lignes.map((l) => l.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(lignes[1]).toMatchObject({ userId: "u-test", threadId: "t-test", feature: "assistant", route: "text", inputTokens: 1_000, cachedInputTokens: 600, reasoningTokens: 20 });
    expect(Number(lignes[1].costUsd)).toBeCloseTo(0.002, 6);
  });

  it("un tarif inconnu reste NULL en base — jamais un zéro ; un appel sans consommation ne vaut pas une ligne", async () => {
    if (!ok) return;
    const id = await withTurn("background", async (trace) => {
      setTurnContext({ missionId: "m-test", feature: "mission" });
      recordModelCall(usage({ costUsd: null, model: "modele-sans-tarif" }));
      recordModelCall(usage({ inputTokens: 0, outputTokens: 0, attempts: 0 }));
      turnIds.push(trace.turnId);
      return trace.turnId;
    });
    await viderTampon();
    const lignes = await prisma.modelCallLog.findMany({ where: { turnId: id } });
    expect(lignes).toHaveLength(1);
    expect(lignes[0].costUsd).toBeNull();
    expect(lignes[0].missionId).toBe("m-test");
  });

  it("HORS de tout tour, l'appel est compté quand même — sans contexte", async () => {
    if (!ok) return;
    const avant = compteurs.recues;
    recordModelCall(usage({ model: "gpt-5.6-terra-hors-tour" }));
    expect(compteurs.recues - avant).toBe(1);
    await viderTampon();
    const ligne = await prisma.modelCallLog.findFirst({ where: { model: "gpt-5.6-terra-hors-tour" }, orderBy: { at: "desc" } });
    expect(ligne?.turnId).toBeNull();
    if (ligne) await prisma.modelCallLog.delete({ where: { id: ligne.id } });
  });
});
