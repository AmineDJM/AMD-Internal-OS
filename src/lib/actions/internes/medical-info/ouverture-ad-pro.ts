import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasRole, type SessionUser } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { canAccessEntity } from "@/lib/entity-access";
import { createMedicalInfoDeclaration } from "@/lib/medical-info";
import { EVENT_SOURCES } from "@/lib/medical-info/circuits";
import { loadEntity } from "@/lib/workflow/engine/entites";
import type { ActionResult } from "@/lib/actions/types";
import { canManage } from "./acces";

/** Qui tient l'étape « Déclaration (information scientifique) » sur une demande Ad & Pro : le pharmacien, et le Super Admin. */
export function tientLaDeclarationAdPro(user: SessionUser): boolean {
  return (hasRole(user, "MEDICAL_INFO_PHARMACIST") || hasRole(user, "SUPER_ADMIN")) && canManage(user);
}

/**
 * OUVRIR LA DÉCLARATION D'UNE DEMANDE AD & PRO QUI N'EN A PAS (Direction, 08/11/2026).
 *
 * La déclaration naît d'ordinaire à la pré-validation, et seulement si un pharmacien est configuré. Une demande accordée
 * avant — ou sous l'ancienne règle du montant global — n'en a donc aucune, et l'étape de la frise resterait vide pour
 * toujours. Le pharmacien l'ouvre d'ici.
 *
 * SANS ARGENT : la déclaration naît SANS montant, et rattachée à l'ordre de dépense déjà émis pour la demande s'il y en a
 * un. Sa validation finale n'émet donc jamais d'ordre (`ordreGlobalALaValidation`) : la demande a déjà été payée par son
 * propre chemin, et un second ordre la paierait deux fois. Idempotent : une déclaration existante est rendue telle quelle.
 */
export async function ouvrirDeclarationAdPro(
  user: SessionUser, sourceType: string, sourceId: string,
): Promise<ActionResult & { id?: string }> {
  if (!tientLaDeclarationAdPro(user)) return { ok: false, error: "Réservé au pharmacien responsable de l'information médicale." };
  if (!EVENT_SOURCES.includes(sourceType)) {
    return { ok: false, error: "Cette demande ne se déclare pas ici : le matériel promotionnel a son propre circuit, avec ses bons de versement." };
  }
  const type = sourceType as EntityType;
  if (!sourceId || !(await canAccessEntity(user, type, sourceId, "VIEW"))) return { ok: false, error: "Demande introuvable, ou hors de votre accès." };

  const existante = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: type, sourceId } }, select: { id: true },
  });
  if (existante) return { ok: true, id: existante.id };

  // L'ÉVÉNEMENT SE DÉCLARE UNE FOIS DÉCIDÉ : la pré-validation (ou l'ancien accord) a conclu le circuit.
  const circuit = await prisma.workflowInstance.findFirst({ where: { entityType: type, entityId: sourceId }, select: { status: true } });
  // Une demande d'avant les circuits n'a pas d'instance : elle n'est pas refusée pour autant.
  if (circuit && circuit.status !== "APPROVED") {
    return { ok: false, error: "La déclaration s'ouvre une fois la demande pré-validée : son circuit n'est pas encore conclu." };
  }
  const resume = await loadEntity(type, sourceId);
  if (!resume) return { ok: false, error: "Demande introuvable." };

  const decl = await createMedicalInfoDeclaration({
    sourceType: type, sourceId, label: resume.label, beneficiary: resume.beneficiary, amount: null, requesterId: resume.requesterId,
  });
  const ordre = await prisma.expenseOrder.findFirst({ where: { sourceType: type, sourceId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (ordre) {
    await prisma.medicalInfoDeclaration.updateMany({ where: { id: decl.id, expenseOrderId: null }, data: { expenseOrderId: ordre.id } });
  }
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Information médicale", entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id,
    summary: `Déclaration ${decl.reference} ouverte depuis la demande Ad & Pro (étape « Déclaration (information scientifique) »)`,
  });
  return { ok: true, id: decl.id };
}
