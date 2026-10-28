import { prisma } from "@/lib/prisma";
import { platformScope } from "@/lib/company";
import { clauseEcrituresVisibles, clauseSalariesVisibles } from "@/lib/queries/visibilite-listes";
import { instantDuCentreDePaie, etatSalaire, saisiAvantLeCentre } from "@/modules/rh/api";
import {
  resultatParMois, debutDuMoisAlger, finDeLaPeriodeAlger, type Periode, type ResultatPeriode,
} from "@/lib/finance/resultat-mensuel";
import { toNumber } from "@/lib/utils";

/**
 * Espace comptable — vue de synthèse légère pour la comptabilité.
 *
 * Ne crée AUCUNE donnée ni table : c'est une lecture agrégée de l'existant
 * (FinanceTransaction + ExpenseOrder). Pas de plan comptable, pas d'écritures
 * en partie double, pas de bilan — juste l'opérationnel du comptable :
 *   • ce qu'il faut régler (ordres de dépense validés par la Direction),
 *   • ce qu'il faut encaisser (recettes prévues / en retard),
 *   • la synthèse recettes / dépenses / résultat du mois,
 *   • un petit historique mensuel.
 */

export interface ComptaItem {
  id: string;
  reference: string;
  label: string;
  category: string;
  amount: number;
  date: string | null; // échéance (ordre) ou date prévue (transaction)
  counterparty: string;
  overdue: boolean;
  kind: "order" | "transaction";
}

export interface ComptaCategoryRow {
  category: string;
  amount: number;
}

export async function getComptaData(userId: string) {
  // Cloisonnement par entité — cf. platformScope.
  const scope = await platformScope(userId);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [txs, orders] = await Promise.all([
    prisma.financeTransaction.findMany({ where: await clauseEcrituresVisibles(userId), orderBy: { date: "desc" }, take: 2000 }),
    prisma.expenseOrder.findMany({
      where: { AND: [{ status: "PENDING" }, scope] },
      include: { requestedBy: { select: { name: true } } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  let recettesMois = 0;
  let depensesMois = 0;
  let aEncaisser = 0; // total recettes prévues (PENDING IN)
  const depByCat = new Map<string, number>();
  const recByCat = new Map<string, number>();
  const recettesAttendues: ComptaItem[] = [];
  const depensesPrevues: ComptaItem[] = [];

  for (const t of txs) {
    const amt = toNumber(t.amount);
    if (t.status === "SETTLED") {
      if (t.date >= monthStart) {
        if (t.direction === "IN") {
          recettesMois += amt;
          recByCat.set(t.category, (recByCat.get(t.category) ?? 0) + amt);
        } else {
          depensesMois += amt;
          depByCat.set(t.category, (depByCat.get(t.category) ?? 0) + amt);
        }
      }
    } else if (t.status === "PENDING") {
      const overdue = t.date < now;
      const item: ComptaItem = {
        id: t.id,
        reference: t.reference,
        label: t.label,
        category: t.category,
        amount: amt,
        date: t.date.toISOString(),
        counterparty: t.counterparty ?? "",
        overdue,
        kind: "transaction",
      };
      if (t.direction === "IN") {
        aEncaisser += amt;
        recettesAttendues.push(item);
      } else {
        depensesPrevues.push(item);
      }
    }
  }

  // Worklist du comptable : ordres de dépense validés mais pas encore réglés.
  const ordersPending: ComptaItem[] = orders.map((o) => ({
    id: o.id,
    reference: o.reference,
    label: o.label,
    category: o.category,
    amount: toNumber(o.amount),
    date: o.dueDate ? o.dueDate.toISOString() : null,
    counterparty: o.beneficiary ?? o.requestedBy?.name ?? "",
    overdue: o.dueDate ? o.dueDate < now : false,
    kind: "order",
  }));
  const aReglerOrders = ordersPending.reduce((a, o) => a + o.amount, 0);

  // Recettes attendues : en retard d'abord, puis par date d'échéance.
  recettesAttendues.sort(
    (a, b) => Number(b.overdue) - Number(a.overdue) || (a.date ?? "").localeCompare(b.date ?? ""),
  );
  depensesPrevues.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  // LA MASSE SALARIALE À PART : elle tombe chaque mois, elle n'a pas à noyer les décaissements
  // qu'on peut encore arbitrer (fournisseurs, prestations). On ne la CACHE pas — la trésorerie
  // doit la prévoir — on la SÉPARE, avec son propre total, pour que la liste « à arbitrer »
  // reste lisible.
  const SALARY_CATEGORIES = new Set(["SALAIRE", "AVANCE"]);
  const depensesSalaires = depensesPrevues.filter((d) => SALARY_CATEGORIES.has(d.category));
  const depensesAutres = depensesPrevues.filter((d) => !SALARY_CATEGORIES.has(d.category));
  const depensesSalairesTotal = depensesSalaires.reduce((a, d) => a + d.amount, 0);
  const depensesAutresTotal = depensesAutres.reduce((a, d) => a + d.amount, 0);

  const enRetardCount =
    recettesAttendues.filter((r) => r.overdue).length + ordersPending.filter((o) => o.overdue).length;
  const enRetardMontant =
    recettesAttendues.filter((r) => r.overdue).reduce((a, r) => a + r.amount, 0) +
    ordersPending.filter((o) => o.overdue).reduce((a, o) => a + o.amount, 0);

  const sortCat = (m: Map<string, number>): ComptaCategoryRow[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount }));

  return {
    recettesMois,
    depensesMois,
    resultatMois: recettesMois - depensesMois,
    aEncaisser,
    aReglerOrders,
    aReglerCount: ordersPending.length,
    enRetardCount,
    enRetardMontant,
    depByCat: sortCat(depByCat),
    recByCat: sortCat(recByCat),
    ordersPending,
    recettesAttendues,
    depensesPrevues,
    depensesSalaires,
    depensesAutres,
    depensesSalairesTotal,
    depensesAutresTotal,
  };
}

const cleMois = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/**
 * LE RÉSULTAT MENSUEL D'UNE PÉRIODE — la règle vit dans `finance/resultat-mensuel.ts` ; ici, on
 * lit ce qu'elle reçoit.
 *
 * Trois lectures, et aucune n'est bornée en silence : les écritures RÉGLÉES datées dans la
 * période ; les écritures de PAIE dont le mois de paie est dans la période mais qui ont été
 * réglées hors d'elle (la paie de septembre virée en octobre, quand on regarde septembre) ; la
 * paie versée par l'ancien circuit SANS écriture, à son net. Les écritures se lisent dans la portée
 * du livre (`clauseEcrituresVisibles`), la paie sans écriture dans celle des salariés
 * (`clauseSalariesVisibles`) : la même entité, au sens strict.
 */
export async function getResultatMensuel(userId: string, periode: Periode): Promise<ResultatPeriode> {
  const [visibles, salariesVisibles, depuisLeCentre] = await Promise.all([
    clauseEcrituresVisibles(userId),
    clauseSalariesVisibles(userId),
    instantDuCentreDePaie(),
  ]);
  const dansPeriode = new Set(periode.mois);
  const annees = [...new Set(periode.mois.map((m) => Number(m.slice(0, 4))))];

  const datees = await prisma.financeTransaction.findMany({
    where: { AND: [visibles, { status: "SETTLED", date: { gte: debutDuMoisAlger(periode.debut), lt: finDeLaPeriodeAlger(periode) } }] },
    select: { id: true, date: true, direction: true, amount: true },
  });
  const ids = datees.map((e) => e.id);

  const [virementsParEcriture, ordresParEcriture, lignesParEcriture, virementsDuMois, lignesDuMois, versesSansEcriture] = await Promise.all([
    ids.length ? prisma.payrollWire.findMany({ where: { transactionId: { in: ids } }, select: { transactionId: true, year: true, month: true } }) : [],
    ids.length
      ? prisma.expenseOrder.findMany({ where: { sourceType: "PAYROLL", transactionId: { in: ids } }, select: { transactionId: true, sourceId: true } })
      : [],
    ids.length ? prisma.payrollEntry.findMany({ where: { transactionId: { in: ids } }, select: { transactionId: true, year: true, month: true } }) : [],
    prisma.payrollWire.findMany({
      where: { year: { in: annees } },
      select: { year: true, month: true, transactionId: true, expenseOrder: { select: { transactionId: true } } },
    }),
    prisma.payrollEntry.findMany({ where: { year: { in: annees }, transactionId: { not: null } }, select: { transactionId: true, year: true, month: true } }),
    prisma.payrollEntry.findMany({
      where: { year: { in: annees }, status: "PAID", transactionId: null, payrollWireId: null, employee: salariesVisibles },
      select: { year: true, month: true, net: true, status: true, budgetTransferredAt: true, paidDate: true, createdAt: true },
    }),
  ]);

  // LE MOIS DE PAIE DE CHAQUE ÉCRITURE DE PAIE — le virement d'abord, puis l'ordre de ce virement,
  // puis la ligne de l'ancien transfert. Une écriture n'a qu'un mois de paie.
  const moisDePaie = new Map<string, string>();
  const poser = (tx: string | null | undefined, year: number, month: number) => {
    if (tx && !moisDePaie.has(tx)) moisDePaie.set(tx, cleMois(year, month));
  };
  for (const v of virementsParEcriture) poser(v.transactionId, v.year, v.month);
  const virementsDesOrdres = ordresParEcriture.length
    ? await prisma.payrollWire.findMany({
        where: { id: { in: ordresParEcriture.map((o) => o.sourceId).filter((v): v is string => Boolean(v)) } },
        select: { id: true, year: true, month: true },
      })
    : [];
  const virementParId = new Map(virementsDesOrdres.map((v) => [v.id, v]));
  for (const o of ordresParEcriture) {
    const v = o.sourceId ? virementParId.get(o.sourceId) : undefined;
    if (v) poser(o.transactionId, v.year, v.month);
  }
  for (const l of lignesParEcriture) poser(l.transactionId, l.year, l.month);
  for (const v of virementsDuMois) poser(v.transactionId ?? v.expenseOrder?.transactionId, v.year, v.month);
  for (const l of lignesDuMois) poser(l.transactionId, l.year, l.month);

  // LA PAIE DU MOIS RÉGLÉE HORS DE LA PÉRIODE — lue, elle aussi, dans la portée du livre.
  const dejaLues = new Set(ids);
  const horsPeriode = [...moisDePaie.entries()].filter(([tx, m]) => dansPeriode.has(m) && !dejaLues.has(tx)).map(([tx]) => tx);
  const reglesAilleurs = horsPeriode.length
    ? await prisma.financeTransaction.findMany({
        where: { AND: [visibles, { status: "SETTLED", id: { in: horsPeriode } }] },
        select: { id: true, date: true, direction: true, amount: true },
      })
    : [];

  return resultatParMois({
    periode,
    ecritures: [...datees, ...reglesAilleurs].map((e) => ({ id: e.id, date: e.date, direction: e.direction, amount: toNumber(e.amount) })),
    moisDePaie,
    paieSansEcriture: versesSansEcriture
      .filter((l) => etatSalaire({
        status: l.status, budgetTransferredAt: l.budgetTransferredAt, transactionId: null, virement: null,
        avantLeCentre: saisiAvantLeCentre(l, depuisLeCentre),
      }) === "VIRE")
      .map((l) => ({ mois: cleMois(l.year, l.month), montant: toNumber(l.net) })),
  });
}
