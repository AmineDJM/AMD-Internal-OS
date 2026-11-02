/**
 * Seuils de déclenchement du Risk Radar — ajustables par le Super Admin.
 * Lecture côté serveur ; valeurs par défaut si la ligne n'existe pas encore. La part pure vit dans `risk-thresholds.ts`.
 */
import { prisma } from "@/lib/prisma";
import { DEFAULT_THRESHOLDS, type RiskThresholds } from "./risk-thresholds";

export { DEFAULT_THRESHOLDS, THRESHOLD_FIELDS, type RiskThresholds } from "./risk-thresholds";

/** Lit les seuils (frais ; valeurs par défaut si absent ou en cas de souci BDD). */
export async function getRiskThresholds(): Promise<RiskThresholds> {
  try {
    const row = await prisma.riskSetting.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULT_THRESHOLDS;
    return {
      pchCautionWarnDays: row.pchCautionWarnDays,
      congressStaleDays: row.congressStaleDays,
      sponsoringStaleDays: row.sponsoringStaleDays,
      expenseStaleDays: row.expenseStaleDays,
      budgetWarnPct: row.budgetWarnPct,
      kolVisitStaleDays: row.kolVisitStaleDays,
      medicalInfoStaleDays: row.medicalInfoStaleDays,
      silentSupplierDays: row.silentSupplierDays,
      stockLowThreshold: row.stockLowThreshold,
      deliveryGraceDays: row.deliveryGraceDays,
      eventHorizonDays: row.eventHorizonDays,
      eventMinAttendance: row.eventMinAttendance,
      recruitmentUnpublishedDays: row.recruitmentUnpublishedDays,
      fieldCoverageMinPct: row.fieldCoverageMinPct,
      adproCdMaxPct: row.adproCdMaxPct,
      bcUnsignedDays: row.bcUnsignedDays,
      tourPlanLeadDays: row.tourPlanLeadDays,
      aiCostDriftPct: row.aiCostDriftPct,
      processStuckDays: row.processStuckDays,
    };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}
