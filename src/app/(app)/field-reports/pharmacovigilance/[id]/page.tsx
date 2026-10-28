import { redirect } from "next/navigation";
import { lienCasPvKam } from "@/lib/chemins/rapports-terrain";

/** ANCIENNE ADRESSE de la fiche d'un cas, côté KAM — les notifications déjà envoyées la portent. */
export default async function AncienneFicheCasPv(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  redirect(lienCasPvKam(params.id));
}
