import { requireUser } from "@/lib/session";
import { FicheCasPv } from "../fiche-cas";

export const dynamic = "force-dynamic";

/** La fiche d'un cas de pharmacovigilance, côté Regulatory (Direction, 06/10). La règle de lecture est dans la fiche. */
export default async function CasPvRegulatoryPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  return (
    <FicheCasPv
      user={user} id={params.id} base="/regulatory/pharmacovigilance"
      retour={{ href: "/regulatory/pharmacovigilance", label: "Pharmacovigilance" }}
    />
  );
}
