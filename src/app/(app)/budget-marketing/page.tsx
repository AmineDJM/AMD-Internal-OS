import { requireModule } from "@/lib/session";
import { VueEnsembleBudget, CONFIG_BUDGET_MARKETING, type ParamsBudget } from "../budgets/vues-budget";

export const dynamic = "force-dynamic";

/**
 * BUDGET MARKETING — VUE D'ENSEMBLE (Direction, 08/10). Les écrans de Budgets, bornés aux enveloppes de la Direction
 * Marketing (Ad & Pro et les siennes). Mêmes lignes en base : Budgets les lit et les additionne comme avant.
 */
export default async function BudgetMarketingPage(props: { searchParams: Promise<ParamsBudget> }) {
 const searchParams = await props.searchParams;
 const user = await requireModule("BUDGET_MARKETING");
 return <VueEnsembleBudget user={user} searchParams={searchParams} config={CONFIG_BUDGET_MARKETING} />;
}
