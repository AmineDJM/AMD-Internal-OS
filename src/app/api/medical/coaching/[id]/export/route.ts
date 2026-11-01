import { getCurrentUser } from "@/lib/session";
import { exporterFicheCoaching } from "@/lib/exports/coaching";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/** TÉLÉCHARGER UNE FICHE DE COACHING (§118.157) — la logique est dans `exporterFicheCoaching`, partagée avec l'Assistant IA (K7). */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  return reponseExport(await exporterFicheCoaching(user, id));
}
