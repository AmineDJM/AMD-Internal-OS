import { requireUser } from "@/lib/session";
import { CHEMIN_PV_KAM } from "@/lib/chemins/rapports-terrain";
import { FicheCasPv } from "@/app/(app)/regulatory/pharmacovigilance/fiche-cas";

export const dynamic = "force-dynamic";

/** La fiche d'un cas, côté KAM — sous Promotion médicale › Rapports (Direction, 07/10). La règle de lecture est dans la fiche. */
export default async function CasPvKamPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  return (
    <FicheCasPv
      user={user} id={params.id} base={CHEMIN_PV_KAM}
      retour={{ href: CHEMIN_PV_KAM, label: "Mes signalements" }}
    />
  );
}
