import { requireUser } from "@/lib/session";
import { featureEnabled, FEATURES } from "@/lib/features";
import { rememberExchange } from "@/lib/memoire-echange";
import { canUseRealtimeVoice } from "@/lib/assistant/voice-realtime";
import { ancienMoteurActif, reponseAncienMoteurMasque } from "@/lib/assistant/ancien-moteur";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PERSISTANCE D'UN TOUR VOCAL — voix et texte sont DEUX MODALITÉS DE LA MÊME CONVERSATION :
 * chaque tour parlé (transcription utilisateur + transcription de la réponse) rejoint le MÊME
 * fil que le texte, par la MÊME porte (`rememberExchange` : cloisonnée par userId, titre du
 * fil, distillation de mémoire — les pipelines de mémoire lisent donc aussi les tours vocaux).
 * Une transcription reste une transcription : exploitable pour la recherche et la mémoire,
 * jamais une preuve documentaire officielle.
 */
export async function POST(req: Request) {
  // I6 (décision 0070) : l'ancien moteur est MASQUÉ (pas supprimé) — cette route ne revient qu'avec ADAM_ANCIEN_MOTEUR=1.
  const masque = ancienMoteurActif() ? null : reponseAncienMoteurMasque();
  if (masque) return masque;
  const user = await requireUser();
  if (!canUseRealtimeVoice(user)) return Response.json({ error: "Non autorisé." }, { status: 403 });

  let body: { threadId?: string | null; user?: string; assistant?: string };
  try { body = (await req.json()) as typeof body; } catch { return Response.json({ error: "Requête invalide." }, { status: 400 }); }
  const userText = typeof body.user === "string" ? body.user.trim().slice(0, 8_000) : "";
  const assistantText = typeof body.assistant === "string" ? body.assistant.trim().slice(0, 16_000) : "";
  if (!userText && !assistantText) return Response.json({ ok: true, threadId: body.threadId ?? null });

  const memoryOn = await featureEnabled(FEATURES.ASSISTANT_MEMORY.key, user.id);
  if (!memoryOn) return Response.json({ ok: true, threadId: body.threadId ?? null });

  const threadId = await rememberExchange(
    user.id,
    typeof body.threadId === "string" ? body.threadId : null,
    userText || "(intervention vocale)",
    assistantText || "(réponse vocale)",
  );
  return Response.json({ ok: true, threadId });
}
