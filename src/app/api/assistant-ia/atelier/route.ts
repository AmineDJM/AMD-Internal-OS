import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { etatAtelier } from "@/modules/assistant-ia/api";
import { enVueExacte, refusAssistantIA, SANS_CACHE } from "../personne";

export const dynamic = "force-dynamic";

/**
 * L'ATELIER, RELU PAR L'ÉCRAN (J3) — les onglets ouverts et leur révision, les conversions récentes. Une route et
 * non une action serveur, pour la même raison que le fil : relue en boucle pendant que l'assistant modifie un
 * document, elle ne doit pas retarder les gestes de la personne. Chaque onglet n'appartient qu'à elle (`userId`) ;
 * en « Vue exacte », rien n'est lu.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return refusAssistantIA(null)!;
  const etat = refusAssistantIA(user) ?? (enVueExacte(user) ? { onglets: [], conversions: [], vueExacte: true } : { ...(await etatAtelier(user.id)), vueExacte: false });
  return etat instanceof NextResponse ? etat : NextResponse.json(etat, SANS_CACHE);
}
