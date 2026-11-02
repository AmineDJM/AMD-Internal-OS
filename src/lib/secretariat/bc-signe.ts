import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import { LIBELLE_BC_DEMANDE } from "@/lib/secretariat/devis-natif";
import { sansBloquer } from "@/lib/journal";

/**
 * APRÈS LA SIGNATURE D'UN BC (module Bons de commande) : si le BC vient d'une demande au
 * secrétariat, la demande le DIT — « Signé et validé » se lit sur sa fiche (l'état est relu par
 * `etatsDesBC`, jamais copié) — et l'assistante qui la suit est prévenue, avec le demandeur : la
 * commande peut partir, la facture suivra, et la demande pourra se terminer. Jamais bloquant.
 *
 * Module à part, sans la fabrique : l'action de signature l'appelle, et n'a pas à charger le
 * générateur de pièces (ni son cycle d'initialisation avec Adam) pour prévenir deux personnes.
 */
export async function apresSignatureDuBCDeDemande(bcId: string, acteurId: string, signataire: string): Promise<void> {
  const bc = await prisma.legalDocument.findUnique({ where: { id: bcId }, select: { sourceType: true, sourceId: true, reference: true, title: true, kind: true } });
  if (!bc || bc.kind !== "PURCHASE_ORDER" || bc.sourceType !== "ADMIN_REQUEST" || !bc.sourceId) return;
  const demande = await prisma.administrativeRequest.findUnique({ where: { id: bc.sourceId }, select: { id: true, reference: true, requesterId: true, assignedToId: true, deletedAt: true } });
  if (!demande || demande.deletedAt) return;
  const nom = bc.reference?.trim() || `« ${bc.title} »`;
  await recordAudit({
    actorId: acteurId, action: "VALIDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: demande.id,
    summary: `Bon de commande ${nom} ${LIBELLE_BC_DEMANDE.SIGNE.toLowerCase()} — signé par ${signataire}`,
  }).catch(sansBloquer("bc-signe.apresSignatureDuBCDeDemande.recordAudit"));
  const avis = { type: "GENERIC" as const, title: "Bon de commande signé et validé", body: `${demande.reference} — ${nom} signé par ${signataire} : la commande peut partir.`, link: `/demandes/${demande.id}` };
  await prevenirLeSecretariat(demande.assignedToId, avis, acteurId).catch(sansBloquer("bc-signe.apresSignatureDuBCDeDemande.prevenirLeSecretariat", 0));
  if (demande.requesterId && demande.requesterId !== acteurId && demande.requesterId !== demande.assignedToId) {
    await notifyUser({ userId: demande.requesterId, ...avis }).catch(sansBloquer("bc-signe.apresSignatureDuBCDeDemande.notifyUser"));
  }
}
