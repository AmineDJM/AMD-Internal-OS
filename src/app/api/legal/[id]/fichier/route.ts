import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob, infoBlob } from "@/lib/drive-storage";
import { qualiteDeLaRequete, repondreFichier } from "@/lib/http/telechargement";
import { recordAudit } from "@/lib/audit";
import { fichierEmisDeLaPiece, specDeLaPieceEmise } from "@/lib/queries/legal-fichier";
import { construireXlsxCommercial } from "@/lib/artifact/factory/xlsx";

/**
 * LE FICHIER ÉMIS D'UNE PIÈCE LEGAL (Word ou PDF de la fabrique), sous la porte de la PIÈCE.
 *
 * `/api/drive/<nœud>/raw` répond selon le Drive — et le fichier d'un BC vit dans le Drive
 * personnel de celui qui l'a émis : les Finances qui le signent, le centre qui le valide, le
 * demandeur qui l'envoie à son fournisseur recevaient un 403. Ici, qui lit la pièce lit son
 * fichier (`fichierEmisDeLaPiece`), et rien de plus : un refus et une absence rendent 404.
 * `?format=pdf|docx|xlsx` (PDF par défaut), `?dl=1` force le téléchargement — et le trace.
 *
 * `xlsx` n'est PAS un fichier du Drive : c'est la pièce RENDUE en classeur à formules, à la demande, depuis sa
 * spécification (« générer le BC sur Excel »), sous la même porte et avec le même contrôle au centime que le Word.
 * Un classeur qui ne retombe pas sur les totaux de la pièce n'est pas livré (422, les raisons dites).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const demande = req.nextUrl.searchParams.get("format");
  const format = demande === "docx" || demande === "xlsx" ? demande : "pdf";
  if (format === "xlsx") {
    const spec = await specDeLaPieceEmise(user, params.id);
    if (!spec) return new NextResponse(null, { status: 404 });
    const classeur = await construireXlsxCommercial(spec);
    if (!classeur.verification.ok) return NextResponse.json({ error: `Le classeur n'a pas pu être produit : ${classeur.verification.bloquants.slice(0, 3).join(" ; ")}` }, { status: 422 });
    if (req.nextUrl.searchParams.get("dl") === "1") {
      await recordAudit({ actorId: user.id, action: "EXPORT", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: params.id, summary: `Export Excel de la pièce « ${spec.numero} »` });
    }
    return new NextResponse(new Uint8Array(classeur.octets), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(classeur.nom)}`,
        "Content-Length": String(classeur.octets.length),
        "Cache-Control": "private, no-store",
      },
    });
  }
  const fichier = await fichierEmisDeLaPiece(user, params.id, format);
  if (!fichier) return new NextResponse(null, { status: 404 });

  const node = await prisma.driveNode.findUnique({
    where: { id: fichier.nodeId },
    select: { name: true, mimeType: true, type: true, isTrashed: true },
  });
  if (!node || node.type !== "FILE" || node.isTrashed) return new NextResponse(null, { status: 404 });
  const version = await prisma.fileVersion.findFirst({
    where: { nodeId: fichier.nodeId }, orderBy: { version: "desc" }, select: { blobId: true, mimeType: true },
  });
  if (!version) return new NextResponse(null, { status: 404 });
  const dl = req.nextUrl.searchParams.get("dl") === "1";
  const info = await infoBlob(version.blobId);
  // UNE PIÈCE JURIDIQUE SE DÉLIVRE EN ORIGINAL : c'est le fichier émis, celui qu'on signe, qu'on
  // contrôle et qu'on envoie. Pas de « taille réduite » ici, et la porte le dit à qui le demande.
  return repondreFichier(
    { nom: node.name, mime: node.mimeType ?? version.mimeType ?? "application/octet-stream", charger: () => getBlob(version.blobId), empreinte: info?.sha256 ?? null, taille: info?.size ?? null },
    {
      qualite: qualiteDeLaRequete(req),
      telecharger: dl,
      reductionAutorisee: { oui: false, raison: "Pièce juridique : seul l'original est délivré." },
      entetes: { "Cache-Control": "private, no-store" },
      journaliser: () => dl
        ? recordAudit({
          actorId: user.id, action: "EXPORT", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: params.id,
          summary: `Téléchargement du fichier émis « ${node.name} »`,
        })
        : undefined,
    },
  );
}
