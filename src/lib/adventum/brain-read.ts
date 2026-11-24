import { prisma } from "@/lib/prisma";
import type { BriefingContent, BriefingRef } from "./briefing";
import type { BrainStatus, HistoryEntry } from "./lifecycle-rules";
import type { RiskAction } from "./risks";

/**
 * ADVENTUM BRAIN — les LECTURES de l'écran. Tout vient de ce que la passe horaire et le briefing ont GARDÉ :
 * rien n'est recalculé au rendu, la page s'ouvre instantanément.
 */

export interface LigneRisque {
  id: string;
  key: string;
  level: string;
  category: string;
  module: string;
  title: string;
  object: string;
  owner: string;
  href: string | null;
  status: BrainStatus;
  snoozedUntil: string | null;
  assigneeName: string | null;
  taskId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedAuto: boolean;
  note: string | null;
  recommendation: string;
  impact: string | null;
  probableCause: string | null;
  evidence: string[];
  actions: RiskAction[];
  ageDays: number | null;
  history: HistoryEntry[];
}

const DAY = 86_400_000;

/**
 * Les risques ouverts (nouveaux, pris en charge, ignorés) et ceux résolus ces 14 derniers jours. Adventum Brain est au
 * Super Admin seul (24/11/2026) : plus de lecture bornée à un périmètre.
 */
export async function lireRisques(now: Date = new Date()): Promise<LigneRisque[]> {
  const toutes = await prisma.brainRisk.findMany({
    where: { OR: [{ status: { in: ["NOUVEAU", "PRIS_EN_CHARGE", "IGNORE"] } }, { resolvedAt: { gte: new Date(now.getTime() - 14 * DAY) } }] },
    orderBy: { lastSeenAt: "desc" },
    take: 500,
  });
  const rows = toutes;
  const ids = [...new Set(rows.map((r) => r.assigneeId).filter((x): x is string => !!x))];
  const noms = new Map((ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  return rows.map((r) => {
    const d = (r.detail ?? {}) as { impact?: string; probableCause?: string; evidence?: string[]; actions?: RiskAction[]; ageDays?: number | null };
    return {
      id: r.id, key: r.key, level: r.level, category: r.category, module: r.module, title: r.title, object: r.object, owner: r.owner,
      href: r.href, status: r.status as BrainStatus, snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
      assigneeName: r.assigneeId ? noms.get(r.assigneeId) ?? null : null, taskId: r.taskId,
      firstSeenAt: r.firstSeenAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolvedAuto: r.resolvedAuto, note: r.note, recommendation: r.recommendation,
      impact: d.impact ?? null, probableCause: d.probableCause ?? null, evidence: Array.isArray(d.evidence) ? d.evidence : [],
      actions: Array.isArray(d.actions) ? d.actions : [],
      // L'âge du RISQUE : depuis quand le problème existe (détecteur), sinon depuis sa première détection.
      ageDays: typeof d.ageDays === "number" ? d.ageDays : Math.floor((now.getTime() - r.firstSeenAt.getTime()) / DAY),
      history: Array.isArray(r.history) ? (r.history as unknown as HistoryEntry[]) : [],
    };
  });
}

export interface BriefingLu {
  id: string;
  day: string;
  content: BriefingContent;
  refs: BriefingRef[];
  source: string;
  model: string | null;
  generatedAt: string;
}

const versBriefing = (b: { id: string; day: string; content: unknown; risks: unknown; source: string; model: string | null; generatedAt: Date }): BriefingLu => ({
  id: b.id, day: b.day, content: b.content as BriefingContent, refs: Array.isArray(b.risks) ? (b.risks as BriefingRef[]) : [],
  source: b.source, model: b.model, generatedAt: b.generatedAt.toISOString(),
});

export async function lireDernierBriefing(): Promise<BriefingLu | null> {
  const b = await prisma.brainBriefing.findFirst({ orderBy: { day: "desc" } });
  return b ? versBriefing(b) : null;
}

export async function lireBriefing(day: string): Promise<BriefingLu | null> {
  const b = await prisma.brainBriefing.findUnique({ where: { day } });
  return b ? versBriefing(b) : null;
}

export interface QuestionLue { id: string; question: string; answer: string; ok: boolean; sources: { label: string; href: string | null }[]; proposals: { title: string }[]; createdAt: string }

export async function lireHistorique(userId: string): Promise<{ briefings: { day: string; source: string; generatedAt: string; decisions: number }[]; questions: QuestionLue[] }> {
  const [bs, qs] = await Promise.all([
    prisma.brainBriefing.findMany({ orderBy: { day: "desc" }, take: 60, select: { day: true, source: true, generatedAt: true, content: true } }),
    prisma.brainQuestion.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return {
    briefings: bs.map((b) => ({ day: b.day, source: b.source, generatedAt: b.generatedAt.toISOString(), decisions: (b.content as BriefingContent | null)?.decisions ?? 0 })),
    questions: qs.map((q) => ({
      id: q.id, question: q.question, answer: q.answer, ok: q.ok, createdAt: q.createdAt.toISOString(),
      sources: Array.isArray(q.sources) ? (q.sources as QuestionLue["sources"]) : [],
      proposals: Array.isArray(q.proposals) ? (q.proposals as QuestionLue["proposals"]) : [],
    })),
  };
}

/** L'âge du dernier calcul (passe horaire). */
export async function derniereAnalyse(): Promise<Date | null> {
  const s = await prisma.intelligenceSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return s?.createdAt ?? null;
}

export async function personnesActives(): Promise<{ id: string; name: string }[]> {
  return prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}
