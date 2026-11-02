import { requireModule } from "@/lib/session";
import { VueEnsembleBudget, CONFIG_BUDGETS, type ParamsBudget } from "./vues-budget";

export const dynamic = "force-dynamic";

/**
 * BUDGETS — VUE D'ENSEMBLE. Un seul écran, une seule question : **où en est le budget ?**
 *
 * Tout ce qui « fait » (imputer, saisir, créer une catégorie, régler l'enveloppe) est parti
 * dans les onglets Dépenses et Réglages. Il ne reste ici que de la lecture : un chiffre
 * dominant, une jauge, un camembert, une courbe, des barres. L'écran est partagé avec Budget
 * Marketing (`vues-budget.tsx`) : ici, toutes les enveloppes visibles, marketing comprises.
 */
export default async function BudgetsPage(props: { searchParams: Promise<ParamsBudget> }) {
 const searchParams = await props.searchParams;
 const user = await requireModule("BUDGETS");
 return <VueEnsembleBudget user={user} searchParams={searchParams} config={CONFIG_BUDGETS} />;
}
