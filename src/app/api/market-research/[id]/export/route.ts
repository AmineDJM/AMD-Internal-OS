import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getMarketResearch } from "@/lib/queries/market-research";
import { buildResearchWorkbook, researchExportFilename } from "@/lib/market-research-export";
import { recordAudit } from "@/lib/audit";
import { contentDisposition } from "@/lib/http/content-disposition";

/** Export Excel (.xlsx) d'une étude de marché au format exact du modèle. */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, "BUSINESS_DEVELOPMENT", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const d = await getMarketResearch(params.id);
  if (!d) return NextResponse.json({ error: "Étude introuvable." }, { status: 404 });

  const buffer = buildResearchWorkbook(d);
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Business Development", summary: `Export Excel étude « ${d.title} »` });

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(researchExportFilename(d.title)),
      "Cache-Control": "no-store",
    },
  });
}
