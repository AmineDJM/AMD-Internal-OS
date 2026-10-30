import { userCan } from "@/lib/rbac";
import { getBudgetOverview, getEnvelopes, getEnvelopesGrandTotal } from "@/lib/queries/budget";
import type { PowerTool } from "@/platform/ia/outil";
import { disponible } from "@/lib/budget/marketing-vue";
import type { CurrentUser } from "@/lib/session";
import { dzd } from "../../domaine/operations/types";

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

/**
 * LIRE LE BUDGET (J6, décision 0020 — l'outil propre au module qui remplace l'emprunt à Adam) : la synthèse des
 * enveloppes que la personne voit, ou le détail d'une enveloppe désignée par un fragment de son nom — les chiffres
 * de l'écran Budgets (`queries/budget`), sous sa portée. Le module Budgets est la porte ; la famille « Budgets &
 * finances » de la console est rejugée par la garde du catalogue (`outils-v1.ts`).
 */
export function lectureBudget(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "read_budget",
      description: "Lit le BUDGET : sans `envelope`, la synthèse des enveloppes que je vois (total, alloué, consommé, restant) ; avec `envelope` (fragment du nom), "
        + "le détail de cette enveloppe par poste. Ne jamais inventer un montant : une enveloppe introuvable ou fermée se dit.",
      input_schema: { type: "object", properties: { envelope: { type: "string", description: "Fragment du nom de l'enveloppe ; vide = synthèse." } } },
    },
    allowed: (u) => u.id === user.id && userCan(u, "BUDGETS", "VIEW"),
    label: "Budget consulté",
    run: async (entree, u) => {
      if (!userCan(u, "BUDGETS", "VIEW")) return "Le module Budgets ne vous est pas ouvert.";
      const voulu = typeof entree.envelope === "string" ? entree.envelope.trim().toLowerCase() : "";
      const ouvertes = await getEnvelopes(u);
      if (!ouvertes.length) return "Aucune enveloppe budgétaire ne vous est ouverte.";
      if (!voulu) {
        const g = await getEnvelopesGrandTotal(u);
        return JSON.stringify({
          enveloppes: g.count, total: dzd(g.total), alloue: dzd(g.allocated), consomme: dzd(g.consumed), reste: dzd(g.remaining),
          detail: g.items.map((x) => ({ enveloppe: x.name, total: dzd(x.total), consomme: dzd(x.consumed), reste: dzd(x.remaining) })),
        });
      }
      const cible = ouvertes.find((x) => x.name.toLowerCase().includes(voulu));
      if (!cible) return `Aucune enveloppe « ${voulu} » parmi les vôtres : ${ouvertes.map((x) => x.name).join(", ")}.`;
      const vue = await getBudgetOverview(u, cible.id);
      if (!vue) return `L'enveloppe « ${cible.name} » ne vous est pas ouverte.`;
      const t = vue.totals;
      return JSON.stringify({
        enveloppe: vue.envelope.name, du: vue.period.from.slice(0, 10), au: vue.period.to.slice(0, 10),
        total: dzd(t.total), alloue: dzd(t.allocated), consomme: dzd(t.consumed), engage: dzd(t.committed), reste: dzd(t.remaining), tauxPct: t.pct,
        disponible: dzd(disponible(t.total, t.consumed, t.committed)),
        postes: vue.categories.filter((c) => !c.parentId).map((c) => ({ poste: c.name, alloue: dzd(c.allocated), consomme: dzd(c.consumed) })),
        nonImputees: { nombre: vue.unattributed.count, montant: dzd(vue.unattributed.total) },
      });
    },
  };
}
