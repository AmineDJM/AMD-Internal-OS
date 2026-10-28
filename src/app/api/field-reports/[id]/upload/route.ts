import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { managesReports } from "@/lib/queries/field-reports";

export const dynamic = "force-dynamic";

/** Pièce jointe d'un rapport terrain : photo, carte de visite, programme, PDF… */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUserPourEcrire();
  // Garde sur le module RAPPORTS TERRAIN (et non « Promotion médicale ») depuis leur séparation.
  if (!user || !userCan(user, "FIELD_REPORTS", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const report = await prisma.fieldReport.findUnique({ where: { id: params.id }, select: { delegateId: true } });
  if (!report) return NextResponse.json({ error: "Rapport introuvable." }, { status: 404 });
  if (!(managesReports(user) || report.delegateId === user.id)) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });
  const err = validateUpload(file.name, file.size, (await getAppSettings()).maxUploadMb);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const { blobId, size } = await putBlob(buf);
  const att = await prisma.fieldReportAttachment.create({
    data: { reportId: params.id, blobId, name: file.name, mime: file.type || "application/octet-stream", size },
    select: { id: true },
  });
  return NextResponse.json({ id: att.id });
}
