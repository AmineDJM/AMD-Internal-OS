import { NextRequest } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { exporterSuiviRegulatory } from "@/lib/exports/regulatory";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/**
 * EXPORT EXCEL DES DOSSIERS REGULATORY — en POST : l'écran envoie la liste des dossiers **actuellement affichés**.
 * Toute la logique (portée, droits, audit) est dans `exporterSuiviRegulatory`, partagée avec l'Assistant IA (K7).
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  // Liste facultative : sans elle, on exporte tout ce que la personne a le droit de voir.
  let ids: string[] | null = null;
  try {
    const raw = ((await req.json()) as { ids?: unknown })?.ids;
    if (Array.isArray(raw)) ids = raw.filter((x): x is string => typeof x === "string");
  } catch {
    /* corps absent ou illisible → export complet dans la portée */
  }
  return reponseExport(await exporterSuiviRegulatory(user, { ids }));
}
