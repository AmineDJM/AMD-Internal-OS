import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { entryCost } from "@/modules/rh/partage";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import type { SessionUser } from "@/lib/rbac";
import type { BudgetOverview } from "@/lib/queries/budget";
import {
  agregerMasseSalariale, estDirectionDesOperations, imputerPaie, moisDeLaPeriode, rattacherForceDeVente,
  CLE_MASSE_SALARIALE, type CategorieMs, type LignePaie, type VueMasseSalariale,
} from "@/lib/budget-operations/force-de-vente";

/**
 * BUDGET OPERATIONS & SALES — ce que la base dit de la force de vente et de sa paie.
 *
 * Les règles (qui en fait partie, où va chaque ligne de paie, ce qui se montre) sont PURES, dans
 * `lib/budget-operations/force-de-vente.ts`. Ici, on lit : salariés, profils KAM, BU, départements, lignes de paie.
 */

interface ForceDeVente {
  rattachement: Map<string, string>;
  nomsBu: Map<string, string>;
  societe: Map<string, string | null>;
  userIds: Set<string>;
}

/** Le rattachement de chaque salarié de la force de vente (id salarié → BU ou « hors BU »). */
export async function chargerForceDeVente(): Promise<ForceDeVente> {
  const [employes, profils, bus, departements, directeurs] = await Promise.all([
    prisma.employee.findMany({ select: { id: true, userId: true, departmentId: true, companyId: true } }),
    prisma.salesRepProfile.findMany({ select: { repId: true, businessUnitId: true, isActive: true } }),
    prisma.businessUnit.findMany({ select: { id: true, name: true, supervisorId: true, departmentId: true } }),
    prisma.department.findMany({ select: { id: true, parentId: true, name: true, code: true, _count: { select: { businessUnits: true } } } }),
    // Le Directeur des opérations : de la Direction des opérations, où que soit son département.
    prisma.user.findMany({ where: { role: "OPERATIONS_DIRECTOR" }, select: { id: true } }),
  ]);
  const idsDirecteurs = new Set(directeurs.map((u) => u.id));
  // La Direction commerciale : le département que `openBusinessUnitBudget` prend pour parent des BU.
  const commercial = (d: { name: string; code: string; _count: { businessUnits: number } }) =>
    d._count.businessUnits === 0 && (/commercial/i.test(d.name) || /COMMERCIAL/i.test(d.code));
  const rattachement = rattacherForceDeVente({
    employes: employes.map((e) => ({ ...e, directeurOperations: !!e.userId && idsDirecteurs.has(e.userId) })),
    profils,
    bus,
    // LA DIRECTION DES OPÉRATIONS ET SES SOUS-DÉPARTEMENTS (Direction, 10/2026) : une BU ou la Direction commerciale
    // rencontrée plus près du salarié l'emporte (`parDepartement` remonte l'arbre du plus proche au plus lointain).
    departements: departements.map((d) => ({ id: d.id, parentId: d.parentId, commercial: commercial(d), operations: estDirectionDesOperations(d) })),
  });
  const userIds = new Set(employes.filter((e) => e.userId && rattachement.has(e.id)).map((e) => e.userId as string));
  return {
    rattachement,
    nomsBu: new Map(bus.map((b) => [b.id, b.name])),
    societe: new Map(employes.map((e) => [e.id, e.companyId])),
    userIds,
  };
}

/** Les lignes de paie de la force de vente sur des années, réduites à leur coût (`entryCost`). */
async function lignesPaie(fdv: ForceDeVente, anneeDe: number, anneeA: number): Promise<LignePaie[]> {
  const ids = [...fdv.rattachement.keys()];
  if (ids.length === 0) return [];
  const lignes = await prisma.payrollEntry.findMany({
    where: { employeeId: { in: ids }, year: { gte: anneeDe, lte: anneeA } },
    select: { employeeId: true, year: true, month: true, employerCost: true, gross: true, bonuses: true, deductions: true },
  });
  return lignes.map((l) => ({
    employeeId: l.employeeId, year: l.year, month: l.month, companyId: fdv.societe.get(l.employeeId) ?? null,
    cost: entryCost({
      employerCost: l.employerCost == null ? null : toNumber(l.employerCost),
      gross: toNumber(l.gross), bonuses: toNumber(l.bonuses), deductions: toNumber(l.deductions),
    }),
  }));
}

/** Une catégorie candidate, telle que les requêtes de Budgets la lisent. */
export interface CategoriePaieCandidate {
  id: string;
  cle: string | null;
  businessUnitId: string | null;
  envelope: { id: string; periodStart: Date; periodEnd: Date; companyId: string | null };
}

/**
 * LA PAIE DE LA FORCE DE VENTE, COMME CONSOMMATION — le pendant de `generalMeansConsumption` : les catégories
 * « Masse salariale de la force de vente » se remplissent de la paie, sans double saisie. Des TOTAUX par catégorie et
 * par mois — jamais une ligne par personne. Aucune catégorie de masse salariale → aucune lecture.
 */
export async function masseSalarialeConsumption(
  candidates: readonly CategoriePaieCandidate[],
  from?: Date | null,
  to?: Date | null,
): Promise<{ byCategory: Map<string, number>; rows: { categoryId: string; date: Date; amount: number; effectif: number }[] }> {
  const cats: CategorieMs[] = candidates
    .filter((c) => c.cle === CLE_MASSE_SALARIALE)
    .map((c) => ({ id: c.id, envelopeId: c.envelope.id, businessUnitId: c.businessUnitId, debut: c.envelope.periodStart, fin: c.envelope.periodEnd, companyId: c.envelope.companyId }));
  if (cats.length === 0) return { byCategory: new Map(), rows: [] };
  const anneeDe = Math.min(...cats.map((c) => c.debut.getUTCFullYear()));
  const anneeA = Math.max(...cats.map((c) => c.fin.getUTCFullYear()));
  const fdv = await chargerForceDeVente();
  const { parCategorie, parMois } = imputerPaie(await lignesPaie(fdv, anneeDe, anneeA), fdv.rattachement, cats, { from, to });
  return { byCategory: parCategorie, rows: parMois.map((r) => ({ categoryId: r.categoryId, date: r.date, amount: r.montant, effectif: r.effectif })) };
}

export interface VueMasseSalarialeEnveloppe {
  vue: VueMasseSalariale;
  /** La catégorie mère « Masse salariale de la force de vente », `null` si l'enveloppe n'en a pas. */
  mere: { id: string; name: string } | null;
  /** Les BU actives sans sous-catégorie de masse salariale dans l'enveloppe. */
  busSansBudget: number;
  voitLesSalaires: boolean;
}

/**
 * L'ÉCRAN « MASSE SALARIALE » — budget (catégorie mère et sous-catégories par BU) et réalisé (la paie), par mois.
 * Le détail par personne n'est construit QUE pour qui voit les salaires : sans ce droit, les noms ne sont même pas lus.
 */
export async function vueMasseSalariale(user: SessionUser, overview: BudgetOverview): Promise<VueMasseSalarialeEnveloppe> {
  const ms = overview.categories.filter((c) => c.cle === CLE_MASSE_SALARIALE);
  const mere = ms.find((c) => !c.businessUnitId) ?? null;
  const parBu = ms.filter((c): c is typeof c & { businessUnitId: string } => Boolean(c.businessUnitId));
  const debut = new Date(overview.envelope.periodStart);
  const fin = new Date(overview.envelope.periodEnd);
  const mois = moisDeLaPeriode(debut, fin);
  const voit = voitLesSalaires(user);
  const [fdv, busActives] = await Promise.all([
    chargerForceDeVente(),
    prisma.businessUnit.findMany({ where: { isActive: true }, select: { id: true } }),
  ]);
  const societe = overview.envelope.companyId ?? null;
  const lignes = (await lignesPaie(fdv, debut.getUTCFullYear(), fin.getUTCFullYear()))
    .filter((l) => !societe || !l.companyId || l.companyId === societe);
  const nomsPersonnes = voit
    ? new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(lignes.map((l) => l.employeeId))] } }, select: { id: true, fullName: true } })).map((e) => [e.id, e.fullName]))
    : undefined;
  const vue = agregerMasseSalariale({
    lignes,
    rattachement: fdv.rattachement,
    nomsBu: fdv.nomsBu,
    mois,
    budgetMere: mere?.allocated ?? 0,
    budgetParBu: new Map(parBu.map((c) => [c.businessUnitId, c.allocated])),
    voitLesSalaires: voit,
    nomsPersonnes,
  });
  const avecBudget = new Set(parBu.map((c) => c.businessUnitId));
  return {
    vue,
    mere: mere ? { id: mere.id, name: mere.name } : null,
    busSansBudget: busActives.filter((b) => !avecBudget.has(b.id)).length,
    voitLesSalaires: voit,
  };
}

/**
 * LES DÉPENSES « À IMPUTER » QUI VIENNENT DE LA FORCE DE VENTE — l'écriture d'un ordre de dépense demandé par un
 * commercial (frais de terrain, notes de frais, achats). Elles se rangent depuis l'écran Dépenses ; on les y marque.
 */
export async function ecrituresDeLaForceDeVente(transactionIds: readonly string[]): Promise<Set<string>> {
  if (transactionIds.length === 0) return new Set();
  const fdv = await chargerForceDeVente();
  if (fdv.userIds.size === 0) return new Set();
  const ordres = await prisma.expenseOrder.findMany({
    where: { transactionId: { in: [...transactionIds] }, requestedById: { in: [...fdv.userIds] } },
    select: { transactionId: true },
  });
  return new Set(ordres.map((o) => o.transactionId).filter((x): x is string => Boolean(x)));
}
