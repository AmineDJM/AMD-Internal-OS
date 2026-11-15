import { prisma } from "@/lib/prisma";
import { lireStatutConformite } from "../../domaine/parcours-agence";

/**
 * LES GARDES DU PARCOURS AGENCE qui se lisent depuis d'autres gestes (Direction, 15/11/2026) — la facture et le paiement d'un
 * poste « par une agence » attendent la RÉCEPTION, et la CONFORMITÉ quand elle est requise.
 */
export async function refusAvantReception(item: { id: string; voie: string | null; conformiteRequise: boolean }): Promise<string | null> {
  if (item.voie !== "AGENCE") return null;
  const e = await prisma.adProExecutionPoste.findUnique({ where: { itemId: item.id }, select: { receptionAt: true, conformiteStatut: true } });
  if (item.conformiteRequise && lireStatutConformite(e?.conformiteStatut) !== "CONFORME") {
    return "La conformité de ce poste n'est pas encore validée par l'information médicale : la facture se dépose après la réception d'une commande conforme.";
  }
  if (!e?.receptionAt) return "La commande n'est pas encore réceptionnée : signez d'abord le PV de réception, puis déposez la facture de l'agence.";
  return null;
}
