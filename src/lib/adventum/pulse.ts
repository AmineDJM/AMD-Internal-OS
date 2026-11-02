import { prisma } from "@/lib/prisma";
import { notifyRoles } from "@/lib/notify";
import { getRisks, type Risk, type RiskLevel } from "./risks";
import { syncBrainRisks } from "./lifecycle";
import { processPulseStats } from "@/lib/queries/process-intelligence";
import { sansBloquer } from "@/lib/journal";

/**
 * Adventum Pulse — couche d'analyse EN CONTINU d'Adventum Brain + Process Intelligence.
 *
 * À intervalle horaire (déclenché par le battement du planificateur — JAMAIS au rendu d'une page : les
 * cockpits lisent l'état gardé et s'ouvrent instantanément), on calcule l'état RÉEL de la société — risques
 * (réconciliés dans `BrainRisk`, voir `lifecycle.ts`) et circuits — et on le PERSISTE (`IntelligenceSnapshot`) :
 *   1. Tendances : les cockpits comparent l'instantané courant au précédent (deltas + courbe).
 *   2. Alertes PROACTIVES : dès qu'un NOUVEAU risque critique apparaît (absent de l'instantané
 *      précédent), le Super Admin est notifié — même si personne n'a ouvert le module.
 *
 * Aucune IA, aucune donnée simulée : pur calcul déterministe sur les données de production. La
 * fonction ne lève jamais (le tick planifié et le rendu des pages ne doivent pas casser).
 */

const LEVEL_RANK: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Compteurs comparables d'un instantané à l'autre. */
export interface PulseCounts {
  riskCritical: number;
  riskHigh: number;
  riskTotal: number;
  stuck: number;
  overdue: number;
  validationsPending: number;
}

interface TopRisk { id: string; level: string; module: string; title: string; object: string; href: string | null }
interface SnapshotDetail { byCategory: Record<string, number>; criticalIds: string[]; topRisks: TopRisk[] }

/** Vue de tendance consommée par les cockpits (Brain + Process Intelligence). */
export interface PulseView {
  hasData: boolean;
  generatedAt: string | null;
  ageMinutes: number | null;
  points: number;
  current: PulseCounts;
  delta: PulseCounts | null;
  spark: { riskTotal: number[]; stuck: number[]; overdue: number[] };
}

/** Bucket horaire « YYYY-MM-DDTHH » — un seul instantané par heure (verrou d'unicité). */
function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13);
}

const ZERO: PulseCounts = { riskCritical: 0, riskHigh: 0, riskTotal: 0, stuck: 0, overdue: 0, validationsPending: 0 };

/**
 * Calcule et persiste l'instantané de l'heure s'il n'existe pas encore, puis émet l'alerte
 * proactive sur les nouveaux risques critiques. Idempotent (1×/h), concurrence-safe (bucket unique).
 */
export async function runIntelligencePulse(): Promise<void> {
  try {
    const bucket = hourBucket();
    // LA PASSE DE L'HEURE SE RÉSERVE D'ABORD (bucket unique) : deux processus ne calculent et ne réconcilient
    // jamais la même heure en même temps — le second s'arrête ici. `skipDuplicates` plutôt qu'un P2002
    // rattrapé : Prisma journalise chaque violation d'unicité en `prisma:error`, à chaque battement.
    const reserve = await prisma.intelligenceSnapshot.createMany({ data: [{ bucket }], skipDuplicates: true });
    if (reserve.count === 0) return;

    // Calculs réels, tolérants aux pannes (un module en erreur ne bloque pas le reste).
    const [risks, processStats] = await Promise.all([
      getRisks().catch((e) => { console.error("[pulse] getRisks failed", e); return null; }),
      processPulseStats().catch((e) => { console.error("[pulse] processPulseStats failed", e); return null; }),
    ]);
    // Un calcul en échec ne doit pas « résoudre » tous les risques ouverts : on ne réconcilie que sur un vrai calcul.
    const premierPassage = (await prisma.brainRisk.count()) === 0;
    const sync = risks ? await syncBrainRisks(risks) : null;
    const liste: Risk[] = risks ?? [];

    const byLevel = (l: RiskLevel) => liste.filter((r) => r.level === l).length;
    const byCategory: Record<string, number> = {};
    for (const r of liste) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    const criticalIds = liste.filter((r) => r.level === "critical").map((r) => r.id);
    const topRisks: TopRisk[] = [...liste]
      .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
      .slice(0, 60)
      .map((r) => ({ id: r.id, level: r.level, module: r.module, title: r.title, object: r.object, href: r.href }));
    const detail: SnapshotDetail = { byCategory, criticalIds, topRisks };
    const stats = processStats ?? { inProgress: 0, stuck: 0, overdue: 0, validationsPending: 0 };

    await prisma.intelligenceSnapshot.update({
      where: { bucket },
      data: {
        riskCritical: byLevel("critical"), riskHigh: byLevel("high"),
        riskMedium: byLevel("medium"), riskLow: byLevel("low"), riskTotal: liste.length,
        inProgress: stats.inProgress, stuck: stats.stuck, overdue: stats.overdue,
        validationsPending: stats.validationsPending,
        detail: detail as unknown as object,
      },
    });

    // Alerte proactive : les risques critiques que la réconciliation vient de CRÉER (un risque connu, ignoré ou
    // déjà pris en charge ne resonne pas). Jamais au tout premier passage : tout y serait « nouveau ».
    if (sync && !premierPassage) {
      const fresh = sync.created.filter((r) => r.level === "critical");
      if (fresh.length > 0) {
        const lead = fresh.slice(0, 3).map((r) => `${r.module} — ${r.title}`).join(" · ");
        await notifyRoles(["SUPER_ADMIN"], {
          type: "GENERIC",
          title: `Adventum Brain — ${fresh.length} nouveau${fresh.length > 1 ? "x" : ""} risque${fresh.length > 1 ? "s" : ""} critique${fresh.length > 1 ? "s" : ""}`,
          body: lead + (fresh.length > 3 ? ` … (+${fresh.length - 3})` : ""),
          link: "/adventum-brain",
        }).catch(sansBloquer("pulse.runIntelligencePulse.notifyRoles"));
      }
    }
  } catch (err) {
    console.error("[pulse] run failed", err);
  }
}

/** Différence champ à champ (courant − précédent). */
function diff(cur: PulseCounts, prev: PulseCounts): PulseCounts {
  return {
    riskCritical: cur.riskCritical - prev.riskCritical,
    riskHigh: cur.riskHigh - prev.riskHigh,
    riskTotal: cur.riskTotal - prev.riskTotal,
    stuck: cur.stuck - prev.stuck,
    overdue: cur.overdue - prev.overdue,
    validationsPending: cur.validationsPending - prev.validationsPending,
  };
}

/**
 * Lit les derniers instantanés et construit la vue de tendance (compteurs courants, deltas vs
 * l'instantané précédent, mini-courbe). Ne lève jamais : renvoie une vue vide en cas de souci.
 */
export async function getPulse(windowN = 24): Promise<PulseView> {
  try {
    const rows = await prisma.intelligenceSnapshot.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.max(2, windowN),
      select: {
        createdAt: true, riskCritical: true, riskHigh: true, riskTotal: true,
        stuck: true, overdue: true, validationsPending: true,
      },
    });
    if (rows.length === 0) return { hasData: false, generatedAt: null, ageMinutes: null, points: 0, current: ZERO, delta: null, spark: { riskTotal: [], stuck: [], overdue: [] } };

    const toCounts = (r: (typeof rows)[number]): PulseCounts => ({
      riskCritical: r.riskCritical, riskHigh: r.riskHigh, riskTotal: r.riskTotal,
      stuck: r.stuck, overdue: r.overdue, validationsPending: r.validationsPending,
    });
    const latest = rows[0];
    const current = toCounts(latest);
    const delta = rows[1] ? diff(current, toCounts(rows[1])) : null;
    const chrono = [...rows].reverse(); // du plus ancien au plus récent (pour la courbe)

    return {
      hasData: true,
      generatedAt: latest.createdAt.toISOString(),
      ageMinutes: Math.max(0, Math.round((Date.now() - latest.createdAt.getTime()) / 60_000)),
      points: rows.length,
      current,
      delta,
      spark: {
        riskTotal: chrono.map((r) => r.riskTotal),
        stuck: chrono.map((r) => r.stuck),
        overdue: chrono.map((r) => r.overdue),
      },
    };
  } catch (err) {
    console.error("[pulse] getPulse failed", err);
    return { hasData: false, generatedAt: null, ageMinutes: null, points: 0, current: ZERO, delta: null, spark: { riskTotal: [], stuck: [], overdue: [] } };
  }
}
