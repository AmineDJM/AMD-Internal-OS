import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { transcribeAudio } from "@/lib/ai";
import { aiFeatureEnabled, logAiUsage } from "@/lib/ai-settings";
import { getAppSettings } from "@/lib/settings";
import { managesReports } from "@/lib/queries/field-reports";

export const dynamic = "force-dynamic";

/** Reçoit l'audio d'un rapport, le stocke (chiffré) et le transcrit (Whisper). */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUserPourEcrire();
  // Garde sur le module RAPPORTS TERRAIN (et non « Promotion médicale ») : c'est le module
  // qui régit ce flux depuis leur séparation ; sinon un profil ayant les rapports mais pas la
  // promotion médicale (ex. Direction des opérations) se voyait refuser la dictée.
  if (!user || !userCan(user, "FIELD_REPORTS", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const report = await prisma.fieldReport.findUnique({ where: { id: params.id }, select: { delegateId: true } });
  if (!report) return NextResponse.json({ error: "Rapport introuvable." }, { status: 404 });
  if (!(managesReports(user) || report.delegateId === user.id)) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Audio manquant." }, { status: 400 });
  const maxMb = (await getAppSettings()).maxUploadMb;
  if (file.size > maxMb * 1024 * 1024) return NextResponse.json({ error: `Audio trop volumineux (max ${maxMb} Mo).` }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const { blobId } = await putBlob(buf);
  await prisma.fieldReport.update({ where: { id: params.id }, data: { audioBlobId: blobId } });

  // L'audio est conservé (chiffré) même si la transcription IA est coupée : le
  // délégué peut alors saisir/relire son compte rendu manuellement.
  if (!(await aiFeatureEnabled("voice"))) {
    return NextResponse.json({ configured: true, error: "La transcription vocale est désactivée dans le Centre de contrôle IA." });
  }

  const t0 = Date.now();
  const tr = await transcribeAudio(buf, file.name || "audio.webm", file.type || "audio/webm");
  await logAiUsage({
    feature: "voice", provider: "openai", model: process.env.STT_MODEL ?? "whisper-1", userId: user.id,
    ok: tr.ok, latencyMs: Date.now() - t0, errorCode: tr.ok ? null : tr.error ?? "error",
  });
  if (tr.ok && tr.text) {
    await prisma.fieldReport.update({ where: { id: params.id }, data: { transcript: tr.text } });
    return NextResponse.json({ configured: true, transcript: tr.text });
  }
  return NextResponse.json({ configured: tr.configured, error: tr.error });
}
