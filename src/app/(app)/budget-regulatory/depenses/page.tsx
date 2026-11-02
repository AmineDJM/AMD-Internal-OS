import { requireModule } from "@/lib/session";
import { VueDepensesBudget, CONFIG_BUDGET_REGULATORY, type ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

/** BUDGET REGULATORY — imputer les dépenses aux catégories des enveloppes du pôle, en ajouter, corriger. */
export default async function BudgetRegulatoryDepensesPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_REGULATORY");
  return <VueDepensesBudget user={user} searchParams={searchParams} config={CONFIG_BUDGET_REGULATORY} />;
}