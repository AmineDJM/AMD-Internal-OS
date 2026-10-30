import { NextResponse } from "next/server";
import { etatAtelier } from "@/modules/assistant-ia/api";
import { personneDeLAssistant, SANS_CACHE } from "../personne";

export const dynamic = "force-dynamic";

/**
 * L'ATELIER, RELU PAR L'ÉCRAN (J3) — les onglets ouverts et leur révision, les conversions récentes. Une route et
 * non une action serveur, pour la même raison que le fil : relue en boucle pendant que l'assistant modifie un
 * document, elle ne doit pas retarder les gestes de la personne. Chaque onglet n'appartient qu'à elle (`userId`).
 */
export async function GET() {
  const p = await personneDeLAssistant();
  if ("refus" in p) return p.refus;
  if (p.vueExacte) return NextResponse.json({ onglets: [], conversions: [], vueExacte: true }, SANS_CACHE);
  return NextResponse.json({ ...(await etatAtelier(p.user.id)), vueExacte: false }, SANS_CACHE);
}
