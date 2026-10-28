"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdBool, type ActionResult } from "@/lib/actions/types";
import { normaliserReglages } from "@/lib/agent/consommation-regles";

/**
 * LES BORNES DE L'ASSISTANT IA — enregistrées par le Super Admin (Administration › Consommation IA,
 * lot V3-D). Plafonds de jetons (par personne et par jour, par tour), étapes d'un tour, et les
 * décisions de Direction du rapport 06 (filtre de la saisie, retrait des cartes caduques, expiration
 * des cartes). Une valeur hors bornes est RAMENÉE dans les bornes (`normaliserReglages`) — l'écran
 * relit et affiche ce qui a été réellement enregistré.
 */
export async function enregistrerReglagesAssistantIa(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") {
    return { ok: false, error: "Réservé au Super Admin." };
  }
  const r = normaliserReglages({
    plafondJetonsJour: formData.get("plafondJetonsJour"),
    plafondJetonsTour: formData.get("plafondJetonsTour"),
    etapesMaxTour: formData.get("etapesMaxTour"),
    expirationCartesHeures: formData.get("expirationCartesHeures"),
    censurerSaisie: fdBool(formData, "censurerSaisie"),
    retirerCartesCaduques: fdBool(formData, "retirerCartesCaduques"),
  });
  const data = { ...r, updatedById: admin.id };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA",
    summary: `Bornes de l'Assistant IA : ${r.plafondJetonsJour} jetons/jour/personne, ${r.plafondJetonsTour} par tour, ${r.etapesMaxTour} étapes`
      + `${r.censurerSaisie ? "" : " — filtre de la saisie COUPÉ"}${r.retirerCartesCaduques ? "" : " — retrait des cartes caduques COUPÉ"}`,
  });
  revalidatePath("/admin/ai/consommation");
  return { ok: true };
}
