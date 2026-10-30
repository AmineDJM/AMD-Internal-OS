import { getCurrentUserPourEcrire } from "@/lib/session";
import { deleguerALaVoix } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// L'assistant délégué peut enchaîner des lectures : la voix attend sa réponse jusqu'à 45 s.
export const maxDuration = 60;

/**
 * UNE DÉLÉGATION DE LA VOIX (lot J13, décision 0025) — la demande dite part dans le fil de la personne, traitée par
 * l'assistant sous ses droits ; rend ce que la voix peut dire (aucune valeur sensible), la carte à afficher, et la
 * réponse écrite pour l'écran.
 */
export async function POST(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  let corps: { demande?: unknown };
  try { corps = (await req.json()) as typeof corps; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  const demande = typeof corps.demande === "string" ? corps.demande.slice(0, 4_000) : "";
  return Response.json(await deleguerALaVoix(personne, demande));
}
