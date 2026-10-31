import { getCurrentUser } from "@/lib/session";
import { exporterSuiviCoaching } from "@/lib/exports/coaching";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/** EXPORTER LE SUIVI DU COACHING (§118.157) — la logique est dans `exporterSuiviCoaching`, partagée avec l'Assistant IA (K7). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  const sp = new URL(req.url).searchParams;
  return reponseExport(await exporterSuiviCoaching(user, { collaborateur: sp.get("collaborateur"), statut: sp.get("statut") }));
}
