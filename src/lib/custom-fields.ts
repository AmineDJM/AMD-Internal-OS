import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/** Entity types that support admin-defined custom fields. */
export const CUSTOM_ENTITY_TYPES: EntityType[] = [
  "REGULATORY_PRODUCT", "SPONSORING", "BUDGET", "CONGRESS_INTERNATIONAL",
  "CONGRESS_NATIONAL", "SALE", "LOGISTICS", "DOCTOR", "VISIT", "BD_OPPORTUNITY",
  "FINANCE_TRANSACTION", "EMPLOYEE", "LEAVE_REQUEST", "TASK", "SALARY_ADVANCE", "EXPENSE_ORDER", "DRIVE_NODE", "ADMIN_REQUEST",
];

export type CustomValues = Record<string, unknown>;

// La lecture des valeurs FILE est PURE et partagée avec les composants client — elle vit dans
// `custom-field-values.ts` (aucun import) et se RÉEXPORTE ici pour le code serveur.
export { fileCustomValue } from "./custom-field-values";
import { fileCustomValue } from "./custom-field-values";

export function getFieldDefs(entityType: EntityType) {
  return prisma.customFieldDef.findMany({
    where: { entityType, active: true },
    orderBy: { order: "asc" },
  });
}

/**
 * Les champs OBLIGATOIRES encore vides — la règle PURE, partagée par l'action serveur
 * (refus avec la liste) et testable sans base. Un Oui/Non n'est jamais « manquant » :
 * une case décochée est une réponse, pas une absence.
 */
export function missingRequiredValues(
  defs: { key: string; label: string; type: string; required?: boolean }[],
  values: CustomValues,
): string[] {
  const missing: string[] = [];
  for (const def of defs) {
    if (!def.required || def.type === "BOOLEAN") continue;
    const v = values[def.key];
    // FICHIER : rempli = une référence Drive valide, pas n'importe quel objet.
    if (def.type === "FILE") {
      if (!fileCustomValue(v)) missing.push(def.label);
      continue;
    }
    if (v === null || v === undefined || String(v).trim() === "") missing.push(def.label);
  }
  return missing;
}

/** Read the `custom` JSON blob for a record. */
export async function readCustomValues(entityType: EntityType, id: string): Promise<CustomValues> {
  const select = { custom: true } as const;
  let row: { custom: Prisma.JsonValue } | null = null;
  switch (entityType) {
    case "REGULATORY_PRODUCT": row = await prisma.regulatoryProduct.findUnique({ where: { id }, select }); break;
    case "SPONSORING": row = await prisma.sponsoringRequest.findUnique({ where: { id }, select }); break;
    case "BUDGET": row = await prisma.budgetLine.findUnique({ where: { id }, select }); break;
    case "CONGRESS_INTERNATIONAL": row = await prisma.congressInternational.findUnique({ where: { id }, select }); break;
    case "CONGRESS_NATIONAL": row = await prisma.congressNational.findUnique({ where: { id }, select }); break;
    case "SALE": row = await prisma.sale.findUnique({ where: { id }, select }); break;
    case "LOGISTICS": row = await prisma.logisticsOrder.findUnique({ where: { id }, select }); break;
    case "DOCTOR": row = await prisma.medicalDoctor.findUnique({ where: { id }, select }); break;
    case "VISIT": row = await prisma.medicalVisit.findUnique({ where: { id }, select }); break;
    case "BD_OPPORTUNITY": row = await prisma.businessDevelopmentOpportunity.findUnique({ where: { id }, select }); break;
    case "FINANCE_TRANSACTION": row = await prisma.financeTransaction.findUnique({ where: { id }, select }); break;
    case "EMPLOYEE": row = await prisma.employee.findUnique({ where: { id }, select }); break;
    case "LEAVE_REQUEST": row = await prisma.leaveRequest.findUnique({ where: { id }, select }); break;
    case "TASK": row = await prisma.task.findUnique({ where: { id }, select }); break;
    case "SALARY_ADVANCE": row = await prisma.salaryAdvance.findUnique({ where: { id }, select }); break;
    case "EXPENSE_ORDER": row = await prisma.expenseOrder.findUnique({ where: { id }, select }); break;
    case "DRIVE_NODE": row = await prisma.driveNode.findUnique({ where: { id }, select }); break;
    case "ADMIN_REQUEST": row = await prisma.administrativeRequest.findUnique({ where: { id }, select }); break;
    default: return {};
  }
  return (row?.custom as CustomValues) ?? {};
}

/** Persist the `custom` JSON blob for a record. */
export async function writeCustomValues(entityType: EntityType, id: string, custom: CustomValues): Promise<void> {
  const data = { custom: custom as Prisma.InputJsonValue };
  switch (entityType) {
    case "REGULATORY_PRODUCT": await prisma.regulatoryProduct.update({ where: { id }, data }); break;
    case "SPONSORING": await prisma.sponsoringRequest.update({ where: { id }, data }); break;
    case "BUDGET": await prisma.budgetLine.update({ where: { id }, data }); break;
    case "CONGRESS_INTERNATIONAL": await prisma.congressInternational.update({ where: { id }, data }); break;
    case "CONGRESS_NATIONAL": await prisma.congressNational.update({ where: { id }, data }); break;
    case "SALE": await prisma.sale.update({ where: { id }, data }); break;
    case "LOGISTICS": await prisma.logisticsOrder.update({ where: { id }, data }); break;
    case "DOCTOR": await prisma.medicalDoctor.update({ where: { id }, data }); break;
    case "VISIT": await prisma.medicalVisit.update({ where: { id }, data }); break;
    case "BD_OPPORTUNITY": await prisma.businessDevelopmentOpportunity.update({ where: { id }, data }); break;
    case "FINANCE_TRANSACTION": await prisma.financeTransaction.update({ where: { id }, data }); break;
    case "EMPLOYEE": await prisma.employee.update({ where: { id }, data }); break;
    case "LEAVE_REQUEST": await prisma.leaveRequest.update({ where: { id }, data }); break;
    case "TASK": await prisma.task.update({ where: { id }, data }); break;
    case "SALARY_ADVANCE": await prisma.salaryAdvance.update({ where: { id }, data }); break;
    case "EXPENSE_ORDER": await prisma.expenseOrder.update({ where: { id }, data }); break;
    case "DRIVE_NODE": await prisma.driveNode.update({ where: { id }, data }); break;
    case "ADMIN_REQUEST": await prisma.administrativeRequest.update({ where: { id }, data }); break;
  }
}

/** Render a stored value for display. */
export function formatCustomValue(type: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "FILE") return fileCustomValue(value)?.name ?? "—";
  if (type === "BOOLEAN") return value ? "Oui" : "Non";
  if (type === "DATE") {
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString("fr-FR");
  }
  return String(value);
}
