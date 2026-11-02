import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { STOCK_PROMO_TABS } from "@/lib/labels";
import { chargerPageStock } from "@/lib/queries/promo-stock";
import { StockEcran } from "./stock-ecran";

export const dynamic = "force-dynamic";

/**
 * STOCK DU MATÉRIEL PROMOTIONNEL (§118.164) — un module à part du circuit d'achat.
 *
 * Le circuit d'achat répond à « où en est la commande ? » ; cet écran à « qu'avons-nous, où, et
 * qu'est-ce qui est en route ? ». Il est gardé par SON module (`PROMO_STOCK`) : le directeur des
 * opérations y gère le matériel de ses équipes sans instruire d'achat, un délégué y tient son
 * stock sans voir les dossiers des autres.
 *
 * Une quantité n'est jamais lue dans un champ : elle se CALCULE à partir des mouvements, en base,
 * par la même somme que celle qui garde les sorties. Le chiffre affiché et le chiffre qui autorise
 * une dotation ne peuvent donc pas diverger.
 */
export default async function PromoStockPage(props: { searchParams?: Promise<{ vue?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PROMO_STOCK");
  const [page, tabs] = await Promise.all([chargerPageStock(user), visibleTabs(user, STOCK_PROMO_TABS)]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock promotionnel"
        description="Ce que le magasin et chacun ont en main, ce qui est en route, et pourquoi. Une quantité se calcule à partir des mouvements — elle ne se saisit jamais."
      />
      <ModuleTabs tabs={tabs} />
      <StockEcran page={page} vueDemandee={typeof searchParams?.vue === "string" ? searchParams.vue : null} />
    </div>
  );
}
