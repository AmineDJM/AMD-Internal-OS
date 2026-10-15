import { prisma } from "@/lib/prisma";
import { etatDuBC } from "@/lib/bons-de-commande/etat";

/**
 * POUR LES BANCS — L'ÉTAT COMPLET D'UN BC, tel qu'un changement de NUMÉRO SEUL doit le laisser (Direction, 14/10/2026) :
 * son étape, sa signature, son circuit, chacune de ses demandes de validation et de leurs étapes (statut ET date de mise à
 * jour : une étape « remise à zéro » puis revalidée se verrait), ses visas de porte. Deux lectures égales = rien n'a bougé.
 */
export async function etatCompletDuBC(id: string) {
  const [doc, validations, visas, etat] = await Promise.all([
    prisma.legalDocument.findUniqueOrThrow({
      where: { id },
      select: { status: true, signedAt: true, signedById: true, signedByName: true, signatureCheck: true, bcCircuitAt: true, bcPrevalidationAt: true },
    }),
    prisma.validationRequest.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: id }, orderBy: { createdAt: "asc" },
      select: { id: true, status: true, updatedAt: true, decidedAt: true, steps: { orderBy: { id: "asc" }, select: { id: true, status: true, decidedAt: true } } },
    }),
    prisma.adProGateVisa.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: id }, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true, decidedAt: true } }),
    etatDuBC(id),
  ]);
  return { doc, validations, visas, etape: etat?.etape ?? null };
}
