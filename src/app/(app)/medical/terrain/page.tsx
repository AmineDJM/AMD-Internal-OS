import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { BackLink } from "@/components/shared/back-link";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import { lireCaptations, peutCapterTerrain } from "@/modules/assistant-ia/api";
import { EcranTerrain } from "@/modules/assistant-ia/ecrans/terrain/ecran-terrain";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Visite médicale — AMD Internal OS" };

/**
 * LE TERRAIN (lot J13, décision 0025) — dicter un compte rendu en sortant d'une visite, photographier un présentoir ou
 * une carte de visite. Hors ligne, tout attend dans le téléphone et part au retour du réseau. Rien n'est écrit sans
 * confirmation : le compte rendu, les échantillons et la tournée de demain arrivent en cartes.
 *
 * Il vit DANS « Visite médicale » (11/2026) : les onglets du module, et le retour vers les Rapports d'où il s'ouvre —
 * sans eux, l'écran était une impasse qu'on ne quittait que par le menu.
 */
export default async function TerrainPage() {
  const user = await requireModule("FIELD_REPORTS");
  if (!peutCapterTerrain(user)) redirect(CHEMIN_RAPPORTS_TERRAIN);
  const [captations, onglets] = await Promise.all([lireCaptations(user), visibleTabs(user, MEDICAL_TABS)]);
  return (
    <div className="space-y-4">
      <BackLink href={CHEMIN_RAPPORTS_TERRAIN}><ArrowLeft className="h-4 w-4" /> Rapports</BackLink>
      <PageHeader title="Terrain" description="Dictez votre compte rendu, photographiez ; vous confirmez ce qui s'enregistre." />
      <ModuleTabs tabs={onglets} />
      <EcranTerrain initiales={captations} />
    </div>
  );
}
