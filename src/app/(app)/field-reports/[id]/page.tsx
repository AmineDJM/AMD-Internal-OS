import { redirect } from "next/navigation";
import { lienRapportTerrain } from "@/lib/chemins/rapports-terrain";

/** ANCIENNE ADRESSE de la fiche d'un rapport terrain — même fiche, sous Promotion médicale › Rapports. */
export default async function AncienneFicheRapport(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  redirect(lienRapportTerrain(params.id));
}
