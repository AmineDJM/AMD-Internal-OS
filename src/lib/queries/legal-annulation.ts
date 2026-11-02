import { prisma } from "@/lib/prisma";

/**
 * CE QUI EMPÊCHE D'ANNULER UNE FACTURE DEPUIS LEGAL (`cancelLegalDocument`) — la phrase du refus, ou `null`.
 *
 * UNE FACTURE DONT DU MATÉRIEL EST ENTRÉ AU STOCK NE S'ANNULE PAS D'ICI : le dossier du matériel
 * promotionnel le refuse déjà (« annulez d'abord leur réception ») ; l'annuler depuis Legal laissait
 * au magasin des unités entrées sur une facture qui n'existe plus (§118.71 — une porte gardée à côté
 * d'une porte ouverte).
 *
 * UNE FACTURE CRÉDITÉE PAR DES AVOIRS NE S'ANNULE PAS SOUS EUX (§118.195) : le client garderait des avoirs sur
 * une facture qui n'existe plus. Les avoirs d'abord — ils s'annulent un par un, motif à l'appui.
 */
export async function refusAnnulationFacture(id: string): Promise<string | null> {
  const recues = await prisma.promoFactureLigne.count({ where: { facture: { legalDocumentId: id }, quantiteRecue: { not: null } } });
  if (recues > 0) {
    return `${recues} ligne(s) de cette facture sont réceptionnées au stock promotionnel : annulez d'abord leur réception depuis le dossier du matériel (ce qui est entré au magasin y est physiquement).`;
  }
  const avoirs = await prisma.legalDocument.findMany({
    where: { chainFromId: id, kind: "CREDIT_NOTE", status: { not: "CANCELLED" } }, select: { reference: true }, orderBy: { createdAt: "asc" },
  });
  if (avoirs.length > 0) {
    return `Cette facture est créditée par ${avoirs.length > 1 ? `${avoirs.length} avoirs` : "un avoir"} (${avoirs.map((a) => a.reference ?? "sans numéro").join(", ")}) : annulez-${avoirs.length > 1 ? "les" : "le"} d'abord — une facture ne s'annule pas sous ses avoirs.`;
  }
  return null;
}
