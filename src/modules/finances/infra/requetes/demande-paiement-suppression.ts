import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { refusDeSuppression } from "../../domaine/correction-demande";
import { isCompanionDossier } from "../../domaine/dossier-auto";

/**
 * SUPPRIMER UNE DEMANDE DE PAIEMENT — la porte de l'écran, de l'aperçu ET de l'action (la même lecture : un bouton
 * armé que l'action refuse fait chercher une panne qui n'existe pas).
 *
 * QUI : le demandeur lui-même, ou le Super Admin. Pas la vue globale qui le supplée ailleurs : retirer est un geste
 * qu'on fait pour quelqu'un, supprimer efface son dossier — la corbeille le rend, mais seul le Super Admin y va.
 *
 * Ce module n'est pas un fichier `"use server"` : c'est une QUESTION posée par des actions qui ont déjà la session.
 */
export async function peutSupprimerUneDemandePaiement(user: Pick<SessionUser, "id" | "role">, id: string): Promise<boolean> {
  if (user.role === "SUPER_ADMIN") return true;
  const req = await prisma.paymentRequest.findUnique({ where: { id }, select: { requesterId: true } });
  return req !== null && req.requesterId === user.id;
}

/** CE QUI INTERDIT LA SUPPRESSION — relu en base (`refusDeSuppression`), `null` si elle peut avoir lieu. */
export async function refusSuppressionDemandePaiement(id: string): Promise<string | null> {
  const req = await prisma.paymentRequest.findUnique({ where: { id }, select: { status: true, origin: true, expenseOrderId: true } });
  if (!req) return null; // l'introuvable se dit par `describe`
  const ordre = req.expenseOrderId
    ? await prisma.expenseOrder.findUnique({ where: { id: req.expenseOrderId }, select: { status: true, reference: true, transactionId: true, paidDate: true } })
    : null;
  return refusDeSuppression({ status: req.status, compagnon: isCompanionDossier(req.origin), ordre });
}
