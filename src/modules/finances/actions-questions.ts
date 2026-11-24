"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasGlobalView, userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { persistUploadedDocument } from "@/lib/documents";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { ouvrirPourEcrire } from "@/lib/queries/porte-ecriture";
import { annulable } from "@/lib/effets/ecran";
import {
  dossierDeLOrdre, lienQuestionDemandeur, lireQuestion, prevenirFinancesDeLaReponse, refusRappelManuel,
  EVT_QUESTION, EVT_RAPPEL, EVT_REPONSE, EVT_REPONSE_LUE,
} from "@/modules/finances/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉCHANGES FINANCES ↔ DEMANDEUR SUR UN PAIEMENT (Super Admin, 24/11/2026).
 *
 * Les Finances posent une question sur une ligne de « Banque & paiements » (RIB, mode de règlement, acompte…), avec
 * une pièce si besoin ; le demandeur est prévenu, la retrouve dans « Mon espace › Aujourd'hui », et répond depuis sa
 * demande — une pièce jointe en réponse est rangée comme PIÈCE DU DOSSIER (`addPaymentPiece`, avec ses gardes), le
 * message dit laquelle. Les Finances sont prévenues ; la ligne passe « Réponse reçue » jusqu'à ce qu'elles l'ouvrent.
 *
 * UN SEUL FIL : celui du dossier compagnon de l'ordre (`PaymentRequestEvent`) — le demandeur le lit déjà, le centre de
 * paiement l'ouvre depuis l'ordre. La question ne BLOQUE rien : on peut payer en l'attendant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const REFUS_DROIT = "Réservé à qui tient Banque & paiements (« Modifier ») — un Super Admin l'accorde dans Administration › Accès.";
const SANS_DOSSIER = "Ce paiement n'a pas de dossier où échanger avec le demandeur (ordre ancien, sans demandeur) : contactez-le directement.";
const MESSAGE_MAX = 2_000;

function revaliderLesDeux(dossierId: string) {
  revalidatePath("/finances/paiements-a-faire");
  revalidatePath(`/validations/paiements/${dossierId}`);
  revalidatePath("/mon-espace");
}

/** Les Finances posent une question au demandeur d'un paiement à régler. */
export async function poserQuestionAuDemandeur(formData: FormData): Promise<ActionResult> { return annulable("finances-questions:poserQuestionAuDemandeur", "Poser une question au demandeur d'un paiement", async () => {
  const user = await requireUser();
  const orderId = fdStr(formData, "orderId");
  if (!orderId) return { ok: false, error: "Ordre introuvable." };
  // LA PORTE DE L'ORDRE : le droit de Banque & paiements ET la société de l'ordre.
  const porte = await ouvrirPourEcrire(user, "EXPENSE_ORDER", orderId, "UPDATE");
  if (!porte.ok) return porte;
  const message = fdStr(formData, "message");
  if (!message) return { ok: false, error: "Écrivez la question : ce que vous attendez du demandeur (RIB, mode de règlement, acompte…)." };
  if (message.length > MESSAGE_MAX) return { ok: false, error: `Question trop longue (${MESSAGE_MAX} caractères au plus).` };
  const ordre = await prisma.expenseOrder.findUnique({ where: { id: orderId }, select: { reference: true, label: true, status: true } });
  if (!ordre) return { ok: false, error: "Ordre introuvable." };
  if (ordre.status !== "PENDING") return { ok: false, error: "Ce paiement est réglé ou annulé : il n'y a plus de question à poser." };
  const dossier = await dossierDeLOrdre(orderId);
  if (!dossier) return { ok: false, error: SANS_DOSSIER };

  // LA PIÈCE JOINTE À LA QUESTION se range dans le dossier, comme toute pièce : le demandeur la lit là où il répond.
  let pieceId: string | null = null;
  const fichier = formData.get("file");
  if (fichier instanceof File && fichier.size > 0) {
    const doc = await persistUploadedDocument(user.id, {
      entityType: "PAYMENT_REQUEST", entityId: dossier.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file: fichier,
    });
    if (!doc.ok || !doc.documentId) return { ok: false, error: doc.error ?? "La pièce n'a pas pu être enregistrée : réessayez — la question n'est pas partie." };
    const position = await prisma.paymentPiece.count({ where: { requestId: dossier.id } });
    pieceId = (await prisma.paymentPiece.create({
      data: {
        requestId: dossier.id, documentId: doc.documentId, kind: "OTHER", status: "ACCEPTED",
        note: "Jointe par les Finances à leur question.", position, createdById: user.id,
      },
      select: { id: true },
    })).id;
  }
  await prisma.paymentRequestEvent.create({ data: { requestId: dossier.id, actorId: user.id, kind: EVT_QUESTION, message, pieceId } });
  await notifyUser({
    userId: dossier.requesterId, type: "ASSIGNMENT", title: "Les Finances vous posent une question",
    body: `${dossier.reference} — ${ordre.label} : ${message.slice(0, 160)}`, link: lienQuestionDemandeur(dossier.id),
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", entityType: "EXPENSE_ORDER", entityId: orderId,
    summary: `Question au demandeur — ${ordre.reference} (${dossier.reference}) : ${message.slice(0, 200)}`,
  });
  revaliderLesDeux(dossier.id);
  return { ok: true, id: dossier.id, message: "Question envoyée : le demandeur est prévenu et répondra depuis sa demande." };
}); }

/** Les Finances relancent le demandeur sur une question restée sans réponse (une fois par 24 h). */
export async function relancerQuestionDemandeur(formData: FormData): Promise<ActionResult> { return annulable("finances-questions:relancerQuestionDemandeur", "Relancer le demandeur sur une question", async () => {
  const user = await requireUser();
  const orderId = fdStr(formData, "orderId");
  if (!orderId) return { ok: false, error: "Ordre introuvable." };
  const porte = await ouvrirPourEcrire(user, "EXPENSE_ORDER", orderId, "UPDATE");
  if (!porte.ok) return porte;
  const dossier = await dossierDeLOrdre(orderId);
  if (!dossier) return { ok: false, error: SANS_DOSSIER };
  const refus = refusRappelManuel(await lireQuestion(dossier));
  if (refus) return { ok: false, error: refus };
  await prisma.paymentRequestEvent.create({ data: { requestId: dossier.id, actorId: user.id, kind: EVT_RAPPEL, message: "Les Finances attendent toujours votre réponse." } });
  await notifyUser({
    userId: dossier.requesterId, type: "ASSIGNMENT", title: "Rappel — les Finances attendent votre réponse",
    body: `${dossier.reference} — ${dossier.title}`, link: lienQuestionDemandeur(dossier.id),
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", entityType: "EXPENSE_ORDER", entityId: orderId,
    summary: `Rappel au demandeur — question sans réponse (${dossier.reference})`,
  });
  revaliderLesDeux(dossier.id);
  return { ok: true, message: "Rappel envoyé au demandeur." };
}); }

/**
 * LES FINANCES ONT LU LA RÉPONSE — l'ouverture du panneau de la ligne l'écrit : « Réponse reçue » s'éteint.
 * Idempotent : sans réponse non lue, rien ne s'écrit.
 */
export async function marquerReponseLue(formData: FormData): Promise<ActionResult> { return annulable("finances-questions:marquerReponseLue", "Marquer lue la réponse du demandeur", async () => {
  const user = await requireUser();
  const orderId = fdStr(formData, "orderId");
  if (!orderId) return { ok: false, error: "Ordre introuvable." };
  if (!userCan(user, "FINANCES_BANQUE", "VIEW")) return { ok: false, error: REFUS_DROIT };
  const dossier = await dossierDeLOrdre(orderId);
  if (!dossier) return { ok: true };
  if ((await lireQuestion(dossier)).etat !== "REPONSE_RECUE") return { ok: true };
  await prisma.paymentRequestEvent.create({ data: { requestId: dossier.id, actorId: user.id, kind: EVT_REPONSE_LUE } });
  revalidatePath("/finances/paiements-a-faire");
  return { ok: true };
}); }

/**
 * LE DEMANDEUR RÉPOND, depuis sa demande. La pièce éventuelle a été déposée juste avant par `addPaymentPiece` (ses
 * gardes : facture déjà connue, écart de montant) ; on la NOMME ici, sans la redéposer.
 */
export async function repondreAuxFinances(formData: FormData): Promise<ActionResult> { return annulable("finances-questions:repondreAuxFinances", "Répondre à la question des Finances", async () => {
  const user = await requireUser();
  const requestId = fdStr(formData, "requestId");
  if (!requestId) return { ok: false, error: "Demande introuvable." };
  const dossier = await prisma.paymentRequest.findUnique({
    where: { id: requestId }, select: { id: true, reference: true, requesterId: true, expenseOrderId: true },
  });
  if (!dossier) return { ok: false, error: "Demande introuvable." };
  if (dossier.requesterId !== user.id && !hasGlobalView(user.role)) return { ok: false, error: "Seul le demandeur répond aux Finances sur sa demande." };
  const pieceId = fdStr(formData, "pieceId");
  const piece = pieceId
    ? await prisma.paymentPiece.findFirst({ where: { id: pieceId, requestId }, select: { id: true, documentId: true } })
    : null;
  if (pieceId && !piece) return { ok: false, error: "Pièce introuvable dans ce dossier : rechargez la page." };
  const texte = fdStr(formData, "message");
  if (!texte && !piece) return { ok: false, error: "Écrivez votre réponse, ou joignez la pièce demandée." };
  if (texte && texte.length > MESSAGE_MAX) return { ok: false, error: `Réponse trop longue (${MESSAGE_MAX} caractères au plus).` };
  const nomPiece = piece ? (await prisma.document.findUnique({ where: { id: piece.documentId }, select: { name: true } }))?.name ?? "pièce" : null;
  const message = [texte, nomPiece ? `Pièce jointe : ${nomPiece}` : null].filter(Boolean).join("\n");

  const avant = await lireQuestion({ id: dossier.id, requesterId: dossier.requesterId });
  // La réponse du DEMANDEUR éteint l'attente (`etatQuestion`) ; celle d'un tiers à vue globale reste un message du fil.
  await prisma.paymentRequestEvent.create({ data: { requestId, actorId: user.id, kind: EVT_REPONSE, message, pieceId: piece?.id ?? null } });
  await prevenirFinancesDeLaReponse({ dossier, avant, message });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Demandes de paiement", entityType: "PAYMENT_REQUEST", entityId: requestId,
    summary: `Réponse aux Finances — ${dossier.reference}${nomPiece ? ` (pièce : ${nomPiece})` : ""}`,
  });
  revaliderLesDeux(requestId);
  return { ok: true, id: requestId, message: "Réponse envoyée aux Finances." };
}); }
