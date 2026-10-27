import { userCan } from "@/lib/rbac";
import { getBudgetOverview } from "@/lib/queries/budget";
import { disponible } from "@/lib/budget/marketing-vue";
import type { CurrentUser } from "@/lib/session";
import { dzd } from "./types";

/**
 * LE BUDGET, AVANT DE REMPLIR — lu comme l'écran Budgets le lit, et seulement par qui l'y lit.
 *
 * Une demande Ad & Pro n'engage pas d'argent à sa création : la Direction accorde ensuite, poste
 * par poste. Le contrôle est donc un ÉCLAIRAGE, pas un barrage : le disponible de l'enveloppe la
 * plus récente QUE LA PERSONNE VOIT (`getBudgetOverview`, sa portée), et l'écart avec le montant.
 * Sans le module Budgets, aucun chiffre : la carte dit que la Direction arbitre — l'assistante
 * de direction, qui n'a pas « Budgets », n'apprend pas l'enveloppe par l'assistant (limite L1).
 */
export async function avertissementBudget(user: CurrentUser, montant: number | null): Promise<string> {
  if (!userCan(user, "BUDGETS", "VIEW")) return "Budget : la Direction arbitre à la validation (l'enveloppe ne se consulte pas avec vos accès).";
  try {
    const vue = await getBudgetOverview(user, null);
    if (!vue) return "Budget : aucune enveloppe ouverte à votre consultation.";
    const reste = disponible(vue.totals.total, vue.totals.consumed, vue.totals.committed);
    const nom = vue.envelope.name;
    if (montant != null && montant > reste) return `Budget : ${dzd(montant)} dépasse le disponible de l'enveloppe « ${nom} » (${dzd(reste)}) — la Direction devra arbitrer.`;
    return `Budget : disponible de l'enveloppe « ${nom} » : ${dzd(reste)}${montant != null ? ` (après cette demande : ${dzd(reste - montant)})` : ""}.`;
  } catch {
    return "Budget : enveloppe illisible pour l'instant — la Direction arbitre à la validation.";
  }
}
