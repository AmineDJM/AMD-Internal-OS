import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * SERT LE FICHIER ORIGINAL d'un import « Ventes PCH », tel qu'il a été déposé — à qui lit le module. Toujours en
 * téléchargement (un classeur ne s'ouvre pas dans le navigateur), `nosniff`, aucune mise en cache.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  if (!userCan(user, "PCH_VENTES", "VIEW")) return new NextResponse(null, { status: 404 });
  const imp = await prisma.pchVenteImport.findUnique({ where: { id: params.id }, select: { nomFichier: true, fichier: true } });
  if (!imp) return new NextResponse(null, { status: 404 });
  const bytes = new Uint8Array(imp.fichier);
  const type = imp.nomFichier.toLowerCase().endsWith(".xls") ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(imp.nomFichier)}`,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
