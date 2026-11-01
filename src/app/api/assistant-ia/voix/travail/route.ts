import { getCurrentUserPourEcrire } from "@/lib/session";
import { annoncesEnAppel, suivreTravailVocal } from "@/modules/assistant-ia/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SUIVRE un travail délégué par la voix (K9, décision 0039) : en cours, prêt (ce que la voix dit), remplacé, échec.
 * `?annonces=1` : les pièces reçues (WhatsApp, mail — K6) pendant l'appel, à annoncer.
 */
export async function GET(req: Request) {
  const personne = await getCurrentUserPourEcrire();
  if (!personne) return Response.json({ error: "Non authentifié." }, { status: 401 });
  const u = new URL(req.url);
  if (u.searchParams.get("annonces") === "1") return Response.json({ annonces: await annoncesEnAppel(personne, u.searchParams.get("session")) });
  return Response.json(await suivreTravailVocal(personne, u.searchParams.get("session"), u.searchParams.get("id")));
}
