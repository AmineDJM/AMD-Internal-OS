import { getCurrentUser } from "@/lib/session";
import { exporterPilotage } from "@/lib/exports/pilotage";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

export const dynamic = "force-dynamic";

/** L'EXPORT DU PILOTAGE (Force de vente) — la logique est dans `exporterPilotage`, partagée avec l'Assistant IA (K7). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(403, "Non autorisé."));
  const sp = new URL(req.url).searchParams;
  return reponseExport(await exporterPilotage(user, { annee: Number(sp.get("y")) || null, mois: Number(sp.get("m")) || null, bu: sp.get("bu") }));
}
