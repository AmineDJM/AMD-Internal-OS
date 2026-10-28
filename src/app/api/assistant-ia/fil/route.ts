import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { lireFil } from "@/lib/agent/fil/service";

export const dynamic = "force-dynamic";

/**
 * LE FIL DE L'ASSISTANT IA, LU PAR L'ÉCRAN — à l'ouverture, puis toutes les secondes tant qu'un tour
 * s'écrit (texte partiel, étapes). Une route et non une action serveur : les actions d'un même
 * écran passent l'une après l'autre, et une lecture répétée retarderait l'envoi d'un message.
 * Chaque lecture dit aussi que la personne est là (`consulteLe`) : présente, elle n'est pas notifiée.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!peutUtiliserAssistantIA(user)) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  // En « Vue exacte », on ne marque pas la présence de la personne regardée (ni ne lit son fil).
  if (user.impersonatedBy || user.visualise) return NextResponse.json({ tours: [], enCours: false, vueExacte: true }, { headers: { "Cache-Control": "no-store" } });
  const fil = await lireFil(user.id);
  return NextResponse.json({
    vueExacte: false,
    enCours: fil.enCours,
    reponseVocale: fil.reponseVocale,
    tours: fil.tours.map((t) => ({
      id: t.id, role: t.role, contenu: t.contenu, etat: t.etat, pieces: t.pieces, blocs: t.blocs, intent: t.intent,
      memoireProposee: t.memoireProposee, outils: t.outils, etapes: t.etapes, createdAt: t.createdAt.toISOString(),
      vocal: t.vocal, lecture: t.lecture, audio: t.audio,
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
