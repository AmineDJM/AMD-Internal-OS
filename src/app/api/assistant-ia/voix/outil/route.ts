import { getCurrentUserPourEcrire } from "@/lib/session";
import { executerOutilVocal } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Un outil lent (lecture d'un long document) tient dans la minute ; la voix attend sa réponse.
export const maxDuration = 60;

/**
 * UN APPEL D'OUTIL DE LA VOIX (lot J13, décision 0025) — exécuté sous les droits RELUS de la personne de la session ;
 * rend ce que la voix peut dire (aucune valeur sensible), la carte à afficher, et les valeurs que l'écran seul montre.
 */
export async function POST(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  let corps: { nom?: unknown; arguments?: unknown };
  try { corps = (await req.json()) as typeof corps; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  const nom = typeof corps.nom === "string" ? corps.nom.slice(0, 80) : "";
  const args = corps.arguments && typeof corps.arguments === "object" ? (corps.arguments as Record<string, unknown>) : {};
  return Response.json(await executerOutilVocal(personne, nom, args));
}
