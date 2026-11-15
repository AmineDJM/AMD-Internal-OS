import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { deposerFichierMarche } from "@/modules/donnees-marche/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TAILLE_MAX = 40 * 1024 * 1024;

/**
 * DÉPOSER LA NOMENCLATURE OU L'AUDIT IQVIA — formulaire de `/explorateur-produits/donnees`. Réservé à qui peut
 * modifier l'Explorateur produits. La nature se reconnaît à l'en-tête du classeur. Répond par un retour à l'écran.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  if (!userCan(user, "PRODUCT_EXPLORER", "UPDATE")) return new NextResponse(null, { status: 403 });
  const retour = (params: Record<string, string>) =>
    NextResponse.redirect(new URL(`/explorateur-produits/donnees?${new URLSearchParams(params)}`, req.url), 303);

  const form = await req.formData().catch(() => null);
  const fichier = form?.get("fichier");
  if (!(fichier instanceof File) || fichier.size === 0) return retour({ erreur: "Choisissez un fichier Excel." });
  if (fichier.size > TAILLE_MAX) return retour({ erreur: "Fichier trop lourd (40 Mo au plus)." });
  const r = await deposerFichierMarche(fichier.name, Buffer.from(await fichier.arrayBuffer()), user.id);
  if (!r.ok) return retour({ erreur: r.erreur });
  return retour({ ok: r.nature, lignes: String(r.lignes), deja: r.deja ? "1" : "0" });
}
