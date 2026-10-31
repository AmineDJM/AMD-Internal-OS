import { getCurrentUserPourEcrire } from "@/lib/session";
import { deleguerALaVoix } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// L'assistant délégué peut enchaîner des lectures et une recherche web : la voix attend sa réponse jusqu'à 70 s.
export const maxDuration = 90;

/**
 * UNE DÉLÉGATION DE LA VOIX (lot J13, décision 0025) — la demande dite part dans le fil de la personne, traitée par
 * l'assistant sous ses droits ; rend ce que la voix dit (valeurs selon le réglage de la décision 0034), la carte à
 * afficher, et la réponse écrite pour l'écran. Une carte se confirme aussi À L'ORAL (décision 0035), jugée ici sur `parole`.
 */
export async function POST(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  let corps: { demande?: unknown; conversation?: unknown; parole?: unknown };
  try { corps = (await req.json()) as typeof corps; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  const demande = typeof corps.demande === "string" ? corps.demande.slice(0, 4_000) : "";
  // Décision 0027 : la conversation ouverte (un identifiant qui n'est pas à la personne retombe sur la courante).
  const conversation = typeof corps.conversation === "string" && corps.conversation.length < 64 ? corps.conversation : null;
  // Décision 0035 : ce que la PERSONNE a dit depuis la délégation précédente (sa transcription) — seul juge d'un « oui ».
  const parole = typeof corps.parole === "string" ? corps.parole.slice(0, 2_000) : null;
  return Response.json(await deleguerALaVoix(personne, demande, conversation, parole));
}
