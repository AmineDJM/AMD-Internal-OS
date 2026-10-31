import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { exporterEtudeDeMarche } from "@/lib/exports/etude-de-marche";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/** Export Excel (.xlsx) d'une étude de marché — la logique est dans `exporterEtudeDeMarche` (K7). */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  return reponseExport(await exporterEtudeDeMarche(user, id));
}
