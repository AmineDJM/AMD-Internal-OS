import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { callLuna, lunaConfigured, lunaModel } from "@/lib/openai-luna";
import { aiFeatureEnabled, logAiUsage } from "@/lib/ai-settings";
import {
  BRIEFING_SCHEMA, briefingDeRegles, briefingDu, jourAlger, lireReponseModele, promptBriefing, refsDe,
  type BriefRisk, type BriefingContent,
} from "@/lib/adventum/briefing";
import { sansBloquer } from "@/lib/journal";

/**
 * LE BRIEFING DU MATIN D'ADVENTUM BRAIN — génération et mémoire (refonte 07/10).
 *
 * À 7 h (heure d'Alger) le planificateur l'écrit une fois ; « Régénérer » le réécrit à la demande. Il part des
 * risques OUVERTS de la table `BrainRisk` (déjà calculés par la passe horaire : rien n'est recalculé ici), les
 * confie au modèle économique (Luna, sortie JSON stricte, délai borné), et retombe sur un briefing de RÈGLES si le
 * modèle est absent, coupé, trop lent ou hors forme. Il est GARDÉ (`BrainBriefing`, un par jour) : l'historique
 * relit ce que Brain disait la semaine dernière.
 *
 * Module de premier niveau (et non `lib/adventum/`) : c'est lui qui appelle le fournisseur d'IA.
 */

const DELAI_MODELE_MS = 45_000;
const DAY = 86_400_000;

async function risquesOuverts(): Promise<BriefRisk[]> {
  const rows = await prisma.brainRisk.findMany({
    where: { status: { in: ["NOUVEAU", "PRIS_EN_CHARGE"] } },
    select: { key: true, level: true, title: true, object: true, module: true, owner: true, recommendation: true, href: true, status: true, detail: true, firstSeenAt: true },
    take: 200,
  });
  return rows.map((r) => {
    const age = (r.detail as { ageDays?: number | null } | null)?.ageDays;
    return {
      key: r.key, level: r.level, title: r.title, object: r.object, module: r.module, owner: r.owner,
      recommendation: r.recommendation, href: r.href, status: r.status,
      ageDays: typeof age === "number" ? age : Math.floor((Date.now() - r.firstSeenAt.getTime()) / DAY),
    };
  });
}

async function depuisHier(now: Date): Promise<{ resolved: number; created: number }> {
  const hier = new Date(now.getTime() - DAY);
  const [resolved, created] = await Promise.all([
    prisma.brainRisk.count({ where: { status: "RESOLU", resolvedAt: { gte: hier } } }),
    prisma.brainRisk.count({ where: { firstSeenAt: { gte: hier } } }),
  ]);
  return { resolved, created };
}

interface Genere { content: BriefingContent; source: "ia" | "regles"; model: string | null; costUsd: number | null; error: string | null }

async function rediger(risks: BriefRisk[], since: { resolved: number; created: number }, jour: string, userId: string | null): Promise<Genere> {
  const regles = briefingDeRegles(risks, since);
  if (risks.length === 0) return { content: regles, source: "regles", model: null, costUsd: null, error: null };
  if (!lunaConfigured()) return { content: regles, source: "regles", model: null, costUsd: null, error: "IA non configurée" };
  if (!(await aiFeatureEnabled("briefing"))) return { content: regles, source: "regles", model: null, costUsd: null, error: "Briefing IA désactivé" };

  const { system, user } = promptBriefing(risks, since, jour);
  const t0 = Date.now();
  const model = lunaModel();
  const minuterie = new Promise<null>((ok) => setTimeout(() => ok(null), DELAI_MODELE_MS));
  const res = await Promise.race([
    callLuna<unknown>({ system, user, jsonSchema: { name: "briefing_matin", schema: BRIEFING_SCHEMA }, maxOutputTokens: 2500 }).catch(sansBloquer("brain-briefing.rediger.callLuna", null)),
    minuterie,
  ]);
  const latencyMs = Date.now() - t0;
  const paragraphs = res?.ok ? lireReponseModele(res.data ?? safeParse(res.text), new Set(risks.map((r) => r.key))) : null;
  const ok = !!paragraphs;
  const error = !res ? "délai dépassé" : !res.ok ? res.error ?? "échec" : !paragraphs ? "réponse hors forme" : null;
  await logAiUsage({
    feature: "briefing", provider: "openai", model, userId, ok, latencyMs, errorCode: error,
    inputTokens: res?.usage.inputTokens ?? null, outputTokens: res?.usage.outputTokens ?? null, costUsd: res?.usage.costUsd ?? null,
  });
  if (!paragraphs) return { content: regles, source: "regles", model, costUsd: res?.usage.costUsd ?? null, error };
  return { content: { paragraphs, since, decisions: regles.decisions }, source: "ia", model, costUsd: res!.usage.costUsd, error: null };
}

function safeParse(t: string): unknown {
  try { return JSON.parse(t); } catch { return null; }
}

/** Écrit (ou réécrit) le briefing du jour. Ne lève pas. */
export async function genererBriefing(opts: { userId?: string | null; now?: Date } = {}): Promise<{ ok: boolean; source?: "ia" | "regles"; error?: string }> {
  const now = opts.now ?? new Date();
  try {
    const jour = jourAlger(now);
    const [risks, since] = await Promise.all([risquesOuverts(), depuisHier(now)]);
    const g = await rediger(risks, since, jour, opts.userId ?? null);
    const data = {
      content: g.content as unknown as Prisma.InputJsonValue,
      risks: refsDe(risks) as unknown as Prisma.InputJsonValue,
      source: g.source, model: g.model, costUsd: g.costUsd, error: g.error,
      generatedById: opts.userId ?? null, generatedAt: now,
    };
    await prisma.brainBriefing.upsert({ where: { day: jour }, create: { day: jour, ...data }, update: data });
    return { ok: true, source: g.source };
  } catch (err) {
    console.error("[brain] briefing impossible", err);
    return { ok: false, error: "Le briefing n'a pas pu être écrit." };
  }
}

/** Le briefing de 7 h — appelé par le planificateur ; une fois par jour, après la passe horaire. */
export async function runBrainBriefingIfDue(now: Date = new Date()): Promise<void> {
  try {
    const dernier = await prisma.brainBriefing.findFirst({ orderBy: { day: "desc" }, select: { day: true } });
    if (!briefingDu(now, dernier?.day ?? null)) return;
    await genererBriefing({ now });
  } catch (err) {
    console.error("[brain] briefing de 7 h", err);
  }
}
