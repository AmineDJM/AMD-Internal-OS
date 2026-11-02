import { prisma } from "@/lib/prisma";
import { notifyRoles } from "@/lib/notify";
import { aiSelfTest, type AiHealthResult } from "@/lib/ai";
import { sansBloquer } from "@/lib/journal";

/**
 * SANTÉ DE L'API IA (chatbot). Point unique qui exécute la sonde, la JOURNALISE
 * (AiHealthCheck) et ALERTE les Super Admins avec le message EXACT en cas de panne
 * (au rétablissement aussi). Utilisé par le planificateur (1×/jour) ET par le bouton
 * « Tester maintenant » du Centre de contrôle IA (force = ignore le débounce).
 */

const AI_CHECK_INTERVAL_MS = 23 * 60 * 60_000; // ~1×/jour (marge sous 24 h)

export interface AiHealthRun extends AiHealthResult {
  /** true si la sonde n'a pas été relancée (débounce quotidien) — on renvoie le dernier état. */
  skipped?: boolean;
}

export async function getLatestAiHealth() {
  try {
    return await prisma.aiHealthCheck.findFirst({ orderBy: { checkedAt: "desc" } });
  } catch {
    return null;
  }
}

export async function performAiHealthCheck(
  opts: { force?: boolean; selfTest?: () => Promise<AiHealthResult> } = {},
): Promise<AiHealthRun> {
  const last = await prisma.aiHealthCheck.findFirst({ orderBy: { checkedAt: "desc" } });
  if (!opts.force && last && Date.now() - last.checkedAt.getTime() < AI_CHECK_INTERVAL_MS) {
    return {
      ok: last.ok, configured: true, model: last.model,
      latencyMs: last.latencyMs ?? 0, status: last.status ?? undefined, error: last.error ?? undefined, skipped: true,
    };
  }

  const r = await (opts.selfTest ?? aiSelfTest)();
  const record = await prisma.aiHealthCheck.create({
    data: { ok: r.ok, model: r.model, status: r.status ?? null, latencyMs: Math.round(r.latencyMs), error: r.error ?? null },
  });

  const wasOk = last?.ok ?? true; // au 1er run, état antérieur supposé sain → on n'alerte qu'en cas d'échec réel
  if (!r.ok) {
    await notifyRoles(["SUPER_ADMIN"], {
      type: "GENERIC",
      title: "⚠️ Chatbot IA indisponible",
      body: `Test ${opts.force ? "" : "quotidien "}de l'API IA (${r.model}) ÉCHOUÉ — ${r.error} Le chatbot et les fonctions IA resteront hors service tant que ce n'est pas corrigé.`,
      link: "/admin/ai",
    });
    await prisma.aiHealthCheck.update({ where: { id: record.id }, data: { notifiedAt: new Date() } }).catch(sansBloquer("ai-health.performAiHealthCheck.aiHealthCheck"));
  } else if (!wasOk) {
    await notifyRoles(["SUPER_ADMIN"], {
      type: "GENERIC",
      title: "✅ Chatbot IA rétabli",
      body: `L'API IA (${r.model}) répond de nouveau normalement (${Math.round(r.latencyMs)} ms).`,
      link: "/admin/ai",
    });
  }
  return r;
}
