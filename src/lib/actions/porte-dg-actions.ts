"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { fdStr, fdNum } from "@/lib/actions/types";
import { canAccessEntity } from "@/lib/entity-access";
import { statuerSurLeTotal } from "@/lib/ad-pro/porte-dg";
import { AD_PRO_PARENTS, PARENT_ENTITE, type AdProParent } from "@/lib/ad-pro-items";
import { CHEMIN_CENTRE_AD_PRO, lienDemandeAdPro } from "@/lib/chemins/ad-pro";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DG STATUE SUR LE TOTAL D'UNE DEMANDE Ad & Pro (Direction, 27/10/2026).
 *
 * « Valider le total » ou « Renvoyer en révision » (motif exigé), depuis la fiche de la demande ou le
 * centre de validation. La règle et l'écriture vivent dans `ad-pro/porte-dg.ts` ; ici, la porte de la
 * personne (session, visibilité de la demande) et la mise à jour des écrans. Le total affiché au DG
 * voyage avec le geste : s'il a changé entre-temps, on le dit au lieu de valider un montant non vu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function statuerTotalDg(formData: FormData): Promise<{ ok: boolean; error?: string; message?: string }> {
  const user = await requireUser();
  const parent = fdStr(formData, "parent");
  const parentId = fdStr(formData, "parentId");
  const decision = fdStr(formData, "decision");
  const totalVu = fdNum(formData, "totalVu");
  if (!parent || !(AD_PRO_PARENTS as readonly string[]).includes(parent) || !parentId) return { ok: false, error: "Demande non précisée." };
  if (decision !== "VALIDEE" && decision !== "A_REVOIR") return { ok: false, error: "Décision inconnue." };
  if (totalVu == null) return { ok: false, error: "Total non précisé : rouvrez la demande." };
  const p = parent as AdProParent;
  if (!(await canAccessEntity(user, PARENT_ENTITE[p], parentId, "VIEW"))) return { ok: false, error: "Demande introuvable." };
  const r = await statuerSurLeTotal({ user, parent: p, parentId, decision, totalVu, note: fdStr(formData, "note") });
  if (r.ok) {
    revalidatePath(lienDemandeAdPro(p, parentId));
    revalidatePath(CHEMIN_CENTRE_AD_PRO);
  }
  return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
}
