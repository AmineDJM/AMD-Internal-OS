import { requireModule } from "@/lib/session";
import { VueDepensesBudget, CONFIG_BUDGETS, type ParamsBudget } from "../vues-budget";

export const dynamic = "force-dynamic";

/** BUDGETS — écran de travail : imputer les dépenses, en ajouter, corriger. */
export default async function BudgetExpensesPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGETS");
  return <VueDepensesBudget user={user} searchParams={searchParams} config={CONFIG_BUDGETS} />;
}
