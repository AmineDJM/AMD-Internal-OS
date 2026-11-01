import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { exporterBudget } from "@/lib/exports/budget";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/** Export Excel (.xlsx) du budget affiché — la logique est dans `exporterBudget`, partagée avec l'Assistant IA (K7). */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  const sp = req.nextUrl.searchParams;
  return reponseExport(await exporterBudget(user, {
    enveloppe: sp.get("env"),
    du: sp.get("from") ? new Date(sp.get("from")!) : null,
    au: sp.get("to") ? new Date(sp.get("to")!) : null,
    portee: sp.get("portee"),
  }));
}
