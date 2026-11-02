import { prisma } from "@/lib/prisma";
import { askClaudeCheap, aiConfigured } from "@/lib/ai";
import { getToday } from "@/lib/queries/today";
import { getMemory } from "@/lib/assistant-memory";
import { algiersTodayYmd } from "@/lib/calendar-tz";
import type { SessionUser } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";

/**
 * LE POINT DU MATIN — l'assistant parle en premier.
 *
 * Trois à cinq lignes, en français : ce qui presse, par quoi commencer, ce qui arrive dans
 * la journée. Rien n'est inventé : la matière vient de `getToday`, déjà filtré par les droits
 * de la personne, et de la mémoire que l'assistant a d'elle.
 *
 * Un seul appel IA par personne et par jour (cache `DailyBrief`, clé `userId + jour d'Alger`) :
 * ouvrir la page dix fois ne coûte rien. `refresh` force une régénération à la demande.
 *
 * Cloisonnement : le brief est écrit à partir des seules données de CETTE personne et n'est
 * jamais lu par quelqu'un d'autre (toute lecture passe par son `userId`).
 */

export interface BriefResult {
  /** Texte du point du matin, ou null si rien à dire / IA indisponible. */
  text: string | null;
  /** Vrai si le texte vient du cache du jour (aucun appel IA). */
  cached: boolean;
  /** Nombre d'actions en attente au moment du point. */
  pending: number;
}

/** Le jour d'Alger, en `Date` UTC minuit — clé du cache journalier. */
function algiersDay(): Date {
  return new Date(`${algiersTodayYmd()}T00:00:00.000Z`);
}

export async function getDailyBrief(user: SessionUser & { name?: string }, refresh = false): Promise<BriefResult> {
  const day = algiersDay();

  if (!refresh) {
    const cached = await prisma.dailyBrief.findUnique({
      where: { userId_day: { userId: user.id, day } },
      select: { text: true },
    });
    if (cached) {
      const t = await getToday(user);
      return { text: cached.text, cached: true, pending: t.counts.total };
    }
  }

  const today = await getToday(user);
  // Journée vide : pas d'appel IA — on ne fabrique pas du bruit pour meubler.
  if (today.counts.total === 0 && today.agenda.length === 0) {
    return { text: null, cached: false, pending: 0 };
  }
  if (!aiConfigured()) return { text: null, cached: false, pending: today.counts.total };

  const lines: string[] = [];
  if (today.focus) lines.push(`À FAIRE EN PRIORITÉ : ${today.focus.title} (${today.focus.module}, ${today.focus.reasonLabel}).`);
  for (const n of today.next) lines.push(`- ${n.title} — ${n.module}, ${n.reasonLabel}.`);
  if (today.counts.overdue > 0) lines.push(`En retard : ${today.counts.overdue}.`);
  if (today.counts.validations > 0) lines.push(`Validations en attente de vous : ${today.counts.validations}.`);
  if (today.restCount > 0) lines.push(`Et ${today.restCount} autre(s) action(s) en attente.`);
  for (const e of today.agenda) lines.push(`Agenda ${e.allDay ? "(journée)" : e.timeLabel} : ${e.title}${e.location ? ` — ${e.location}` : ""}.`);

  const memory = await getMemory(user.id).catch(sansBloquer("daily-brief.getDailyBrief.getMemory", null));

  const res = await askClaudeCheap(
    `${memory ? `CE QUE TU SAIS DE CETTE PERSONNE :\n${memory}\n\n` : ""}` +
    `SA JOURNÉE (données réelles, déjà filtrées par ses droits) :\n${lines.join("\n")}\n\n` +
    `Rédige son point du matin.`,
    {
      system:
        `Tu es l'assistant interne de ${user.name ?? "cette personne"}. Tu lui écris son point du matin, en français, ` +
        "en 3 à 5 phrases courtes, sans Markdown, sans titre, sans salutation ni formule de politesse. " +
        "Dis ce qui presse, par quoi commencer, et ce qui l'attend dans la journée. " +
        "N'invente RIEN : n'utilise que les éléments fournis. Vouvoie-la. Va droit au but.",
      maxTokens: 350,
      temperature: 0.4,
    },
  );
  if (!res.ok || !res.text) return { text: null, cached: false, pending: today.counts.total };

  const text = res.text.trim();
  await prisma.dailyBrief.upsert({
    where: { userId_day: { userId: user.id, day } },
    create: { userId: user.id, day, text },
    update: { text },
  }).catch(sansBloquer("daily-brief.getDailyBrief.dailyBrief")); // le cache est un confort, jamais un point de rupture

  return { text, cached: false, pending: today.counts.total };
}
