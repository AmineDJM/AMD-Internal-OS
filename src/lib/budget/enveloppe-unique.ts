import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { choisirEnveloppe, estDomaineDirection, type CleEnveloppe } from "./enveloppe-cle";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TROUVER, SINON CRÉER — LE SEUL ENDROIT OÙ UNE ENVELOPPE BUDGÉTAIRE NAÎT (Super Admin, 25/11/2026).
 *
 * Chaque ouverture d'office (Administration, Impôts & taxes, Informatique, l'enveloppe de l'année d'un pôle, la
 * campagne budgétaire) et chaque création à la main passent par ici, avec la clé (société, direction, année) de
 * `enveloppe-cle.ts` — jamais le nom. Le cliquet `enveloppe-unique.test.ts` fait tomber la suite si un
 * `budgetEnvelope.create` réapparaît ailleurs dans le code de production.
 *
 * SÉRIALISÉ PAR LA BASE : un verrou `pg_advisory_xact_lock` sur (direction, année), tenu le temps de la transaction.
 * Deux onglets, deux serveurs, une tâche de fond et un clic : le second attend, puis TROUVE ce que le premier a créé.
 * Le verrou ne porte pas la société, exprès : la règle du doublon (une clé sans société adopte l'unique enveloppe de
 * société) lit les enveloppes de toutes les sociétés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Tx = Prisma.TransactionClient;

/** Ce que l'appelant dit de l'enveloppe à créer — la société et l'année viennent de la clé. */
export type DonneesEnveloppe = Omit<Prisma.BudgetEnvelopeUncheckedCreateInput, "id" | "companyId" | "periodStart" | "periodEnd"> & {
  periodStart?: Date;
  periodEnd?: Date;
};

export interface ResultatEnveloppe { id: string; name: string; creee: boolean }

export interface OptionsEnveloppe {
  /** La transaction de l'appelant (il tient déjà la sienne) ; sinon une transaction est ouverte ici. */
  tx?: Tx;
  /**
   * Reconnaître une enveloppe ANCIENNE de cette direction qui ne porte pas encore son code (l'enveloppe Informatique
   * d'avant le code, reconnue à sa ligne IA). Adoptée, elle reçoit le code : la fois suivante, la clé suffit.
   */
  reconnaitre?: Prisma.BudgetEnvelopeWhereInput;
}

const SELECTION = {
  id: true, name: true, companyId: true, domaine: true, module: true, modules: true, periodStart: true,
  businessUnitId: true, productId: true, isActive: true, createdAt: true,
} as const;

async function corps(tx: Tx, cle: CleEnveloppe, donnees: DonneesEnveloppe, reconnaitre?: Prisma.BudgetEnvelopeWhereInput): Promise<ResultatEnveloppe> {
  const debut = new Date(Date.UTC(cle.annee, 0, 1));
  const fin = new Date(Date.UTC(cle.annee, 11, 31, 23, 59, 59));
  const direction = cle.direction;

  if (direction !== null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enveloppe:${direction}:${cle.annee}`}))`;
    const pole = estDomaineDirection(direction);
    const parDirection: Prisma.BudgetEnvelopeWhereInput = pole
      ? { domaine: direction }
      : { domaine: { notIn: ["MARKETING", "REGULATORY", "OPERATIONS"] }, OR: [{ module: direction }, { module: null, modules: { has: direction } }] };
    const ou: Prisma.BudgetEnvelopeWhereInput[] = [parDirection, ...(reconnaitre ? [{ AND: [reconnaitre, { module: null }] }] : [])];
    const lues = await tx.budgetEnvelope.findMany({
      where: {
        periodStart: { gte: debut, lt: new Date(Date.UTC(cle.annee + 1, 0, 1)) },
        AND: [{ OR: ou }, ...(cle.companyId ? [{ OR: [{ companyId: cle.companyId }, { companyId: null }] }] : [])],
      },
      select: SELECTION,
    });
    // Une enveloppe reconnue sans son code est lue comme si elle le portait.
    const candidates = lues.map((e) => (!pole && e.module === null && !e.modules.includes(direction) ? { ...e, module: direction, adoptee: true } : { ...e, adoptee: false }));
    const trouvee = choisirEnveloppe(candidates, cle);
    if (trouvee) {
      if (trouvee.adoptee) await tx.budgetEnvelope.update({ where: { id: trouvee.id }, data: { module: direction } });
      return { id: trouvee.id, name: trouvee.name, creee: false };
    }
  }

  // Créée : elle doit répondre à SA propre clé, sinon la suivante ne la trouverait pas.
  const pole = estDomaineDirection(direction);
  const modules = Array.isArray(donnees.modules) ? (donnees.modules as string[]) : [];
  const module = direction && !pole && donnees.module !== direction && !(donnees.module == null && modules.includes(direction))
    ? direction
    : donnees.module ?? null;
  const cree = await tx.budgetEnvelope.create({
    data: {
      ...donnees,
      module,
      ...(pole ? { domaine: direction! } : {}),
      ...(cle.businessUnitId !== undefined ? { businessUnitId: cle.businessUnitId } : {}),
      ...(cle.productId !== undefined ? { productId: cle.productId } : {}),
      companyId: cle.companyId,
      periodStart: donnees.periodStart ?? debut,
      periodEnd: donnees.periodEnd ?? fin,
    },
    select: { id: true, name: true },
  });
  return { ...cree, creee: true };
}

/** L'enveloppe de la clé — trouvée, sinon créée avec `donnees`. Voir l'en-tête. */
export async function trouverOuCreerEnveloppe(cle: CleEnveloppe, donnees: DonneesEnveloppe, opts: OptionsEnveloppe = {}): Promise<ResultatEnveloppe> {
  if (opts.tx) return corps(opts.tx, cle, donnees, opts.reconnaitre);
  return prisma.$transaction((tx) => corps(tx, cle, donnees, opts.reconnaitre), { timeout: 20_000 });
}
