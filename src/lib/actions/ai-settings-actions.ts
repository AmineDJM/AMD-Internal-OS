"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdBool, fdNum, type ActionResult } from "@/lib/actions/types";

const estSuperAdmin = (u: Awaited<ReturnType<typeof requireUser>>) => userCan(u, "ADMIN", "UPDATE") && u.role === "SUPER_ADMIN";
const REFUS_SUPER_ADMIN: ActionResult = { ok: false, error: "Réservé au Super Admin." };

/**
 * Centre de contrôle IA — enregistre les bascules d'activation (Super Admin).
 * Aucune clé n'est stockée ni modifiée ici : les secrets restent dans
 * l'environnement (Render). On ne gère que l'activation par fonction.
 */
export async function updateAiSettings(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!estSuperAdmin(admin)) return REFUS_SUPER_ADMIN;

  const data = {
    masterEnabled: fdBool(formData, "masterEnabled"),
    assistantEnabled: fdBool(formData, "assistantEnabled"),
    proactiveNudgesEnabled: fdBool(formData, "proactiveNudgesEnabled"),
    brainEnabled: fdBool(formData, "brainEnabled"),
    processIntelEnabled: fdBool(formData, "processIntelEnabled"),
    fieldReportAiEnabled: fdBool(formData, "fieldReportAiEnabled"),
    voiceTranscriptEnabled: fdBool(formData, "voiceTranscriptEnabled"),
    siteWebAiEnabled: fdBool(formData, "siteWebAiEnabled"),
    lecturePiecesEnabled: fdBool(formData, "lecturePiecesEnabled"),
    conseilPiecesEnabled: fdBool(formData, "conseilPiecesEnabled"),
    ocrVisionEnabled: fdBool(formData, "ocrVisionEnabled"),
    updatedById: admin.id,
  };
  // Le plafond MENSUEL de l'OCR vision (décision 0019) : seulement s'il est envoyé — une bascule rejouée ailleurs
  // (l'op d'Adam) ne le remet pas à zéro.
  const plafond = formData.has("ocrVisionPlafondUsd") ? fdNum(formData, "ocrVisionPlafondUsd") : null;
  if (formData.has("ocrVisionPlafondUsd") && (plafond === null || !Number.isFinite(plafond) || plafond < 0 || plafond > 10_000)) {
    return { ok: false, error: "Plafond mensuel de l'OCR vision : un montant en dollars entre 0 et 10 000." };
  }
  const donnees = plafond === null ? data : { ...data, ocrVisionPlafondUsd: Math.round(plafond * 100) / 100 };

  await prisma.aiSetting.upsert({
    where: { id: "global" },
    create: { id: "global", ...donnees },
    update: donnees,
  });

  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA",
    summary: data.masterEnabled
      ? "Mise à jour des activations IA"
      : "IA coupée globalement (interrupteur général)",
  });
  revalidatePath("/admin/ai");
  return { ok: true };
}

