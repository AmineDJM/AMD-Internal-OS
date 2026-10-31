import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { exporterBudgetMarketing } from "@/lib/exports/budget";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

/**
 * EXPORTS DE LA VUE D'ENSEMBLE BUDGET MARKETING (Excel, PDF, CSV, PowerPoint) sous les filtres de l'écran (`debut`, `fin`,
 * `cat`, `n1`) — la logique est dans `exporterBudgetMarketing`, partagée avec l'Assistant IA (K7).
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  const sp = req.nextUrl.searchParams;
  return reponseExport(await exporterBudgetMarketing(user, {
    format: sp.get("format"),
    enveloppe: sp.get("env"),
    du: sp.get("from") ? new Date(sp.get("from")!) : null,
    au: sp.get("to") ? new Date(sp.get("to")!) : null,
    debut: sp.get("debut"), fin: sp.get("fin"), categorie: sp.get("cat"), n1: sp.get("n1") === "1",
  }));
}
