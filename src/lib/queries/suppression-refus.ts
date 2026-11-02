import { prisma } from "@/lib/prisma";

/**
 * CE QUI NE SE SUPPRIME PAS — les refus du registre des suppressions (`admin-delete-registry.ts`) qui lisent
 * l'histoire d'une fiche avant de la laisser partir. Le registre les nomme ; la règle vit ici.
 */

// CE QUI A EU LIEU NE S'EFFACE PAS (audit 27/10, DONNEES-07). Un praticien qui porte des visites rapportées ou des
// montants Ad & Pro attribués ne se supprime pas : la cascade emportait ses montants (`AdProMedecin`), sa
// segmentation et ses observations, sans retour. On l'ARCHIVE (sa fiche quitte l'annuaire, son historique reste).
export async function refusSuppressionPraticien(id: string): Promise<string | null> {
  const [visites, montants] = await Promise.all([
    prisma.medicalVisit.count({ where: { doctorId: id, status: "COMPLETED" } }),
    prisma.adProMedecin.count({ where: { doctorId: id } }),
  ]);
  if (visites === 0 && montants === 0) return null;
  const faits = [visites ? `${visites} visite(s) rapportée(s)` : null, montants ? `${montants} montant(s) Ad & Pro attribué(s)` : null].filter(Boolean).join(" et ");
  return `Ce praticien porte ${faits} : il ne se supprime pas. Archivez-le depuis l'annuaire — sa fiche en sort, son historique reste.`;
}

// UNE COMMANDE LIVRÉE NE SE SUPPRIME PAS (audit 27/10, DONNEES-15) : ses bons de livraison justifient des entrées
// en stock — la supprimer détachait les mouvements de stock de leur livraison et perdait les réserves de
// réception. On corrige une commande livrée, on ne l'efface pas.
export async function refusSuppressionCommandePch(id: string): Promise<string | null> {
  const livrees = await prisma.pchDelivery.count({ where: { orderId: id, deliveredAt: { not: null } } });
  return livrees > 0
    ? `Ce bon de commande porte ${livrees} livraison(s) réceptionnée(s) : il ne se supprime pas — ses bons de livraison justifient des entrées en stock. Corrigez-le plutôt.`
    : null;
}

/**
 * CE QUI DÉCOULE DU LOT NE SE DÉTACHE PAS EN SILENCE. Un bon de commande né de la ligne (`PchOrder.lineId`,
 * un lien TEXTE que Postgres ne vide pas : il désignerait un lot disparu) ou qui la porte en ligne, une
 * ligne de contrat de marché, une vente sous marché, la répartition d'un poste Ad & Pro : les quatre la
 * désignent, et la clé étrangère les viderait sans un mot — une vente sous marché passerait pour une vente
 * de VILLE (§118.118), un contrat ne dirait plus de quel lot il découle. On COMPTE sans nommer ce qui n'est
 * pas du marché : le titre d'un contrat passe par la porte de Legal, le libellé d'un poste par celle
 * d'Ad & Pro, et ce refus ne sait pas qui le lit (§118.118). Le remède est un geste qui EXISTE sur la ligne.
 */
export async function refusSuppressionLotDeMarche(id: string): Promise<string | null> {
  const [bons, lignesDeBon, lignesDeContrat, ventes, repartitions] = await Promise.all([
    prisma.pchOrder.findMany({ where: { lineId: id }, select: { id: true, reference: true } }),
    prisma.pchOrderLine.findMany({ where: { tenderLineId: id }, select: { order: { select: { id: true, reference: true } } } }),
    prisma.pchContractLine.count({ where: { tenderLineId: id } }),
    prisma.sale.count({ where: { tenderLineId: id } }),
    prisma.adProProductAllocation.count({ where: { tenderLineId: id } }),
  ]);
  const bc = new Map<string, string>();
  for (const b of [...bons, ...lignesDeBon.map((l) => l.order)]) bc.set(b.id, b.reference ?? "sans numéro");
  const refs = [...bc.values()];
  const pl = (n: number, un: string, des: string) => `${n} ${n > 1 ? des : un}`;
  const parts: string[] = [];
  if (refs.length) {
    const noms = refs.length <= 3 ? refs.join(", ") : `${refs.slice(0, 3).join(", ")} et ${pl(refs.length - 3, "autre", "autres")}`;
    parts.push(`${pl(refs.length, "bon de commande", "bons de commande")} (${noms})`);
  }
  if (lignesDeContrat) parts.push(pl(lignesDeContrat, "ligne de contrat de marché", "lignes de contrat de marché"));
  if (ventes) parts.push(pl(ventes, "vente sous marché", "ventes sous marché"));
  if (repartitions) parts.push(pl(repartitions, "répartition d'un poste Ad & Pro", "répartitions de postes Ad & Pro"));
  if (parts.length === 0) return null;
  const liste = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`;
  return `Ce lot ne se supprime pas : il porte ${liste}. Le supprimer les détacherait de leur lot — une vente sous marché passerait pour une vente de ville, un contrat ne dirait plus de quel lot il découle. Pour le sortir du marché, passez son statut à « Lot annulé » : il reste à l'historique, avec ce qui en découle.`;
}
