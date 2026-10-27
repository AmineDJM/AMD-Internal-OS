import type { AssistantRoutine, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { proprietaire } from "@/platform/in-process/missions/proprietaire";
import { decrireCalendrier, prochaineExecution, type Calendrier, type Frequence } from "./calendrier";
import { passageDeRoutine } from "./passage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ROUTINES DE L'ASSISTANT IA — programmer, gérer, exécuter.
 *
 * ── CE QU'UNE ROUTINE EST, ET CE QU'ELLE N'EST PAS ───────────────────────────────────────
 *
 * La PERSONNE la programme (une carte, confirmée) ; l'assistant ne s'en crée jamais une. À chaque
 * passage, le tour de l'assistant est rejoué SOUS SES DROITS, RELUS À CE MOMENT (`proprietaire`) —
 * un module retiré le mardi n'est plus lu le dimanche —, en LECTURE SEULE : une routine lit,
 * cherche, rapporte ; elle n'écrit rien, n'envoie rien, ne relance personne.
 *
 * ── PAS D'ÉCHEC MUET ─────────────────────────────────────────────────────────────────────
 *
 * Chaque passage laisse une ligne (rapport, « rien de nouveau », échec et sa cause, passage
 * ignoré et pourquoi) et, si la personne l'a laissé, une notification. Trois échecs d'affilée le
 * disent plus fort ; la routine n'est jamais éteinte en douce. Elle n'est mise en pause que si
 * l'assistant ne lui est plus ouvert — et la notification le dit.
 *
 * ── LA PRISE EST ATOMIQUE ────────────────────────────────────────────────────────────────
 *
 * Même motif que le planificateur de l'ERP : la prochaine échéance est avancée DANS l'écriture
 * qui prend la routine (`priseLe: null` comme précondition) — deux instances ne la jouent pas deux
 * fois, et un processus tué ne la laisse pas perpétuellement due.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ROUTINES_ACTIVES_MAX = 10;
const PRISE_PERIMEE_MS = 15 * 60_000;
const PAR_PASSAGE = 3;
const PASSAGES_GARDES = 60;
const ECHECS_ALERTE = 3;
/** Au-delà de ce retard, le passage est dit « rattrapé » (serveur arrêté, instance en veille). */
const RETARD_DIT_MS = 30 * 60_000;

export const calendrierDe = (r: Pick<AssistantRoutine, "frequence" | "intervalle" | "jours" | "jourDuMois" | "heure" | "minute" | "debutLe" | "finLe" | "maxExecutions">): Calendrier => ({
  frequence: r.frequence as Frequence, intervalle: r.intervalle, jours: r.jours, jourDuMois: r.jourDuMois,
  heure: r.heure, minute: r.minute, debutLe: r.debutLe, finLe: r.finLe, maxExecutions: r.maxExecutions,
});

export interface NouvelleRoutine {
  titre: string;
  consigne: string;
  calendrier: Calendrier;
}

export async function routinesActives(userId: string): Promise<number> {
  return prisma.assistantRoutine.count({ where: { userId, statut: "ACTIVE" } });
}

export async function creerRoutine(userId: string, n: NouvelleRoutine, now = new Date()): Promise<{ ok: true; routine: AssistantRoutine } | { ok: false; erreur: string }> {
  if ((await routinesActives(userId)) >= ROUTINES_ACTIVES_MAX) {
    return { ok: false, erreur: `Vous avez déjà ${ROUTINES_ACTIVES_MAX} routines actives : mettez-en une en pause ou supprimez-la.` };
  }
  const prochaine = prochaineExecution(n.calendrier, now, 0);
  if (!prochaine) return { ok: false, erreur: "Ce calendrier ne tombe jamais dans le futur : vérifiez la date, l'heure ou la fin." };
  const c = n.calendrier;
  const routine = await prisma.assistantRoutine.create({
    data: {
      userId, titre: n.titre.slice(0, 120), consigne: n.consigne.slice(0, 4000),
      frequence: c.frequence, intervalle: c.intervalle, jours: c.jours, jourDuMois: c.jourDuMois, heure: c.heure, minute: c.minute,
      debutLe: c.debutLe, finLe: c.finLe, maxExecutions: c.maxExecutions, prochaineLe: prochaine,
    },
  });
  return { ok: true, routine };
}

export async function modifierRoutine(userId: string, id: string, n: NouvelleRoutine, now = new Date()): Promise<{ ok: true; routine: AssistantRoutine } | { ok: false; erreur: string }> {
  const r = await prisma.assistantRoutine.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, erreur: "Routine introuvable." };
  const prochaine = prochaineExecution(n.calendrier, now, 0);
  if (!prochaine) return { ok: false, erreur: "Ce calendrier ne tombe jamais dans le futur : vérifiez la date, l'heure ou la fin." };
  const c = n.calendrier;
  const routine = await prisma.assistantRoutine.update({
    where: { id },
    data: {
      titre: n.titre.slice(0, 120), consigne: n.consigne.slice(0, 4000),
      frequence: c.frequence, intervalle: c.intervalle, jours: c.jours, jourDuMois: c.jourDuMois, heure: c.heure, minute: c.minute,
      debutLe: c.debutLe, finLe: c.finLe, maxExecutions: c.maxExecutions, prochaineLe: prochaine,
      executions: 0, statut: r.statut === "ENDED" ? "ACTIVE" : r.statut,
    },
  });
  return { ok: true, routine };
}

export async function changerStatut(userId: string, id: string, statut: "ACTIVE" | "PAUSED", now = new Date()): Promise<{ ok: true; routine: AssistantRoutine } | { ok: false; erreur: string }> {
  const r = await prisma.assistantRoutine.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, erreur: "Routine introuvable." };
  if (r.statut === "ENDED") return { ok: false, erreur: "Cette routine est terminée : modifiez son calendrier pour la relancer." };
  if (statut === "ACTIVE" && r.statut !== "ACTIVE" && (await routinesActives(userId)) >= ROUTINES_ACTIVES_MAX) {
    return { ok: false, erreur: `Vous avez déjà ${ROUTINES_ACTIVES_MAX} routines actives.` };
  }
  // REPRENDRE ne rejoue pas les passages manqués pendant la pause : la prochaine échéance repart de maintenant.
  const prochaine = statut === "ACTIVE" ? prochaineExecution(calendrierDe(r), now, r.executions) : r.prochaineLe;
  const routine = await prisma.assistantRoutine.update({
    where: { id },
    data: { statut: statut === "ACTIVE" && !prochaine ? "ENDED" : statut, prochaineLe: prochaine },
  });
  return { ok: true, routine };
}

export async function supprimerRoutine(userId: string, id: string): Promise<boolean> {
  return (await prisma.assistantRoutine.deleteMany({ where: { id, userId } })).count === 1;
}

export async function listerRoutines(userId: string) {
  const routines = await prisma.assistantRoutine.findMany({
    where: { userId },
    orderBy: [{ statut: "asc" }, { prochaineLe: "asc" }],
    include: { passages: { orderBy: { debutLe: "desc" }, take: 12, select: { id: true, debutLe: true, statut: true, declenchement: true, luLe: true, erreur: true, contenu: true } } },
  });
  return routines.map((r) => ({
    id: r.id, titre: r.titre, consigne: r.consigne, statut: r.statut, quand: decrireCalendrier(calendrierDe(r)),
    prochaineLe: r.prochaineLe?.toISOString() ?? null, derniereLe: r.derniereLe?.toISOString() ?? null,
    echecsConsecutifs: r.echecsConsecutifs, notifier: r.notifier,
    passages: r.passages.map((p) => ({
      id: p.id, debutLe: p.debutLe.toISOString(), statut: p.statut, declenchement: p.declenchement, lu: Boolean(p.luLe),
      apercu: (p.erreur ?? p.contenu ?? "").replace(/\s+/g, " ").slice(0, 160),
    })),
  }));
}

export async function lirePassage(userId: string, runId: string) {
  const p = await prisma.assistantRoutineRun.findFirst({ where: { id: runId, routine: { userId } }, include: { routine: { select: { titre: true } } } });
  if (!p) return null;
  if (!p.luLe) await prisma.assistantRoutineRun.update({ where: { id: p.id }, data: { luLe: new Date() } });
  return { id: p.id, titre: p.routine.titre, debutLe: p.debutLe.toISOString(), statut: p.statut, contenu: p.contenu, blocs: p.blocs, erreur: p.erreur, outils: p.outils };
}

export async function passagesNonLus(userId: string): Promise<number> {
  return prisma.assistantRoutineRun.count({ where: { luLe: null, routine: { userId } } });
}

// ─────────────────────────────── L'exécution ───────────────────────────────

type Statut = "SUCCES" | "RIEN_DE_NOUVEAU" | "ECHEC" | "IGNOREE";

const lien = (id: string) => `/assistant?routine=${id}`;

async function notifier(r: AssistantRoutine, titre: string, corps: string, toujours = false): Promise<void> {
  if (!r.notifier && !toujours) return;
  await notifyUser({ userId: r.userId, type: "GENERIC", title: titre, body: corps.slice(0, 280), link: lien(r.id) }).catch(() => undefined);
}

/**
 * JOUE UN PASSAGE d'une routine déjà prise (ou demandée à la main) — et le consigne. Ne lève jamais.
 */
export async function jouerRoutine(r: AssistantRoutine, declenchement: "PLANIFIE" | "MANUEL", now = new Date(), prevuLe: Date | null = null): Promise<{ statut: Statut; runId: string }> {
  const debut = Date.now();
  let statut: Statut;
  let contenu: string | null = null;
  let blocs: Prisma.InputJsonValue | undefined;
  let erreur: string | null = null;
  let outils: string[] = [];
  let pause = false;

  const user = await proprietaire(r.userId);
  if (!user) {
    [statut, erreur] = ["IGNOREE", "Le compte n'est plus actif."];
    pause = true;
  } else if (!peutUtiliserAssistantIA(user)) {
    [statut, erreur] = ["IGNOREE", "L'assistant ne vous est plus ouvert : la routine est mise en pause."];
    pause = true;
  } else {
    const etat = (r.etat ?? {}) as { dernierRapport?: string; dernierLe?: string };
    const retard = prevuLe && now.getTime() - prevuLe.getTime() > RETARD_DIT_MS ? prevuLe : null;
    const p = await passageDeRoutine(user, { titre: r.titre, consigne: r.consigne, precedent: etat.dernierRapport ?? null, precedentLe: etat.dernierLe ?? null, retard, now });
    if (p.ok) {
      contenu = p.contenu;
      blocs = p.blocs as Prisma.InputJsonValue;
      outils = p.outils;
      statut = /^\s*\**\s*rien de nouveau/i.test(p.contenu) ? "RIEN_DE_NOUVEAU" : "SUCCES";
    } else {
      [statut, erreur] = ["ECHEC", p.raison];
    }
  }

  const run = await prisma.assistantRoutineRun.create({
    data: {
      routineId: r.id, debutLe: new Date(debut), finLe: new Date(), statut, declenchement, contenu, erreur, ms: Date.now() - debut,
      ...(blocs !== undefined ? { blocs } : {}), outils,
    },
  });
  const echecs = statut === "ECHEC" ? r.echecsConsecutifs + 1 : 0;
  const fin = declenchement === "PLANIFIE" && !r.prochaineLe;
  await prisma.assistantRoutine.update({
    where: { id: r.id },
    data: {
      priseLe: null, derniereLe: now, echecsConsecutifs: echecs,
      ...(declenchement === "PLANIFIE" ? { executions: { increment: 1 } } : {}),
      ...(contenu ? { etat: { dernierRapport: contenu.slice(0, 2000), dernierLe: now.toISOString() } } : {}),
      ...(pause ? { statut: "PAUSED" } : fin ? { statut: "ENDED" } : {}),
    },
  }).catch((e) => console.error("[routines] mise à jour", r.id, e));
  // L'historique se borne ici, pas dans un balayage à part : une routine quotidienne ferait sinon des milliers de lignes.
  const anciens = await prisma.assistantRoutineRun.findMany({ where: { routineId: r.id }, orderBy: { debutLe: "desc" }, skip: PASSAGES_GARDES, select: { id: true } });
  if (anciens.length) await prisma.assistantRoutineRun.deleteMany({ where: { id: { in: anciens.map((a) => a.id) } } }).catch(() => undefined);

  if (statut === "SUCCES") await notifier(r, `Routine « ${r.titre} » : rapport prêt`, contenu!.replace(/[#*_`>]/g, "").trim());
  else if (statut === "RIEN_DE_NOUVEAU") await notifier(r, `Routine « ${r.titre} » : rien de nouveau`, "Le passage a eu lieu ; rien n'a changé depuis le précédent rapport.");
  else if (statut === "ECHEC") {
    await notifier(r, echecs >= ECHECS_ALERTE ? `Routine « ${r.titre} » : ${echecs} échecs d'affilée` : `Routine « ${r.titre} » : passage en échec`,
      `${erreur}${echecs >= ECHECS_ALERTE ? " — vérifiez-la, ou mettez-la en pause." : " Elle repassera à l'échéance suivante."}`, true);
  } else if (user) await notifier(r, `Routine « ${r.titre} » : passage ignoré`, erreur ?? "", true);
  return { statut, runId: run.id };
}

/** UN BALAYAGE : libère les prises perdues, prend et joue les routines dues. Ne lève jamais. */
export async function executerRoutinesDues(now = new Date(), parPassage = PAR_PASSAGE): Promise<{ jouees: number }> {
  let jouees = 0;
  try {
    await prisma.assistantRoutine.updateMany({ where: { priseLe: { lt: new Date(now.getTime() - PRISE_PERIMEE_MS) } }, data: { priseLe: null } });
    for (let i = 0; i < parPassage; i++) {
      const candidates = await prisma.assistantRoutine.findMany({
        where: { statut: "ACTIVE", priseLe: null, prochaineLe: { lte: now } }, orderBy: { prochaineLe: "asc" }, take: 5,
      });
      let prise: AssistantRoutine | null = null;
      let prevuLe: Date | null = null;
      for (const c of candidates) {
        const suivante = prochaineExecution(calendrierDe(c), now, c.executions + 1);
        const ok = await prisma.assistantRoutine.updateMany({ where: { id: c.id, priseLe: null, statut: "ACTIVE" }, data: { priseLe: now, prochaineLe: suivante } });
        if (ok.count === 1) { prise = { ...c, prochaineLe: suivante }; prevuLe = c.prochaineLe; break; }
      }
      if (!prise) break;
      await jouerRoutine(prise, "PLANIFIE", now, prevuLe);
      jouees++;
    }
  } catch (e) {
    console.error("[routines] balayage", e);
  }
  return { jouees };
}

/** « Exécuter maintenant » — hors calendrier : ne compte pas dans le nombre de passages, ne déplace pas l'échéance. */
export async function executerMaintenant(userId: string, id: string): Promise<{ ok: true; statut: Statut; runId: string } | { ok: false; erreur: string }> {
  const r = await prisma.assistantRoutine.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, erreur: "Routine introuvable." };
  const pris = await prisma.assistantRoutine.updateMany({ where: { id, priseLe: null }, data: { priseLe: new Date() } });
  if (pris.count !== 1) return { ok: false, erreur: "Cette routine est déjà en cours d'exécution." };
  const j = await jouerRoutine(r, "MANUEL");
  return { ok: true, ...j };
}
