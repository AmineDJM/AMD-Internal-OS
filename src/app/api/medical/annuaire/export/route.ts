import { getCurrentUser } from "@/lib/session";
import { exporterAnnuaire } from "@/lib/exports/annuaire";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/** EXPORT DE L'ANNUAIRE EN CLASSEUR — la logique est dans `exporterAnnuaire`, partagée avec l'Assistant IA (K7). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  return reponseExport(await exporterAnnuaire(user, new URL(req.url).searchParams.get("grade")));
}
