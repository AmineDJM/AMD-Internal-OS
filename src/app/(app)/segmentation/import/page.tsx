import Link from "next/link";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { droitsSegmentation } from "@/lib/segmentation/droits";
import { busPourImport } from "@/lib/segmentation/import-direction";
import { ImportDirection } from "./import-direction";

export const dynamic = "force-dynamic";
export const metadata = { title: "Importer la segmentation — AMD Internal OS" };

/**
 * L'ESPACE D'IMPORT DE LA SEGMENTATION (Direction, 08/10) — « j'importe exactement ce fichier et ça fait le tout » :
 * stratégie, produit, règles, annuaires, fiches, réponses et lettres, en une fois, après un aperçu.
 */
export default async function ImportSegmentationPage(props: { searchParams?: Promise<{ bu?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("SEGMENTATION");
  const droits = droitsSegmentation(user);
  const retour = <Link href={searchParams?.bu ? `/segmentation?bu=${searchParams.bu}` : "/segmentation"} className="inline-flex h-9 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-[13px] font-medium hover:bg-secondary sm:h-8">Segmentation</Link>;
  if (!droits.valider) {
    return (
      <div className="space-y-4">
        <PageHeader title="Importer le fichier">{retour}</PageHeader>
        <p className="surface rounded-xl p-5 text-sm text-muted-foreground">L&apos;import de la segmentation demande le droit de valider (Administration › Accès).</p>
      </div>
    );
  }
  const bus = await busPourImport();
  const initiale = bus.some((b) => b.id === searchParams?.bu) ? searchParams!.bu! : null;
  return (
    <div className="space-y-4">
      <PageHeader title="Importer le fichier" description="Segmentation de la BU, annuaires reliés, en une fois">{retour}</PageHeader>
      <ImportDirection bus={bus.map((b) => ({ id: b.id, nom: b.name }))} buInitiale={initiale} peutForcer={droits.forcer} />
    </div>
  );
}
