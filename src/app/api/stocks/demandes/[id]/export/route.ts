import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { exporterDemandeStocks } from "@/lib/exports/demande-stocks";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

export const dynamic = "force-dynamic";

/** EXPORT D'UNE DEMANDE DE STOCKS — la logique est dans `exporterDemandeStocks`, partagée avec l'Assistant IA (K7). */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(403, "Non autorisé."));
  return reponseExport(await exporterDemandeStocks(user, id));
}
