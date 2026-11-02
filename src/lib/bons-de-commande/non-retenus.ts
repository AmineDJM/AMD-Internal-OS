import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS NON RETENUS D'UN POSTE (Direction, 11/2026) — l'écriture et la lecture.
 *
 * La règle (quels devis) est pure : `devisNonRetenus` (`bons-de-commande/version-signee.ts`). Ici, ce qu'elle écrit sur le lien
 * poste ↔ pièce (`AdProItemPiece.nonRetenuAt`) et ce que Legal en lit. Un devis qui couvre plusieurs postes n'est « non retenu »
 * dans Legal que s'il ne l'a été sur AUCUN : retenu pour l'un, il a servi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Marque ces devis du poste « non retenus » — une fois : une marque déjà posée garde sa date. */
export async function marquerNonRetenus(itemId: string, pieceIds: readonly string[], parId: string | null): Promise<number> {
  if (pieceIds.length === 0) return 0;
  const { count } = await prisma.adProItemPiece.updateMany({
    where: { itemId, legalDocumentId: { in: [...pieceIds] }, nature: "DEVIS", nonRetenuAt: null },
    data: { nonRetenuAt: new Date(), nonRetenuParId: parId },
  });
  return count;
}

/** Efface les marques du poste — son BC signé a été annulé : les offres redeviennent comparables. */
export async function effacerNonRetenusDuPoste(itemId: string): Promise<void> {
  await prisma.adProItemPiece.updateMany({
    where: { itemId, nature: "DEVIS", nonRetenuAt: { not: null } },
    data: { nonRetenuAt: null, nonRetenuParId: null },
  });
}

/** Efface les marques des postes que ce BC (pièce Legal) servait — appelé quand il est annulé ou supprimé. */
export async function effacerNonRetenusDuBC(legalDocumentId: string): Promise<void> {
  const liens = await prisma.adProItemPiece.findMany({ where: { legalDocumentId, nature: "BON_DE_COMMANDE" }, select: { itemId: true } });
  for (const l of liens) await effacerNonRetenusDuPoste(l.itemId);
}

/**
 * LES DEVIS NON RETENUS PARMI CES PIÈCES LEGAL : la date (la plus récente) et qui a validé l'offre retenue. Une pièce retenue sur
 * un seul de ses postes n'y est pas.
 */
export async function nonRetenusDesPieces(legalDocumentIds: readonly string[]): Promise<Map<string, { le: Date; par: string | null }>> {
  const res = new Map<string, { le: Date; par: string | null }>();
  if (legalDocumentIds.length === 0) return res;
  const liens = await prisma.adProItemPiece.findMany({
    where: { legalDocumentId: { in: [...legalDocumentIds] }, nature: "DEVIS" },
    select: { legalDocumentId: true, nonRetenuAt: true, nonRetenuParId: true },
  });
  const parPiece = new Map<string, typeof liens>();
  for (const l of liens) parPiece.set(l.legalDocumentId, [...(parPiece.get(l.legalDocumentId) ?? []), l]);
  const personnes = [...new Set(liens.map((l) => l.nonRetenuParId).filter((x): x is string => Boolean(x)))];
  const noms = personnes.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: personnes } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  for (const [id, ls] of parPiece) {
    if (!ls.every((l) => l.nonRetenuAt)) continue;
    const dernier = ls.reduce((a, b) => ((b.nonRetenuAt as Date) > (a.nonRetenuAt as Date) ? b : a));
    res.set(id, { le: dernier.nonRetenuAt as Date, par: dernier.nonRetenuParId ? noms.get(dernier.nonRetenuParId) ?? null : null });
  }
  return res;
}
