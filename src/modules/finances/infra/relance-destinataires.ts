import { prisma } from "@/lib/prisma";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { CHEMIN_CENTRE_DE_PAIEMENT, lienCentreDePaiement } from "@/lib/chemins/finances";
import type { EtatPaiement } from "../domaine/relance-paiement";
import { CENTRAL_AUTH_THRESHOLD_DZD, isHighValue, ROLES_CENTRE_DE_PAIEMENT } from "../domaine/authorization";
import { ENTITE_SANS } from "../domaine/entite-centre";
import { phraseJustificatifAttendu, regleDeJustificatif, titreJoindreJustificatif } from "../domaine/justificatif";

/**
 * PRÉVENIR QUI A LA MAIN — la seule règle des destinataires d'une relance de paiement, lue par la relance unifiée
 * (`relancerPaiement`) ET par la relance du dossier (`nudgePaymentRequest`) (Direction, 14/10/2026) :
 *   • au CENTRE (la Direction générale : le Directeur Général et le Super Admin) tant qu'il n'a pas autorisé ;
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

/** L'ANNONCE AU CENTRE — un ordre y entre : à sa naissance justifiée, ou à sa pièce jointe. Les Finances, elles, n'en savent rien. */
export async function annoncerAuCentre(o: { reference: string; label: string; amount: number; companyId: string | null }): Promise<void> {
  const money = `${o.amount.toLocaleString("fr-FR")} DZD`;
  await notifyRoles([...ROLES_CENTRE_DE_PAIEMENT], {
    type: "VALIDATION_REQUIRED",
    title: "Autorisation de paiement demandée",
    body: `${o.reference} — ${o.label} (${money}${isHighValue(o.amount) ? `, au-dessus de ${CENTRAL_AUTH_THRESHOLD_DZD.toLocaleString("fr-FR")} DZD` : ""})`,
    // L'entité où l'ordre attend : le centre n'a plus qu'une file par entité.
    link: lienCentreDePaiement(o.companyId ?? ENTITE_SANS),
  });
}

/** LA DEMANDE DE PIÈCE — au service qui la détient (le demandeur de l'ordre : les RH pour la paie, les Moyens généraux pour la caisse…). */
export async function demanderLeJustificatif(o: {
  reference: string; label: string; sourceType: string | null; sourceId: string | null; requestedById: string | null; lien: string;
}): Promise<void> {
  const body = `${regleDeJustificatif(o.sourceType).service} : ${phraseJustificatifAttendu(o.sourceType)}`;
  if (o.requestedById) await notifyUser({ userId: o.requestedById, type: "VALIDATION_REQUIRED", title: titreJoindreJustificatif(o), body, link: o.lien });
  // L'achat du secrétariat : l'ordre porte le nom du valideur, la pièce est chez l'assistante qui tient la demande.
  if (o.sourceType === "ADMIN_REQUEST" && o.sourceId) {
    const d = await prisma.administrativeRequest.findUnique({ where: { id: o.sourceId }, select: { assignedToId: true } }).catch(() => null);
    if (d?.assignedToId && d.assignedToId !== o.requestedById) {
      await notifyUser({ userId: d.assignedToId, type: "VALIDATION_REQUIRED", title: titreJoindreJustificatif(o), body, link: `/demandes/${o.sourceId}` });
    }
  }
}
