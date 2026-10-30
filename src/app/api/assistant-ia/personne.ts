import { NextResponse } from "next/server";
import { getCurrentUser, type CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";

/**
 * LA PERSONNE D'UNE ROUTE DE RELECTURE de l'Assistant IA (fil, Atelier) : connectée et titulaire du module — sinon la
 * réponse de refus, toute faite. `vueExacte` : un administrateur qui regarde l'écran de quelqu'un ne lit pas ses données.
 */
export async function personneDeLAssistant(): Promise<{ user: CurrentUser; vueExacte: boolean } | { refus: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { refus: NextResponse.json({ error: "Non authentifié." }, { status: 401 }) };
  if (!peutUtiliserAssistantIA(user)) return { refus: NextResponse.json({ error: "Non autorisé." }, { status: 403 }) };
  return { user, vueExacte: Boolean(user.impersonatedBy || user.visualise) };
}

export const SANS_CACHE = { headers: { "Cache-Control": "no-store" } } as const;
