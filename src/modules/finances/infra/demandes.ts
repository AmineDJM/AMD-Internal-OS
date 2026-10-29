import type { PaymentRequestStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { referenceDeSerie } from "@/lib/refs";
import { ttcDesFacturesStockees } from "@/lib/factures/connues";
import type { ActionResult } from "@/lib/actions/types";
import { ROLES_CENTRE_DE_PAIEMENT } from "../domaine/authorization";
import { statusFromPieces } from "../domaine/payment-request";
import type { LectureMontant } from "../domaine/montant-facture";

/**
 * LES AIDES PRIVÉES DES ACTIONS DE DEMANDE DE PAIEMENT (`actions-demandes.ts`) — qui instruit, qui
 * demande, le fil du dossier, la relecture des pages, l'alerte au centre, le recalcul d'état.
 *
 * Elles vivaient en tête du fichier d'actions (1 197 lignes) ; elles en sortent pour qu'aucun fichier
 * du module ne dépasse 1 000 lignes. Elles ne sont PAS dans `api.ts` : ce sont des détails des actions,
 * pas un contrat du module, et le fichier d'actions les importe en RELATIF — le scanner du contrat ne
 * suit que les portes `@/`, si bien que chaque action est décrite exactement comme quand ces aides
 * étaient locales (`npm run actions:contrat` identique).
 */

/** La page des demandes de paiement — la même que `PATH` dans `actions-demandes.ts`. */
const PATH = "/validations/paiements";

/** Les Finances — celles qui instruisent. La Direction supplée, comme partout ailleurs. */
export function isFinance(user: SessionUser): boolean {
  return user.role === "FINANCE_BUDGET_MANAGER"
    || userCan(user, "FINANCES", "VALIDATE")
    || userCan(user, "FINANCES", "UPDATE")
    || hasGlobalView(user.role);
}

export function isRequester(user: SessionUser, req: { requesterId: string }): boolean {
  return req.requesterId === user.id || hasGlobalView(user.role);
}

export async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "PaymentRequest", prefixe: "PAY", annee: year,
    existantes: async () => (await prisma.paymentRequest.findMany({ where: { reference: { startsWith: `PAY-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

export function revalidate(id?: string) {
  revalidatePath("/validations");
  revalidatePath(PATH);
  if (id) revalidatePath(`${PATH}/${id}`);
}

/** Le fil du dossier : chaque geste laisse une trace lisible, dans l'ordre. */
export async function trace(requestId: string, actorId: string | null, kind: string, message?: string | null, pieceId?: string | null) {
  await prisma.paymentRequestEvent.create({
    data: { requestId, actorId, kind, message: message || null, pieceId: pieceId || null },
  });
}

/**
 * PRÉVENIR QUI DOIT AGIR — le CENTRE, puis les Finances seulement une fois autorisé.
 *
 * Une demande transmise n'attend pas les Finances : elle attend le centre de paiement, qui
 * autorise avant qu'elles ne voient quoi que ce soit. Les prévenir à ce moment-là leur annonçait
 * un travail qu'elles ne pouvaient pas commencer — et noyait la vraie alerte, celle du centre.
 *
 * Le destinataire nommé n'existe plus à la création ; il survit sur les demandes anciennes, et on
 * continue de le prévenir quand il y en a un : sa demande est la sienne, il doit la suivre.
 */
export async function alertFinance(req: { id: string; reference: string; title: string; recipientId: string | null }, title: string) {
  const body = `${req.reference} — ${req.title}`;
  const link = `${PATH}/${req.id}`;
  if (req.recipientId) await notifyUser({ userId: req.recipientId, type: "VALIDATION_REQUIRED", title, body, link });
  await notifyRoles([...ROLES_CENTRE_DE_PAIEMENT], { type: "VALIDATION_REQUIRED", title, body, link });
}

/** Recalcule l'état d'après les verdicts, et le trace s'il change. */
export async function syncStatus(requestId: string, current: string, actorId: string | null): Promise<string> {
  // Les pièces EN VIGUEUR : une pièce remplacée ne dicte plus rien (`piecesEnVigueur`). Mesuré : retiré
  // seul, ce filtre ne change aucun état ici — une pièce remplacée est soit marquée acceptée à son
  // remplacement, soit une pièce jamais mise en cause (en attente ou acceptée), et aucune des deux ne fait
  // changer le dossier de camp (`statusFromPieces`). Il reste parce que c'est la MÊME lecture que la
  // transmission et le bon à payer, qui, eux, en dépendent (le décompte des pièces validées).
  const pieces = await prisma.paymentPiece.findMany({ where: { requestId, replacedBy: { is: null } }, select: { status: true } });
  const next = statusFromPieces(current, pieces);
  if (!next) return current;
  await prisma.paymentRequest.update({ where: { id: requestId }, data: { status: next as PaymentRequestStatus } });
  await trace(requestId, actorId, next === "CHANGES_REQUESTED" ? "CHANGES" : "SUBMIT", "État recalculé d'après les verdicts des pièces.");
  return next;
}

/**
 * LE TTC LU DES FACTURES EN VIGUEUR d'une demande (`finance/montant-facture.ts`) — une facture remplacée ne compte plus.
 * La pièce qu'on vient de déposer arrive avec sa lecture du dépôt ; les autres avec leur lecture gardée.
 */
export async function ttcDesFacturesEnVigueur(requestId: string, ajout?: { pieceId: string; ttc: number | null }): Promise<(number | null)[]> {
  const pieces = await prisma.paymentPiece.findMany({
    where: { requestId, kind: "INVOICE", replacedBy: { is: null } }, select: { id: true, documentId: true },
  });
  const stockes = await ttcDesFacturesStockees(pieces.filter((p) => p.id !== ajout?.pieceId).map((p) => p.documentId));
  return pieces.map((p) => (ajout && p.id === ajout.pieceId ? ajout.ttc : stockes.get(p.documentId) ?? null));
}

/** Le refus d'un écart de montant, avec les deux chiffres que l'écran propose de reprendre. */
export function refusDuMontant(lecture: LectureMontant, error: string): ActionResult {
  return { ok: false, error, ...(lecture.etat === "ECART" ? { ecartMontant: { montant: lecture.montant, total: lecture.total } } : {}) };
}

/** Une correction refusée au milieu de la transaction — elle annule tout, et son motif remonte. */
export class CorrectionRefusee extends Error {}
