import Link from "next/link";
import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { chargerPageStock } from "@/lib/queries/promo-stock";
import { CHEMIN_STOCK_PROMO, type VueStockPromo } from "@/lib/chemins/stock-promo";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { StockEcran } from "@/app/(app)/stock-promotionnel/stock-ecran";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mon sac — Visite médicale — AMD Internal OS" };

/** Les vues du stock promotionnel qui SONT le sac du délégué : ce qu'il a en main, et à qui il l'a remis. */
const VUES_DU_SAC: readonly VueStockPromo[] = ["moi", "medecins"];

/**
 * « MON SAC » (interface du délégué, maquette VALIDÉE le 24/11/2026 ; DECISIONS : « le sac affiché dans Visite médicale,
 * données existantes »).
 *
 * C'est l'écran du STOCK PROMOTIONNEL, restreint à ses vues à lui — rien n'est recopié (§118.5) : les mêmes quantités
 * calculées des mouvements, les mêmes gestes (confirmer une réception, demander au magasin, déclarer une perte ou un
 * périmé), les mêmes règles (`stock-acces.ts`). Le module `PROMO_STOCK` garde la porte : sans lui, l'écran le dit.
 */
export default async function MonSacPage(props: { searchParams?: Promise<{ vue?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const aiguillage = await aiguillerVisite(user);
  if (aiguillage.destination !== "JOURNEE") redirect(aiguillage.chemin);

  const ouvert = userCan(user, "PROMO_STOCK", "VIEW");
  const [page, tabs] = await Promise.all([ouvert ? chargerPageStock(user) : Promise.resolve(null), visibleTabs(user, MEDICAL_TABS)]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Mon sac">
        {ouvert && <Link href={CHEMIN_STOCK_PROMO} className="text-sm text-primary hover:underline">Stock promotionnel</Link>}
      </PageHeader>
      <ModuleTabs tabs={tabs} />
      {page ? (
        <StockEcran page={page} vueDemandee={typeof searchParams?.vue === "string" ? searchParams.vue : "moi"} seulement={VUES_DU_SAC} />
      ) : (
        <EmptyState icon="Package" title="Votre sac n'est pas ouvert" description="Le stock promotionnel ne vous est pas ouvert : demandez l'accès à votre administrateur (module Stock promotionnel)." />
      )}
    </div>
  );
}
