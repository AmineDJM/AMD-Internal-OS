import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { exporterInscritsEvenement } from "@/lib/exports/evenement";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

export const dynamic = "force-dynamic";

/** Export CSV de la liste des inscrits / présence — la logique est dans `exporterInscritsEvenement` (K7). */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(403, "Non autorisé."));
  return reponseExport(await exporterInscritsEvenement(user, id));
}
