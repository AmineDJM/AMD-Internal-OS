import { getCurrentUser } from "@/lib/session";
import { exporterPlanTourneePdf } from "@/lib/exports/plan-de-tournee";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

export const dynamic = "force-dynamic";

/**
 * LE PDF DU PLAN DE TOURNÉE — la porte et la composition sont dans `exporterPlanTourneePdf`, partagée avec l'Assistant IA
 * (K7). Ouvert dans l'onglet (`inline`), comme avant.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  return reponseExport(await exporterPlanTourneePdf(user, { plan: id }), "inline");
}
