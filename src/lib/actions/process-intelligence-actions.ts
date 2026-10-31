"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { actionReversible } from "@/lib/effets/reversible";

/**
 * « Régler » — LE DÉLAI CIBLE D'UNE ÉTAPE DE CIRCUIT (Process Intelligence). Au-delà, le dossier compte parmi les
 * « en cours bloqués » et Adventum Brain le signale. Un délai vide RETIRE la cible (retour à la limite par défaut).
 * Super Admin seul, journalisé.
 */
export async function reglerDelaiEtape(formData: FormData): Promise<ActionResult> {
  return actionReversible("process-intelligence-actions:reglerDelaiEtape", "Délai cible d'une étape de circuit", async () => {
    const user = await requireUser();
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
    const circuit = fdStr(formData, "circuit");
    const stepKey = fdStr(formData, "stepKey");
    const stepLabel = fdStr(formData, "stepLabel") ?? stepKey;
    const jours = fdNum(formData, "targetDays");
    if (!circuit || !stepKey || !stepLabel) return { ok: false, error: "Étape inconnue." };

    if (jours === null) {
      await prisma.processStepSla.deleteMany({ where: { circuit, stepKey } });
      await recordAudit({ actorId: user.id, action: "UPDATE", module: "Process Intelligence", summary: `Délai cible retiré : ${stepLabel} (${circuit})` });
    } else {
      const targetDays = Math.round(jours);
      if (targetDays < 1 || targetDays > 365) return { ok: false, error: "Entre 1 et 365 jours." };
      await prisma.processStepSla.upsert({
        where: { circuit_stepKey: { circuit, stepKey } },
        create: { circuit, stepKey, stepLabel, targetDays, updatedById: user.id },
        update: { stepLabel, targetDays, updatedById: user.id },
      });
      await recordAudit({ actorId: user.id, action: "UPDATE", module: "Process Intelligence", summary: `Délai cible : ${stepLabel} — ${targetDays} j (${circuit})` });
    }
    revalidatePath("/process-intelligence");
    return { ok: true };
  });
}
