/**
 * MATÉRIEL PROMOTIONNEL, EXÉCUTION — le PAIEMENT d'une facture du dossier : son détail ligne à ligne, l'ordre déjà lié,
 * et la phrase qui dit ce qui est parti (l'ordre, les lignes renoncées, la formalité adressée — ou pas).
 *
 * Sorti de `actions/promo-execution-actions.ts` (lot V4) : lectures et phrases, aucune écriture.
 */
import { prisma } from "@/lib/prisma";
import { formatDzd } from "@/lib/promo-material/devis";
import { SELECT_LIGNE_FACTURE } from "@/lib/queries/promo-achats";

/** Le détail ligne à ligne d'une facture — `null` pour une facture d'avant ce détail. */
export async function detailDeLaFacture(legalDocumentId: string) {
  return prisma.promoFacture.findUnique({
    where: { legalDocumentId },
    select: { tvaRate: true, extraTaxRate: true, totalImprime: true, lignes: { orderBy: { position: "asc" }, select: SELECT_LIGNE_FACTURE } },
  });
}

/** L'ordre déjà lié à la facture (son état), s'il y en a un. */
export async function ordreDejaLie(expenseOrderId: string | null) {
  return expenseOrderId
    ? await prisma.expenseOrder.findUnique({ where: { id: expenseOrderId }, select: { status: true, centralStatus: true } })
    : null;
}

/** Ce que dit un paiement demandé : l'ordre, la part reçue, les lignes renoncées, et la formalité partie ou non. */
export function phraseDuPaiement(
  ordreReference: string, montant: number, partiel: boolean, renonces: number,
  declaration: { reference: string } | null, libelleFormalite: string,
): string {
  const formaliteLue = `${libelleFormalite[0].toUpperCase()}${libelleFormalite.slice(1)}`;
  return `Paiement demandé (ordre ${ordreReference}, ${formatDzd(montant)}${partiel ? " — la part reçue" : ""}) : il attend le centre de paiement. `
    + (renonces ? `${renonces} ligne${renonces > 1 ? "s" : ""} non livrée${renonces > 1 ? "s" : ""} : renoncement enregistré, elle${renonces > 1 ? "s" : ""} ne se paiera${renonces > 1 ? "ont" : ""} pas. ` : "")
    + (declaration
      ? `${formaliteLue} ${declaration.reference} adressée à l'information médicale.`
      : `${formaliteLue} : elle n'a PAS pu partir — utilisez « Adresser à l'information médicale » sur cette facture.`);
}
