import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUAND CE QUI DEMANDAIT UN PAIEMENT S'EN VA, LE PAIEMENT S'EN VA AVEC LUI (§118.185 — audit 360°, I7).
 *
 * Mesuré par l'audit : retirer sa demande de paiement, la voir refusée par les Finances, ou annuler
 * dans Legal une facture déjà envoyée au règlement laissait l'ordre de dépense OUVERT au centre de
 * paiement. Le dossier disait « annulé », la facture « annulée », et l'ordre restait payable — au
 * centre comme aux Finances, qui n'ont aucune raison de savoir que la demande a disparu. Deux vérités
 * sur le même paiement, et c'est la plus coûteuse qui reste vraie (§118.5).
 *
 * Annuler un ordre NON RÉGLÉ est un geste qui RÉDUIT : rien ne sort, et le centre n'a plus rien à
 * autoriser (§118.15 — les gestes qui réduisent sont sans danger). Un ordre RÉGLÉ ne s'annule pas :
 * l'argent est parti, et c'est alors la demande qui ne peut plus disparaître en silence — l'appelant
 * reçoit le refus AVANT d'avoir touché à quoi que ce soit, et le dit.
 *
 * L'écriture est CONDITIONNELLE (`updateMany` sur un statut non réglé) : un règlement qui passe entre
 * la lecture et l'annulation ne se fait pas défaire, et l'appelant lit alors « déjà réglé ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type AnnulationOrdre =
  | { ok: true; annule: boolean; reference: string | null }
  | { ok: false; error: string };

/** Les statuts d'un ordre qui ne l'ont pas encore payé — et qu'on peut donc annuler. */
const NON_REGLES = ["PENDING", "REVISION_REQUESTED"] as const;

export async function annulerOrdreNonRegle(
  orderId: string | null | undefined,
  opts: { acteurId: string; motif: string },
): Promise<AnnulationOrdre> {
  if (!orderId) return { ok: true, annule: false, reference: null };
  const res = await prisma.expenseOrder.updateMany({
    where: { id: orderId, status: { in: [...NON_REGLES] } },
    data: { status: "CANCELLED" },
  });
  const ordre = await prisma.expenseOrder.findUnique({ where: { id: orderId }, select: { reference: true, status: true } });
  if (res.count === 1) {
    await recordAudit({
      actorId: opts.acteurId, action: "UPDATE", module: "Finances",
      entityType: "EXPENSE_ORDER", entityId: orderId,
      field: "status", newValue: "CANCELLED",
      summary: `Ordre de dépense ${ordre?.reference ?? ""} annulé — ${opts.motif}`,
    });
    return { ok: true, annule: true, reference: ordre?.reference ?? null };
  }
  if (ordre?.status === "PAID") {
    return {
      ok: false,
      error: `Le paiement ${ordre.reference} est déjà réglé : l'argent est parti, on ne l'annule pas d'ici. Si ce règlement est une erreur, voyez les Finances.`,
    };
  }
  // Déjà annulé, ou introuvable : rien à faire, et rien à refuser.
  return { ok: true, annule: false, reference: ordre?.reference ?? null };
}
