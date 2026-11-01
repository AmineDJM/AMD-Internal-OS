import { getCurrentUserPourEcrire } from "@/lib/session";
import { suivreTravailVocal } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SUIVRE un travail délégué par la voix (K9, décision 0038) : en cours, prêt (ce que la voix dit), remplacé, échec. */
export async function GET(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  const u = new URL(req.url);
  return Response.json(await suivreTravailVocal(personne, u.searchParams.get("session"), u.searchParams.get("id")));
}
