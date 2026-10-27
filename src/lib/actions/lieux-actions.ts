"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/lib/actions/types";

/**
 * L'INTERRUPTEUR DE LA DOUBLE ÉCRITURE DES LIEUX (refonte V2-D) — `AppSetting.lieuxDoubleEcriture`.
 *
 * Allumé (défaut) : chaque saisie d'une wilaya / ville sur une fiche pose aussi `wilayaCode`. Éteint : seul le
 * texte est écrit, comme avant la refonte — le geste de repli si la lecture du lieu se trompait en production.
 * Rien n'est effacé dans un sens ni dans l'autre ; la reprise « lieux-wilaya » remet les codes en accord.
 * Super Admin seul, journalisé.
 */
export async function reglerDoubleEcritureLieux(actif: boolean): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const avant = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { lieuxDoubleEcriture: true } });
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", lieuxDoubleEcriture: actif },
    update: { lieuxDoubleEcriture: actif },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Refonte des données", field: "lieuxDoubleEcriture",
    oldValue: String(avant?.lieuxDoubleEcriture ?? true), newValue: String(actif),
    summary: `Double écriture des lieux ${actif ? "allumée" : "éteinte"}`,
  });
  revalidatePath("/admin/refonte-donnees");
  return { ok: true, message: actif ? "Double écriture des lieux allumée." : "Double écriture des lieux éteinte." };
}
