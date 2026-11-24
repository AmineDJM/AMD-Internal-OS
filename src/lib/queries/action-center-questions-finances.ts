import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { EVT_QUESTION, etatsDesQuestions, lienQuestionDemandeur } from "@/modules/finances/api";
import type { ActionItem } from "./action-center";

/**
 * « MON ESPACE » — LES QUESTIONS DES FINANCES QUI M'ATTENDENT (Banque & paiements, 24/11/2026).
 *
 * Les Finances posent une question sur un paiement (RIB, mode de règlement, acompte…) : le demandeur la retrouve ici,
 * « Les Finances vous posent une question — <objet> », et répond depuis sa demande. La ligne disparaît dès sa réponse
 * (l'état se relit sur le fil du dossier, `etatQuestion`) ou quand le paiement n'est plus à régler.
 */
export async function lignesQuestionsDesFinances(user: SessionUser): Promise<ActionItem[]> {
  const questions = await prisma.paymentRequestEvent.findMany({
    where: { kind: EVT_QUESTION, request: { requesterId: user.id } },
    orderBy: { at: "desc" },
    select: { requestId: true, message: true, at: true },
    take: 200,
  });
  if (questions.length === 0) return [];
  const derniere = new Map<string, { message: string | null; at: Date }>();
  for (const q of questions) if (!derniere.has(q.requestId)) derniere.set(q.requestId, q);
  const dossiers = await prisma.paymentRequest.findMany({
    where: { id: { in: [...derniere.keys()] }, requesterId: user.id, expenseOrderId: { not: null } },
    select: { id: true, reference: true, title: true, requesterId: true, expenseOrderId: true, amount: true },
  });
  const ouverts = new Set((await prisma.expenseOrder.findMany({
    where: { id: { in: dossiers.map((d) => d.expenseOrderId!) }, status: "PENDING" },
    select: { id: true },
  })).map((o) => o.id));
  const vivants = dossiers.filter((d) => ouverts.has(d.expenseOrderId!));
  const etats = await etatsDesQuestions(vivants);
  const out: ActionItem[] = [];
  for (const d of vivants) {
    if (etats.get(d.id)?.etat !== "EN_ATTENTE_DEMANDEUR") continue;
    const q = derniere.get(d.id)!;
    const texte = q.message ?? "";
    out.push({
      key: `qfin-${d.id}`, objet: `QUESTION_FINANCES:${d.id}`,
      title: `Les Finances vous posent une question — ${d.title}`,
      subtitle: texte.length > 140 ? `${texte.slice(0, 140)}…` : texte || d.reference,
      module: "Finances", href: lienQuestionDemandeur(d.id), kind: "request", priority: "HIGH",
      deadline: null, depuis: q.at.toISOString(), owner: "", statusLabel: "Question des Finances", statusTone: "warning",
      montant: Number(d.amount),
    });
  }
  return out;
}
