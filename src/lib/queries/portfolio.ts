import { prisma } from "@/lib/prisma";
import { mergePortfolio, type Portfolio, type PortfolioProduct } from "@/lib/sales-portfolio";

/**
 * LECTURE DU PORTEFEUILLE — ce qu'une personne porte réellement ce cycle.
 *
 * Deux règles décidées avec le métier, et qui expliquent la longueur de ce fichier :
 *
 * 1. **Le superviseur porte les siens ET ceux de son équipe.** Un superviseur national a
 *    souvent quelques produits en direct tout en pilotant les autres ; ne montrer que l'un des
 *    deux donnerait une vue fausse de son périmètre.
 *
 * 2. **Report du dernier cycle saisi.** Si la Direction n'a pas encore arrêté le cycle en
 *    cours, on montre le dernier connu — mais on le DIT (`fromPreviousCycle`). Sans report, un
 *    délégué se retrouverait sans aucun produit le 1er du mois ; sans le dire, il croirait son
 *    portefeuille reconduit alors qu'il ne l'est pas.
 */

const EMPTY: Portfolio = { products: [], cycleLabel: null, fromPreviousCycle: false, hasTeam: false };

/** Les identifiants des KAM d'un superviseur — les membres des BU qu'il supervise. */
async function teamMemberIds(userId: string): Promise<string[]> {
  const bus = await prisma.businessUnit.findMany({
    where: { supervisorId: userId, isActive: true },
    select: { reps: { where: { isActive: true }, select: { repId: true } } },
  });
  return [...new Set(bus.flatMap((b) => b.reps.map((m) => m.repId)))];
}

/** Le cycle en cours (année/mois d'Alger), s'il a été créé. */
async function currentCycle() {
  const alg = new Date(Date.now() + 3_600_000); // Alger = UTC+1, sans changement d'heure
  return prisma.promoCycle.findUnique({
    where: { year_month: { year: alg.getUTCFullYear(), month: alg.getUTCMonth() + 1 } },
    select: { id: true, label: true, year: true, month: true },
  });
}

type Row = {
  productId: string; position: number; plannedVisits: number;
  product: { name: string; code: string | null; channel: PortfolioProduct["channel"]; isActive: boolean };
};

const toProducts = (rows: Row[], viaTeam: boolean): PortfolioProduct[] =>
  rows
    .filter((r) => r.product.isActive) // un produit retiré du catalogue ne se promeut plus
    .map((r) => ({
      productId: r.productId, name: r.product.name, code: r.product.code,
      channel: r.product.channel, position: r.position, plannedVisits: r.plannedVisits, viaTeam,
    }));

const SELECT = {
  productId: true, position: true, plannedVisits: true,
  product: { select: { name: true, code: true, channel: true, isActive: true } },
} as const;

/**
 * Le portefeuille d'une personne. Ne lève jamais : un module de planification en panne ne doit
 * pas empêcher quelqu'un de travailler — il verra simplement un portefeuille vide.
 */
export async function getMyPortfolio(userId: string): Promise<Portfolio> {
  try {
    const members = await teamMemberIds(userId);
    const repIds = [userId, ...members];

    // 1) Le cycle en cours, s'il porte des affectations pour cette personne ou son équipe.
    const cycle = await currentCycle();
    if (cycle) {
      const rows = await prisma.promotionAssignment.findMany({
        where: { cycleId: cycle.id, repId: { in: repIds } },
        select: { ...SELECT, repId: true },
      });
      if (rows.length > 0) {
        return {
          products: mergePortfolio(
            toProducts(rows.filter((r) => r.repId === userId), false),
            toProducts(rows.filter((r) => r.repId !== userId), true),
          ),
          cycleLabel: cycle.label,
          fromPreviousCycle: false,
          hasTeam: members.length > 0,
        };
      }
    }

    // 2) Rien sur le cycle en cours : on retombe sur le DERNIER cycle réellement saisi pour
    //    cette personne (ou son équipe), et on le signalera à l'écran.
    const last = await prisma.promotionAssignment.findFirst({
      where: { repId: { in: repIds } },
      orderBy: [{ cycle: { year: "desc" } }, { cycle: { month: "desc" } }],
      select: { cycleId: true, cycle: { select: { label: true } } },
    });
    if (!last) return { ...EMPTY, hasTeam: members.length > 0 };

    const rows = await prisma.promotionAssignment.findMany({
      where: { cycleId: last.cycleId, repId: { in: repIds } },
      select: { ...SELECT, repId: true },
    });
    return {
      products: mergePortfolio(
        toProducts(rows.filter((r) => r.repId === userId), false),
        toProducts(rows.filter((r) => r.repId !== userId), true),
      ),
      cycleLabel: last.cycle.label,
      // Signalé seulement si un cycle EN COURS existe et n'a rien : sans cycle courant créé,
      // il n'y a pas de « retard de saisie » à reprocher.
      fromPreviousCycle: Boolean(cycle),
      hasTeam: members.length > 0,
    };
  } catch (e) {
    console.error("[portfolio] lecture impossible", e);
    return EMPTY;
  }
}
