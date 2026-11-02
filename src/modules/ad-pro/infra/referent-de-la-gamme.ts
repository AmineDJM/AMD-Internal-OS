import { prisma } from "@/lib/prisma";
import { porteLeRoleQuiTranche, referentUnique, type ReferentMarketing } from "@/lib/personnes/referents-gamme";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉFÉRENT À INSCRIRE SUR UNE DEMANDE — la lecture, une seule fois pour six natures.
 *
 * `productManagerId` a sept lecteurs (droits de la fiche, déclaration d'information médicale,
 * garde de l'analyse Direction Marketing) et n'avait plus AUCUN écrivain depuis que le menu de
 * création a été retiré (§118.142) : un champ que tout le monde lit et que personne n'écrit.
 * Le voici, et il vient de la configuration de la gamme.
 *
 * LA DÉCISION est PURE et vit dans `referents.ts` (`referentUnique`) : un seul référent désigne
 * cette personne, PLUSIEURS n'en désignent aucune. Ce module ne fait que la LIRE en base — les
 * séparer est ce qui permet d'éprouver la règle sans base et le branchement sans la réécrire.
 *
 * Le rôle est relu avec la personne : y inscrire quelqu'un qui ne porte plus le rôle lui
 * ouvrirait la garde de l'analyse (`c.productManagerId !== user.id`), donc la désignation
 * ACCORDERAIT un droit — ce que le module pur refuse explicitement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function referentAInscrire(businessUnitId: string | null | undefined): Promise<string | null> {
  const buId = (businessUnitId ?? "").trim();
  if (!buId) return null;
  const lignes = await prisma.businessUnitMarketingReferent.findMany({
    where: { businessUnitId: buId, user: { isActive: true } },
    select: { userId: true, user: { select: { name: true, role: true, secondaryRole: true } } },
  });
  const referents: ReferentMarketing[] = lignes.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    porteLeRole: porteLeRoleQuiTranche(r.user),
  }));
  return referentUnique(referents);
}
