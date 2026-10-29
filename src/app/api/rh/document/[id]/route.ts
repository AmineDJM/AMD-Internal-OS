import { NextRequest, NextResponse } from "next/server";
import { servirPiece } from "@/lib/http/servir-piece";
import { getCurrentUser } from "@/lib/session";
import { peutOuvrirDocumentRh } from "@/lib/entity-access/ouverture-pieces";
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

  // Un bulletin, un contrat, une pièce d'identité : GÉRER les RH dans une société permise, ou l'employé
  // pour ses pièces visibles — la règle est partagée avec la bibliothèque (`entity-access/ouverture-pieces.ts`).
  if (!(await peutOuvrirDocumentRh(user, doc))) return new NextResponse(null, { status: 403 });

  const bytes = await getBlob(doc.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });
  return servirPiece(req, { octets: bytes, nom: doc.name, mime: doc.mime }, { disposition: "en-ligne", bacASable: false });
}
