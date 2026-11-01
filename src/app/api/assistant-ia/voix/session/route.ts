import { NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { ouvrirVoixAssistant } from "@/modules/assistant-ia/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * OUVRIR LA CONVERSATION VOCALE (GPT-Live, lot J13, décision 0025) — le navigateur envoie son offre WebRTC ; le serveur
 * vérifie droits, console et plafond, ouvre la session chez le fournisseur avec SA clé et SA configuration, et rend la
 * réponse SDP. Aucun secret ne sort d'ici.
 */
export async function POST(req: Request) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (await interrupteurIaCoupe()) return NextResponse.json({ error: REFUS_IA_COUPEE }, { status: 409 });
  let corps: { sdp?: unknown; conversation?: unknown };
  try { corps = (await req.json()) as typeof corps; } catch { return NextResponse.json({ error: "Requête invalide." }, { status: 400 }); }
  const conversation = typeof corps.conversation === "string" && corps.conversation.length < 64 ? corps.conversation : null;
  const s = await ouvrirVoixAssistant(user, String(corps.sdp ?? ""), { conversation });
  if (!s.ok) return NextResponse.json({ error: s.erreur }, { status: s.statut });
  // K9 : `reprises` — ce qui est arrivé après la dernière session vocale, que la voix dit en ouvrant.
  return NextResponse.json({ session: s.id, sdp: s.sdp, modele: s.modele, reprises: s.reprises }, { status: 201 });
}
