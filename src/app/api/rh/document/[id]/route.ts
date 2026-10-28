import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { entitePermisePourFiche } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";

export const dynamic = "force-dynamic";

/**
 * Sert un document RH déchiffré. Accès : l'employé propriétaire (compte lié, et
 * document marqué visible) OU un gestionnaire RH. `?dl=1` force le téléchargement.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const doc = await prisma.employeeDocument.findUnique({
    where: { id: params.id },
    select: { blobId: true, name: true, mime: true, visibleToEmployee: true, employee: { select: { userId: true, companyId: true } } },
  });
  if (!doc) return new NextResponse(null, { status: 404 });

  // Un bulletin, un contrat, une pièce d'identité : la LECTURE du module ne suffisait plus à les
  // télécharger (audit 360°, S5) — il faut GÉRER les RH (`voitLesSalaires`), et dans une société
  // permise (S6). L'employé garde ses propres pièces marquées visibles.
  const isOwner = doc.employee.userId === user.id && doc.visibleToEmployee;
  const isHr = voitLesSalaires(user) && (await entitePermisePourFiche(user.id, doc.employee.companyId));
  if (!isOwner && !isHr) return new NextResponse(null, { status: 403 });

  const bytes = await getBlob(doc.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });

  const dl = req.nextUrl.searchParams.get("dl") === "1";
  const filename = encodeURIComponent(doc.name);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": doc.mime || "application/octet-stream",
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(doc.mime || "application/octet-stream"),
      "Content-Disposition": `${dl ? "attachment" : "inline"}; filename*=UTF-8''${filename}`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
