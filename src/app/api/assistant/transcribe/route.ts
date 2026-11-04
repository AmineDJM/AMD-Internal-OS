import { ancienMoteurActif, reponseAncienMoteurMasque } from "@/lib/assistant/ancien-moteur";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan, peutVoirAdam } from "@/lib/rbac";
import { transcribeAudio } from "@/lib/ai";
import { aiFeatureEnabled, logAiUsage } from "@/lib/ai-settings";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Dictée vocale de l'assistant : reçoit un court audio, le transcrit (Whisper) et renvoie le
 * TEXTE — que l'utilisateur relit/édite dans la zone de saisie avant d'envoyer. L'audio n'est
 * PAS conservé (saisie éphémère). Accessible à tout employé (assistant universel).
 */
export async function POST(req: NextRequest) {
  // I6 (décision 0070) : l'ancien moteur est MASQUÉ (pas supprimé) — cette route ne revient qu'avec ADAM_ANCIEN_MOTEUR=1.
  if (!ancienMoteurActif()) return reponseAncienMoteurMasque();
  const user = await getCurrentUserPourEcrire();
  // La dictée de l'assistant est Adam : Super Admin seul (§118.153).
  if (!user || !userCan(user, "WORKSPACE", "VIEW") || !peutVoirAdam(user)) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  // Interrupteur « voix » du Centre de contrôle IA (Super Admin).
  if (!(await aiFeatureEnabled("voice"))) {
    return NextResponse.json({ configured: true, error: "La transcription vocale est désactivée dans le Centre de contrôle IA." });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Audio manquant." }, { status: 400 });
  const maxMb = (await getAppSettings()).maxUploadMb;
  if (file.size > maxMb * 1024 * 1024) return NextResponse.json({ error: `Audio trop volumineux (max ${maxMb} Mo).` }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const t0 = Date.now();
  const tr = await transcribeAudio(buf, file.name || "audio.webm", file.type || "audio/webm");
  await logAiUsage({
    feature: "voice", provider: "openai", model: process.env.STT_MODEL ?? "whisper-1", userId: user.id,
    ok: tr.ok, latencyMs: Date.now() - t0, errorCode: tr.ok ? null : tr.error ?? "error",
  });
  if (tr.ok && tr.text) return NextResponse.json({ configured: true, transcript: tr.text });
  return NextResponse.json({ configured: tr.configured, error: tr.error });
}
