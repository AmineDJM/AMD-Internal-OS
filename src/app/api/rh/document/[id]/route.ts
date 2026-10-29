import { NextRequest, NextResponse } from "next/server";
import { servirPiece } from "@/lib/http/servir-piece";
import { getCurrentUser } from "@/lib/session";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { entitePermisePourFiche } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { accesAssistantIa } from "@/lib/agent/role-config";
import { familleExplicite } from "@/lib/agent/acces-regles";

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
  // Décision 0012 : la Direction peut OUVRIR explicitement « Contrats & documents RH » à une personne dans la
  // console de l'Assistant IA — le lien que l'assistant lui donne doit alors s'ouvrir (société permise toujours).
  const ouvertParDirection = !isOwner && !isHr
    && familleExplicite(await accesAssistantIa(user), "CONTRATS_RH") && (await entitePermisePourFiche(user.id, doc.employee.companyId));
  if (!isOwner && !isHr && !ouvertParDirection) return new NextResponse(null, { status: 403 });

  const bytes = await getBlob(doc.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });
  return servirPiece(req, { octets: bytes, nom: doc.name, mime: doc.mime }, { disposition: "en-ligne", bacASable: false });
}
