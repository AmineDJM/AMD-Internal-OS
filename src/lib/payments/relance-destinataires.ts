import { prisma } from "@/lib/prisma";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { CHEMIN_CENTRE_DE_PAIEMENT } from "@/lib/chemins/finances";
import type { EtatPaiement } from "@/lib/finance/relance-paiement";
import { ROLES_CENTRE_DE_PAIEMENT } from "@/lib/payments/authorization";

/**
 * PRÉVENIR QUI A LA MAIN — la seule règle des destinataires d'une relance de paiement, lue par la relance unifiée
 * (`relancerPaiement`) ET par la relance du dossier (`nudgePaymentRequest`) (Direction, 14/10/2026) :
 *   • au CENTRE (le PDG, le Directeur Général, le Super Admin par leur rôle, et les sièges nommés) tant qu'il n'a pas autorisé ;
 *   • au DEMANDEUR quand le dossier lui a été renvoyé ;
 *   • aux FINANCES sinon (et au destinataire nommé des demandes anciennes).
 * Prévenir les Finances d'un paiement encore au centre leur annonçait un travail qu'elles ne pouvaient pas commencer.
 *
 * Hors d'un fichier « use server » : envoyer des notifications n'est pas un geste d'écran. Rend « … prévenu(e)s ».
 */
export async function prevenirQuiALaMain(i: {
  etat: EtatPaiement; title: string; body: string; dossierId: string | null; recipientId: string | null; demandeurId: string | null; acteurId: string;
}): Promise<string> {
  const lienDossier = i.dossierId ? `/validations/paiements/${i.dossierId}` : CHEMIN_CENTRE_DE_PAIEMENT;
  if (i.etat === "CENTRE") {
    await notifyRoles([...ROLES_CENTRE_DE_PAIEMENT], { type: "VALIDATION_REQUIRED", title: i.title, body: i.body, link: CHEMIN_CENTRE_DE_PAIEMENT });
    const sieges = await prisma.paymentCentreSeat.findMany({ select: { userId: true } });
    for (const s of sieges) await notifyUser({ userId: s.userId, type: "VALIDATION_REQUIRED", title: i.title, body: i.body, link: CHEMIN_CENTRE_DE_PAIEMENT });
    return "le centre de paiement est prévenu";
  }
  if (i.etat === "DEMANDEUR") {
    if (i.demandeurId && i.demandeurId !== i.acteurId) await notifyUser({ userId: i.demandeurId, type: "VALIDATION_REQUIRED", title: i.title, body: i.body, link: lienDossier });
    return "le demandeur est prévenu";
  }
  if (i.recipientId) await notifyUser({ userId: i.recipientId, type: "VALIDATION_REQUIRED", title: i.title, body: i.body, link: lienDossier });
  await notifyRoles(["FINANCE_BUDGET_MANAGER"], { type: "VALIDATION_REQUIRED", title: i.title, body: i.body, link: lienDossier });
  return "les Finances sont prévenues";
}
