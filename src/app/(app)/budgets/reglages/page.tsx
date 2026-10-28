import { requireModule } from "@/lib/session";
import { VueReglagesBudget, CONFIG_BUDGETS, type ParamsBudget } from "../vues-budget";

export const dynamic = "force-dynamic";

/** BUDGETS — écran de paramétrage : l'enveloppe, ses catégories, le budget total. */
export default async function BudgetSettingsPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGETS");
  return <VueReglagesBudget user={user} searchParams={searchParams} config={CONFIG_BUDGETS} />;
}
