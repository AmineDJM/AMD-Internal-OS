import { prisma } from "@/lib/prisma";
import { notifyUser, notifyRoles, broadcastNotification } from "@/lib/notify";
import type { UserRole } from "@prisma/client";
import { sansBloquer } from "@/lib/journal";

/**
 * LES RAPPELS DU CHIEF OF STAFF — la planification en langage naturel devient un vrai job.
 *
 * « Rappelle-moi mardi à 10 h de vérifier ça », « tous les dimanches relance Regulatory » : le
 * modèle traduit la phrase en un enregistrement (`AssistantReminder`), et le BALAYAGE — branché
 * dans `lib/scheduled.ts`, comme toutes les tâches planifiées de la plateforme — fait le reste.
 * Pas de cron externe, pas de worker à déployer : le même mécanisme qui envoie déjà les rappels
 * d'échéance Legal et les relances de caisse.
 *
 * Deux effets à l'échéance :
 *   • le PROPRIÉTAIRE est prévenu en POP-UP (un rappel qu'on a demandé mérite d'interrompre) ;
 *   • si le rappel porte un `targetRole`, ce rôle est RELANCÉ avec la note — c'est le
 *     « demande à Regulatory où en sont les dossiers » du dimanche.
 *
 * Un rappel simple s'éteint après son tir ; une récurrence avance son échéance et continue.
 */

export const REMINDER_RECURRENCES = ["NONE", "DAILY", "WEEKLY", "MONTHLY", "MONTHLY_WEEKDAY"] as const;
export type ReminderRecurrence = (typeof REMINDER_RECURRENCES)[number];

export const RECURRENCE_LABEL: Record<ReminderRecurrence, string> = {
  NONE: "une seule fois",
  DAILY: "tous les jours",
  WEEKLY: "toutes les semaines",
  MONTHLY: "tous les mois (même quantième)",
  MONTHLY_WEEKDAY: "tous les mois (même Nième jour de semaine)",
};

/**
 * L'échéance SUIVANTE d'une récurrence, STRICTEMENT après `after`.
 *
 * On avance depuis l'échéance courante — jamais depuis « maintenant » : un rappel hebdomadaire du
 * dimanche 10 h doit retomber un dimanche 10 h, même si le serveur l'a tiré avec vingt minutes de
 * retard. La boucle rattrape un serveur resté éteint plusieurs périodes (bornée : pas de gel).
 */
export function nextOccurrence(current: Date, recurrence: string, after: Date): Date | null {
  if (recurrence === "NONE") return null;
  if (recurrence === "MONTHLY_WEEKDAY") return nextMonthlyWeekday(current, after);
  const next = new Date(current.getTime());
  for (let i = 0; i < 400; i += 1) {
    if (recurrence === "DAILY") next.setUTCDate(next.getUTCDate() + 1);
    else if (recurrence === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
    else if (recurrence === "MONTHLY") next.setUTCMonth(next.getUTCMonth() + 1);
    else return null;
    if (next.getTime() > after.getTime()) return new Date(next.getTime());
  }
  return null;
}

/**
 * « CHAQUE PREMIER LUNDI DU MOIS » — le Nième jour de semaine du mois, pas le quantième.
 *
 * Le rang (1er…5e) et le jour (lundi…) se LISENT sur l'échéance courante, en HEURE D'ALGER :
 * un rappel posé le lundi 6 (2e lundi) retombe chaque 2e lundi, à la même heure. Un mois sans
 * 5e occurrence retombe sur la DERNIÈRE (le « 5e lundi » d'un mois qui n'en a que 4 devient le
 * 4e) — annuler le rappel un mois sur deux serait pire que le décaler d'une semaine.
 */
function nextMonthlyWeekday(current: Date, after: Date): Date | null {
  const alg = new Date(current.getTime() + 3_600_000); // heure d'Alger (UTC+1, sans été)
  const weekday = alg.getUTCDay();
  const nth = Math.ceil(alg.getUTCDate() / 7);
  const hours = alg.getUTCHours();
  const minutes = alg.getUTCMinutes();

  let year = alg.getUTCFullYear();
  let month = alg.getUTCMonth();
  for (let i = 0; i < 60; i += 1) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    // Premier jour du mois → premier `weekday` du mois → avance de (nth−1) semaines, borné au mois.
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const firstMatch = 1 + ((weekday - firstDow + 7) % 7);
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    let day = firstMatch + (nth - 1) * 7;
    while (day > daysInMonth) day -= 7;
    const candidate = new Date(Date.UTC(year, month, day, hours, minutes) - 3_600_000); // retour en UTC
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

/**
 * « mardi à 10 h », heure d'Alger, en instant UTC. L'Algérie vit en UTC+1 SANS changement
 * d'heure : la conversion est une soustraction, pas une table de fuseaux.
 */
export function algiersToUtc(date: string, time: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim() || "09:00");
  if (!m || !t) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]) - 1, Number(t[2]));
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** L'échéance, relue en heure d'Alger pour l'affichage. */
export function formatAlgiersDue(d: Date): string {
  const alg = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(alg.getUTCDate())}/${p(alg.getUTCMonth() + 1)}/${alg.getUTCFullYear()} à ${p(alg.getUTCHours())}h${p(alg.getUTCMinutes())}`;
}

const SWEEP_LIMIT = 50;

/** Les entités qu'un rappel peut SURVEILLER (« si pas validé sous 48 h, préviens-moi »). */
export const WATCH_TYPES = ["EXPENSE_ORDER", "PAYMENT_REQUEST", "TASK", "VALIDATION_REQUEST"] as const;
export type WatchType = (typeof WATCH_TYPES)[number];

export interface WatchState {
  /** L'entité attend-elle ENCORE ? (introuvable = résolue : on ne hurle pas sur un fantôme.) */
  pending: boolean;
  detail: string;
}

/**
 * L'entité surveillée est-elle toujours en attente ? Relu depuis la SOURCE au moment du tir —
 * jamais depuis un état mémorisé : c'est tout l'intérêt d'une surveillance.
 */
export async function watchState(type: string, id: string): Promise<WatchState | null> {
  if (type === "EXPENSE_ORDER") {
    const o = await prisma.expenseOrder.findUnique({ where: { id }, select: { reference: true, status: true, centralStatus: true, paidDate: true } });
    if (!o) return { pending: false, detail: "règlement introuvable (supprimé ?)" };
    const pending = !o.paidDate && o.status !== "CANCELLED"
      && (o.centralStatus == null || ["AWAITING", "CHANGES_REQUESTED", "INFO_REQUESTED"].includes(o.centralStatus));
    return { pending, detail: `${o.reference} — ${o.paidDate ? "payé" : o.centralStatus ?? o.status}` };
  }
  if (type === "PAYMENT_REQUEST") {
    const p = await prisma.paymentRequest.findUnique({ where: { id }, select: { reference: true, status: true } });
    if (!p) return { pending: false, detail: "demande introuvable (supprimée ?)" };
    return { pending: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ON_HOLD", "CHANGES_REQUESTED"].includes(p.status), detail: `${p.reference} — ${p.status}` };
  }
  if (type === "TASK") {
    const t = await prisma.task.findUnique({ where: { id }, select: { title: true, status: true } });
    if (!t) return { pending: false, detail: "tâche introuvable (supprimée ?)" };
    return { pending: ["REQUESTED", "TODO", "IN_PROGRESS"].includes(t.status), detail: `${t.title} — ${t.status}` };
  }
  if (type === "VALIDATION_REQUEST") {
    const v = await prisma.validationRequest.findUnique({ where: { id }, select: { reference: true, status: true } });
    if (!v) return { pending: false, detail: "validation introuvable (supprimée ?)" };
    return { pending: v.status === "PENDING", detail: `${v.reference} — ${v.status}` };
  }
  return null;
}

/**
 * LE BALAYAGE — tire les rappels échus. Idempotent par construction : un rappel simple passe
 * `active=false` dans la MÊME écriture qui précède les notifications ; une récurrence avance son
 * `dueAt` de même. Deux passages concurrents peuvent au pire notifier deux fois — jamais dériver.
 *
 * Deux gardes de GOUVERNANCE :
 *   • un rappel de SURVEILLANCE relit l'entité : réglée → il le dit au propriétaire et s'éteint ;
 *     encore en attente → il prévient le PROPRIÉTAIRE uniquement (surveiller n'est pas relancer) ;
 *   • l'ARRÊT D'URGENCE (`aiExternalActionsDisabled`) coupe les RELANCES vers autrui (rôle,
 *     personne) — le pop-up au propriétaire, lui, reste : se parler à soi-même n'est pas une
 *     action externe.
 */
export async function runAssistantReminders(now: Date = new Date()): Promise<void> {
  const due = await prisma.assistantReminder.findMany({
    where: { active: true, dueAt: { lte: now } },
    orderBy: { dueAt: "asc" },
    take: SWEEP_LIMIT,
  });
  if (due.length === 0) return;

  const externalDisabled = await prisma.appSetting.findUnique({
    where: { id: "global" },
    select: { aiExternalActionsDisabled: true },
  }).then((s) => s?.aiExternalActionsDisabled === true).catch(sansBloquer("reminders.runAssistantReminders.appSetting", false));

  for (const r of due) {
    // Surveillance : l'état de l'entité décide du message — et une entité RÉGLÉE éteint le
    // rappel, récurrence comprise (surveiller un dossier clos n'a pas de sens).
    const watch = r.watchType && r.watchId ? await watchState(r.watchType, r.watchId).catch(sansBloquer("reminders.runAssistantReminders.watchState", null)) : null;
    const resolved = watch != null && !watch.pending;

    /**
     * ── L'ÉCHELLE DE RELANCES (« demain ; si rien, +48 h ; puis +72 h ») ──────────────
     *
     * Un rappel SANS récurrence mais avec des barreaux restants ne s'éteint pas au premier
     * tir : il se REPROGRAMME au barreau suivant, et l'échelle se consomme en base — un
     * redémarrage entre deux barreaux ne perd ni le rappel ni sa position. L'échelle
     * s'arrête d'elle-même quand l'entité surveillée est réglée (`resolved`) ou quand
     * l'événement d'extinction arrive (`eteindreRappelsSurEvenement`).
     */
    const echelle = Array.isArray(r.escalationsH)
      ? (r.escalationsH as unknown[]).filter((h): h is number => typeof h === "number" && h > 0)
      : [];
    const barreauSuivant = !resolved && r.recurrence === "NONE" && echelle.length > 0
      ? new Date(now.getTime() + echelle[0] * 3_600_000)
      : null;

    const next = resolved ? null : (nextOccurrence(r.dueAt, r.recurrence, now) ?? barreauSuivant);
    // L'état d'abord, les notifications ensuite : si l'envoi échoue, on préfère un rappel
    // silencieux à un rappel qui hurle toutes les minutes.
    await prisma.assistantReminder.update({
      where: { id: r.id },
      data: next
        ? {
            dueAt: next, lastFiredAt: now,
            // Le barreau consommé quitte l'échelle — la position vit en base, pas en mémoire.
            ...(barreauSuivant && next === barreauSuivant ? { escalationsH: echelle.slice(1) as never } : {}),
          }
        : { active: false, lastFiredAt: now },
    });

    const watchLine = watch
      ? (watch.pending
          ? `Toujours en attente : ${watch.detail}.`
          : `C'est réglé (${watch.detail}) — surveillance terminée.`)
      : null;

    const corps = watchLine ?? r.note ?? (r.recurrence !== "NONE" ? `Rappel ${RECURRENCE_LABEL[r.recurrence as ReminderRecurrence] ?? ""}.` : undefined);

    /**
     * ── LE CANAL DEMANDÉ, ET LE DIRE QUAND IL N'A PAS PU SERVIR ───────────────────────────
     *
     * Un rappel ne connaissait que la notification interne. « Envoie-moi un mail dans deux
     * minutes » recevait donc « je ne peux pas programmer un e-mail différé dans cette
     * session » — vrai du mécanisme, faux de l'architecture : l'ordonnanceur vise la minute,
     * la boîte connectée sait envoyer, et le dirigeant a AUTORISÉ par écrit la nature RAPPEL
     * sans confirmation (§118.39). Il ne manquait que la jonction.
     *
     * L'envoi passe par la porte de l'autonomie : nature RAPPEL, destinataires limités aux
     * adresses que la personne a déclarées pour elle-même. Ce qui n'a pas pu partir est DIT
     * dans la notification — un e-mail promis et jamais reçu, sans un mot, est pire que pas
     * d'e-mail du tout.
     */
    let noteCanal: string | null = null;
    if (r.channel === "EMAIL" || r.channel === "LES_DEUX") {
      const { ecrireAuProprietaire } = await import("@/platform/in-process/courrier/proprietaire");
      const envoi = await ecrireAuProprietaire({
        ownerId: r.userId, nature: "RAPPEL",
        sujet: `Rappel — ${r.title}`,
        corps: [corps, r.link ? `Ouvrir : ${r.link}` : null].filter(Boolean).join("\n\n") || r.title,
      }).catch((e) => {
        console.error("[reminders] mail owner failed", e);
        return { issue: "echec" as const, motif: "l'envoi a échoué", destinataires: [] as string[] };
      });
      if (envoi.issue !== "envoye") noteCanal = `E-mail non envoyé : ${envoi.motif}.`;
      // EMAIL SEUL et l'envoi a réussi : la notification interne serait un doublon. Elle reste
      // dans tous les autres cas — y compris l'échec, qui est justement ce qu'il faut voir.
      if (r.channel === "EMAIL" && envoi.issue === "envoye") continue;
    }

    // Le pop-up passe par la diffusion ciblée (`broadcastNotification`), la seule porte qui
    // sache l'afficher en plein écran : un rappel qu'on a demandé mérite d'interrompre.
    await broadcastNotification({
      audience: "USERS",
      userIds: [r.userId],
      title: `Rappel — ${r.title}`,
      body: [corps, noteCanal].filter(Boolean).join(" — ") || undefined,
      link: r.link ?? "/chief-of-staff",
      popup: true,
    }).catch((e) => console.error("[reminders] notify owner failed", e));

    // Les RELANCES vers AUTRUI — jamais quand l'entité surveillée est réglée, jamais sous
    // arrêt d'urgence.
    if (resolved || externalDisabled) continue;

    // La RELANCE d'un rôle : « Regulatory, où en êtes-vous ? » — envoyée au nom du demandeur.
    if (r.targetRole) {
      await notifyRoles([r.targetRole as UserRole], {
        type: "GENERIC",
        title: `Relance — ${r.title}`,
        body: r.note ?? "Un point d'avancement est attendu.",
        link: r.link ?? undefined,
      }).catch((e) => console.error("[reminders] notify role failed", e));
    }

    // La RELANCE d'une PERSONNE NOMMÉE : « tous les dimanches relance Nesrine ». Se cumule avec
    // le rôle — l'un, l'autre, ou les deux.
    if (r.targetUserId) {
      await notifyUser({
        userId: r.targetUserId,
        type: "GENERIC",
        title: `Relance — ${r.title}`,
        body: r.note ?? "Un point d'avancement est attendu.",
        link: r.link ?? undefined,
      }).catch((e) => console.error("[reminders] notify person failed", e));
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTINCTION SUR ÉVÉNEMENT (§10) — un rappel conditionnel n'est jamais du spam mécanique.
 *
 * « Rappelle-moi dans 7 jours SEULEMENT SI Sarah n'a pas envoyé le contrat. » La condition est
 * une Attente — la MÊME grammaire que le réveil des missions (event/from/threadId/subject/
 * attachment) : une seule vérité pour « cet événement est-il celui-là ? ». Le contrat arrive à
 * 8 h, le rappel de 9 h s'éteint TOUT SEUL, relances comprises — et la personne est prévenue
 * une fois (« c'est arrivé, je n'insiste plus »), jamais relancée pour une chose faite.
 *
 * Appelée par le registre d'événements (`events/ledger.ts`), à côté de la satisfaction des
 * engagements — le rappel est un engagement envers soi-même.
 */
export async function eteindreRappelsSurEvenement(fait: {
  type: string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  relatedRefs?: readonly string[];
  payload?: unknown;
}): Promise<number> {
  const { correspond, lireAttente } = await import("@/platform/in-process/missions/attentes");
  const candidats = await prisma.assistantReminder.findMany({
    where: { active: true, NOT: { stopOnEvent: { equals: null } } as never },
    take: 100,
    select: { id: true, userId: true, title: true, stopOnEvent: true },
  }).catch(sansBloquer("reminders.eteindreRappelsSurEvenement.assistantReminder", []));

  let eteints = 0;
  for (const r of candidats) {
    const attente = lireAttente(r.stopOnEvent);
    if (!attente || !correspond(attente, {
      type: fait.type,
      actorId: fait.actorId ?? null,
      entityType: fait.entityType ?? null,
      entityId: fait.entityId ?? null,
      relatedRefs: fait.relatedRefs ?? [],
      payload: fait.payload,
    })) continue;

    // Conditionnée à `active` : deux faits simultanés n'éteignent (et ne préviennent) qu'une fois.
    const maj = await prisma.assistantReminder.updateMany({
      where: { id: r.id, active: true },
      data: { active: false },
    });
    if (maj.count !== 1) continue;
    eteints += 1;
    await notifyUser({
      userId: r.userId,
      type: "GENERIC",
      title: `Rappel annulé — ${r.title}`,
      body: "Ce que vous attendiez est arrivé : je n'insiste plus.",
      link: "/chief-of-staff",
    }).catch(sansBloquer("reminders.eteindreRappelsSurEvenement.notifyUser"));
  }
  return eteints;
}

/**
 * REPOUSSE un rappel (« snooze ») — l'échéance recule, l'échelle de relances reste intacte.
 * L'appartenance est vérifiée par la requête : le rappel d'un autre ne bouge pas.
 */
export async function snoozeReminder(id: string, userId: string, minutes: number): Promise<Date | null> {
  const m = Math.max(1, Math.min(7 * 24 * 60, Math.round(minutes)));
  const r = await prisma.assistantReminder.findFirst({ where: { id, userId, active: true }, select: { dueAt: true } });
  if (!r) return null;
  const base = r.dueAt.getTime() > Date.now() ? r.dueAt.getTime() : Date.now();
  const nouvelle = new Date(base + m * 60_000);
  const maj = await prisma.assistantReminder.updateMany({
    where: { id, userId, active: true },
    data: { dueAt: nouvelle },
  });
  // La nouvelle échéance est rendue pour être DITE à la personne — un report muet se re-demande.
  return maj.count === 1 ? nouvelle : null;
}
