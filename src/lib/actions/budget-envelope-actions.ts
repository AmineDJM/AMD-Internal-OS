"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { canManageEnvelopes, canManageEnvelope, canViewEnvelope, hasGlobalView, userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { canEditCompanyId, companyIdForNew } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdNum, fdDate, fdBool, type ActionResult } from "@/lib/actions/types";
import { poleDe } from "@/lib/budget/domaines";
import { supprimerSousGarde } from "@/lib/budget/suppression-garde";

const NOT_ALLOWED: ActionResult = { ok: false, error: "Gestion des enveloppes réservée au Super Admin (ou à un délégué)." };

const readAccessRoles = (formData: FormData) => formData.getAll("accessRoles").map(String).filter(Boolean);
const readAccessUserIds = (formData: FormData) => [...new Set(formData.getAll("accessUserIds").map(String).filter(Boolean))];
const readManagerRoles = (formData: FormData) => formData.getAll("managerRoles").map(String).filter(Boolean);
const readManagerUserIds = (formData: FormData) => [...new Set(formData.getAll("managerUserIds").map(String).filter(Boolean))];
const readModules = (formData: FormData) => [...new Set(formData.getAll("modules").map(String).filter(Boolean))];

/** GESTION du CONTENU d'une enveloppe (catégories, dépenses budgétaires) : gestionnaire global
 *  OU délégué désigné par l'admin sur CETTE enveloppe. Charge les listes d'accès puis vérifie. */
async function ensureCanManageEnvelope(user: Awaited<ReturnType<typeof requireUser>>, envelopeId: string): Promise<ActionResult | null> {
  const env = await prisma.budgetEnvelope.findUnique({ where: { id: envelopeId }, select: { managerRoles: true, managerUserIds: true, domaine: true } });
  if (!env) return { ok: false, error: "Enveloppe introuvable." };
  return canManageEnvelope(user, env) ? null : NOT_ALLOWED;
}

/** Idem via l'id d'une (sous-)catégorie : on remonte à son enveloppe pour vérifier la gestion. */
async function ensureCanManageCategory(user: Awaited<ReturnType<typeof requireUser>>, categoryId: string): Promise<ActionResult | null> {
  const cat = await prisma.budgetCategoryLine.findUnique({ where: { id: categoryId }, select: { envelope: { select: { managerRoles: true, managerUserIds: true, domaine: true } } } });
  if (!cat) return { ok: false, error: "Catégorie introuvable." };
  return canManageEnvelope(user, cat.envelope) ? null : NOT_ALLOWED;
}

// ─────────────────────── Budget total (fixe / flexible) ───────────────────────

/** Règle le budget total : FIXED (montant figé) ou FLEXIBLE (= somme des enveloppes). */
export async function setBudgetTotal(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageEnvelopes(user)) return NOT_ALLOWED;
  const mode = fdStr(formData, "mode") === "FIXED" ? "FIXED" : "FLEXIBLE";
  const fixed = fdNum(formData, "budgetFixedTotal") ?? 0;
  await prisma.appSetting.upsert({
    where: { id: "global" },
    update: { budgetTotalMode: mode, budgetFixedTotal: fixed, updatedById: user.id },
    create: { id: "global", budgetTotalMode: mode, budgetFixedTotal: fixed, updatedById: user.id },
  });
  revalidatePath("/budgets");
  return { ok: true };
}

// ─────────────────────────── Enveloppe ───────────────────────────

export async function createEnvelope(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageEnvelopes(user)) return NOT_ALLOWED;
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de l'enveloppe est obligatoire." };
  const now = new Date();
  const periodStart = fdDate(formData, "periodStart") ?? new Date(now.getFullYear(), 0, 1);
  const periodEnd = fdDate(formData, "periodEnd") ?? new Date(now.getFullYear(), 11, 31);

  const modules = readModules(formData);
  const created = await prisma.budgetEnvelope.create({
    data: {
      name,
      modules,
      module: modules[0] ?? null, // compat : module principal
      accessRoles: readAccessRoles(formData),
      accessUserIds: readAccessUserIds(formData),
      managerRoles: readManagerRoles(formData),
      managerUserIds: readManagerUserIds(formData),
      periodStart,
      periodEnd,
      totalAmount: fdNum(formData, "totalAmount") ?? 0,
      notes: fdStr(formData, "notes"),
      createdById: user.id,
      // Une enveloppe appartient à une société : le budget d'Adventum n'est pas celui de Pharmagène.
      companyId: await companyIdForNew(user.id),
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Budgets", summary: `Enveloppe budgétaire « ${name} »` });
  revalidatePath("/budgets");
  return { ok: true, id: created.id };
}

export async function updateEnvelope(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageEnvelopes(user)) return NOT_ALLOWED;
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id || !name) return { ok: false, error: "Paramètres manquants." };
  const modules = readModules(formData);
  const accessRoles = readAccessRoles(formData);
  const accessUserIds = readAccessUserIds(formData);
  const managerRoles = readManagerRoles(formData);
  const managerUserIds = readManagerUserIds(formData);
  await prisma.budgetEnvelope.update({
    where: { id },
    data: {
      name,
      modules,
      module: modules[0] ?? null, // compat : module principal
      accessRoles,
      accessUserIds,
      managerRoles,
      managerUserIds,
      periodStart: fdDate(formData, "periodStart") ?? undefined,
      periodEnd: fdDate(formData, "periodEnd") ?? undefined,
      totalAmount: fdNum(formData, "totalAmount") ?? 0,
      notes: fdStr(formData, "notes"),
      isActive: fdBool(formData, "isActive"),
    },
  });
  // Traçabilité : toute modification des ACCÈS (visualisation / gestion) est journalisée.
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets",
    summary: `Enveloppe « ${name} » modifiée — accès : ${accessRoles.length} rôle(s) + ${accessUserIds.length} personne(s) en consultation, ${managerRoles.length} rôle(s) + ${managerUserIds.length} personne(s) en gestion`,
  });
  revalidatePath("/budgets");
  return { ok: true };
}

export async function deleteEnvelope(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageEnvelopes(user)) return NOT_ALLOWED;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const env = await prisma.budgetEnvelope.findUnique({ where: { id }, select: { name: true } });
  if (!env) return { ok: false, error: "Enveloppe introuvable." };
  // Ses dépenses budgétaires partiraient en cascade : refusé tant qu'il en reste (`budget/suppression-garde.ts`).
  const fait = await supprimerSousGarde({ envelopeId: id });
  if (!fait.ok) return fait;
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Budgets", summary: `Enveloppe budgétaire « ${env.name} » supprimée` });
  revalidatePath("/budgets");
  return { ok: true };
}

// ─────────────────────────── Catégories ───────────────────────────

export async function createBudgetCategory(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const envelopeId = fdStr(formData, "envelopeId");
  const name = fdStr(formData, "name");
  if (!envelopeId || !name) return { ok: false, error: "Nom de catégorie manquant." };
  const denied = await ensureCanManageEnvelope(user, envelopeId);
  if (denied) return denied;
  // Sous-catégorie : rattachée à une catégorie parente. Elle n'a pas de module
  // (l'attribution automatique des dépenses se fait au niveau de la catégorie de tête).
  const parentId = fdStr(formData, "parentId");
  const created = await prisma.budgetCategoryLine.create({
    data: {
      envelopeId, name,
      parentId: parentId || null,
      module: parentId ? null : fdStr(formData, "module"),
      allocated: fdNum(formData, "allocated") ?? 0,
      color: fdStr(formData, "color"), notes: fdStr(formData, "notes"),
    },
    select: { id: true },
  });
  revalidatePath("/budgets");
  return { ok: true, id: created.id };
}

export async function updateBudgetCategory(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id || !name) return { ok: false, error: "Paramètres manquants." };
  const denied = await ensureCanManageCategory(user, id);
  if (denied) return denied;
  const parentId = fdStr(formData, "parentId");
  const isSub = Boolean(parentId) && parentId !== id; // pas d'auto-rattachement
  await prisma.budgetCategoryLine.update({
    where: { id },
    data: {
      name, allocated: fdNum(formData, "allocated") ?? 0, color: fdStr(formData, "color"), notes: fdStr(formData, "notes"),
      parentId: isSub ? parentId : null,
      // Le module d'attribution est MODIFIABLE et ré-enregistrable pour une catégorie de tête
      // (une sous-catégorie n'en porte pas — l'attribution auto se fait au niveau de la tête).
      module: isSub ? null : (fdStr(formData, "module") || null),
    },
  });
  revalidatePath("/budgets");
  return { ok: true };
}

export async function deleteBudgetCategory(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const denied = await ensureCanManageCategory(user, id);
  if (denied) return denied;
  // Les écritures de trésorerie attribuées repassent en « non attribué » (FK SetNull) ; les dépenses
  // budgétaires, elles, partiraient en cascade : refusé tant qu'il en reste (`budget/suppression-garde.ts`).
  const fait = await supprimerSousGarde({ categoryId: id });
  if (!fait.ok) return fait;
  revalidatePath("/budgets");
  return { ok: true };
}

/** Attribue (ou retire) une dépense à une catégorie budgétaire. */
export async function attributeTransaction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const transactionId = fdStr(formData, "transactionId");
  if (!transactionId) return { ok: false, error: "Transaction manquante." };
  const budgetCategoryId = fdStr(formData, "budgetCategoryId"); // null = retirer
  if (!(hasGlobalView(user.role) || userCan(user, "BUDGETS", "UPDATE"))) {
    // BUDGETS DES PÔLES (08/10) : un pôle (Marketing, Regulatory, Operations) impute aux catégories de SES enveloppes,
    // et retire une imputation qui y pointe — jamais ailleurs. La catégorie visée (ou quittée) doit être dans une
    // enveloppe de pôle que la personne gère.
    const actuelle = await prisma.financeTransaction.findUnique({ where: { id: transactionId }, select: { budgetCategoryId: true } });
    if (!actuelle) return { ok: false, error: "Transaction introuvable." };
    const ids = [budgetCategoryId, actuelle.budgetCategoryId].filter((x): x is string => Boolean(x));
    const cats = ids.length
      ? await prisma.budgetCategoryLine.findMany({ where: { id: { in: ids } }, select: { id: true, envelope: { select: { managerRoles: true, managerUserIds: true, domaine: true } } } })
      : [];
    const ok = ids.length > 0 && ids.every((id) => {
      const c = cats.find((x) => x.id === id);
      return c ? poleDe(c.envelope) !== null && canManageEnvelope(user, c.envelope) : false;
    });
    if (!ok) return { ok: false, error: "Allocation réservée à la Direction." };
  }
  await prisma.financeTransaction.update({ where: { id: transactionId }, data: { budgetCategoryId } });
  revalidatePath("/budgets");
  revalidatePath("/budget-marketing");
  revalidatePath("/budget-regulatory");
  revalidatePath("/budget-operations");
  return { ok: true };
}

/**
 * CETTE DÉPENSE CONCERNE UNE AUTRE SOCIÉTÉ (Direction, 06/10) — la déplacer. L'écriture change de société, et l'ordre de
 * dépense qu'elle a payé la suit ; elle quitte la liste « à imputer » de l'enveloppe de son ancienne société. Les deux
 * sociétés, l'ancienne et la nouvelle, doivent être de celles que la personne engage.
 */
export async function changerSocieteEcriture(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!(hasGlobalView(user.role) || userCan(user, "BUDGETS", "UPDATE") || userCan(user, "FINANCES", "UPDATE"))) return { ok: false, error: "Réservé à la Direction, aux Budgets et aux Finances." };
  const transactionId = fdStr(formData, "transactionId");
  const companyId = fdStr(formData, "companyId");
  if (!transactionId || !companyId) return { ok: false, error: "Choisissez la société de cette dépense." };
  const tx = await prisma.financeTransaction.findUnique({ where: { id: transactionId }, select: { id: true, reference: true, label: true, companyId: true, company: { select: { name: true } } } });
  if (!tx) return { ok: false, error: "Dépense introuvable." };
  if (tx.companyId === companyId) return { ok: true, message: "Cette dépense est déjà rattachée à cette société." };
  const societe = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, isActive: true } });
  if (!societe?.isActive) return { ok: false, error: "Société introuvable." };
  if (!(await canEditCompanyId(user.id, tx.companyId)) || !(await canEditCompanyId(user.id, companyId))) {
    return { ok: false, error: "Vous ne pouvez déplacer une dépense qu'entre des sociétés que vous engagez." };
  }
  await prisma.$transaction([
    prisma.financeTransaction.update({ where: { id: tx.id }, data: { companyId } }),
    prisma.expenseOrder.updateMany({ where: { transactionId: tx.id }, data: { companyId } }),
  ]);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets", entityType: "FINANCE_TRANSACTION", entityId: tx.id,
    summary: `Dépense ${tx.reference} « ${tx.label} » déplacée de ${tx.company?.name ?? "sans société"} vers ${societe.name}`,
  });
  revalidatePath("/budgets");
  return { ok: true, message: `Dépense ${tx.reference} rattachée à ${societe.name}.` };
}

/** Accès en imputation à une (sous-)catégorie : renvoie la catégorie si autorisée, sinon un message. */
async function resolveExpenseCategory(user: Awaited<ReturnType<typeof requireUser>>, budgetCategoryId: string) {
  const cat = await prisma.budgetCategoryLine.findUnique({
    where: { id: budgetCategoryId },
    select: { id: true, name: true, envelope: { select: { accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true, domaine: true } } },
  });
  if (!cat) return { error: "Catégorie introuvable." as const };
  // Peut imputer : un GESTIONNAIRE de l'enveloppe (global ou délégué par l'admin), OU la
  // Direction / un titulaire BUDGETS:UPDATE à condition que l'enveloppe lui soit OUVERTE.
  const allowed = canManageEnvelope(user, cat.envelope)
    || ((hasGlobalView(user.role) || userCan(user, "BUDGETS", "UPDATE")) && canViewEnvelope(user, cat.envelope));
  if (!allowed) return { error: "Cette enveloppe ne vous est pas ouverte." as const };
  return { cat };
}

/**
 * AJOUT RAPIDE d'une ligne de dépense qui CONSOMME un budget, directement depuis le module
 * Budget (référence + montant). Crée une ligne PUREMENT BUDGÉTAIRE (BudgetExpenseLine) imputée
 * à la (sous-)catégorie choisie → la consommation se met à jour aussitôt, SANS toucher les
 * Finances ni la trésorerie (le financier enregistrera le mouvement réel s'il le souhaite).
 * Réservé à la Direction / aux gestionnaires, sur une enveloppe qui leur est ACCESSIBLE.
 */
export async function addBudgetExpense(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // L'autorisation fine (gestionnaire de l'enveloppe OU Direction sur enveloppe ouverte) est
  // décidée par resolveExpenseCategory une fois la catégorie — donc l'enveloppe — connue.
  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  const reference = fdStr(formData, "reference"); // la « référence » saisie sert de libellé de la dépense
  const amount = fdNum(formData, "amount");
  if (!budgetCategoryId) return { ok: false, error: "Choisissez la catégorie de budget." };
  if (!reference) return { ok: false, error: "Indiquez une référence." };
  if (amount == null || amount <= 0) return { ok: false, error: "Indiquez un montant positif." };

  const resolved = await resolveExpenseCategory(user, budgetCategoryId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { cat } = resolved;

  const date = fdDate(formData, "date") ?? new Date();
  const created = await prisma.budgetExpenseLine.create({
    data: { categoryId: budgetCategoryId, reference: reference.slice(0, 160), amount, date, createdById: user.id },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Budgets", entityId: created.id, summary: `Dépense budgétaire « ${reference.slice(0, 160)} » imputée à « ${cat.name} »` });
  revalidatePath("/budgets");
  return { ok: true };
}

/**
 * MODIFIE une ligne de dépense purement budgétaire (BudgetExpenseLine) : référence, montant,
 * date et, éventuellement, RÉ-IMPUTATION vers une autre (sous-)catégorie. La consommation des
 * catégories concernées est réajustée aussitôt. Réservé à la Direction / aux gestionnaires
 * ayant accès à l'enveloppe — et, en cas de ré-imputation, à l'enveloppe CIBLE.
 * (Les dépenses réelles, elles, se modifient dans les Finances.)
 */
export async function updateBudgetExpense(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const line = await prisma.budgetExpenseLine.findUnique({
    where: { id },
    select: { id: true, reference: true, categoryId: true, category: { select: { name: true, envelope: { select: { accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true, domaine: true } } } } },
  });
  if (!line) return { ok: false, error: "Ligne introuvable." };
  // Droit sur l'enveloppe ACTUELLE de la ligne.
  const env = line.category.envelope;
  const allowed = canManageEnvelope(user, env) || ((hasGlobalView(user.role) || userCan(user, "BUDGETS", "UPDATE")) && canViewEnvelope(user, env));
  if (!allowed) return { ok: false, error: "Cette enveloppe ne vous est pas ouverte." };

  const reference = fdStr(formData, "reference"); // sert de libellé de la dépense
  const amount = fdNum(formData, "amount");
  if (!reference) return { ok: false, error: "Indiquez une référence." };
  if (amount == null || amount <= 0) return { ok: false, error: "Indiquez un montant positif." };
  const date = fdDate(formData, "date");

  // Ré-imputation éventuelle vers une autre (sous-)catégorie : on vérifie l'accès à la CIBLE.
  const targetCategoryId = fdStr(formData, "budgetCategoryId") || line.categoryId;
  let targetName = line.category.name;
  if (targetCategoryId !== line.categoryId) {
    const resolved = await resolveExpenseCategory(user, targetCategoryId);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    targetName = resolved.cat.name;
  }

  await prisma.budgetExpenseLine.update({
    where: { id },
    data: { reference: reference.slice(0, 160), amount, categoryId: targetCategoryId, ...(date ? { date } : {}) },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Budgets", entityId: id, summary: `Dépense budgétaire « ${reference.slice(0, 160)} » modifiée (imputée à « ${targetName} »)` });
  revalidatePath("/budgets");
  return { ok: true };
}

/**
 * Supprime une ligne de dépense purement budgétaire (BudgetExpenseLine) — la consommation
 * de la catégorie est réajustée aussitôt. Réservé à la Direction / aux gestionnaires ayant
 * accès à l'enveloppe. (Les dépenses réelles, elles, se suppriment dans les Finances.)
 */
export async function deleteBudgetExpense(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const line = await prisma.budgetExpenseLine.findUnique({
    where: { id },
    select: { id: true, reference: true, categoryId: true, category: { select: { name: true, envelope: { select: { accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true, domaine: true } } } } },
  });
  if (!line) return { ok: false, error: "Ligne introuvable." };
  const env = line.category.envelope;
  const allowed = canManageEnvelope(user, env) || ((hasGlobalView(user.role) || userCan(user, "BUDGETS", "UPDATE")) && canViewEnvelope(user, env));
  if (!allowed) return { ok: false, error: "Cette enveloppe ne vous est pas ouverte." };
  await prisma.budgetExpenseLine.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Budgets", entityId: id, summary: `Dépense budgétaire « ${line.reference} » retirée de « ${line.category.name} »` });
  revalidatePath("/budgets");
  return { ok: true };
}
