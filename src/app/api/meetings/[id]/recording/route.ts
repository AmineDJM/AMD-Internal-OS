import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import { transcribeAudio } from "@/lib/ai";
import { aiFeatureEnabled, logAiUsage } from "@/lib/ai-settings";
import { getAppSettings } from "@/lib/settings";
import { canManageMeeting } from "@/lib/meetings";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * Reçoit l'enregistrement audio d'une réunion, le stocke (chiffré) et le transcrit
 * (Whisper). Réservé à l'organisateur (ou vue globale). L'audio est conservé même si la
 * transcription IA est coupée : l'organisateur peut alors coller le texte manuellement.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUserPourEcrire();
  if (!user || !userCan(user, "MESSAGING", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const meeting = await prisma.meeting.findUnique({
    where: { id: params.id },
    select: { id: true, organizerId: true, audioBlobId: true, participants: { select: { userId: true } } },
  });
  if (!meeting) return NextResponse.json({ error: "Réunion introuvable." }, { status: 404 });
  if (!canManageMeeting(user, meeting)) return NextResponse.json({ error: "Réservé à l'organisateur." }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Audio manquant." }, { status: 400 });
  const maxMb = (await getAppSettings()).maxUploadMb;
  if (file.size > maxMb * 1024 * 1024) return NextResponse.json({ error: `Enregistrement trop volumineux (max ${maxMb} Mo).` }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const { blobId } = await putBlob(buf);
  // Remplace un enregistrement précédent éventuel (on libère l'ancien blob).
  const previous = meeting.audioBlobId;
  await prisma.meeting.update({ where: { id: meeting.id }, data: { audioBlobId: blobId } });
  if (previous && previous !== blobId) await releaseBlob(previous).catch(sansBloquer("recording-route.POST.releaseBlob"));

  if (!(await aiFeatureEnabled("voice"))) {
    return NextResponse.json({ configured: true, error: "La transcription vocale est désactivée dans le Centre de contrôle IA." });
  }

  const t0 = Date.now();
  const tr = await transcribeAudio(buf, file.name || "reunion.webm", file.type || "audio/webm");
  await logAiUsage({
    feature: "voice", provider: "openai", model: process.env.STT_MODEL ?? "whisper-1", userId: user.id,
    ok: tr.ok, latencyMs: Date.now() - t0, errorCode: tr.ok ? null : tr.error ?? "error",
  });
  if (tr.ok && tr.text) {
    await prisma.meeting.update({ where: { id: meeting.id }, data: { transcript: tr.text } });
    return NextResponse.json({ configured: true, transcript: tr.text });
  }
  return NextResponse.json({ configured: tr.configured, error: tr.error });
}
