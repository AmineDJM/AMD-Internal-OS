import { prisma } from "@/lib/prisma";
import type { FindingInput } from "../types";
import { STATE_MACHINES } from "../state-machines/registry";
import { sansBloquer } from "@/lib/journal";

/**
 * Cohérence multi-oracles (§30). Un même fait, vu par plusieurs sous-systèmes, doit concorder.
 * Oracles réellement disponibles in-app : base (Prisma, vérité), énumération par état, module
 * finance (ordres de dépense) et journal d'audit. Toute divergence non autorisée est signalée.
 * Lecture seule.
 */

type Delegate = { count: (a: unknown) => Promise<number>; findMany: (a: unknown) => Promise<Record<string, unknown>[]> };
function delegate(model: string): Delegate | null {
  const d = (prisma as unknown as Record<string, Delegate>)[model];
  return d && typeof d.count === "function" ? d : null;
}

export interface OracleCheck {
  id: string;
  label: string;
  oracles: string[];
  agree: boolean;
  detail: string;
  skipped?: boolean;
}

/** Oracle 1 : pour chaque machine, Σ(comptes par état déclaré) === total (détecte les états hors-enum). */
async function statusSumConsistency(): Promise<{ checks: OracleCheck[]; findings: FindingInput[] }> {
  const checks: OracleCheck[] = [];
  const findings: FindingInput[] = [];
  for (const m of STATE_MACHINES) {
    const del = delegate(m.model);
    if (!del) { checks.push({ id: `ORA-SUM-${m.id}`, label: m.label, oracles: ["énumération", "total"], agree: true, detail: "modèle indisponible", skipped: true }); continue; }
    const total = await del.count({}).catch(sansBloquer("consistency.statusSumConsistency.count", -1));
    if (total < 0) { checks.push({ id: `ORA-SUM-${m.id}`, label: m.label, oracles: ["énumération", "total"], agree: true, detail: "comptage impossible", skipped: true }); continue; }
    let sum = 0, countError = false;
    for (const s of m.states) {
      const n = await del.count({ where: { [m.statusField]: s } }).catch(sansBloquer("consistency.statusSumConsistency.count", null)); // null = état hors-enum (déclaration à corriger, PAS une anomalie donnée)
      if (n === null) { countError = true; break; }
      sum += n;
    }
    if (countError) { checks.push({ id: `ORA-SUM-${m.id}`, label: m.label, oracles: ["énumération par état", "total"], agree: true, detail: "énumération d'états incompatible avec la base (déclaration à revoir)", skipped: true }); continue; }
    const agree = sum === total;
    checks.push({ id: `ORA-SUM-${m.id}`, label: m.label, oracles: ["énumération par état", "total"], agree, detail: `Σétats=${sum} vs total=${total}` });
    if (!agree) {
      findings.push({
        severity: "HIGH", category: "oracle", module: m.module,
        title: `États hors-énumération (${m.label})`,
        detail: `${total - sum} enregistrement(s) « ${m.model} » portent un statut absent de l'énumération déclarée — divergence entre l'oracle « par état » et l'oracle « total ».`,
        suggestion: "Recenser ces statuts inattendus (migration incomplète ou écriture directe) et compléter/corriger.",
        confidence: "high",
      });
    }
  }
  return { checks, findings };
}

/** Oracle 2 : tout `expenseOrderId` référencé par un module métier existe côté finance. */
async function expenseLinkConsistency(): Promise<{ checks: OracleCheck[]; findings: FindingInput[] }> {
  const models = ["sponsoringRequest", "congressInternational", "congressNational", "medicalInfoDeclaration", "event"];
  const eo = delegate("expenseOrder");
  const checks: OracleCheck[] = [];
  const findings: FindingInput[] = [];
  if (!eo) return { checks: [{ id: "ORA-EXP-LINK", label: "Liens ordres de dépense", oracles: ["module", "finance"], agree: true, detail: "finance indisponible", skipped: true }], findings };

  let totalRefs = 0, totalMissing = 0;
  for (const model of models) {
    const del = delegate(model);
    if (!del) continue;
    const rows = await del.findMany({ select: { expenseOrderId: true }, distinct: ["expenseOrderId"], take: 10000 }).catch(sansBloquer("consistency.expenseLinkConsistency.findMany", null));
    if (!rows) continue;
    const ids = [...new Set(rows.map((r) => r.expenseOrderId).filter(Boolean) as string[])];
    if (ids.length === 0) continue;
    const existing = await eo.count({ where: { id: { in: ids } } }).catch(sansBloquer("consistency.expenseLinkConsistency.expenseOrder", ids.length));
    totalRefs += ids.length;
    totalMissing += ids.length - existing;
  }
  const agree = totalMissing === 0;
  checks.push({ id: "ORA-EXP-LINK", label: "Liens module métier → ordre de dépense", oracles: ["module métier", "finance"], agree, detail: `${totalRefs} lien(s), ${totalMissing} manquant(s)` });
  if (!agree) {
    findings.push({
      severity: "HIGH", category: "oracle", module: "FINANCES",
      title: "Liens ordres de dépense pendants",
      detail: `${totalMissing} référence(s) d'ordre de dépense pointent vers un ordre inexistant — le module métier et la finance ne concordent pas.`,
      suggestion: "Un ordre de dépense a été supprimé sans nettoyer la référence amont, ou l'émission a échoué à mi-chemin.",
      confidence: "high",
    });
  }
  return { checks, findings };
}

/** Oracle 3 (info) : couverture d'audit — les décisions de validation sont-elles tracées ? */
async function auditCoverageConsistency(): Promise<{ checks: OracleCheck[]; findings: FindingInput[] }> {
  const vr = delegate("validationRequest");
  if (!vr) return { checks: [], findings: [] };
  const decided = await vr.count({ where: { NOT: { decidedAt: null } } }).catch(sansBloquer("consistency.auditCoverageConsistency.count", -1));
  if (decided < 0) return { checks: [], findings: [] };
  const audited = await prisma.auditLog.count({ where: { field: "status", newValue: { in: ["APPROVED", "REJECTED"] }, module: { contains: "alidation" } } }).catch(sansBloquer("consistency.auditCoverageConsistency.auditLog", -1));
  const checks: OracleCheck[] = [];
  const findings: FindingInput[] = [];
  if (audited < 0) return { checks, findings };
  // L'audit est best-effort : on ne signale qu'un écart marquant, et seulement en info.
  const agree = decided === 0 || audited >= decided * 0.5;
  checks.push({ id: "ORA-AUDIT-VAL", label: "Couverture d'audit des validations", oracles: ["base", "journal d'audit"], agree, detail: `${decided} décision(s), ${audited} trace(s) d'audit` });
  if (!agree) {
    findings.push({
      severity: "INFO", category: "oracle", module: "VALIDATIONS",
      title: "Couverture d'audit faible sur les décisions de validation",
      detail: `${decided} demande(s) décidée(s) mais seulement ${audited} changement(s) de statut tracé(s) dans l'audit. L'audit est best-effort ; écart à qualifier.`,
      confidence: "low",
    });
  }
  return { checks, findings };
}

export interface OracleReport { checks: OracleCheck[]; findings: FindingInput[]; disagreements: number }

export async function runOracles(): Promise<OracleReport> {
  const parts = await Promise.all([statusSumConsistency(), expenseLinkConsistency(), auditCoverageConsistency()]);
  const checks = parts.flatMap((p) => p.checks);
  const findings = parts.flatMap((p) => p.findings);
  const disagreements = checks.filter((c) => !c.agree && !c.skipped).length;
  return { checks, findings, disagreements };
}
