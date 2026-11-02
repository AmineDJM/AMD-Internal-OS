import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/rbac";
import type { UserRole } from "@prisma/client";
import { guardMode } from "./guard";
import { WRITE_MODES, type RunConfig, type TestRunMode, type FindingInput } from "./types";
import { seedSyntheticUsers } from "./synthetic";
import { cleanupRun, verifyClean } from "./manifest";
import { smokeFindings } from "./smoke";
import { deepAudit } from "./deep-audit";
import { infraChecks } from "./infra-checks";
import { godModeSelfValidation } from "./god";
import { computeCertification } from "./certify";
import { buildEvidence, fingerprintFindings } from "./evidence";
import { differential, type Metrics } from "./differential";
import { redact } from "./redact";
import { sansBloquer } from "@/lib/journal";

/**
 * Orchestrateur d'un run (phase 1). Cycle : préflight → (identités synthétiques) → smoke
 * → **nettoyage garanti** → **vérification post-nettoyage** → clôture. Toute exception
 * tente quand même le nettoyage (sûreté) avant de marquer l'état. Aucune donnée
 * préexistante n'est touchée : seules les ressources du manifeste sont supprimées.
 */

function gitInfo() {
  return {
    commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
    branch: process.env.RENDER_GIT_BRANCH ?? process.env.GIT_BRANCH ?? null,
  };
}

export interface RunResult { ok: boolean; runId?: string; error?: string }

export async function executeRun(opts: { mode: TestRunMode; initiatedById: string; config?: RunConfig }): Promise<RunResult> {
  const config = opts.config ?? {};
  const guard = guardMode(opts.mode, config);
  if (!guard.ok) return { ok: false, error: guard.error };

  const writes = WRITE_MODES.includes(opts.mode);
  const git = gitInfo();
  const run = await prisma.testRun.create({
    data: {
      mode: opts.mode, environment: guard.environment, status: "RUNNING",
      cleanupStatus: writes ? "PENDING" : "NOT_REQUIRED",
      initiatedById: opts.initiatedById, gitCommit: git.commit, gitBranch: git.branch,
      config: redact(config) as object, step: "préflight",
    },
    select: { id: true },
  });
  const runId = run.id;

  try {
    // 1) Identités synthétiques (modes d'écriture) : un compte INACTIF par rôle réel.
    let created = 0;
    if (writes) {
      await prisma.testRun.update({ where: { id: runId }, data: { step: "création des identités synthétiques", progress: 20 } });
      const roles = Object.keys(PERMISSIONS) as UserRole[];
      created = (await seedSyntheticUsers(runId, roles)).length;
    }

    // 2) Smoke (santé + cohérence).
    await prisma.testRun.update({ where: { id: runId }, data: { step: "smoke — santé & cohérence", progress: 50 } });
    const smoke = await smokeFindings();
    await persistFindings(runId, smoke.findings);

    // 2b) Audit approfondi : invariants métier (§28) + machines à états (§29) + couverture.
    await prisma.testRun.update({ where: { id: runId }, data: { step: "audit approfondi — invariants & machines à états", progress: 60 } });
    const deep = await deepAudit();
    await persistFindings(runId, deep.findings);

    // 2c) Infra : cohérence multi-oracles (§30) + migrations/reprise (§35, roundtrip si écriture).
    await prisma.testRun.update({ where: { id: runId }, data: { step: "cohérence multi-oracles & certification migrations", progress: 72 } });
    const infra = await infraChecks(runId, writes);
    await persistFindings(runId, infra.findings);

    // 2d) GOD MODE — auto-validation du testeur (§27/§33/§34) : PBT, mutation, métamorphique,
    //     fuzzing, instabilité, minimisation, time-travel. Pur (aucune écriture).
    await prisma.testRun.update({ where: { id: runId }, data: { step: "auto-validation du testeur (mutation, propriétés, fuzz, time-travel)", progress: 88 } });
    const god = godModeSelfValidation();
    await persistFindings(runId, god.findings);

    const allFindings = [...smoke.findings, ...deep.findings, ...infra.findings, ...god.findings];
    const criticalCount = allFindings.filter((f) => f.severity === "CRITICAL").length;
    const blockingFailures = deep.blockingFailures + infra.blockingFailures + god.blockingFailures;

    // 3) Nettoyage garanti + vérification.
    let cleanupStatus: "DONE" | "INCOMPLETE" | "NOT_REQUIRED" = "NOT_REQUIRED";
    let deleted = 0;
    if (writes) {
      await prisma.testRun.update({ where: { id: runId }, data: { step: "nettoyage", cleanupStatus: "RUNNING", progress: 82 } });
      const clean = await cleanupRun(runId);
      deleted = clean.deleted;
      const verify = await verifyClean(runId);
      cleanupStatus = verify.clean && clean.errors === 0 ? "DONE" : "INCOMPLETE";
      if (!verify.clean) {
        await persistFindings(runId, [{ severity: "CRITICAL", category: "cleanup", title: "Nettoyage incomplet", detail: `${verify.residuals.length} ressource(s) synthétique(s) subsistent après nettoyage — intervention requise.`, evidence: verify.residuals, confidence: "high" }]);
      }
    }

    const status = cleanupStatus === "INCOMPLETE" ? "CLEANUP_INCOMPLETE" : criticalCount > 0 || blockingFailures > 0 ? "FAILED" : "PASSED";
    const findingsCount = allFindings.length + (cleanupStatus === "INCOMPLETE" ? 1 : 0);
    const bySev = (s: string) => allFindings.filter((f) => f.severity === s).length;
    const findingCounts = { critical: criticalCount, high: bySev("HIGH"), medium: bySev("MEDIUM"), low: bySev("LOW"), info: bySev("INFO") };

    // 4) Certification (§36) — verdict + différentiel (§32) + paquet de preuves immuable.
    await prisma.testRun.update({ where: { id: runId }, data: { step: "certification & paquet de preuves", progress: 95 } });
    const cert = computeCertification({
      criticalCount, blockingFailures, cleanupStatus,
      selfValidationOk: god.selfValidationOk, invariantsSkipped: deep.invariants.skipped,
      migrationsChecked: infra.migration.migrationsChecked, findingCounts,
    });

    const candidateMetrics: Metrics = {
      score: smoke.score ?? null, criticalCount, findingsCount,
      blockingFailures, transitionCoverage: deep.coverage.transition,
      businessObjectCoverage: deep.coverage.business.coverage, mutationKillRate: god.mutation.killRate,
    };
    const prev = await prisma.testRun.findFirst({
      where: { id: { not: runId }, finishedAt: { not: null } },
      orderBy: { finishedAt: "desc" },
      select: { id: true, gitCommit: true, score: true, criticalCount: true, findingsCount: true, summary: true },
    });
    const diff = differential(candidateMetrics, prev ? metricsFromRun(prev) : null, {
      baselineRunId: prev?.id ?? null, baselineCommit: prev?.gitCommit ?? null, candidateCommit: git.commit,
    });

    const summary = {
      mode: opts.mode, smokeCoverage: smoke.coverage, blockingFailures,
      invariants: { total: deep.invariants.total, passed: deep.invariants.passed, failed: deep.invariants.failed, skipped: deep.invariants.skipped },
      transitionCoverage: deep.coverage.transition, businessObjectCoverage: deep.coverage.business.coverage,
      rbacGrantDensity: deep.coverage.rbac.grantDensity,
      oracleDisagreements: infra.oracles.disagreements,
      migrations: { onDisk: infra.migration.onDisk, applied: infra.migration.applied, missing: infra.migration.missing.length },
      backupRestoreOk: infra.migration.backupRestore?.ok ?? null,
      selfValidation: {
        ok: god.selfValidationOk, mutationKillRate: god.mutation.killRate, mutationsSurvived: god.mutation.survived,
        propertiesFailed: god.properties.failed, metamorphicFailed: god.metamorphic.failed,
        fuzzCrashes: god.fuzz.crashes, fuzzSecurityBreaches: god.fuzz.securityBreaches,
        flaky: god.flaky.flakyCount, reproducibility: god.flaky.reproducibility, timeTravelOk: god.timeTravel.ok,
      },
      certification: cert.status, certificationReasons: cert.reasons,
    };

    const evidence = buildEvidence({
      runId, mode: opts.mode, environment: guard.environment, commit: git.commit, branch: git.branch,
      config: redact(config), coverage: { transition: deep.coverage.transition, business: deep.coverage.business.coverage, rbacGrantDensity: deep.coverage.rbac.grantDensity, invariants: deep.invariants },
      results: { findingCounts, status, blockingFailures, selfValidation: summary.selfValidation, oracles: { disagreements: infra.oracles.disagreements } },
      manifest: { created, deleted, cleanupStatus, artifacts: created },
      certification: cert.status, certificationReasons: cert.reasons,
      exclusions: buildExclusions(opts.mode, guard.environment),
      findingsFingerprint: fingerprintFindings(allFindings.map((f) => ({ severity: f.severity, title: f.title, category: f.category }))),
    });

    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status, cleanupStatus, finishedAt: new Date(), progress: 100, step: "terminé",
        score: smoke.score, criticalCount, findingsCount, resourcesCreated: created, resourcesDeleted: deleted,
        certification: cert.status, evidenceHash: evidence.hash,
        summary: redact(summary) as object,
        evidence: redact(evidence) as object,
        differential: diff as unknown as object,
      },
    });
    await recordAudit({ actorId: opts.initiatedById, action: "UPDATE", module: "Administration", summary: `Test Center — run ${runId.slice(0, 8)} (${opts.mode}) : ${cert.status} · ${status} · ${created} créées / ${deleted} supprimées` });
    return { ok: true, runId };
  } catch (e) {
    // Sûreté : on TENTE le nettoyage même en cas d'échec inattendu.
    let cleanupStatus: "DONE" | "INCOMPLETE" | "NOT_REQUIRED" = writes ? "INCOMPLETE" : "NOT_REQUIRED";
    if (writes) {
      try { await cleanupRun(runId); cleanupStatus = (await verifyClean(runId)).clean ? "DONE" : "INCOMPLETE"; } catch { cleanupStatus = "INCOMPLETE"; }
    }
    await prisma.testRun.update({
      where: { id: runId },
      data: { status: cleanupStatus === "INCOMPLETE" ? "CLEANUP_INCOMPLETE" : "FAILED", cleanupStatus, finishedAt: new Date(), step: "erreur", certification: cleanupStatus === "INCOMPLETE" ? "BLOCKED" : "INCONCLUSIVE", summary: redact({ error: (e as Error).message }) as object },
    }).catch(sansBloquer("test-center-runner.executeRun.testRun"));
    return { ok: false, runId, error: (e as Error).message };
  }
}

/** Métriques comparables d'un run passé (pour le différentiel §32). */
function metricsFromRun(r: { score: number | null; criticalCount: number; findingsCount: number; summary: unknown }): Metrics {
  const s = (r.summary ?? {}) as Record<string, unknown>;
  const sv = (s.selfValidation ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    score: r.score ?? null,
    criticalCount: r.criticalCount,
    findingsCount: r.findingsCount,
    blockingFailures: typeof s.blockingFailures === "number" ? s.blockingFailures : 0,
    transitionCoverage: num(s.transitionCoverage),
    businessObjectCoverage: num(s.businessObjectCoverage),
    mutationKillRate: num(sv.mutationKillRate),
  };
}

/** Ce que le run N'A PAS testé (exclusions §36) — jamais présenté comme couvert. */
function buildExclusions(mode: TestRunMode, environment: string): string[] {
  const ex = [
    "Parcours navigateur réels (UX / responsive / accessibilité) — mesurés hors app via autotest:live.",
    "Envois d'e-mails / SMS / notifications réels — jamais déclenchés.",
    "Paiements et écritures irréversibles réels — jamais déclenchés.",
  ];
  if (!WRITE_MODES.includes(mode)) ex.push("Création de données synthétiques — mode lecture seule.");
  if (environment === "production") ex.push("Opérations destructives en production — lecture seule par défaut.");
  return ex;
}

async function persistFindings(runId: string, findings: FindingInput[]) {
  if (!findings.length) return;
  await prisma.testFinding.createMany({
    data: findings.map((f) => ({
      testRunId: runId, severity: f.severity, category: f.category, module: f.module ?? null, route: f.route ?? null,
      roleTested: f.roleTested ?? null, title: f.title, detail: f.detail,
      evidence: f.evidence === undefined ? undefined : (redact(f.evidence) as object),
      suggestion: f.suggestion ?? null, confidence: f.confidence ?? null,
    })),
  });
}
