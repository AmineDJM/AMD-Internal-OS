"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdDate, fdNum, type ActionResult } from "@/lib/actions/types";
import { MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";

const PATH = "/medical";

function isPlanManager(user: SessionUser): boolean {
  return hasGlobalView(user.role) || user.role === "MEDICAL_PROMOTION_MANAGER";
}

/** Le délégué gère SES plans ; le manager / la Direction gèrent tous les plans. */
function canManagePlan(user: SessionUser, plan: { delegateId: string | null }): boolean {
  return isPlanManager(user) || plan.delegateId === user.id;
}

/** Crée un plan de tournée (période + cibles). Le délégué le crée pour lui-même. */
export async function createDelegatePlan(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Création non autorisée." };

  const weekStart = fdDate(formData, "weekStart");
  if (!weekStart) return { ok: false, error: "La date de début de période est obligatoire." };

  // Le manager peut assigner un délégué ; sinon le plan est pour l'utilisateur courant.
  const delegateId = (isPlanManager(user) ? fdStr(formData, "delegateId") : null) ?? user.id;

  const plan = await prisma.medicalDelegatePlan.create({
    data: {
      delegateId,
      weekStart,
      region: fdStr(formData, "region"),
      productTarget: fdStr(formData, "productTarget"),
      visitsTarget: fdNum(formData, "visitsTarget") ?? 0,
      keyDoctorsTarget: fdNum(formData, "keyDoctorsTarget") ?? 0,
      managerComment: isPlanManager(user) ? fdStr(formData, "managerComment") : null,
      createdById: user.id,
      updatedById: user.id,
    },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE_AUDIT_VISITE, entityType: "DELEGATE_PLAN", entityId: plan.id, summary: "Plan de tournée créé" });
  revalidatePath(PATH);
  return { ok: true };
}

/** Modifie un plan (cibles, région, période, commentaire manager). */
export async function updateDelegatePlan(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Plan introuvable." };
  const plan = await prisma.medicalDelegatePlan.findUnique({ where: { id }, select: { delegateId: true } });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (!(canManagePlan(user, plan) && userCan(user, "MEDICAL", "UPDATE"))) return { ok: false, error: "Modification non autorisée." };

  const weekStart = fdDate(formData, "weekStart");
  await prisma.medicalDelegatePlan.update({
    where: { id },
    data: {
      ...(weekStart ? { weekStart } : {}),
      region: fdStr(formData, "region"),
      productTarget: fdStr(formData, "productTarget"),
      visitsTarget: fdNum(formData, "visitsTarget") ?? 0,
      keyDoctorsTarget: fdNum(formData, "keyDoctorsTarget") ?? 0,
      achievedVisits: fdNum(formData, "achievedVisits") ?? undefined,
      ...(isPlanManager(user) ? { managerComment: fdStr(formData, "managerComment") } : {}),
      updatedById: user.id,
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE, entityType: "DELEGATE_PLAN", entityId: id, summary: "Plan de tournée modifié" });
  revalidatePath(PATH);
  return { ok: true };
}

/** Supprime un plan (propriétaire ou manager). */
export async function deleteDelegatePlan(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Plan introuvable." };
  const plan = await prisma.medicalDelegatePlan.findUnique({ where: { id }, select: { delegateId: true } });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (!(canManagePlan(user, plan) && userCan(user, "MEDICAL", "DELETE"))) return { ok: false, error: "Suppression non autorisée." };

  await prisma.medicalDelegatePlan.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: MODULE_AUDIT_VISITE, entityType: "DELEGATE_PLAN", entityId: id, summary: "Plan de tournée supprimé" });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Duplique un plan vers une nouvelle période (mensuel ou date choisie). Reprend
 * région / cibles / produit ; remet l'avancement à zéro. Idéal pour rejouer un
 * plan d'un mois sur l'autre puis l'ajuster.
 */
export async function duplicateDelegatePlan(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Plan introuvable." };
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Duplication non autorisée." };

  const src = await prisma.medicalDelegatePlan.findUnique({ where: { id } });
  if (!src) return { ok: false, error: "Plan introuvable." };
  if (!canManagePlan(user, src)) return { ok: false, error: "Duplication non autorisée." };

  // Nouvelle date : choisie par l'utilisateur, sinon le mois suivant par défaut.
  let weekStart = fdDate(formData, "weekStart");
  if (!weekStart) {
    weekStart = new Date(src.weekStart);
    weekStart.setMonth(weekStart.getMonth() + 1);
  }

  const copy = await prisma.medicalDelegatePlan.create({
    data: {
      delegateId: src.delegateId,
      weekStart,
      region: src.region,
      productTarget: src.productTarget,
      visitsTarget: src.visitsTarget,
      keyDoctorsTarget: src.keyDoctorsTarget,
      achievedVisits: 0,
      managerComment: null,
      createdById: user.id,
      updatedById: user.id,
    },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE_AUDIT_VISITE, entityType: "DELEGATE_PLAN", entityId: copy.id, summary: "Plan de tournée dupliqué" });
  revalidatePath(PATH);
  return { ok: true };
}
