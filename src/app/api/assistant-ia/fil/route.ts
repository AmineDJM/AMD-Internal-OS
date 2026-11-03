import { NextResponse } from "next/server";
import { filPourEcran, lireFil } from "@/modules/assistant-ia/api";
import { getCurrentUser } from "@/lib/session";
import { enVueExacte, refusAssistantIA, SANS_CACHE } from "../personne";

export const dynamic = "force-dynamic";

/**
 * LE FIL DE L'ASSISTANT IA, LU PAR L'ÉCRAN — à l'ouverture, puis toutes les secondes tant qu'un tour
 * s'écrit (texte partiel, étapes). Une route et non une action serveur : les actions d'un même
 * écran passent l'une après l'autre, et une lecture répétée retarderait l'envoi d'un message.
 * Chaque lecture dit aussi que la personne est là (`consulteLe`) : présente, elle n'est pas notifiée.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus ?? NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  // En « Vue exacte », on ne marque pas la présence de la personne regardée (ni ne lit son fil).
  if (enVueExacte(user)) return NextResponse.json({ tours: [], enCours: false, vueExacte: true }, SANS_CACHE);
  // Décision 0027 : la conversation lue (`?c=`) ; sans elle, la conversation courante.
  const conversation = new URL(req.url).searchParams.get("c")?.slice(0, 64) || null;
  const fil = await lireFil(user.id, 80, conversation);
  return NextResponse.json(await filPourEcran(user, fil), SANS_CACHE);
}
