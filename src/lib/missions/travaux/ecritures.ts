import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REÇU D'UN GESTE (J2) — ce qui fait qu'un redémarrage ne DOUBLE jamais une écriture.
 *
 * Le moteur pose une clé d'idempotence sur l'étape AVANT d'agir (`execution.ts`) : elle protège
 * contre deux exécutants simultanés. Mais un processus tué APRÈS le geste et AVANT d'avoir écrit
 * le résultat de l'étape laisse une étape « en cours » que la reprise relance — et le geste
 * repartirait. D'où ce reçu, en base, en trois temps :
 *
 *   1. RÉCLAMER (clé unique) AVANT d'agir — la base tranche entre deux prétendants ;
 *   2. agir ;
 *   3. CLORE (FAIT + résultat, ou ECHEC).
 *
 * À la reprise : un reçu FAIT rend son résultat SANS refaire le geste ; un reçu ECHEC se reréclame
 * (le geste n'a pas eu lieu) ; un reçu RÉCLAMÉ jamais clos est un geste INTERROMPU — on ne sait pas
 * s'il a eu lieu, donc on ne le rejoue PAS : l'étape échoue et le dit (même doctrine que les
 * intentions de l'Assistant IA, IA-ASSISTANT-07).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Reclamation =
  | { etat: "NEUF" }
  | { etat: "FAIT"; resultat: unknown }
  | { etat: "INTERROMPU" };

export async function reclamerEcriture(cle: string, missionId: string, stepKey: string, geste: string): Promise<Reclamation> {
  // `skipDuplicates` : la base tranche entre deux prétendants, sans lever — le perdant lit le reçu existant.
  const cree = await prisma.travailEcriture.createMany({ data: [{ cle, missionId, stepKey, geste, statut: "RECLAME" }], skipDuplicates: true });
  if (cree.count === 1) return { etat: "NEUF" };
  const r = await prisma.travailEcriture.findUnique({ where: { cle }, select: { statut: true, resultat: true } });
  if (r?.statut === "FAIT") return { etat: "FAIT", resultat: r.resultat };
  if (r?.statut === "ECHEC") {
    const repris = await prisma.travailEcriture.updateMany({ where: { cle, statut: "ECHEC" }, data: { statut: "RECLAME", resultat: Prisma.DbNull } });
    if (repris.count === 1) return { etat: "NEUF" };
  }
  return { etat: "INTERROMPU" };
}

export async function cloreEcriture(cle: string, statut: "FAIT" | "ECHEC", resultat: unknown): Promise<void> {
  await prisma.travailEcriture.update({
    where: { cle },
    data: { statut, resultat: (resultat ?? Prisma.DbNull) as Prisma.InputJsonValue },
  });
}
