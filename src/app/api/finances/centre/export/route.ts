import { getCurrentUser } from "@/lib/session";
import { exporterOrdresCentre } from "@/lib/exports/paiements";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";

export const dynamic = "force-dynamic";

/** EXPORT DES ORDRES DU CENTRE DE PAIEMENT (`/centre-de-paiement`, entité et section de l'écran) — `exporterOrdresCentre` (K7). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  const sp = new URL(req.url).searchParams;
  return reponseExport(await exporterOrdresCentre(user, { entite: sp.get("entite"), section: sp.get("section"), statuts: sp.getAll("statut") }));
}
