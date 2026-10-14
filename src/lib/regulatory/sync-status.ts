import type { RegulatoryStatus, UserRole } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyRoles } from "@/lib/notify";
import { getAppSettings } from "@/lib/settings";
import { synchroniserCycleDeVie } from "@/lib/products/canonique";
import { deriveStatus } from "@/lib/regulatory/process-status";
import type { RegWorkflowState } from "@/lib/regulatory-workflow";

/**
 * Module SERVEUR ordinaire (pas `"use server"`) : ces fonctions ne sont pas des actions — exportées
 * d'un fichier d'actions, elles deviendraient appelables depuis le navigateur. Elles vivaient dans
 * `regulatory-actions.ts` ; le règlement d'un BV par les Finances (`settleExpenseOrder`, qui coche
 * « Paiement du BV ») doit lui aussi faire suivre le niveau de process, par le MÊME écrivain.
 */

/** Rôles superviseurs Regulatory = Super Admin (toujours) + rôles configurés en Administration. */
export async function regSupervisorRoles(): Promise<UserRole[]> {
  const settings = await getAppSettings();
  return Array.from(new Set(["SUPER_ADMIN", ...settings.regulatorySupervisorRoles])) as UserRole[];
}

/**
 * LE NIVEAU DE PROCESS SUIT LES ÉTAPES — automatiquement, à chaque coche.
 *
 * Le menu déroulant « Niveau de process » a disparu de l'écran : la valeur se DÉDUIT du travail
 * réellement coché (`lib/regulatory/process-status.ts`). Cette fonction est le seul endroit qui
 * l'écrit ; toute action qui touche au processus l'appelle juste après.
 *
 * Elle n'écrit QUE si le niveau change, et laisse une trace nommée : « déposé » apparu tout seul
 * dans un tableau, sans ligne d'audit, se lirait comme une anomalie.
 */
export async function syncStatusFromWorkflow(
  productId: string,
  wf: RegWorkflowState,
  current: string,
  reference: string,
  actorId: string,
): Promise<string> {
  const d = deriveStatus(wf, current);
  if (!d.changed) return current;

  const maj = await prisma.regulatoryProduct.update({
    where: { id: productId },
    data: { status: d.status as RegulatoryStatus, updatedById: actorId },
    select: { productId: true },
  });
  await recordAudit({
    actorId, action: "UPDATE", module: "Regulatory",
    entityType: "REGULATORY_PRODUCT", entityId: productId,
    field: "status", oldValue: current, newValue: d.status,
    summary: `Niveau de process de ${reference} → ${d.status} (déduit du processus d'enregistrement)`,
  });
  // Le CYCLE DE VIE du produit canonique suit ce que ses dossiers prouvent : une décision obtenue
  // l'enregistre (§118.178). C'est le seul écrivain du niveau de process, donc le seul endroit
  // où le cycle de vie peut prendre du retard.
  if (maj.productId) await synchroniserCycleDeVie(maj.productId);

  // Dépôt effectué : la supervision doit fixer la date cible d'enregistrement. Le message
  // partait déjà quand le niveau se posait à la main — il ne doit pas se perdre maintenant
  // qu'il se déduit.
  if (d.status === "SUBMITTED" && current !== "SUBMITTED") {
    await notifyRoles(await regSupervisorRoles(), {
      type: "GENERIC",
      title: "Dossier déposé — fixer la date cible d'enregistrement",
      body: `${reference} vient d'être déposé à l'ANPP.`,
      link: `/regulatory/${productId}`,
    });
  }
  revalidatePath("/regulatory");
  return d.status;
}
