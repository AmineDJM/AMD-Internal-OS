import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { getBlob } from "@/lib/drive-storage";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { getDocument } from "@/lib/regulatory/intelligence/queries";
import { contentDisposition } from "@/lib/http/content-disposition";

/**
 * Téléchargement / aperçu d'un document décortiqué du dossier. Org-scopé + permission.
 * Aperçu inline pour PDF/images/texte ; téléchargement pour le reste. Les fichiers bloqués
 * (exécutables, chiffrés…) n'ont pas de blob → jamais servis.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INLINE_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", xml: "application/xml",
};

export async function GET(req: NextRequest, props: { params: Promise<{ documentId: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!regCan(user, "regulatory.document.view")) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });

  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return NextResponse.json({ error: "Module non activé." }, { status: 403 });

  const doc = await getDocument(companyId, params.documentId);
  if (!doc?.blobId) return NextResponse.json({ error: "Fichier indisponible (bloqué ou non conservé)." }, { status: 404 });

  const bytes = await getBlob(doc.blobId);
  if (!bytes) return NextResponse.json({ error: "Contenu indisponible." }, { status: 404 });

  const inlineType = INLINE_MIME[doc.ext.toLowerCase()];
  const wantsInline = req.nextUrl.searchParams.get("inline") === "1" && !!inlineType;
  const filename = doc.originalFilename.replace(/[^\w.\-]+/g, "_") || `document.${doc.ext || "bin"}`;

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": inlineType ?? "application/octet-stream",
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(inlineType ?? "application/octet-stream"),
      "Content-Disposition": contentDisposition(filename, wantsInline ? "inline" : "attachment"),
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
