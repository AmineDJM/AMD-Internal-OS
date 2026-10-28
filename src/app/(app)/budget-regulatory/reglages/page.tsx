import { requireModule } from "@/lib/session";
import { VueReglagesBudget, CONFIG_BUDGET_REGULATORY, type ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

/** BUDGET REGULATORY — créer une enveloppe, la régler, la répartir en catégories. */
export default async function BudgetRegulatoryReglagesPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_REGULATORY");
  return <VueReglagesBudget user={user} searchParams={searchParams} config={CONFIG_BUDGET_REGULATORY} />;
}