import { prisma } from "@/lib/prisma";
import { clauseAImputer, piecesDesEcritures, type LienDepense, type PieceDepense } from "@/modules/finances/api";
import { platformScope } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import { canViewEnvelope, type SessionUser } from "@/lib/rbac";
import { generalMeansConsumption } from "@/lib/queries/budget-general-means";
import { getAppSettings } from "@/lib/settings";
import { dansLaPortee, totaliser, type PorteeBudget } from "@/lib/budget/domaines";
import { masseSalarialeConsumption } from "@/lib/queries/budget-operations";
import { fraisMissionConsumption } from "@/lib/missions-equipe/imputation-serveur";
import { datesReellesDesEcritures, engagementsDesCategories } from "@/lib/queries/budget-sources";
import { dansLaPeriode } from "@/lib/budget/engage";
import { lienMission } from "@/lib/chemins/espace";
import { categoriesGouvernees, consommationIntegree, contexteDeLEnveloppe, contextesDesCategories } from "@/lib/queries/budget-integration";
import { estAbsenteDuFichier } from "@/lib/budget/integration-regle";
import { lienDemandeIntegree } from "@/lib/budget-marketing/integration-vue";

/**
 * LA PORTÉE D'UN ÉCRAN (Budget Marketing, 08/10) : Budgets lit toutes les enveloppes visibles, Budget Marketing les
 * seules enveloppes `domaine = MARKETING`. Mêmes requêtes, mêmes calculs — un filtre de plus, jamais une copie.
 */
export interface OptionsPortee { portee?: PorteeBudget }

/** Une enveloppe est visible d'un non-gestionnaire seulement si l'admin lui a ouvert la
 *  visualisation (rôle/personne) ou lui a délégué la gestion — sinon invisible (strict). */
function envelopeVisible(user: SessionUser, e: { accessRoles: string[]; accessUserIds?: string[]; managerRoles?: string[]; managerUserIds?: string[] }): boolean {
  return canViewEnvelope(user, e);
}

/**
 * Budget « enveloppe » : un total défini par la Direction, réparti en catégories,
 * dont la consommation est calculée à partir des dépenses réelles
 * (FinanceTransaction OUT) attribuées à chaque catégorie, sur une période choisie.
 */

export type BudgetHealth = "ON_TRACK" | "AT_RISK" | "OVER_BUDGET" | "NONE";

export interface BudgetCategoryView {
  id: string;
  name: string;
  module: string | null;
  parentId: string | null;
  color: string | null;
  notes: string | null;
  allocated: number;
  consumed: number;
  committed: number;
  remaining: number;
  pct: number;
  health: BudgetHealth;
  /** La clé d'une catégorie reconnue (BV_25, BV_75, MASSE_SALARIALE_FDV) — `null` pour une catégorie libre. */
  cle?: string | null;
  /** La BU d'une sous-catégorie de masse salariale. */
  businessUnitId?: string | null;
}

export interface UnattributedTx {
  id: string;
  reference: string;
  date: string;
  label: string;
  amount: number;
  category: string;
  counterparty: string | null;
  status: string;
  /** La société de la dépense — une dépense d'une autre société se déplace (Direction, 06/10). */
  companyId: string | null;
  societe: string | null;
  /** Payée ou non, en clair ; ses liens (facture, dossier, origine) et ses pièces (fichiers). */
  paiement: string;
  liens: LienDepense[];
  pieces: PieceDepense[];
}

/**
 * Dépense DÉJÀ imputée à une catégorie de l'enveloppe. Trois origines :
 * - `FINANCE` : une vraie dépense de trésorerie (FinanceTransaction OUT) que la Direction a
 *   attribuée à la catégorie → RÉ-ATTRIBUABLE (elle se supprime, elle, dans les Finances) ;
 * - `BUDGET` : une ligne purement budgétaire saisie ici (BudgetExpenseLine), sans impact sur
 *   la trésorerie → SUPPRIMABLE directement depuis le module Budget ;
 * - `GENERAL_MEANS` : un achat des moyens généraux, classé par celui qui l'a fait. Il se lit
 *   ici mais ne se corrige QUE là-bas, avec son justificatif — c'est la même dépense, pas une
 *   copie, et deux endroits pour la modifier feraient deux montants différents.
 */
export interface AttributedTx {
  id: string;
  /** `PAIE` : la paie de la force de vente, en TOTAL par mois (Budget Operations & Sales) — elle se lit, ne se corrige pas.
   *  `MISSION` : la note de frais de mission d'un membre de l'équipe Adventum (Budget Operations & Sales) — lue, jamais
   *  recopiée ; elle se corrige sur la mission. */
  kind: "FINANCE" | "BUDGET" | "GENERAL_MEANS" | "PAIE" | "MISSION" | "HISTORIQUE";
  reference: string;
  date: string;
  label: string;
  amount: number;
  counterparty: string | null;
  status: string;
  categoryId: string;
  categoryName: string;
  /** Moyens généraux seulement : où la dépense se corrige. `null` quand elle n'est pas au SERVICE —
   *  l'écran des moyens généraux ne montre plus que lui (§118.170), et un « Voir la dépense » qui
   *  mène là où elle n'est pas fait chercher ce qui n'y est pas. */
  lien?: string | null;
}

export interface BudgetEnvelopeOption {
  id: string;
  name: string;
  module: string | null;
  modules: string[];
  accessRoles: string[];
  accessUserIds: string[];
  managerRoles: string[];
  managerUserIds: string[];
  periodStart: string;
  periodEnd: string;
  total: number;
  isActive: boolean;
  domaine: string;
  businessUnitId: string | null;
  productId: string | null;
}

/** Ligne d'une enveloppe dans la vue consolidée (« total des enveloppes »). */
export interface EnvelopeSummaryItem {
  id: string;
  name: string;
  isActive: boolean;
  modules: string[];
  domaine: string;
  total: number;
  allocated: number;
  consumed: number;
  remaining: number;
}

export interface EnvelopesGrandTotal {
  count: number;
  total: number;
  allocated: number;
  consumed: number;
  remaining: number;
  items: EnvelopeSummaryItem[];
}

/**
 * Un mois de la période : ce qui a été consommé, le cumul depuis le début, et le **rythme
 * théorique** au même instant (budget dépensé régulièrement). Au-dessus du rythme = on
 * dépense trop vite — c'est toute la lecture de la courbe.
 */
export interface BudgetMonthPoint {
  month: string; // « 2026-03 »
  label: string; // « mars »
  consumed: number;
  cumulative: number;
  expected: number;
}

export interface BudgetOverview {
  envelope: { id: string; name: string; module: string | null; modules: string[]; accessRoles: string[]; accessUserIds: string[]; managerRoles: string[]; managerUserIds: string[]; periodStart: string; periodEnd: string; total: number; notes: string | null; isActive: boolean; domaine: string; businessUnitId: string | null; productId: string | null; companyId?: string | null };
  period: { from: string; to: string };
  categories: BudgetCategoryView[];
  totals: {
    total: number; allocated: number; unallocated: number; consumed: number; committed: number; remaining: number; pct: number;
    /**
     * La part de `committed` déjà CONSOMMÉE : des ordres de dépense émis, au centre de paiement ou chez les Finances,
     * pas encore réglés (`budget/depense-poste.ts`). L'onglet Dépenses coupe le « non payé » en engagé + consommé.
     */
    enCircuit?: number;
  };
  /** Consommation mois par mois (courbe de la vue d'ensemble). */
  monthly: BudgetMonthPoint[];
  unattributed: { total: number; count: number; transactions: UnattributedTx[] };
  /** Le lot d'intégration des dépenses réelles posé sur l'enveloppe (Ad & Pro 2026), s'il y en a un — `budget/integration-regle.ts`. */
  integration?: { lotId: string; integreLe: string; historique: number; absentes: number; aDecider: number } | null;
  attributed: { count: number; transactions: AttributedTx[] };
}

const MONTH_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/**
 * Répartit la consommation par mois et calcule le rythme théorique.
 * Fonction PURE (les dates arrivent déjà lues) : c'est elle qui est testée, pas la requête.
 */
export function buildMonthlySeries(
  from: Date, to: Date, total: number, entries: { date: Date; amount: number }[],
): BudgetMonthPoint[] {
  const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const months: { month: string; label: string }[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  // Garde-fou : une période aberrante ne doit pas produire des milliers de points.
  while (cur <= end && months.length < 60) {
    months.push({ month: key(cur), label: MONTH_FR[cur.getUTCMonth()] });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  if (months.length === 0) return [];

  const byMonth = new Map<string, number>();
  for (const e of entries) byMonth.set(key(e.date), (byMonth.get(key(e.date)) ?? 0) + e.amount);

  let running = 0;
  return months.map((m, i) => {
    const consumed = byMonth.get(m.month) ?? 0;
    running += consumed;
    return {
      month: m.month,
      label: m.label,
      consumed,
      cumulative: running,
      // Rythme théorique : le budget réparti également sur les mois de la période.
      expected: Math.round((total * (i + 1)) / months.length),
    };
  });
}

function health(allocated: number, consumed: number): BudgetHealth {
  if (allocated <= 0) return "NONE";
  const pct = consumed / allocated;
  if (pct >= 1) return "OVER_BUDGET";
  if (pct >= 0.8) return "AT_RISK";
  return "ON_TRACK";
}

export async function getEnvelopes(viewer: SessionUser, opts: OptionsPortee = {}): Promise<BudgetEnvelopeOption[]> {
  const list = await prisma.budgetEnvelope.findMany({ where: await platformScope(viewer.id), orderBy: [{ isActive: "desc" }, { periodStart: "desc" }] });
  return list
    .filter((e) => dansLaPortee(e, opts.portee) && envelopeVisible(viewer, e))
    .map((e) => ({ id: e.id, name: e.name, module: e.module, modules: e.modules, accessRoles: e.accessRoles, accessUserIds: e.accessUserIds, managerRoles: e.managerRoles, managerUserIds: e.managerUserIds, periodStart: e.periodStart.toISOString(), periodEnd: e.periodEnd.toISOString(), total: toNumber(e.totalAmount), isActive: e.isActive, domaine: e.domaine, businessUnitId: e.businessUnitId, productId: e.productId }));
}

/**
 * Vue consolidée « total des enveloppes » : agrège TOUTES les enveloppes que le
 * spectateur est autorisé à voir (le gestionnaire les voit toutes ; les autres ne
 * voient que celles ouvertes par le Super Admin à leur rôle ou à eux-mêmes). La
 * consommation par enveloppe est la somme des dépenses réelles (OUT réglées)
 * attribuées à ses catégories. L'alloué ne compte que les catégories de 1er niveau.
 */
export async function getEnvelopesGrandTotal(viewer: SessionUser, opts: OptionsPortee = {}): Promise<EnvelopesGrandTotal> {
  const envelopes = await prisma.budgetEnvelope.findMany({
    where: await platformScope(viewer.id),
    orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
    include: { categories: { select: { id: true, allocated: true, parentId: true, cle: true, businessUnitId: true } } },
  });
  const visible = envelopes.filter((e) => dansLaPortee(e, opts.portee) && envelopeVisible(viewer, e));

  const catIds = visible.flatMap((e) => e.categories.map((c) => c.id));
  // La vue consolidée ne borne pas la période : elle additionne chaque enveloppe sur SA propre
  // durée de vie. Les moyens généraux sont donc relus sur un intervalle volontairement large,
  // que les enveloppes recoupent d'elles-mêmes par leurs catégories.
  const [sums, expenseSums, generalMeans] = catIds.length
    ? await Promise.all([
        prisma.financeTransaction.groupBy({
          by: ["budgetCategoryId"],
          where: { direction: "OUT", status: "SETTLED", budgetCategoryId: { in: catIds } },
          _sum: { amount: true },
        }),
        prisma.budgetExpenseLine.groupBy({
          by: ["categoryId"],
          where: { categoryId: { in: catIds } },
          _sum: { amount: true },
        }),
        // Sans bornes : la vue consolidée n'a pas de période commune.
        generalMeansConsumption(catIds),
      ])
    : [[], [], { byCategory: new Map<string, number>(), rows: [] }];
  // Consommation = dépenses réglées attribuées + lignes purement budgétaires (découplées)
  // + les achats des moyens généraux classés par ceux qui les font.
  // L'INTÉGRATION DES DÉPENSES RÉELLES : les catégories d'une enveloppe dont un lot est validé se relisent par la règle du
  // lot (`budget/integration-regle.ts`) — leurs agrégats rapides sont écartés, remplacés par les sources qui comptent et
  // les postes historiques. Les autres enveloppes gardent leur agrégat.
  const ctxs = await contextesDesCategories(catIds);
  const gouvernees = categoriesGouvernees(ctxs, catIds);
  const integ = ctxs.length ? await consommationIntegree(ctxs, catIds, null, null, { statuts: ["SETTLED"] }) : null;
  const consumedByCat = new Map<string | null, number>(sums.filter((s) => !gouvernees.has(s.budgetCategoryId ?? "")).map((s) => [s.budgetCategoryId, toNumber(s._sum.amount)]));
  for (const s of expenseSums) {
    if (gouvernees.has(s.categoryId)) continue;
    consumedByCat.set(s.categoryId, (consumedByCat.get(s.categoryId) ?? 0) + toNumber(s._sum.amount));
  }
  if (integ) {
    for (const e of integ.ecritures) consumedByCat.set(e.budgetCategoryId, (consumedByCat.get(e.budgetCategoryId) ?? 0) + toNumber(e.amount as Parameters<typeof toNumber>[0]));
    for (const l of integ.lignes) consumedByCat.set(l.categoryId, (consumedByCat.get(l.categoryId) ?? 0) + toNumber(l.amount as Parameters<typeof toNumber>[0]));
    for (const [catId, amount] of integ.historiqueParCategorie) consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }
  for (const [catId, amount] of generalMeans.byCategory) {
    consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }
  // …et la paie de la force de vente (Budget Operations & Sales), chaque enveloppe sur SA période — en totaux.
  const paie = await masseSalarialeConsumption(visible.flatMap((e) => e.categories.map((c) => ({
    id: c.id, cle: c.cle, businessUnitId: c.businessUnitId,
    envelope: { id: e.id, periodStart: e.periodStart, periodEnd: e.periodEnd, companyId: e.companyId },
  }))));
  for (const [catId, amount] of paie.byCategory) {
    consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }
  // …et les notes de frais de mission de l'équipe Adventum validées (Operations & Sales seulement, jamais Ad & Pro).
  const missions = await fraisMissionConsumption(catIds);
  for (const [catId, amount] of missions.consumed) {
    consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }

  const items: EnvelopeSummaryItem[] = visible.map((e) => {
    const total = toNumber(e.totalAmount);
    const allocated = e.categories.filter((c) => c.parentId === null).reduce((a, c) => a + toNumber(c.allocated), 0);
    const consumed = e.categories.reduce((a, c) => a + (consumedByCat.get(c.id) ?? 0), 0);
    return { id: e.id, name: e.name, isActive: e.isActive, modules: e.modules, domaine: e.domaine, total, allocated, consumed, remaining: total - consumed };
  });

  return { ...totaliser(items), items };
}

export interface BudgetCategoryOption { id: string; label: string; isSub: boolean }

/**
 * Options de **(sous-)catégories** budgétaires proposées à la Direction pour attribuer
 * une dépense à la validation définitive. Priorité aux enveloppes actives couvrant le
 * module ; sinon toutes les enveloppes actives. Le libellé montre le chemin complet
 * « Enveloppe › Catégorie › Sous-catégorie ».
 *
 * `viewer` (la Direction qui décide) RESTREINT aux enveloppes qui lui sont accessibles
 * — décidées par le Super Admin (rôle ou personne). Omis = toutes les enveloppes actives
 * (rétrocompatible / contexte purement serveur).
 */
export async function getBudgetCategoryOptions(module?: string | string[], viewer?: SessionUser): Promise<BudgetCategoryOption[]> {
  const envelopes = await prisma.budgetEnvelope.findMany({
    where: { isActive: true },
    include: { categories: { orderBy: { name: "asc" } } },
    orderBy: [{ periodStart: "desc" }],
  });
  // Enveloppes ACCESSIBLES au décideur (le Super Admin ouvre l'accès à la Direction).
  const accessible = viewer ? envelopes.filter((e) => envelopeVisible(viewer, e)) : envelopes;
  // Accepte un module OU une famille de modules (ex. tout Ad & Pro) : la dépense peut
  // être imputée à n'importe quelle enveloppe couvrant la famille, pas seulement le
  // module exact d'où vient la demande.
  const wanted = module ? (Array.isArray(module) ? module : [module]) : null;
  const relevant = wanted ? accessible.filter((e) => wanted.some((m) => e.modules.includes(m) || e.module === m)) : accessible;
  const list = relevant.length ? relevant : accessible;
  const out: BudgetCategoryOption[] = [];
  for (const env of list) {
    const tops = env.categories.filter((c) => c.parentId === null);
    for (const top of tops) {
      out.push({ id: top.id, label: `${env.name} › ${top.name}`, isSub: false });
      for (const sub of env.categories.filter((c) => c.parentId === top.id)) {
        out.push({ id: sub.id, label: `${env.name} › ${top.name} › ${sub.name}`, isSub: true });
      }
    }
  }
  return out;
}

/** Synthèse budgétaire d'une enveloppe sur une période (par défaut la période de l'enveloppe). */
export async function getBudgetOverview(
  viewer: SessionUser,
  envelopeId: string | null,
  fromArg?: Date | null,
  toArg?: Date | null,
  opts: OptionsPortee = {},
): Promise<BudgetOverview | null> {
  // Sélection de l'enveloppe à afficher :
  //  • enveloppe explicitement demandée (sélecteur) → on la charge telle quelle ;
  //  • vue PAR DÉFAUT (aucun `env`) → la plus récente enveloppe VISIBLE PAR LE SPECTATEUR,
  //    et NON l'enveloppe globale la plus récente. Sinon un compte à qui l'on n'a ouvert
  //    qu'une enveloppe « secondaire » (ex. Ad & Pro) tomberait sur l'enveloppe par défaut
  //    (une autre, plus récente, qui lui est fermée) → `null` → écran « aucune enveloppe »,
  //    alors même que l'enveloppe qui lui est ouverte figure bien dans le sélecteur. On
  //    reprend l'ordre de `getEnvelopes` (actives d'abord, puis récence) pour que l'enveloppe
  //    ouverte par défaut soit exactement la 1re du sélecteur.
  let envelope;
  if (envelopeId) {
    envelope = await prisma.budgetEnvelope.findUnique({ where: { id: envelopeId }, include: { categories: { orderBy: { name: "asc" } } } });
  }
  // Budget d'un pôle (Marketing, Regulatory, Operations) : l'enveloppe mémorisée (cookie partagé avec Budgets) peut être
  // une enveloppe d'une autre portée — on retombe alors sur la première enveloppe du pôle visible, au lieu d'un écran vide.
  const dUnPole = opts.portee !== undefined && opts.portee !== "TOUT";
  if (envelope && dUnPole && !(dansLaPortee(envelope, opts.portee) && envelopeVisible(viewer, envelope))) envelope = null;
  if (!envelopeId || (!envelope && dUnPole)) {
    const candidates = await prisma.budgetEnvelope.findMany({
      orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
      include: { categories: { orderBy: { name: "asc" } } },
    });
    envelope = candidates.find((e) => dansLaPortee(e, opts.portee) && envelopeVisible(viewer, e)) ?? null;
  }
  if (!envelope) return null;
  // Accès : un non-gestionnaire ne peut ouvrir qu'une enveloppe qui lui est ouverte
  // (garde-fou pour le cas d'une enveloppe explicitement demandée via `env`).
  if (!envelopeVisible(viewer, envelope)) return null;

  const from = fromArg ?? envelope.periodStart;
  const to = toArg ?? envelope.periodEnd;

  const catIds = envelope.categories.map((c) => c.id);
  // L'INTÉGRATION DES DÉPENSES RÉELLES (Ad & Pro 2026) : une enveloppe dont un lot est validé se lit par la règle du lot
  // (`budget/integration-regle.ts`) — postes historiques, ce qui naît après, jamais deux fois. Sans lot : `null`, et
  // rien ne change ci-dessous.
  const ctxIntegration = await contexteDeLEnveloppe(envelope.id);
  const integ = ctxIntegration ? await consommationIntegree([ctxIntegration], catIds, from, to) : null;
  // ⚠️ FILTRE SUR LES CATÉGORIES DE **CETTE** ENVELOPPE — la faute qui gonflait le consommé.
  // Sans lui, le groupBy ramenait TOUTES les dépenses de la plateforme : celles imputées aux
  // enveloppes VOISINES et celles ENCORE NON IMPUTÉES (clé `null`). Le total (ligne « consommé »)
  // additionnant toutes les valeurs de la table, une enveloppe Ad & Pro de quelques millions
  // affichait la consommation de l'entreprise entière — d'où les « 42 millions consommés »
  // impossibles. Chaque enveloppe ne compte QUE ses propres catégories ; le non-imputé a sa
  // propre alerte (« à imputer »), il ne doit jamais peser dans une enveloppe qui ne l'a pas reçu.
  const [sums, expenseSums, generalMeans, reglages] = await Promise.all([
    integ
      ? Promise.resolve(integ.ecritures.map((e) => ({ budgetCategoryId: e.budgetCategoryId, status: e.status, _sum: { amount: e.amount } })))
      : catIds.length
      ? prisma.financeTransaction.groupBy({
          by: ["budgetCategoryId", "status"],
          where: { direction: "OUT", date: { gte: from, lte: to }, status: { in: ["SETTLED", "PENDING"] }, budgetCategoryId: { in: catIds } },
          _sum: { amount: true },
        })
      : Promise.resolve([] as { budgetCategoryId: string | null; status: string; _sum: { amount: unknown } }[]),
    // Lignes purement budgétaires (découplées des Finances) imputées aux catégories de l'enveloppe.
    integ
      ? Promise.resolve(integ.lignes.map((l) => ({ categoryId: l.categoryId, _sum: { amount: l.amount } })))
      : catIds.length
      ? prisma.budgetExpenseLine.groupBy({
          by: ["categoryId"],
          where: { categoryId: { in: catIds }, date: { gte: from, lte: to } },
          _sum: { amount: true },
        })
      : Promise.resolve([] as { categoryId: string; _sum: { amount: unknown } }[]),
    // Les achats des moyens généraux, classés par ceux qui les font — c'est ce qui remplit
    // l'enveloppe « Moyens généraux » sans double saisie.
    generalMeansConsumption(catIds, from, to),
    getAppSettings(),
  ]);

  const consumedByCat = new Map<string | null, number>();
  const committedByCat = new Map<string | null, number>();
  for (const s of sums) {
    const amt = toNumber(s._sum.amount);
    const map = s.status === "SETTLED" ? consumedByCat : committedByCat;
    map.set(s.budgetCategoryId, (map.get(s.budgetCategoryId) ?? 0) + amt);
  }
  // Les lignes budgétaires comptent comme consommation (au même titre que les dépenses réglées).
  for (const s of expenseSums) {
    const amt = toNumber(s._sum.amount as Parameters<typeof toNumber>[0]);
    consumedByCat.set(s.categoryId, (consumedByCat.get(s.categoryId) ?? 0) + amt);
  }
  // Les moyens généraux aussi : un ticket de caisse justifié est une dépense au même titre.
  for (const [catId, amount] of generalMeans.byCategory) {
    consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }
  // (a) LES POSTES HISTORIQUES d'un lot d'intégration : payés, à leur date, dans leur catégorie ou sous-catégorie.
  if (integ) {
    for (const [catId, amount] of integ.historiqueParCategorie) consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }
  // La paie de la force de vente (Budget Operations & Sales) : des totaux par catégorie et par mois.
  const env = envelope;
  const paie = await masseSalarialeConsumption(
    env.categories.map((c) => ({ id: c.id, cle: c.cle, businessUnitId: c.businessUnitId, envelope: { id: env.id, periodStart: env.periodStart, periodEnd: env.periodEnd, companyId: env.companyId } })),
    from, to,
  );
  for (const [catId, amount] of paie.byCategory) {
    consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }
  // L'ENGAGÉ AFFICHAIT 0 (Direction, 10/2026) : il ne lisait que des écritures `PENDING`, que le circuit n'écrit jamais.
  // Ce qui est promis et pas payé, ce sont les ORDRES DE DÉPENSE émis et les BC émis des postes accordés
  // (`budget-sources.ts`, règle pure et testée dans `budget/engage.ts`) — ajouté aux écritures `PENDING` saisies à la main.
  const engagements = await engagementsDesCategories(catIds, to);
  for (const [catId, amount] of engagements.parCategorie) {
    committedByCat.set(catId, (committedByCat.get(catId) ?? 0) + amount);
  }
  // LES FRAIS DE L'ÉQUIPE ADVENTUM (Direction, 10/2026 : « ce n'est pas Ad & Pro, c'est Operations & Sales ») : la note
  // de frais de mission compte dans la catégorie Operations & Sales du membre — engagée en route, consommée une fois
  // validée par les RH. Seules les catégories d'une enveloppe Operations & Sales la lisent : Ad & Pro ne la voit jamais.
  // (Le transport et l'hébergement intégrés à la clôture sont des lignes budgétaires, déjà comptées plus haut.)
  const fraisMission = await fraisMissionConsumption(catIds, from, to);
  for (const [catId, amount] of fraisMission.consumed) {
    consumedByCat.set(catId, (consumedByCat.get(catId) ?? 0) + amount);
  }
  for (const [catId, amount] of fraisMission.committed) {
    committedByCat.set(catId, (committedByCat.get(catId) ?? 0) + amount);
  }

  const categories: BudgetCategoryView[] = envelope.categories.map((c) => {
    const allocated = toNumber(c.allocated);
    const consumed = consumedByCat.get(c.id) ?? 0;
    const committed = committedByCat.get(c.id) ?? 0;
    return {
      id: c.id, name: c.name, module: c.module, parentId: c.parentId, color: c.color, notes: c.notes,
      cle: c.cle, businessUnitId: c.businessUnitId,
      allocated, consumed, committed,
      remaining: allocated - consumed,
      pct: allocated > 0 ? Math.round((consumed / allocated) * 100) : 0,
      health: health(allocated, consumed),
    };
  });

  const total = toNumber(envelope.totalAmount);
  // L'alloué de l'enveloppe ne compte que les catégories de 1er niveau (les
  // sous-catégories sont une répartition À L'INTÉRIEUR de leur catégorie parente).
  const allocated = categories.filter((c) => c.parentId === null).reduce((a, c) => a + c.allocated, 0);
  const consumedTotal = [...consumedByCat.values()].reduce((a, v) => a + v, 0);
  const committedTotal = [...committedByCat.values()].reduce((a, v) => a + v, 0);

  // NON IMPUTÉ : compté À PART, jamais dans le consommé de l'enveloppe (c'est une dépense qui
  // n'a pas encore trouvé sa catégorie — l'imputer plus tard la fera entrer dans UNE enveloppe).
  // Total et compte EXACTS via un agrégat, indépendants des 30 lignes affichées. La clause est
  // UNE, lue par les deux : elle écarte les remises et rallonges de caisse d'avance, qui ne sont
  // pas des dépenses (§118.176, `finance/a-imputer.ts`).
  const aImputer = await clauseAImputer(from, to, { societeId: envelope.companyId });
  const [unattributedAgg, unattributedTx] = await Promise.all([
    prisma.financeTransaction.aggregate({
      where: aImputer,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.financeTransaction.findMany({
      where: aImputer,
      orderBy: { date: "desc" },
      take: 30,
      select: { id: true, reference: true, date: true, label: true, amount: true, category: true, counterparty: true, status: true, companyId: true, company: { select: { name: true, shortName: true } } },
    }),
  ]);
  const unattributedTotal = toNumber(unattributedAgg._sum.amount);
  // CE QUI EXPLIQUE CHAQUE DÉPENSE (Direction, 06/10) : ses pièces, sa facture, son ordre, sa source — en lot.
  const piecesAImputer = await piecesDesEcritures(unattributedTx.map((t) => ({ id: t.id, status: t.status })));

  // Dépenses DÉJÀ imputées à une catégorie de CETTE enveloppe. Deux origines fusionnées :
  // les vraies dépenses de trésorerie (FinanceTransaction, ré-attribuables) et les lignes
  // purement budgétaires (BudgetExpenseLine, supprimables ici).
  const catNameById = new Map(envelope.categories.map((c) => [c.id, c.name]));
  const [financeAttr, expenseAttr] = integ
    ? [
        [...integ.ecritures].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 60),
        [...integ.lignes].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 60),
      ]
    : catNameById.size
    ? await Promise.all([
        prisma.financeTransaction.findMany({
          where: { direction: "OUT", budgetCategoryId: { in: [...catNameById.keys()] }, date: { gte: from, lte: to } },
          orderBy: { date: "desc" },
          take: 60,
          select: { id: true, reference: true, date: true, label: true, amount: true, counterparty: true, status: true, budgetCategoryId: true },
        }),
        prisma.budgetExpenseLine.findMany({
          where: { categoryId: { in: [...catNameById.keys()] }, date: { gte: from, lte: to } },
          orderBy: { date: "desc" },
          take: 60,
          select: { id: true, reference: true, date: true, amount: true, categoryId: true },
        }),
      ])
    : [[], []];
  // Série mensuelle (courbe) : on relit les seules dates + montants CONSOMMÉS de l'enveloppe,
  // sans plafond de lignes — la courbe doit couvrir toute la période, pas les 60 dernières.
  const [monthlyFinance, monthlyLines] = integ
    ? [integ.ecritures.filter((e) => e.status === "SETTLED"), integ.lignes]
    : catNameById.size
    ? await Promise.all([
        prisma.financeTransaction.findMany({
          where: { direction: "OUT", status: "SETTLED", budgetCategoryId: { in: [...catNameById.keys()] }, date: { gte: from, lte: to } },
          select: { id: true, date: true, createdAt: true, amount: true },
        }),
        prisma.budgetExpenseLine.findMany({
          where: { categoryId: { in: [...catNameById.keys()] }, date: { gte: from, lte: to } },
          select: { date: true, amount: true },
        }),
      ])
    : [[], []];
  // LA COURBE SAUTAIT EN JUILLET : une écriture réglée au centre de paiement porte la date du clic. Chaque dépense se
  // date par ce qui la date vraiment (`datesReellesDesEcritures`), ramenée dans la période pour que la courbe et le
  // compteur racontent la même histoire.
  const datesReelles = await datesReellesDesEcritures(monthlyFinance);
  const monthly = buildMonthlySeries(from, to, toNumber(envelope.totalAmount), [
    ...monthlyFinance.map((t) => ({ date: dansLaPeriode(datesReelles.get(t.id) ?? t.date, from, to), amount: toNumber(t.amount) })),
    ...monthlyLines.map((l) => ({ date: l.date, amount: toNumber(l.amount) })),
    // La courbe doit raconter la MÊME histoire que le compteur : sans les moyens généraux,
    // elle resterait plate pendant que le consommé, lui, monte.
    ...generalMeans.rows.map((r) => ({ date: r.date, amount: r.amount })),
    ...paie.rows.map((r) => ({ date: r.date, amount: r.amount })),
    ...fraisMission.rows.map((r) => ({ date: dansLaPeriode(r.date, from, to), amount: r.amount })),
    ...(integ?.historiques ?? []).map((h) => ({ date: h.payeLe, amount: h.montant })),
  ]);

  const attributedTx: AttributedTx[] = [
    ...financeAttr.map((t) => ({
      id: t.id, kind: "FINANCE" as const, reference: t.reference, date: t.date.toISOString(), label: t.label,
      amount: toNumber(t.amount), counterparty: t.counterparty, status: t.status,
      categoryId: t.budgetCategoryId ?? "", categoryName: catNameById.get(t.budgetCategoryId ?? "") ?? "—",
    })),
    ...expenseAttr.map((l) => ({
      id: l.id, kind: "BUDGET" as const, reference: l.reference, date: l.date.toISOString(), label: l.reference,
      amount: toNumber(l.amount), counterparty: null, status: "SETTLED",
      categoryId: l.categoryId, categoryName: catNameById.get(l.categoryId) ?? "—",
    })),
    ...generalMeans.rows.slice(0, 60).map((r) => ({
      id: r.expenseId, kind: "GENERAL_MEANS" as const, reference: "Moyens généraux",
      date: r.date.toISOString(), label: r.label, amount: r.amount,
      counterparty: r.department || null, status: "SETTLED",
      categoryId: r.categoryId, categoryName: catNameById.get(r.categoryId) ?? "—",
      lien: r.departmentId === reglages.generalMeansDepartmentId ? "/moyens-generaux" : null,
    })),
    // La paie : UNE ligne par catégorie et par mois (un total et un effectif), jamais une ligne par personne.
    ...paie.rows.map((r) => ({
      id: `paie-${r.categoryId}-${r.date.toISOString().slice(0, 7)}`, kind: "PAIE" as const, reference: "Paie",
      date: r.date.toISOString(), label: `Paie de la force de vente — ${r.effectif} personne${r.effectif > 1 ? "s" : ""}`,
      amount: r.amount, counterparty: null, status: "SETTLED",
      categoryId: r.categoryId, categoryName: catNameById.get(r.categoryId) ?? "—",
      lien: "/budget-operations/masse-salariale",
    })),
    // Les notes de frais de mission de l'équipe Adventum : UNE ligne par note, lue sur la mission.
    ...fraisMission.rows.map((r) => ({
      id: r.id, kind: "MISSION" as const, reference: "Mission Ad & Pro",
      date: r.date.toISOString(), label: r.label, amount: r.amount, counterparty: null, status: "SETTLED",
      categoryId: r.categoryId, categoryName: catNameById.get(r.categoryId) ?? "—",
      lien: lienMission(r.assignmentId, "frais"),
    })),
    // Les postes HISTORIQUES (intégration Ad & Pro 2026) : une ligne par poste payé, lue sur sa demande.
    ...(integ?.historiques ?? []).map((h) => ({
      id: h.id, kind: "HISTORIQUE" as const, reference: h.ligne ? `Fichier L${h.ligne}` : "Historique 2026",
      date: h.payeLe.toISOString(), label: h.libelle, amount: h.montant, counterparty: null, status: "SETTLED",
      categoryId: h.categoryId ?? "", categoryName: catNameById.get(h.categoryId ?? "") ?? "—",
      lien: h.demande ? lienDemandeIntegree(h.demande) : null,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return {
    envelope: { id: envelope.id, name: envelope.name, module: envelope.module, modules: envelope.modules, accessRoles: envelope.accessRoles, accessUserIds: envelope.accessUserIds, managerRoles: envelope.managerRoles, managerUserIds: envelope.managerUserIds, periodStart: envelope.periodStart.toISOString(), periodEnd: envelope.periodEnd.toISOString(), total, notes: envelope.notes, isActive: envelope.isActive, domaine: envelope.domaine, businessUnitId: envelope.businessUnitId, productId: envelope.productId, companyId: envelope.companyId },
    period: { from: from.toISOString(), to: to.toISOString() },
    categories,
    totals: {
      total, allocated, unallocated: total - allocated,
      consumed: consumedTotal, committed: committedTotal,
      enCircuit: [...engagements.enCircuitParCategorie.values()].reduce((x, v) => x + v, 0),
      remaining: total - consumedTotal,
      pct: total > 0 ? Math.round((consumedTotal / total) * 100) : 0,
    },
    monthly,
    unattributed: {
      total: unattributedTotal,
      count: unattributedAgg._count._all,
      transactions: unattributedTx.map((t) => ({
        id: t.id, reference: t.reference, date: t.date.toISOString(), label: t.label,
        amount: toNumber(t.amount), category: t.category, counterparty: t.counterparty, status: t.status,
        companyId: t.companyId, societe: t.company ? (t.company.shortName || t.company.name) : null,
        ...(piecesAImputer.get(t.id) ?? { paiement: t.status, liens: [], pieces: [] }),
      })),
    },
    integration: ctxIntegration && integ ? {
      lotId: ctxIntegration.regle.lotId,
      integreLe: ctxIntegration.regle.integreLe.toISOString(),
      historique: integ.historiques.reduce((s, h) => s + h.montant, 0),
      absentes: integ.jugees.filter((j) => estAbsenteDuFichier(j.verdict)).length,
      aDecider: integ.jugees.filter((j) => j.verdict.raison === "ABSENTE_A_DECIDER").length,
    } : null,
    attributed: {
      count: attributedTx.length,
      transactions: attributedTx,
    },
  };
}
