import { refusAnnulationRallonge } from "@/lib/annulations/regles";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { mergeGrants, canViewDepartmentBudget, editableKindsOn, type DeptBudgetGrant, type BudgetSetter, type DeptBudgetKind } from "@/lib/department-budget";
import { headedDepartmentIds } from "@/lib/queries/department-budget";
import { nextRechargeDate, type PettyCashStatus } from "@/lib/petty-cash";
import { continuousCash, remittanceSpent, type ContinuousCash, type CashRemittance } from "@/lib/general-means/continuous-cash";
import { etatRemise, remiseEnAttente, type EtatRemise } from "@/lib/general-means/remise-centre";
import { isFullyClassified } from "@/lib/budget/imputation";
import { natureDeLaDepense, partsParNature, type PartDeNature } from "@/lib/general-means/ecran";
import { getAppSettings } from "@/lib/settings";

/**
 * MOYENS GÉNÉRAUX — la lecture consolidée d'un département : son budget, ses dépenses, sa
 * caisse d'avance.
 *
 * Ces trois choses vivaient séparément : le budget dans un tableau, les achats dans les
 * demandes administratives, l'argent liquide nulle part. Impossible de répondre à « combien
 * a-t-on dépensé ce mois-ci, et me reste-t-il de quoi payer ? » sans additionner à la main.
 */

/** La liste affichée est plafonnée pour rester lisible ; les TOTAUX, eux, ne le sont pas. */
export const LIST_LIMIT = 200;

export interface GeneralMeansExpense {
  id: string;
  label: string;
  amount: number;
  date: string;
  kind: DeptBudgetKind;
  notes: string | null;
  /** Payée sur la caisse d'avance ? (sinon : virement / Finances) */
  fromPettyCash: boolean;
  /** Pièces justificatives — une dépense sans pièce n'est qu'une affirmation. */
  documents: { id: string; name: string }[];
  /** Le DÉTAIL du ticket : ce qui a été acheté, en quelle quantité, à quel prix, et où c'est classé. */
  lines: { id: string; label: string; quantity: number; amount: number; budgetCategoryId: string | null }[];
  /** Classement budgétaire du ticket entier — `null` = à classer. */
  budgetCategoryId: string | null;
  /** Le chemin lisible de ce classement (« Enveloppe › Catégorie »), pour l'afficher tel quel. */
  budgetLabel: string | null;
  /** Reste-t-il une part non classée sur cette dépense ? (elle est alors signalée) */
  toClassify: boolean;
  /** LA NATURE de la dépense : le nom de sa catégorie budgétaire (« Café et eau ») — `null` = non classée. */
  nature: string | null;
  /** La dépense découpée par nature, article par article (`partsParNature`) — ce que « Par nature » additionne. */
  parts: PartDeNature[];
  createdBy: string;
}

/** Une remise d'argent, telle qu'elle se lit dans l'historique : sa date, sa somme, son sort. */
export interface GeneralMeansRemittance {
  id: string;
  /** « AAAA-MM » — la période reste enregistrée, elle ne cloisonne simplement plus l'argent. */
  period: string;
  /** La DATE de la remise : deux remises peuvent tomber le même mois. */
  remittedAt: string;
  amount: number;
  /** Ce qui est sorti depuis cette remise. */
  spent: number;
  status: PettyCashStatus;
  /**
   * OÙ EN EST L'ARGENT (§118.176) — lu sur l'ordre de la remise : en attente du centre, autorisée
   * et à verser, versée, refusée. `VERSEE` pour une remise d'avant la règle.
   */
  centre: EtatRemise;
  holder: string;
  receivedAt: string | null;
  note: string | null;
}

/**
 * LA CAISSE D'AVANCE — une seule, continue, faite de toutes les remises non soldées.
 *
 * Elle n'a plus de « mois » : une remise ajoute au fond, elle ne clôt pas la précédente. Ce
 * qu'on garde de chaque remise, c'est sa date et sa période — de quoi répondre à « combien
 * a-t-on remis en août ? » sans faire croire que septembre a soldé août.
 */
export interface GeneralMeansCash {
  /** La remise sur laquelle une nouvelle dépense s'impute (la plus récente EN MAIN). */
  currentId: string | null;
  /** Qui détient la caisse aujourd'hui — celui de la remise la plus récente. */
  holder: string;
  holderId: string | null;
  fund: ContinuousCash;
  /** Les remises qui composent le fond, la plus récente d'abord. */
  remittances: GeneralMeansRemittance[];
}

/** Le réglage mensuel de la caisse (posé par les RH) et sa prochaine échéance. */
export interface GeneralMeansPlan {
  monthlyAmount: number;
  rechargeDay: number;
  holderId: string | null;
  holder: string;
  isActive: boolean;
  nextRechargeAt: string | null;
}

/** Une demande de rallonge, telle qu'elle se lit et se tranche. */
export interface GeneralMeansTopUp {
  id: string;
  amountRequested: number;
  amountGranted: number | null;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  requester: string;
  createdAt: string;
  decisionNote: string | null;
  /** Celle qui l'a demandée peut la retirer tant qu'elle n'est pas tranchée (décision du 04/10). */
  canCancel: boolean;
}

export interface GeneralMeansView {
  department: { id: string; name: string; path: string; /** La société du département (nom court), pour l'en-tête. */ company: string | null };
  year: number;
  allocated: number;
  consumed: number;
  remaining: number;
  /** Consommé sur les AUTRES natures (budget métier, formation) — montré à part pour que la
   *  liste se réconcilie avec l'enveloppe sans qu'on croie l'avoir entamée. */
  otherConsumed: number;
  /** Nombre RÉEL de dépenses de l'année (la liste, elle, est plafonnée). */
  expenseCount: number;
  /** La liste affichée est-elle tronquée ? */
  truncated: boolean;
  /** L'utilisateur tient-il ce budget (directeur, RH nommé, administration) ? */
  canSpend: boolean;
  /** Peut-il remettre une caisse et trancher les rallonges ? (administration) */
  canAllot: boolean;
  /** Est-il le DÉTENTEUR de la caisse courante ? (c'est lui qui confirme la réception) */
  isHolder: boolean;
  /** Peut-il corriger ou supprimer une dépense payée SUR LA CAISSE ? C'est de l'argent
   *  physique : seule la personne qui le détient — ou la direction — y touche. Calculé ici
   *  avec la MÊME règle que le serveur, pour qu'un bouton visible ne mène pas à un refus. */
  canAmendCash: boolean;
  cash: GeneralMeansCash | null;
  /** Réglage mensuel — `null` tant que les RH ne l'ont pas posé. */
  plan: GeneralMeansPlan | null;
  /** Demandes de rallonge sur la caisse en cours, la plus récente d'abord. */
  topUps: GeneralMeansTopUp[];
  /** Les remises SOLDÉES, la plus récente d'abord — ce qui a été arrêté, compté, rendu. */
  history: GeneralMeansRemittance[];
  expenses: GeneralMeansExpense[];
}

function grantOf(rows: { departmentId: string | null; accessRoles: string[]; accessUserIds: string[]; operatingRoles: string[]; operatingUserIds: string[]; hrRoles: string[]; hrUserIds: string[]; activityRoles: string[]; activityUserIds: string[] }[], departmentId: string): DeptBudgetGrant {
  const as = (r: (typeof rows)[number] | undefined): DeptBudgetGrant | null =>
    r ? {
      accessRoles: r.accessRoles, accessUserIds: r.accessUserIds,
      operatingRoles: r.operatingRoles, operatingUserIds: r.operatingUserIds,
      hrRoles: r.hrRoles, hrUserIds: r.hrUserIds,
      activityRoles: r.activityRoles, activityUserIds: r.activityUserIds,
    } : null;
  return mergeGrants(as(rows.find((r) => r.departmentId === null)), as(rows.find((r) => r.departmentId === departmentId)));
}

/**
 * LES REMISES NON SOLDÉES D'UN DÉPARTEMENT — la matière du fond, pour l'écran comme pour la saisie.
 *
 * Un seul chargement, une seule forme : l'écran affiche le solde et les actions le revérifient
 * avec EXACTEMENT le même calcul. Deux lectures différentes de la même caisse, c'est un bouton
 * proposé puis un refus après la saisie — le formulaire est perdu, et la personne ne sait pas
 * pourquoi.
 */
export async function openRemittances(
  departmentId: string,
  /**
   * LA LECTURE SOUS VERROU (audit Assistante de direction, 10/2026) : la dépense sur caisse relit le fond DANS sa
   * transaction, après avoir verrouillé le département — deux dépenses simultanées ne lisent plus le même solde.
   */
  db: Pick<typeof prisma, "pettyCashAllotment"> = prisma,
): Promise<(CashRemittance & { holderId: string | null; enAttenteDuCentre: boolean })[]> {
  const rows = await db.pettyCashAllotment.findMany({
    where: { departmentId, status: { not: "CLOSED" } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, period: true, createdAt: true, amount: true, status: true, holderId: true,
      expenseOrderId: true, transactionId: true,
      expenseOrder: { select: { status: true, centralStatus: true } },
      expenses: { select: { id: true, amount: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    period: r.period,
    remittedAt: r.createdAt.toISOString(),
    amount: toNumber(r.amount),
    status: r.status,
    holderId: r.holderId,
    // UNE REMISE QUI ATTEND LE CENTRE (§118.176) n'est pas encore dans le fond : elle ne se solde
    // pas avec lui, et elle ne se confirme pas.
    enAttenteDuCentre: remiseEnAttente(etatRemise({
      aUnOrdre: Boolean(r.expenseOrderId), ordre: r.expenseOrder, transactionId: r.transactionId,
    })),
    expenses: r.expenses.map((e) => ({ id: e.id, amount: toNumber(e.amount) })),
  }));
}

/**
 * Le département dont on montre les moyens généraux : le SERVICE désigné, pour tout le monde.
 * Sans service, celui que la personne DIRIGE, à défaut la caisse qu'elle détient, à défaut le sien
 * — sans ce repli, l'assistante devrait connaître l'identifiant de son propre département pour
 * voir sa caisse.
 */
export async function resolveGeneralMeansDepartment(user: SessionUser): Promise<string | null> {
  // LES MOYENS GÉNÉRAUX SONT CEUX DE TOUT LE MONDE.
  //
  // Chacun arrivait sur les moyens généraux DE SON DÉPARTEMENT : autant de caisses que de
  // directions, alors qu'il n'y a qu'un service qui achète et qui décaisse. On demandait des
  // cartouches à une caisse, on les recevait d'une autre, et personne ne savait laquelle était
  // « la bonne ». Le service désigné (réglé par le Super Admin) est donc la porte de tous.
  //
  // ET PLUS PERSONNE NE PASSE D'UN DÉPARTEMENT À L'AUTRE ICI, Super Admin compris (décision du
  // 01/10 : « enlève les autres départements, laisse que l'Administration »). Le Super Admin
  // ouvrait jusque-là les moyens généraux de n'importe quel département par `?dept=` : ce
  // paramètre n'a plus d'appelant, il est retiré — le garder ferait une porte cachée vers ce
  // qu'on vient de retirer de l'écran (§118.14). Le découpage par département n'a pas disparu :
  // il reste la façon dont l'argent est IMPUTÉ, et il se lit dans Budgets › par département.
  const { generalMeansDepartmentId } = await getAppSettings();
  // Le service doit EXISTER : le réglage n'est pas une clé étrangère, et un département supprimé
  // laisserait tout le module en 404 — sans plus aucun `?dept=` pour en sortir. On retombe alors
  // sur le repli ; et le Super Admin, qu'il ait un département à lui ou non, retrouve de quoi en
  // redésigner un (« Changer de service… », et l'écran vide qui le propose d'office). Sans ce
  // second geste, le premier jet de cette phrase promettait une issue qui n'existait pas pour un
  // Super Admin sans département — le repli rend alors `null`.
  if (generalMeansDepartmentId) {
    const service = await prisma.department.findUnique({ where: { id: generalMeansDepartmentId }, select: { id: true } });
    if (service) return service.id;
  }

  // Aucun service désigné : on retombe sur l'ancien comportement plutôt que sur un écran vide.
  // Une plateforme qui n'a pas encore été réglée doit continuer de fonctionner.
  const headed = await headedDepartmentIds(user.id);
  if (headed.length > 0) return headed[0];
  // La caisse qu'on détient désigne le département aussi sûrement qu'un rattachement.
  const held = await prisma.pettyCashAllotment.findFirst({
    where: { holderId: user.id },
    orderBy: { period: "desc" },
    select: { departmentId: true },
  });
  if (held) return held.departmentId;
  const emp = await prisma.employee.findUnique({ where: { userId: user.id }, select: { departmentId: true } });
  return emp?.departmentId ?? null;
}

export async function getGeneralMeans(
  user: SessionUser,
  departmentId: string,
  year: number,
): Promise<GeneralMeansView | null> {
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, name: true, parent: { select: { name: true } }, company: { select: { name: true, shortName: true } } },
  });
  if (!department) return null;

  const headed = await headedDepartmentIds(user.id);
  const rights: BudgetSetter = {
    role: user.role,
    secondaryRole: user.secondaryRole ?? null,
    canManageBudgets: userCan(user, "BUDGETS", "UPDATE") || userCan(user, "BUDGETS", "VALIDATE"),
    canManageHr: userCan(user, "RH", "UPDATE"),
    headOfDepartmentIds: headed,
  };
  const subject = { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null };
  const canViewModule = userCan(user, "BUDGETS", "VIEW");

  const accessRows = await prisma.departmentBudgetAccess.findMany({
    where: { OR: [{ departmentId }, { departmentId: null }] },
  });
  const grant = grantOf(accessRows, departmentId);

  // LA CAISSE SE LIT D'UN BLOC. On chargeait la remise du MOIS demandé ; le fond, lui, est fait
  // de toutes les remises non soldées — c'est la somme qu'on a réellement dans le tiroir. Les
  // remises soldées suivent, en nombre borné : elles ne servent qu'à l'historique.
  const remittanceRows = await prisma.pettyCashAllotment.findMany({
    where: { departmentId },
    orderBy: { createdAt: "desc" },
    take: 36,
    include: {
      holder: { select: { id: true, name: true } },
      expenses: { select: { id: true, amount: true } },
      expenseOrder: { select: { status: true, centralStatus: true } },
      topUps: {
        orderBy: { createdAt: "desc" },
        include: { requestedBy: { select: { name: true } } },
      },
    },
  });
  const openRows = remittanceRows.filter((r) => r.status !== "CLOSED");
  const closedRows = remittanceRows.filter((r) => r.status === "CLOSED").slice(0, 12);
  /** La remise la plus récente : c'est elle qui nomme le détenteur du fond. */
  const latest = openRows[0] ?? null;
  const planRow = await prisma.pettyCashPlan.findUnique({
    where: { departmentId },
    include: { holder: { select: { name: true } } },
  });
  // DÉTENIR LA CAISSE, c'est détenir N'IMPORTE LAQUELLE des remises ouvertes : le fond est un,
  // et une remise plus ancienne à son nom suffit à en faire la personne qui sort l'argent.
  const isHolder = openRows.some((r) => r.holderId === user.id);
  // LE DROIT DE MODULE SUFFIT. Celui qui achète au quotidien (l'assistante de direction) a le
  // module « Moyens généraux » et rien d'autre : exiger en plus une autorisation budgétaire la
  // renvoyait vers un écran vide sur son propre budget. Le module ouvre SON département ; les
  // autres restent gouvernés par les autorisations budgétaires, comme avant.
  const hasModule = userCan(user, "GENERAL_MEANS", "VIEW");

  if (!isHolder && !hasModule && !canViewDepartmentBudget(subject, rights, grant, canViewModule, departmentId)) return null;

  const [budget, expenses, totals, expenseCount] = await Promise.all([
    prisma.departmentBudget.findUnique({
      where: { departmentId_year_kind: { departmentId, year, kind: "OPERATING" } },
      select: { amount: true },
    }),
    prisma.departmentBudgetExpense.findMany({
      where: { departmentId, year, kind: { not: "HR" } },
      orderBy: { date: "desc" },
      take: LIST_LIMIT,
      include: {
        createdBy: { select: { name: true } },
        lines: { orderBy: { createdAt: "asc" }, select: { id: true, label: true, quantity: true, amount: true, budgetCategoryId: true } },
      },
    }),
    // LE CONSOMMÉ NE SE CALCULE PAS SUR LA LISTE AFFICHÉE. Elle est plafonnée pour rester
    // lisible ; additionner ses lignes revenait à ignorer en silence tout ce qui dépasse le
    // plafond — un budget qui s'allège tout seul au 201ᵉ achat. La base additionne, elle.
    prisma.departmentBudgetExpense.groupBy({
      by: ["kind"],
      where: { departmentId, year, kind: { not: "HR" } },
      _sum: { amount: true },
    }),
    prisma.departmentBudgetExpense.count({ where: { departmentId, year, kind: { not: "HR" } } }),
  ]);

  // UNE SEULE LISTE DE DÉPENSES, donc un seul jeu de pièces à charger. Il y en avait deux :
  // celles de l'année et celles de la caisse du mois, qui se recouvraient largement — la même
  // dépense s'affichait deux fois, à deux endroits, et l'on ne savait plus laquelle lire.
  const docIds = Array.from(new Set(expenses.map((e) => e.id)));
  const docRows = docIds.length
    ? await prisma.document.findMany({
        where: { entityType: "DEPARTMENT_EXPENSE", entityId: { in: docIds } },
        select: { id: true, name: true, entityId: true },
      })
    : [];
  const docsByExpense = new Map<string, { id: string; name: string }[]>();
  for (const d of docRows) {
    const arr = docsByExpense.get(d.entityId) ?? [];
    arr.push({ id: d.id, name: d.name });
    docsByExpense.set(d.entityId, arr);
  }

  // LE CHEMIN LISIBLE DU CLASSEMENT. On ne montre pas un identifiant à quelqu'un qui n'a pas
  // le module Budget : on lui montre « Enveloppe › Catégorie », c'est-à-dire ce qu'il a choisi.
  const usedCategoryIds = Array.from(new Set([
    ...expenses.map((e) => e.budgetCategoryId),
    ...expenses.flatMap((e) => e.lines.map((l) => l.budgetCategoryId)),
  ].filter((x): x is string => Boolean(x))));
  const categoryRows = usedCategoryIds.length
    ? await prisma.budgetCategoryLine.findMany({
        where: { id: { in: usedCategoryIds } },
        select: { id: true, name: true, envelope: { select: { name: true } } },
      })
    : [];
  const categoryPath = new Map(categoryRows.map((c) => [c.id, `${c.envelope.name} › ${c.name}`]));
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));

  type ExpenseRow = {
    id: string; label: string; amount: unknown; date: Date; kind: string; notes: string | null;
    pettyCashId?: string | null; budgetCategoryId: string | null;
    lines: { id: string; label: string; quantity: unknown; amount: unknown; budgetCategoryId: string | null }[];
    createdBy: { name: string | null } | null;
  };
  const toExpense = (e: ExpenseRow, fromPettyCash?: boolean): GeneralMeansExpense => {
    const lines = e.lines.map((l) => ({
      id: l.id, label: l.label, quantity: toNumber(l.quantity), amount: toNumber(l.amount),
      budgetCategoryId: l.budgetCategoryId,
    }));
    const amount = toNumber(e.amount);
    return {
      id: e.id,
      label: e.label,
      amount,
      date: e.date.toISOString(),
      kind: e.kind as DeptBudgetKind,
      notes: e.notes,
      fromPettyCash: fromPettyCash ?? Boolean(e.pettyCashId),
      documents: docsByExpense.get(e.id) ?? [],
      lines,
      budgetCategoryId: e.budgetCategoryId,
      budgetLabel: e.budgetCategoryId ? categoryPath.get(e.budgetCategoryId) ?? null : null,
      // « À classer » se calcule avec la MÊME règle que le budget : ce qui reste après les
      // articles classés, quand le ticket lui-même n'a pas de case.
      toClassify: !isFullyClassified({ amount, budgetCategoryId: e.budgetCategoryId, lines }),
      nature: natureDeLaDepense({ budgetCategoryId: e.budgetCategoryId, lines }, categoryName),
      parts: partsParNature({ amount, budgetCategoryId: e.budgetCategoryId, lines }, categoryName),
      createdBy: e.createdBy?.name ?? "",
    };
  };

  const allExpenses = expenses.map((e) => toExpense(e));
  const allocated = budget ? toNumber(budget.amount) : 0;
  // L'ENVELOPPE AFFICHÉE EST CELLE DES MOYENS GÉNÉRAUX. On ne lui soustrait donc QUE les
  // dépenses de cette nature : imputer un achat « budget métier » sur l'enveloppe des moyens
  // généraux faisait fondre celle-ci pour de l'argent qu'elle n'a jamais porté — et faisait
  // diverger cet écran de la page Budgets, qui compte nature par nature.
  const sumOf = (k: DeptBudgetKind): number => toNumber(totals.find((t) => t.kind === k)?._sum.amount ?? 0);
  const consumed = sumOf("OPERATING");
  const otherConsumed = totals
    .filter((t) => t.kind !== "OPERATING")
    .reduce((a, t) => a + toNumber(t._sum.amount ?? 0), 0);

  type RemittanceRow = (typeof remittanceRows)[number];
  const asRemittance = (r: RemittanceRow): CashRemittance => ({
    id: r.id,
    period: r.period,
    remittedAt: r.createdAt.toISOString(),
    amount: toNumber(r.amount),
    status: r.status,
    expenses: r.expenses.map((e) => ({ id: e.id, amount: toNumber(e.amount) })),
  });
  const centreDe = (r: RemittanceRow): EtatRemise => etatRemise({
    aUnOrdre: Boolean(r.expenseOrderId), ordre: r.expenseOrder, transactionId: r.transactionId,
  });
  const readable = (r: RemittanceRow): GeneralMeansRemittance => {
    const base = asRemittance(r);
    return {
      id: base.id,
      period: base.period,
      remittedAt: base.remittedAt,
      amount: base.amount,
      spent: remittanceSpent(base),
      status: r.status as PettyCashStatus,
      centre: centreDe(r),
      holder: r.holder?.name ?? "",
      receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
      note: r.note,
    };
  };

  // LE FOND NE COMPTE QUE CE QUI A ÉTÉ VERSÉ (§118.176). Une remise qui attend le centre n'a pas
  // quitté la banque : la compter « remise » ferait annoncer à la détentrice une somme à
  // confirmer qu'elle ne peut pas recevoir. Elle reste dans la liste, avec ce qu'elle attend.
  const fund = continuousCash(openRows.filter((r) => !remiseEnAttente(centreDe(r))).map(asRemittance));
  const cash: GeneralMeansCash | null = latest
    ? {
        currentId: fund.currentId,
        holder: latest.holder?.name ?? "",
        holderId: latest.holderId,
        fund,
        remittances: openRows.map(readable),
      }
    : null;

  const plan: GeneralMeansPlan | null = planRow
    ? {
        monthlyAmount: toNumber(planRow.monthlyAmount),
        rechargeDay: planRow.rechargeDay,
        holderId: planRow.holderId,
        holder: planRow.holder?.name ?? "",
        isActive: planRow.isActive,
        nextRechargeAt: planRow.isActive ? nextRechargeDate(planRow.rechargeDay, new Date()).toISOString() : null,
      }
    : null;

  return {
    department: {
      id: department.id,
      name: department.name,
      path: department.parent ? `${department.parent.name} › ${department.name}` : department.name,
      company: department.company ? department.company.shortName || department.company.name : null,
    },
    year,
    allocated,
    consumed,
    remaining: allocated - consumed,
    otherConsumed,
    expenseCount,
    truncated: expenseCount > LIST_LIMIT,
    // SAISIR UNE DÉPENSE : le droit de module suffit (c'est le geste quotidien de l'acheteur),
    // ou le fait de tenir ce budget. Elle est de toute façon déduite du budget, pièce à l'appui.
    canSpend: userCan(user, "GENERAL_MEANS", "CREATE")
      || editableKindsOn(subject, rights, grant, departmentId).some((k) => k !== "HR"),
    // Doter la caisse et arbitrer : l'administration, les finances — et les RESSOURCES
    // HUMAINES, qui pilotent le module des moyens généraux de tous les départements.
    canAllot: hasGlobalView(user) || rights.canManageBudgets || rights.canManageHr,
    isHolder,
    canAmendCash: isHolder || hasGlobalView(user),
    cash,
    plan,
    // LES RALLONGES DE TOUTES LES REMISES OUVERTES. Les rattacher à la seule remise du mois
    // faisait disparaître une demande en attente le jour où une nouvelle somme arrivait.
    topUps: openRows.flatMap((r) => r.topUps).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((t) => ({
      id: t.id,
      amountRequested: toNumber(t.amountRequested),
      amountGranted: t.amountGranted === null ? null : toNumber(t.amountGranted),
      reason: t.reason,
      status: t.status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED",
      requester: t.requestedBy?.name ?? "",
      createdAt: t.createdAt.toISOString(),
      decisionNote: t.decisionNote,
      canCancel: t.requestedById === user.id && refusAnnulationRallonge(t.status) === null,
    })),
    history: closedRows.map(readable),
    expenses: allExpenses,
  };
}
