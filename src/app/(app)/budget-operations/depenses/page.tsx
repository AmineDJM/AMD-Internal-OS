import { requireModule } from "@/lib/session";
import { assurerEnveloppeAnnuelle } from "@/lib/budget/enveloppes-pole";
import { VueDepensesBudget, CONFIG_BUDGET_OPERATIONS, type ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

/** BUDGET OPERATIONS & SALES — imputer les dépenses aux catégories des enveloppes du pôle, en ajouter, corriger. */
export default async function BudgetOperationsDepensesPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_OPERATIONS");
  // L'enveloppe de l'année existe d'emblée, masse salariale en tête (Direction, 10/2026) : rien à créer avant de saisir.
  await assurerEnveloppeAnnuelle("OPERATIONS", user);
  return <VueDepensesBudget user={user} searchParams={searchParams} config={CONFIG_BUDGET_OPERATIONS} />;
}