import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { ecrireAuFil } from "@/modules/ad-pro/api";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE DE DEVIS RETIRÉE — LE DOSSIER NE RESTE PAS « DEVIS DEMANDÉS » (audit du 04/10, constat 35).
 *
 * Une demande de devis de matériel promotionnel est une demande au secrétariat (`type: QUOTE`,
 * `linkedEntityType: PROMO_MATERIAL`). Annulée — depuis le dossier, par son demandeur dans « Demandes »,
 * ou par le secrétariat —, elle laissait le dossier sur « devis demandés » : une étape que plus personne
 * n'avait à faire avancer, sans une ligne d'échec. Quand PLUS AUCUNE demande de devis n'est vivante, le
 * dossier revient à l'étape d'AVANT :
 *   • « devis à demander » s'il n'a jamais reçu de devis retranscrits (première demande) ;
 *   • le choix des lignes s'il en a reçu lors d'un tour PRÉCÉDENT terminé (une demande de « nouveaux
 *     devis » retirée : les devis déjà retranscrits et vérifiés sont toujours là).
 *
 * Sous le verrou de la ligne du dossier, et par une écriture CONDITIONNELLE sur « devis demandés » : deux
 * retraits simultanés ne ramènent le dossier qu'une fois, et un dossier qui a changé d'étape entre-temps
 * n'est pas touché. Hors d'un fichier « use server » : elle reçoit l'auteur en argument (§118.153).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une demande de devis du secrétariat encore VIVANTE — celle qui retient le dossier sur « devis demandés ». */
export const DEMANDE_DEVIS_VIVANTE = { type: "QUOTE" as const, deletedAt: null, status: { notIn: ["DONE" as const, "CANCELLED" as const] } };

/**
 * LES DEMANDES DE DEVIS VIVANTES D'UN DOSSIER, et ce qui empêche de les retirer — une lecture pour l'action
 * et pour la fiche (§118.83). EXÉCUTÉE dès que l'assistante a commencé à RETRANSCRIRE : un devis enregistré
 * depuis la demande est du travail fait.
 */
export async function etatRetraitDemandeDevis(promoMaterialId: string): Promise<{
  demandes: { id: string; reference: string }[]; refus: string | null;
}> {
  const demandes = await prisma.administrativeRequest.findMany({
    where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: promoMaterialId, ...DEMANDE_DEVIS_VIVANTE },
    select: { id: true, reference: true, createdAt: true }, orderBy: { createdAt: "asc" },
  });
  if (demandes.length === 0) return { demandes: [], refus: null };
  const commences = await prisma.promoQuote.count({ where: { promoMaterialId, createdAt: { gte: demandes[0]!.createdAt } } });
  const refus = commences > 0
    ? `L'assistante a déjà retranscrit ${commences} devis pour cette demande : elle est en cours d'exécution et ne se retire plus. Demandez-lui de terminer (vous choisirez ensuite les lignes, ou redemanderez des devis), ou de retirer ces devis d'abord.`
    : null;
  return { demandes: demandes.map((d) => ({ id: d.id, reference: d.reference })), refus };
}

export async function ramenerSiPlusDeDemandeDevis(
  promoMaterialId: string, auteurId: string, motif: string,
): Promise<{ ramene: boolean; etape: "QUOTE_TO_REQUEST" | "REVIEW_REQUESTER" | null }> {
  const r = await prisma.$transaction(async (tx) => {
    const [pm] = await tx.$queryRaw<{ circuitState: string | null; circuitVersion: number; reference: string; requesterId: string | null }[]>`
      SELECT "circuitState", "circuitVersion", reference, "requesterId" FROM "PromoMaterial" WHERE id = ${promoMaterialId} FOR UPDATE`;
    if (!pm || pm.circuitVersion !== 2 || pm.circuitState !== "QUOTE_REQUESTED") return null;
    const vivantes = await tx.administrativeRequest.count({
      where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: promoMaterialId, ...DEMANDE_DEVIS_VIVANTE },
    });
    if (vivantes > 0) return null;
    // Un tour PRÉCÉDENT terminé ⇒ ses devis ont été retranscrits et vérifiés : on revient au choix.
    const tourTermine = await tx.administrativeRequest.count({
      where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: promoMaterialId, type: "QUOTE", status: "DONE", deletedAt: null },
    });
    const etape = tourTermine > 0 ? "REVIEW_REQUESTER" as const : "QUOTE_TO_REQUEST" as const;
    const u = await tx.promoMaterial.updateMany({
      where: { id: promoMaterialId, circuitVersion: 2, circuitState: "QUOTE_REQUESTED" },
      data: { circuitState: etape, updatedById: auteurId },
    });
    return u.count > 0 ? { etape, reference: pm.reference, requesterId: pm.requesterId } : null;
  });
  if (!r) return { ramene: false, etape: null };
  const libelle = r.etape === "REVIEW_REQUESTER" ? "au choix des lignes (les devis déjà reçus restent)" : "à « devis à demander »";
  await ecrireAuFil({ entityType: "PROMO_MATERIAL", entityId: promoMaterialId, authorId: auteurId, body: `Demande de devis retirée — le dossier revient ${libelle} : ${motif}` });
  await recordAudit({
    actorId: auteurId, action: "UPDATE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: promoMaterialId,
    field: "circuitState", oldValue: "QUOTE_REQUESTED", newValue: r.etape,
    summary: `Plus aucune demande de devis vivante — le dossier ${r.reference} revient ${libelle}`,
  });
  // Le DEMANDEUR, quand ce n'est pas lui qui a retiré (le secrétariat, la Direction) : c'est son dossier qui recule.
  if (r.requesterId && r.requesterId !== auteurId) {
    await notifyUser({
      userId: r.requesterId, type: "GENERIC", title: "Demande de devis retirée",
      body: `${r.reference} — le dossier revient ${libelle} : ${motif}`, link: `/promo-material/${promoMaterialId}`,
    }).catch(sansBloquer("retrait-devis.ramenerSiPlusDeDemandeDevis.notifyUser"));
  }
  return { ramene: true, etape: r.etape };
}
