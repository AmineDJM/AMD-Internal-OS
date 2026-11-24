import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BC DE PRISE EN CHARGE SIGNÉ EST IMMUABLE (Super Admin, 24/11/2026).
 *
 * Le BC n°k d'une prise en charge (`CarePecBc`) porte des lignes que l'assistante achète une à une : une révision qui en
 * changerait le montant ou le fournisseur ferait tomber les signatures (`aiguillerBC`) pendant que l'achat court. Il ne se
 * révise donc JAMAIS une fois signé — par la Direction Marketing ou par les Finances. Un ajout, un retrait, une hausse
 * au-delà de la marge partent dans un BC complémentaire (« Lancer les achats ») ; un retrait barre la ligne dans le lien BC ↔
 * poste, sans toucher la pièce.
 *
 * Relu par la révision de la fabrique AVANT d'écrire (la modification d'une pièce émise dans Legal ne touche ni son montant ni
 * sa partie). La fabrique l'atteint par la porte ÉTROITE `api-bc-pec.ts` : elle n'a pas à tirer tout le métier Ad & Pro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const REFUS_BC_PEC_IMMUABLE =
  "Ce bon de commande de prise en charge est signé : il ne se réécrit jamais. Un ajout ou une hausse au-delà de la marge part dans un BC complémentaire (« Lancer les achats » sur la prise en charge).";

/** LA RÈGLE, sans base : un BC de prise en charge signé par quiconque ne se révise pas. */
export function refusRevisionBcPec(f: { bcPec: boolean; signeDm: boolean; signeFinances: boolean }): string | null {
  return f.bcPec && (f.signeDm || f.signeFinances) ? REFUS_BC_PEC_IMMUABLE : null;
}

/** Le refus d'une révision de cette pièce — `null` : ce n'est pas un BC de prise en charge, ou personne ne l'a encore signé. */
export async function refusRevisionBcPecDuDocument(legalDocumentId: string): Promise<string | null> {
  const bcPec = (await prisma.carePecBc.count({ where: { legalDocumentId } })) > 0;
  if (!bcPec) return null;
  const [doc, dm] = await Promise.all([
    prisma.legalDocument.findUnique({ where: { id: legalDocumentId }, select: { signedAt: true } }),
    prisma.signatureBC.count({ where: { legalDocumentId, qualite: "DIRECTION_MARKETING" } }),
  ]);
  return refusRevisionBcPec({ bcPec, signeDm: dm > 0, signeFinances: doc?.signedAt != null });
}
