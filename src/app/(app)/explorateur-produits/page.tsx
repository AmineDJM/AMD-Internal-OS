import { requireModule } from "@/lib/session";
import { searchProducts, productFilterOptions } from "@/lib/market/products";
import Link from "next/link";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ProductExplorer } from "./product-explorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Explorateur produits — AMD Internal OS" };

/**
 * L'EXPLORATEUR PRODUITS — un module à part entière, plus une sous-page d'Intelligence marché.
 *
 * On ne l'ouvre pas « en analysant le marché » : on l'ouvre parce qu'on cherche UN produit, UNE
 * molécule, UN laboratoire — en préparant un dossier réglementaire, en répondant à un appel
 * d'offres, en arbitrant un référencement. C'était le geste le plus fréquent du pôle, et il
 * fallait deux clics et connaître le chemin pour y arriver.
 */
export default async function ProductExplorerPage() {
  await requireModule("PRODUCT_EXPLORER");
  // Listes de filtres (UNION ville + hôpital) + jeu initial (60 plus fortes valeurs) chargés
  // côté serveur ; les recherches suivantes passent par l'action `searchMarketProducts`.
  const { classes } = productFilterOptions();
  const initial = searchProducts({ limit: 60 });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Explorateur produits"
        description="Cherchez par MOLÉCULE, par nom de produit ou par laboratoire — selon la case que vous remplissez. Une recherche par molécule ouvre en plus l'analyse concurrentielle : poids du marché, partage ville / hôpital, part de marché de chaque acteur et production locale ou importée."
      >
        <Link href="/explorateur-produits/donnees"><Button variant="outline">Données marché</Button></Link>
      </PageHeader>
      <ProductExplorer classes={classes} initial={initial.products} initialTotal={initial.total} />
    </div>
  );
}
