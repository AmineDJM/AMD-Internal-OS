import { getCurrentUser } from "@/lib/session";
import { exporterDemandesPaiement } from "@/lib/exports/paiements";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

export const dynamic = "force-dynamic";

/** EXPORT DES DEMANDES DE PAIEMENT (`/validations/paiements`) — la logique est dans `exporterDemandesPaiement` (K7). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  const sp = new URL(req.url).searchParams;
  return reponseExport(await exporterDemandesPaiement(user, { perimetre: sp.get("perimetre"), statuts: sp.getAll("statut") }));
}
