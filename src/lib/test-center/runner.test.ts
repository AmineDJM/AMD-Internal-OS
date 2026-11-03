import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { executeRun } from "./runner";

// Environnement déterministe : ce test valide un mode d'écriture ; on force « development »
// pour ne pas dépendre de NODE_ENV (les gardes production sont testées ailleurs).
process.env.TEST_CENTER_ENV = "development";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `runnertest_${crypto.randomBytes(4).toString("hex")}`;

suite("Test Center — runner : run de bout en bout (création → nettoyage garanti → vérification)", () => {
  const runIds: string[] = [];
  let initiatorId = "";

  beforeAll(async () => {
    // Un run est toujours initié par un Super Admin réel : on en crée un (nettoyé en fin de test).
    const u = await prisma.user.create({
      data: { email: `initiator@${TAG}.invalid`, name: "Initiateur QA", passwordHash: bcrypt.hashSync("x", 4), role: "SUPER_ADMIN", isActive: false },
      select: { id: true },
    });
    initiatorId = u.id;
  });

  afterAll(async () => {
    // Filet de sécurité : on supprime NOS runs (cascade → artefacts + constats) et, par
    // prudence extrême, tout compte synthétique de ces runs qui aurait survécu (jamais attendu).
    for (const id of runIds) await retirerComptesEtSemis({ where: { email: { contains: `qa_${id}_` } } }).catch(() => {});
    for (const id of runIds) await prisma.testRun.delete({ where: { id } }).catch(() => {});
    if (initiatorId) await prisma.user.delete({ where: { id: initiatorId } }).catch(() => {});
  });

  it("SAFE_SYNTHETIC_TEST : crée des identités, exécute les smoke tests, puis nettoie et VÉRIFIE — 0 résidu", async () => {
    const res = await executeRun({ mode: "SAFE_SYNTHETIC_TEST", initiatedById: initiatorId });
    expect(res.ok).toBe(true);
    expect(res.runId).toBeTruthy();
    const runId = res.runId!;
    runIds.push(runId);

    const run = await prisma.testRun.findUniqueOrThrow({ where: { id: runId } });

    // 1) Des identités synthétiques ont bien été créées (une par rôle réel).
    expect(run.resourcesCreated).toBeGreaterThan(0);

    // 2) INVARIANT DE NETTOYAGE : tout ce qui a été créé a été supprimé.
    expect(run.resourcesDeleted).toBe(run.resourcesCreated);

    // 3) Le nettoyage est marqué vérifié.
    expect(run.cleanupStatus).toBe("DONE");

    // 4) Statut final concluant (PASSED, ou FAILED sur constat critique — jamais bloqué au nettoyage).
    expect(["PASSED", "FAILED"]).toContain(run.status);
    expect(run.progress).toBe(100);

    // 5) VÉRIFICATION RÉELLE EN BASE : aucun compte synthétique de ce run ne subsiste.
    const residual = await prisma.user.count({ where: { email: { contains: `qa_${runId}_` } } });
    expect(residual).toBe(0);

    // 6) Manifeste cohérent : chaque artefact est marqué supprimé (aucun en attente).
    const pending = await prisma.testArtifact.count({ where: { testRunId: runId, deletedAt: null } });
    expect(pending).toBe(0);

    // 7) Certification (§36) : un verdict est rendu et le paquet de preuves est scellé (hash).
    expect(run.certification).not.toBeNull();
    expect(["CERTIFIED", "CERTIFIED_WITH_RESERVATIONS", "BLOCKED", "INCONCLUSIVE"]).toContain(run.certification);
    expect(run.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  }, 90_000);

  it("READ_ONLY_AUDIT : aucune écriture, aucun nettoyage requis", async () => {
    const res = await executeRun({ mode: "READ_ONLY_AUDIT", initiatedById: initiatorId });
    expect(res.ok).toBe(true);
    const runId = res.runId!;
    runIds.push(runId);

    const run = await prisma.testRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.resourcesCreated).toBe(0);
    expect(run.resourcesDeleted).toBe(0);
    expect(run.cleanupStatus).toBe("NOT_REQUIRED");
    // LE VERDICT SE LIT SUR LA MÊME RÈGLE QUE CELLE QUE LE RUNNER APPLIQUE.
    //
    // Cette assertion ne lisait que `criticalCount` ; le runner conclut FAILED sur
    // `criticalCount > 0 || blockingFailures > 0`. Elle mesurait donc la moitié de la règle, et
    // le prix a été payé : une migration présente sur disque et absente de `_prisma_migrations`
    // a produit un constat HIGH bloquant, zéro CRITIQUE, et un test rouge qui accusait le
    // produit au lieu de nommer la vraie cause (§118.92 — « qu'est-ce que le juge a réellement
    // mesuré ? »). On lit les DEUX compteurs, et l'échec DIT lequel a parlé.
    const bloquants = (run.summary as { blockingFailures?: number } | null)?.blockingFailures ?? 0;
    const attendu = run.criticalCount > 0 || bloquants > 0 ? "FAILED" : "PASSED";
    expect(run.status, `critiques ${run.criticalCount}, bloquants ${bloquants}`).toBe(attendu);
    // Aucun artefact au manifeste pour un audit lecture seule.
    expect(await prisma.testArtifact.count({ where: { testRunId: runId } })).toBe(0);
  }, 60_000);
});
