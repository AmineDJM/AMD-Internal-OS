import { NextResponse } from "next/server";
import { idsDriveCites, lireFil, piecesCitees, propositionsParIds, type PropositionNote } from "@/modules/assistant-ia/api";
import { getCurrentUser } from "@/lib/session";
import { enVueExacte, refusAssistantIA, SANS_CACHE } from "../personne";

export const dynamic = "force-dynamic";

/**
 * LE FIL DE L'ASSISTANT IA, LU PAR L'ÉCRAN — à l'ouverture, puis toutes les secondes tant qu'un tour
 * s'écrit (texte partiel, étapes). Une route et non une action serveur : les actions d'un même
 * écran passent l'une après l'autre, et une lecture répétée retarderait l'envoi d'un message.
 * Chaque lecture dit aussi que la personne est là (`consulteLe`) : présente, elle n'est pas notifiée.
 */
export async function GET() {
  const user = await getCurrentUser();
  const refus = refusAssistantIA(user);
  if (refus || !user) return refus ?? NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  // En « Vue exacte », on ne marque pas la présence de la personne regardée (ni ne lit son fil).
  if (enVueExacte(user)) return NextResponse.json({ tours: [], enCours: false, vueExacte: true }, SANS_CACHE);
  const fil = await lireFil(user.id);
  // LES PIÈCES RENVOYÉES PAR L'ASSISTANT (décision 0015) : les fichiers du Drive cités par une réponse
  // terminée ou par le résultat d'une action exécutée — droits revérifiés, ouvrables dans l'aperçu.
  const rendues = new Map<string, { id: string; nom: string }[]>();
  for (const t of fil.tours) {
    if (t.role !== "assistant" || t.etat === "EN_COURS") continue;
    const ids = idsDriveCites(t.contenu, (t.intent as { resultLink?: string } | null)?.resultLink);
    if (ids.length) rendues.set(t.id, await piecesCitees(user, ids));
  }
  // « MES NOTES » (décision 0026) : les modifications proposées par un tour, dans leur état présent (la carte).
  const idsNotes = fil.tours.flatMap((t) => (Array.isArray(t.notesProposees) ? (t.notesProposees as unknown[]).filter((x): x is string => typeof x === "string") : []));
  const notes = new Map((await propositionsParIds(user.id, idsNotes)).map((p) => [p.id, p]));
  const notesDu = (v: unknown): PropositionNote[] | null => {
    const ps = Array.isArray(v) ? v.flatMap((id) => (typeof id === "string" && notes.has(id) ? [notes.get(id)!] : [])) : [];
    return ps.length ? ps : null;
  };
  return NextResponse.json({
    vueExacte: false,
    enCours: fil.enCours,
    reponseVocale: fil.reponseVocale,
    tours: fil.tours.map((t) => ({
      id: t.id, role: t.role, contenu: t.contenu, etat: t.etat, pieces: t.pieces, blocs: t.blocs, intent: t.intent,
      memoireProposee: t.memoireProposee, outils: t.outils, etapes: t.etapes, createdAt: t.createdAt.toISOString(),
      vocal: t.vocal, lecture: t.lecture, audio: t.audio, piecesRendues: rendues.get(t.id) ?? null, notesProposees: notesDu(t.notesProposees),
    })),
  }, SANS_CACHE);
}
