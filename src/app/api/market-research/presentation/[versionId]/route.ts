import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { exporterPresentationEtude } from "@/lib/exports/etude-de-marche";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/** Télécharge le .pptx d'une version de présentation — la logique est dans `exporterPresentationEtude` (K7). */
export async function GET(_req: NextRequest, props: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await props.params;
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  return reponseExport(await exporterPresentationEtude(user, versionId));
}
