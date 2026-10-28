import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getPresentationVersionForExport } from "@/lib/queries/market-research";
import { buildPresentationPptx, presentationFilename } from "@/lib/market-presentation-pptx";
import type { PresentationAnalysis } from "@/lib/market-presentation";
import { recordAudit } from "@/lib/audit";
import { contentDisposition } from "@/lib/http/content-disposition";

/** Télécharge le .pptx d'une version de présentation — (re)construit à la demande depuis l'analyse stockée. */
export async function GET(_req: NextRequest, props: { params: Promise<{ versionId: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, "BUSINESS_DEVELOPMENT", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const v = await getPresentationVersionForExport(params.versionId);
  if (!v) return NextResponse.json({ error: "Présentation introuvable." }, { status: 404 });

  const buffer = await buildPresentationPptx(v.research, v.analysis as PresentationAnalysis, {
    presentationTitle: v.presentationTitle,
    version: v.version,
    generatedAt: v.createdAt,
  });
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Business Development", summary: `Téléchargement présentation « ${v.presentationTitle} » (v${v.version})` });

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": contentDisposition(presentationFilename(v.presentationTitle, v.version)),
      "Cache-Control": "no-store",
    },
  });
}
