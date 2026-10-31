import { getCurrentUser } from "@/lib/session";
import { exporterSegmentation } from "@/lib/exports/segmentation";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

export const dynamic = "force-dynamic";

/** L'EXPORT DE LA SEGMENTATION D'UNE BU — la logique est dans `exporterSegmentation`, partagée avec l'Assistant IA (K7). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(403, "Non autorisé."));
  return reponseExport(await exporterSegmentation(user, new URL(req.url).searchParams.get("s") ?? ""));
}
