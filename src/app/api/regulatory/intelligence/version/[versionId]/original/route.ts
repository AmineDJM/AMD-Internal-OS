import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getBlob } from "@/lib/drive-storage";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { getVersionForCompany } from "@/lib/regulatory/intelligence/queries";
import { contentDisposition } from "@/lib/http/content-disposition";

/** Téléchargement de l'archive ORIGINALE (immuable) d'une version de dossier. Org-scopé. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, props: { params: Promise<{ versionId: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!regCan(user, "regulatory.document.view")) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });

  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return NextResponse.json({ error: "Module non activé." }, { status: 403 });

  const version = await getVersionForCompany(companyId, params.versionId);
  if (!version?.originalZipBlobId) return NextResponse.json({ error: "Archive introuvable." }, { status: 404 });

  const bytes = await getBlob(version.originalZipBlobId);
  if (!bytes) return NextResponse.json({ error: "Contenu indisponible." }, { status: 404 });

  const filename = `${version.dossier.reference}-v${version.versionNo}-original.zip`.replace(/[^\w.\-]+/g, "_");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(filename),
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
