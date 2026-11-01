import { getCurrentUserPourEcrire } from "@/lib/session";
import { deleguerALaVoix } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// K9 (décision 0038) : la délégation rend AUSSITÔT (travail lancé, carte résumée ou confirmée) — elle ne tient plus la voix.
export const maxDuration = 60;

const court = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/**
 * UN ÉNONCÉ DÉLÉGUÉ PAR LA VOIX (lots J13 puis K9) — ce que la personne a dit (transcription d'entrée de SA session
 * vocale) : nouvelle demande (travail lancé, suivi par `/voix/travail`), précision du travail en cours, valeur d'un
 * champ, « vas-y » d'une carte, commande orale. Le serveur juge ; la voix dit ce qu'il rend.
 */
export async function POST(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  let corps: { demande?: unknown; session?: unknown; delegationId?: unknown; enCours?: unknown };
  try { corps = (await req.json()) as typeof corps; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  const demande = typeof corps.demande === "string" ? corps.demande.slice(0, 4_000) : "";
  return Response.json(await deleguerALaVoix(personne, demande, {
    session: court(corps.session, 120), delegationId: court(corps.delegationId, 120), enCours: court(corps.enCours, 64),
  }));
}
