import { prisma } from "@/lib/prisma";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { lienOrdreAPayer } from "@/lib/chemins/finances";
import {
  etatQuestion, joursAvantRappel, rappelDu, EVT_QUESTION, EVT_RAPPEL, EVT_REPONSE, EVT_REPONSE_LUE,
  type LectureQuestion,
} from "../domaine/banque-paiements";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA QUESTION DES FINANCES AU DEMANDEUR — sur le fil du DOSSIER COMPAGNON de l'ordre (Super Admin, 24/11/2026).
 *
 * Un seul fil : celui que le demandeur lit déjà sur sa demande (`/validations/paiements/<id>`), avec ses pièces. La
 * question, la réponse, le rappel et la lecture y sont des ÉVÉNEMENTS (`PaymentRequestEvent`) — l'état se relit sur
 * eux (`etatQuestion`), sans colonne ni migration. Le demandeur est celui du DOSSIER (`requesterId`) : c'est lui qui
 * l'ouvre et y répond, quel que soit le circuit d'origine.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les genres d'événements qui comptent pour l'état d'une question. */
export const KINDS_QUESTION = [EVT_QUESTION, EVT_REPONSE, EVT_RAPPEL, EVT_REPONSE_LUE, "COMMENT"];

/** Le chemin du fil, côté demandeur. */
export const lienQuestionDemandeur = (dossierId: string) => `/validations/paiements/${dossierId}#question-finances`;

/** Le dossier compagnon d'un ordre — le plus ancien, celui que l'ordre a ouvert en naissant. */
export async function dossierDeLOrdre(orderId: string) {
  return prisma.paymentRequest.findFirst({
    where: { expenseOrderId: orderId },
    orderBy: { createdAt: "asc" },
    select: { id: true, reference: true, title: true, requesterId: true, status: true, expenseOrderId: true },
  });
}

/** L'état de la question de plusieurs dossiers, en une lecture. */
export async function etatsDesQuestions(dossiers: readonly { id: string; requesterId: string }[]): Promise<Map<string, LectureQuestion>> {
  const out = new Map<string, LectureQuestion>();
  if (dossiers.length === 0) return out;
  const events = await prisma.paymentRequestEvent.findMany({
    where: { requestId: { in: dossiers.map((d) => d.id) }, kind: { in: KINDS_QUESTION } },
    select: { requestId: true, kind: true, actorId: true, at: true },
  });
  const parDossier = new Map<string, typeof events>();
  for (const e of events) parDossier.set(e.requestId, [...(parDossier.get(e.requestId) ?? []), e]);
  for (const d of dossiers) out.set(d.id, etatQuestion(parDossier.get(d.id) ?? [], d.requesterId));
  return out;
}

export async function lireQuestion(dossier: { id: string; requesterId: string }): Promise<LectureQuestion> {
  return (await etatsDesQuestions([dossier])).get(dossier.id)!;
}

/**
 * LE DEMANDEUR A RÉPONDU — les Finances le savent. Appelé APRÈS l'écriture de la réponse, avec l'état lu AVANT :
 * seule une question qui attendait prévient (un second message ne resonne pas).
 */
export async function prevenirFinancesDeLaReponse(args: {
  dossier: { id: string; reference: string; expenseOrderId: string | null };
  avant: LectureQuestion;
  message: string | null;
}): Promise<void> {
  if (args.avant.etat !== "EN_ATTENTE_DEMANDEUR") return;
  const notif = {
    type: "GENERIC" as const,
    title: "Réponse du demandeur à votre question",
    body: `${args.dossier.reference}${args.message ? ` — ${args.message.slice(0, 140)}` : ""}`,
    link: lienOrdreAPayer(args.dossier.expenseOrderId),
  };
  if (args.avant.questionPar) await notifyUser({ userId: args.avant.questionPar, ...notif });
  else await notifyRoles(["FINANCE_BUDGET_MANAGER"], notif);
}

/**
 * LE RAPPEL AUTOMATIQUE — une question sans réponse depuis N jours (`FINANCES_RAPPEL_QUESTION_JOURS`, 3 par défaut)
 * rappelle le demandeur. IDEMPOTENT : le rappel est lui-même un événement, qui repart le compte ; deux passages le
 * même jour n'en écrivent qu'un. Seuls les ordres encore à régler sont relus : payé ou annulé, la question est close.
 */
export async function rappelerQuestionsSansReponse(now: Date = new Date()): Promise<number> {
  const jours = joursAvantRappel(process.env.FINANCES_RAPPEL_QUESTION_JOURS);
  const avecQuestion = await prisma.paymentRequestEvent.findMany({
    where: { kind: EVT_QUESTION, at: { gte: new Date(now.getTime() - 120 * 86_400_000) } },
    distinct: ["requestId"],
    select: { requestId: true },
  });
  if (avecQuestion.length === 0) return 0;
  const dossiers = await prisma.paymentRequest.findMany({
    where: { id: { in: avecQuestion.map((e) => e.requestId) }, expenseOrderId: { not: null } },
    select: { id: true, reference: true, title: true, requesterId: true, expenseOrderId: true },
  });
  const ouverts = new Set((await prisma.expenseOrder.findMany({
    where: { id: { in: dossiers.map((d) => d.expenseOrderId!) }, status: "PENDING" },
    select: { id: true },
  })).map((o) => o.id));
  const etats = await etatsDesQuestions(dossiers.filter((d) => ouverts.has(d.expenseOrderId!)));
  let n = 0;
  for (const d of dossiers) {
    const l = etats.get(d.id);
    if (!l || !rappelDu(l, jours, now)) continue;
    // Conditionnel : un autre exécutant a pu écrire le rappel entre la lecture et ici (§118.151).
    const recent = await prisma.paymentRequestEvent.count({
      where: { requestId: d.id, kind: EVT_RAPPEL, at: { gte: new Date(now.getTime() - jours * 86_400_000) } },
    });
    if (recent > 0) continue;
    await prisma.paymentRequestEvent.create({
      data: { requestId: d.id, actorId: null, kind: EVT_RAPPEL, at: now, message: `Rappel automatique : la question des Finances attend votre réponse depuis ${jours} jour(s).` },
    });
    await notifyUser({
      userId: d.requesterId, type: "ASSIGNMENT", title: "Rappel — les Finances attendent votre réponse",
      body: `${d.reference} — ${d.title}`, link: lienQuestionDemandeur(d.id),
    });
    await recordAudit({
      actorId: null, action: "UPDATE", module: "Finances", entityType: "PAYMENT_REQUEST", entityId: d.id,
      summary: `Rappel automatique au demandeur — question des Finances sans réponse (${d.reference})`,
    });
    n += 1;
  }
  return n;
}
