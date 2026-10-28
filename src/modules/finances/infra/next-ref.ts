import { buildRef } from "@/lib/refs";
import { prisma } from "@/lib/prisma";

/**
 * LA PROCHAINE RÉFÉRENCE D'ÉCRITURE — « FIN-2026-137 ».
 *
 * Elle vivait en copie privée dans le fichier d'actions qui en avait besoin. Une seconde copie
 * est apparue le jour où la caisse d'avance a dû, elle aussi, écrire au livre : deux fonctions
 * identiques, qu'une correction n'aurait touchée que d'un côté.
 *
 * Le numéro se dérive du MAXIMUM réellement présent, jamais d'un `count()` : une écriture
 * supprimée ferait retomber le compteur sur une référence existante, et la contrainte d'unicité
 * sauterait au pire moment — pendant un règlement.
 */
export async function nextFinanceRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.financeTransaction.findMany({
    where: { reference: { startsWith: `FIN-${year}-` } },
    select: { reference: true },
  });
  return buildRef("FIN", year, refs.map((r) => r.reference));
}
