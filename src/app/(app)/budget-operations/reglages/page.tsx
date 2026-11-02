import { requireModule } from "@/lib/session";
import { assurerEnveloppeAnnuelle } from "@/lib/budget/enveloppes-pole";
import { VueReglagesBudget, CONFIG_BUDGET_OPERATIONS, type ParamsBudget } from "../../budgets/vues-budget";

export const dynamic = "force-dynamic";

/** BUDGET OPERATIONS & SALES — créer une enveloppe, la régler, la répartir en catégories. */
export default async function BudgetOperationsReglagesPage(props: { searchParams: Promise<ParamsBudget> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_OPERATIONS");
  // L'enveloppe de l'année existe d'emblée, masse salariale en tête (Direction, 10/2026) : rien à créer avant de saisir.
  await assurerEnveloppeAnnuelle("OPERATIONS", user);
  return <VueReglagesBudget user={user} searchParams={searchParams} config={CONFIG_BUDGET_OPERATIONS} />;
}