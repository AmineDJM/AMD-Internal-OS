"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasGlobalView, userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { MODULE_EXAMEN } from "@/lib/factures/recensement";

/**
 * « À EXAMINER / EXAMINÉ » — le seul geste de l'écran des doublons de factures (Direction, 14/10/2026).
 *
 * Il ne corrige rien : il dit que les Finances ont regardé ce groupe, pièce en main. Aucune facture n'est annulée,
 * fusionnée ni déplacée — c'est une décision humaine qui se prend dans le module de chaque pièce. La trace va au
 * journal d'audit (pas de migration) ; la dernière entrée d'un groupe fait foi.
 *
 * Réservé à qui peut MODIFIER les Finances (ou la vue globale) : lire l'écran ne suffit pas pour dire « examiné ».
 */
export async function marquerExamenDoublon(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE") && !hasGlobalView(user.role)) return { ok: false, error: "Seules les Finances marquent un groupe examiné." };
  const signature = fdStr(formData, "signature");
  if (!signature || !/^[0-9a-f]{24}$/.test(signature)) return { ok: false, error: "Groupe introuvable." };
  const examine = fdStr(formData, "examine") !== "0";
  const note = (fdStr(formData, "note") ?? "").slice(0, 300);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_EXAMEN, entityId: signature, field: "examen",
    newValue: examine ? "EXAMINE" : "A_EXAMINER",
    summary: `${examine ? "Groupe de doublons examiné" : "Groupe de doublons remis à examiner"}${note ? ` — ${note}` : ""}`,
  });
  revalidatePath("/finances/doublons-factures");
  return { ok: true, message: examine ? "Groupe marqué examiné." : "Groupe remis à examiner." };
}
