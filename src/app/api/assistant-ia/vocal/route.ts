import { NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { deposerAudio, deposerMessage, DUREE_VOCAL_MAX_S, nomDeVocal, traiterFil } from "@/modules/assistant-ia/api";
import { TAILLE_MAX_STT } from "@/lib/media/stt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ENVOYER UN MESSAGE VOCAL À L'ASSISTANT IA — « comme WhatsApp » (Direction, 28/10/2026).
 *
 * L'enregistrement part dans le Drive de la personne (dossier « Assistant IA — vocaux », sans
 * partage : les droits sont ceux du fil), puis le vocal est DÉPOSÉ comme un message du fil, avec
 * les pièces déjà jointes. La transcription se fait quand le fil le joue (en arrière-plan) : la
 * requête rend la main tout de suite, l'écran montre « transcription… » puis le texte sous le vocal.
 *
 * Identité de la SESSION, jamais d'un paramètre. Indisponible en « Vue exacte » (on n'écrit pas dans
 * le fil de la personne regardée) et quand l'interrupteur général de l'IA est coupé (un vocal qu'on
 * ne pourrait pas transcrire n'est pas stocké pour rien).
 */
const FORMATS: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-m4a": "m4a", "video/webm": "webm" };

export async function POST(req: Request) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!peutUtiliserAssistantIA(user)) return NextResponse.json({ error: REFUS_ASSISTANT_IA }, { status: 403 });
  if (user.impersonatedBy || user.visualise) return NextResponse.json({ error: "Indisponible en « Vue exacte »." }, { status: 403 });
  if (await interrupteurIaCoupe()) return NextResponse.json({ error: REFUS_IA_COUPEE }, { status: 409 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Requête invalide." }, { status: 400 }); }
  const fichier = form.get("audio");
  if (!(fichier instanceof File) || fichier.size === 0) return NextResponse.json({ error: "Enregistrement manquant." }, { status: 400 });
  if (fichier.size > TAILLE_MAX_STT) {
    return NextResponse.json({ error: `Vocal trop lourd (${(fichier.size / 1048576).toFixed(1)} Mo) : ${TAILLE_MAX_STT / 1048576} Mo au plus — envoyez un vocal plus court.` }, { status: 413 });
  }
  const dureeS = Number(form.get("dureeS"));
  if (Number.isFinite(dureeS) && dureeS > DUREE_VOCAL_MAX_S + 5) {
    return NextResponse.json({ error: `Vocal trop long : ${Math.round(DUREE_VOCAL_MAX_S / 60)} minutes au plus.` }, { status: 413 });
  }
  const type = (fichier.type || "audio/webm").split(";")[0].trim().toLowerCase();
  const ext = FORMATS[type];
  if (!ext) return NextResponse.json({ error: `Format d'enregistrement non pris en charge (${type}).` }, { status: 415 });

  let pieces: unknown = [];
  try { pieces = JSON.parse(String(form.get("pieces") ?? "[]")); } catch { pieces = []; }

  const depot = await deposerAudio(user, Buffer.from(await fichier.arrayBuffer()), nomDeVocal("vocal", ext), type);
  if ("erreur" in depot) return NextResponse.json({ error: depot.erreur }, { status: 400 });
  const r = await deposerMessage(
    user.id, String(form.get("texte") ?? ""), Array.isArray(pieces) ? (pieces as { id: string; nom: string }[]) : [],
    { id: depot.id, dureeS: Number.isFinite(dureeS) ? dureeS : null },
    // Décision 0027 : la conversation où le vocal est envoyé (sans elle, la conversation courante).
    typeof form.get("conversation") === "string" ? String(form.get("conversation")).slice(0, 64) || null : null,
  );
  if (!r.ok) return NextResponse.json({ error: r.erreur }, { status: 400 });
  // NON ATTENDU, à dessein : la transcription et la réponse se jouent en arrière-plan.
  void traiterFil(user.id, r.conversation);
  return NextResponse.json({ ok: true, id: r.tour.id, vocal: depot.id, conversation: r.conversation });
}
