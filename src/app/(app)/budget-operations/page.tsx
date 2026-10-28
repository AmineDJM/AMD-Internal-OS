import { requireModule } from "@/lib/session";
import { assurerEnveloppeAnnuelle } from "@/lib/budget/enveloppes-pole";
import { VueEnsembleBudget, CONFIG_BUDGET_OPERATIONS, type ParamsBudget } from "../budgets/vues-budget";

export const dynamic = "force-dynamic";

/** BUDGET OPERATIONS & SALES — VUE D'ENSEMBLE (Direction, 08/10). Les écrans de Budgets, bornés aux enveloppes du pôle. */
export default async function BudgetOperationsPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_OPERATIONS");
  // L'enveloppe de l'année existe d'emblée, masse salariale en tête (Direction, 10/2026) : rien à créer avant de saisir.
  await assurerEnveloppeAnnuelle("OPERATIONS", user);
  return <VueEnsembleBudget user={user} searchParams={searchParams} config={CONFIG_BUDGET_OPERATIONS} />;
}