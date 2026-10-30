import { NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";

export const dynamic = "force-dynamic";

/**
 * LA CONVERSATION VOCALE EN DIRECT DE L'ASSISTANT IA (`gpt-live-1`, décision 0027 point 7b) — POINT D'ACCROCHE.
 *
 * La session temps réel (secret éphémère, configuration du modèle, outils sous les droits de la personne, transcription
 * écrite dans la conversation) est livrée par le lot J13 (`jarvis/j13-terrain-voix`) : tant qu'il n'est pas sur la
 * base, cette route le dit (501) et l'écran d'Adventum IA l'affiche. Elle ne rend jamais une clé de fournisseur.
 */
export async function POST() {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!peutUtiliserAssistantIA(user)) return NextResponse.json({ error: REFUS_ASSISTANT_IA }, { status: 403 });
  return NextResponse.json({
    error: "La conversation vocale en direct (gpt-live-1) arrive avec le lot J13. En attendant, maintenez le micro pour envoyer un message vocal : il est transcrit et l'assistant y répond.",
    reasonCode: "VOIX_DIRECTE_A_VENIR",
  }, { status: 501 });
}
