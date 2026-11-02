import { cookies } from "next/headers";

/**
 * L'ENVELOPPE BUDGÉTAIRE CHOISIE, MÉMORISÉE.
 *
 * L'enveloppe vivait uniquement dans l'URL (`?env=…`). Elle se perdait donc dès qu'on
 * naviguait autrement : en passant de « Vue d'ensemble » à « Dépenses » (les onglets pointent
 * en dur, sans le paramètre), en cliquant « Budgets » dans le menu, ou en rouvrant
 * l'application. À chaque fois on retombait sur la première enveloppe de la liste — « Masse
 * salariale » — alors qu'on travaillait sur Ad & Pro.
 *
 * Le choix est donc retenu dans un cookie, comme la portée d'entité. L'URL reste prioritaire :
 * un lien partagé continue d'ouvrir l'enveloppe qu'il désigne.
 */

export const BUDGET_COOKIE = "amd-budget-env";

/**
 * La dernière enveloppe consultée. Défensif : hors contexte de requête (tests, tâches
 * planifiées), renvoie `null` — l'appelant retombera sur son défaut habituel.
 */
export async function getBudgetScope(): Promise<string | null> {
  try {
    return (await cookies()).get(BUDGET_COOKIE)?.value || null;
  } catch {
    return null;
  }
}

/**
 * L'enveloppe à afficher : ce que demande l'URL, sinon la dernière consultée.
 *
 * L'URL d'abord, toujours : un lien envoyé à un collègue doit ouvrir CETTE enveloppe, pas la
 * dernière que le destinataire a regardée.
 */
export async function resolveBudgetEnvelope(fromUrl: string | undefined): Promise<string | null> {
  return fromUrl || (await getBudgetScope());
}
