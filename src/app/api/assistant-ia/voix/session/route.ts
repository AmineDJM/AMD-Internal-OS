import { NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { ouvrirVoixAssistant } from "@/modules/assistant-ia/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * OUVRIR LA VOIX TEMPS RÉEL DE L'ASSISTANT IA (lot J13, décision 0025) — le navigateur reçoit un SECRET ÉPHÉMÈRE, jamais
 * la clé ; la session (consignes, outils sous les droits de la personne) est configurée côté serveur.
 */
export async function POST() {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (await interrupteurIaCoupe()) return NextResponse.json({ error: REFUS_IA_COUPEE }, { status: 409 });
  const s = await ouvrirVoixAssistant(user);
  if (!s.ok) return NextResponse.json({ error: s.erreur }, { status: s.statut });
  return NextResponse.json({ secret: s.secret, expireA: s.expireA, urlAppel: s.urlAppel, modele: s.modele, voix: s.voix, outils: s.outils });
}
