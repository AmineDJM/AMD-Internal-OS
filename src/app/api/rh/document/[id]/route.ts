import { NextRequest, NextResponse } from "next/server";
import { servirPiece } from "@/lib/http/servir-piece";
import { getCurrentUser } from "@/lib/session";
import { peutOuvrirDocumentRh } from "@/lib/entity-access/ouverture-pieces";
import { entitePermisePourFiche } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { journal } from "@/lib/journal";
import { accesAssistantIa } from "@/modules/assistant-ia/api";
import { familleExplicite } from "@/modules/assistant-ia/partage";

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

  // Un bulletin, un contrat, une pièce d'identité : GÉRER les RH dans une société permise, ou l'employé pour ses pièces
  // visibles — la règle est partagée avec la bibliothèque (`entity-access/ouverture-pieces.ts`).
  // Décision 0012 : la Direction peut OUVRIR explicitement « Contrats & documents RH » à une personne dans la
  // console de l'Assistant IA — le lien que l'assistant lui donne doit alors s'ouvrir (société permise toujours).
  // Cette ouverture vaut pour le LIEN de l'assistant : la recherche de la bibliothèque, elle, s'en tient à la règle de base.
  const ouvertParDirection = async () => familleExplicite(await accesAssistantIa(user), "CONTRATS_RH")
    && (await entitePermisePourFiche(user.id, doc.employee.companyId));
  if (!(await peutOuvrirDocumentRh(user, doc)) && !(await ouvertParDirection())) return new NextResponse(null, { status: 403 });

  // Un service qui n'a pas la même clé de chiffrement ou le même stockage objet que l'ERP (site Adventum IA, worker)
  // ne peut pas relire le fichier : le dire en clair plutôt qu'une erreur 500 (31/10/2026).
  let bytes: Buffer | null;
  try {
    bytes = await getBlob(doc.blobId);
  } catch (e) {
    journal.erreur("rh.document-illisible", { documentId: params.id }, e);
    return new NextResponse(
      "Ce document n'a pas pu être lu sur ce service : sa configuration du stockage des fichiers diffère de celle de l'ERP "
      + "(clé de chiffrement ou stockage objet). Ouvrez-le depuis l'ERP, et signalez-le à l'administrateur.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  if (!bytes) return new NextResponse(null, { status: 404 });
  return servirPiece(req, { octets: bytes, nom: doc.name, mime: doc.mime }, { disposition: "en-ligne", bacASable: false });
}
