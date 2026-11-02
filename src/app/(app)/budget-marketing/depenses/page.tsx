import { requireModule } from "@/lib/session";
import { VueDepensesBudget, CONFIG_BUDGET_MARKETING, type ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

/** BUDGET MARKETING — imputer les dépenses aux catégories des enveloppes marketing, en ajouter, corriger. */
export default async function BudgetMarketingDepensesPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_MARKETING");
  return <VueDepensesBudget user={user} searchParams={searchParams} config={CONFIG_BUDGET_MARKETING} />;
}
