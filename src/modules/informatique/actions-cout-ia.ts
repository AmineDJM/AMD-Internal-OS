"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getMyCompanies } from "@/lib/company";
import { actionReversible } from "@/lib/effets/reversible";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { imputerCoutIaDuMois, libelleMois, lireMois, lireTaux, moisDe } from "@/modules/informatique/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * IMPUTER LE COÛT DE L'IA D'UN MOIS AU BUDGET INFORMATIQUE (Super Admin, 24/11/2026) — le geste de l'écran « Consommation IA ».
 *
 * La tâche de fond le refait seule chaque mois au DERNIER taux fixé ; ce geste fixe le taux USD → DZD et (re)calcule un mois,
 * pour les sociétés de la personne. Rejoué, il ne crée rien de plus (une imputation par société et par mois) ; un coût ou un
 * taux changé met à jour la même ligne de dépense budgétaire. Aucun ordre de paiement.
 *
 * DROITS : « Consommation IA » (`INFORMATIQUE_CONSOMMATION_IA`) en modification — le Super Admin et le responsable du
 * département Informatique, par défaut. RÉVERSIBLE : déclaration `metiers.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export async function imputerCoutIa(formData: FormData): Promise<ActionResult> {
  return actionReversible("informatique-cout-ia-actions:imputerCoutIa", "Coût de l'IA imputé", async () => {
    const user = await requireUser();
    if (!userCan(user, "INFORMATIQUE_CONSOMMATION_IA", "UPDATE")) return { ok: false, error: "Non autorisé : imputer le coût de l'IA demande le droit de modifier « Consommation IA »." };
    const mois = lireMois(fdStr(formData, "mois"));
    if (!mois) return { ok: false, error: "Mois illisible : choisissez un mois (AAAA-MM)." };
    if (mois > moisDe(new Date())) return { ok: false, error: "Ce mois n'est pas encore commencé : rien à imputer." };
    const taux = lireTaux(fdStr(formData, "taux"));
    if (taux === null) return { ok: false, error: "Fixez le taux USD → DZD du mois (un nombre positif, par exemple 135,5)." };
    const societes = (await getMyCompanies(user.id)).map((c) => c.id);
    if (societes.length === 0) return { ok: false, error: "Aucune société ne vous est ouverte : demandez l'accès au Super Admin." };
    const r = await imputerCoutIaDuMois({ mois, taux, acteurId: user.id, societes });
    revalidatePath("/informatique/consommation-ia");
    revalidatePath("/budgets");
    const ecrites = r.societes.filter((s) => s.geste === "CREER" || s.geste === "METTRE_A_JOUR");
    if (r.societes.length === 0) return { ok: true, message: `Aucune consommation à imputer pour ${libelleMois(mois)}.` };
    if (ecrites.length === 0) return { ok: true, message: `${libelleMois(mois)} : déjà imputé, rien n'a changé.` };
    const total = Math.round(ecrites.reduce((a, s) => a + s.montantDzd, 0) * 100) / 100;
    return { ok: true, message: `${libelleMois(mois)} imputé : ${total.toLocaleString("fr-FR")} DZD sur ${ecrites.length} budget(s) Informatique.` };
  });
}
