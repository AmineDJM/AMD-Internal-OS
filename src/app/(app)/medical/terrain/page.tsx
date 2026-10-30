import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { lireCaptations, peutCapterTerrain } from "@/modules/assistant-ia/api";
import { EcranTerrain } from "@/modules/assistant-ia/ecrans/terrain/ecran-terrain";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — AMD Internal OS" };

/**
 * LE TERRAIN (lot J13, décision 0025) — dicter un compte rendu en sortant d'une visite, photographier un présentoir ou
 * une carte de visite. Hors ligne, tout attend dans le téléphone et part au retour du réseau. Rien n'est écrit sans
 * confirmation : le compte rendu, les échantillons et la tournée de demain arrivent en cartes.
 */
export default async function TerrainPage() {
  const user = await requireModule("FIELD_REPORTS");
  if (!peutCapterTerrain(user)) redirect("/medical/rapports");
  const captations = await lireCaptations(user);
  return (
    <div className="space-y-4">
      <PageHeader title="Terrain" description="Dictez votre compte rendu, photographiez ; vous confirmez ce qui s'enregistre." />
      <EcranTerrain initiales={captations} />
    </div>
  );
}
