import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getBlob } from "@/lib/drive-storage";
import { prisma } from "@/lib/prisma";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { contentDisposition } from "@/lib/http/content-disposition";

/** Téléchargement d'un document GÉNÉRÉ (G10) — org-scopé + permission. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, props: { params: Promise<{ docId: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!regCan(user, "regulatory.document.view")) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return NextResponse.json({ error: "Module non activé." }, { status: 403 });

  // Isolation : le document généré doit appartenir à un dossier de l'organisation.
  const doc = await prisma.regulatoryGeneratedDoc.findFirst({
    where: { id: params.docId, dossierVersion: { dossier: { companyId } } },
    select: { blobId: true, filename: true },
  });
  if (!doc) return NextResponse.json({ error: "Document introuvable." }, { status: 404 });

  const bytes = await getBlob(doc.blobId);
  if (!bytes) return NextResponse.json({ error: "Contenu indisponible." }, { status: 404 });

  const filename = doc.filename.replace(/[^\w.\-]+/g, "_") || "document.docx";
  const mime = filename.toLowerCase().endsWith(".pdf")
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": contentDisposition(filename),
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
