import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { exporterAppelDOffres } from "@/lib/exports/appel-d-offres";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/** EXPORT EXCEL d'un appel d'offres PCH — la logique est dans `exporterAppelDOffres`, partagée avec l'Assistant IA (K7). */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  return reponseExport(await exporterAppelDOffres(user, req.nextUrl.searchParams.get("id") ?? ""));
}
