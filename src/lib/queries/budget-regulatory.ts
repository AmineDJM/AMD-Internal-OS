import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { regulatoryLockWhere, userCan, type SessionUser } from "@/lib/rbac";
import type { BudgetOverview } from "@/lib/queries/budget";
import {
  CLE_BV_25, CLE_BV_75, lignesBv, totauxBv,
  type DossierBv, type LigneBv, type OrdreBv, type SaisieBv, type TotauxBv,
} from "@/lib/budget-regulatory/bv";
import { LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";
import { lireBvAcceptes } from "@/lib/queries/budget-bv-acceptes";

/**
 * BUDGET REGULATORY — les BV des dossiers d'enregistrement, lus pour l'enveloppe affichée.
 *
 * Les règles (nature d'un ordre, statut d'un BV, prévision du 75 %) sont PURES, dans `lib/budget-regulatory/bv.ts`.
 * Ici, on lit : les ordres de dépense de BV (source `REGULATORY_PRODUCT`, ancien circuit), l'écriture de ceux qui sont
 * payés, les BV ACCEPTÉS au Centre de validations (nouveau circuit — engagés, puis consommés quand leur paiement est
 * « fait » : `budget-bv-acceptes.ts`), les BV saisis à la main, et les dossiers — jamais un dossier verrouillé (pipeline)
 * à qui ne les voit pas. Un même BV ne vit que dans un circuit (le verrou de la demande y veille) : rien n'est compté deux fois.
 */

/** Les dossiers encore en cours : ceux dont le BV 75 % peut être attendu. */
const EN_COURS = ["PRE_SUBMISSION", "IN_PREPARATION", "SUBMITTED", "AWAITING_BV_PAYMENT", "AWAITING_ANPP", "RESPONDING_TO_QUERIES", "BLOCKED"] as const;

export interface VueBv {
  lignes: LigneBv[];
  totaux: TotauxBv;
  categories: { bv25: { id: string; allocated: number; consumed: number } | null; bv75: { id: string; allocated: number; consumed: number } | null };
  /** Les BV saisis à la main sans dossier (comptés dans la catégorie, pas dans le tableau). */
  saisiesSansDossier: number;
  /** La date de dépôt PRÉVUE de chaque dossier lu (ISO, `null` si non fixée) : d'où l'on date le BV 75 % attendu. */
  depotPrevu: Record<string, string | null>;
  /** Les dossiers proposés pour une saisie à la main. */
  dossiers: { id: string; libelle: string }[];
  /** La personne ouvre-t-elle les dossiers (lien vers la fiche) ? */
  lienDossiers: boolean;
}

export async function vueBvParDossier(user: SessionUser, overview: BudgetOverview): Promise<VueBv> {
  const top = overview.categories.filter((c) => c.parentId === null);
  const c25 = top.find((c) => c.cle === CLE_BV_25) ?? null;
  const c75 = top.find((c) => c.cle === CLE_BV_75) ?? null;
  const from = new Date(overview.period.from);
  const to = new Date(overview.period.to);
  const societe = overview.envelope.companyId ?? null;
  const verrou = regulatoryLockWhere(user);
  const deLaSociete = societe ? { OR: [{ companyId: societe }, { companyId: null }] } : {};

  const [ordres, saisies, acceptes] = await Promise.all([
    prisma.expenseOrder.findMany({
      where: {
        sourceType: "REGULATORY_PRODUCT",
        AND: [
          deLaSociete,
          // Un BV REFUSÉ par le centre de paiement (« non prioritaire »…) reste un ordre non réglé : il n'est plus demandé,
          // et ne doit pas se compter comme tel — redemandé, c'est le nouvel ordre qui compte (circuit BV, 10/2026).
          { OR: [{ status: "PAID", paidDate: { gte: from, lte: to } }, { status: { in: ["PENDING", "REVISION_REQUESTED"] }, centralStatus: { not: "REFUSED" } }] },
        ],
      },
      select: { id: true, sourceId: true, label: true, amount: true, status: true, paidDate: true, createdAt: true, budgetCategoryId: true, transactionId: true },
    }),
    [c25?.id, c75?.id].some(Boolean)
      ? prisma.budgetExpenseLine.findMany({
          where: { categoryId: { in: [c25?.id, c75?.id].filter((x): x is string => Boolean(x)) }, date: { gte: from, lte: to } },
          select: { id: true, categoryId: true, amount: true, date: true, regulatoryProductId: true },
        })
      : Promise.resolve([] as { id: string; categoryId: string; amount: unknown; date: Date; regulatoryProductId: string | null }[]),
    lireBvAcceptes(),
  ]);
  // LES BV ACCEPTÉS AU CENTRE DE VALIDATIONS, lus comme des ordres : engagés (« demandés, pas réglés ») tant que leur
  // paiement n'est pas « fait », puis payés — dans la période, comme un ordre réglé. Jamais « à ranger » : leur ligne
  // se déduit de la date d'acceptation, elle ne se range pas à la main.
  const acceptesDeLaPeriode = acceptes.filter((b) => !b.paiementFait || (b.payeLe !== null && b.payeLe >= from && b.payeLe <= to));
  const txIds = ordres.map((o) => o.transactionId).filter((x): x is string => Boolean(x));
  const ecritures = txIds.length
    ? new Map((await prisma.financeTransaction.findMany({ where: { id: { in: txIds } }, select: { id: true, budgetCategoryId: true } })).map((t) => [t.id, t.budgetCategoryId]))
    : new Map<string, string | null>();

  const idsCites = [...new Set([...ordres.map((o) => o.sourceId), ...saisies.map((s) => s.regulatoryProductId), ...acceptesDeLaPeriode.map((b) => b.productId)].filter((x): x is string => Boolean(x)))];
  const dossiersRaw = await prisma.regulatoryProduct.findMany({
    where: { AND: [verrou, societe ? { OR: [{ companyId: societe }, { companyId: null }] } : {}, { OR: [{ id: { in: idsCites } }, { status: { in: [...EN_COURS] } }] }] },
    select: { id: true, reference: true, dci: true, brandName: true, status: true, workflow: true, targetSubmissionDate: true },
    orderBy: { reference: "asc" },
    take: 2000,
  });
  const visibles = new Set(dossiersRaw.map((d) => d.id));

  const dossiers: DossierBv[] = dossiersRaw.map((d) => ({
    id: d.id, reference: d.reference, dci: d.dci, nom: d.brandName, status: d.status,
    workflow: (d.workflow as DossierBv["workflow"]) ?? null,
  }));
  const ordresBv: OrdreBv[] = ordres
    .filter((o) => o.sourceId && visibles.has(o.sourceId))
    .map((o) => ({
      id: o.id, productId: o.sourceId as string, label: o.label, amount: toNumber(o.amount), status: o.status,
      paidDate: o.paidDate, createdAt: o.createdAt, budgetCategoryId: o.budgetCategoryId,
      transactionCategoryId: o.transactionId ? ecritures.get(o.transactionId) ?? null : null,
    }));
  for (const b of acceptesDeLaPeriode) {
    if (!visibles.has(b.productId)) continue;
    ordresBv.push({
      id: b.validationId, productId: b.productId, label: LIBELLE_NATURE_BV[b.nature], amount: b.montant,
      status: b.paiementFait ? "PAID" : "PENDING", paidDate: b.payeLe, createdAt: b.accepteLe,
      budgetCategoryId: b.categoryId, transactionCategoryId: b.paiementFait ? b.categoryId : null, circuit: "VALIDATION",
    });
  }
  const saisiesBv: SaisieBv[] = saisies
    .filter((s) => s.regulatoryProductId && visibles.has(s.regulatoryProductId))
    .map((s) => ({ id: s.id, productId: s.regulatoryProductId as string, categoryId: s.categoryId, amount: toNumber(s.amount as Parameters<typeof toNumber>[0]), date: s.date }));
  const saisiesSansDossier = saisies
    .filter((s) => !s.regulatoryProductId)
    .reduce((a, s) => a + toNumber(s.amount as Parameters<typeof toNumber>[0]), 0);

  const lignes = lignesBv({ dossiers, ordres: ordresBv, saisies: saisiesBv, categories: { bv25: c25?.id ?? null, bv75: c75?.id ?? null } });
  const cat = (c: typeof c25) => (c ? { id: c.id, allocated: c.allocated, consumed: c.consumed } : null);
  return {
    lignes,
    totaux: totauxBv(lignes),
    categories: { bv25: cat(c25), bv75: cat(c75) },
    saisiesSansDossier,
    depotPrevu: Object.fromEntries(dossiersRaw.map((d) => [d.id, d.targetSubmissionDate ? d.targetSubmissionDate.toISOString() : null])),
    dossiers: dossiersRaw.map((d) => ({ id: d.id, libelle: `${d.reference} — ${d.brandName ?? d.dci}` })),
    lienDossiers: userCan(user, "REGULATORY", "VIEW"),
  };
}
