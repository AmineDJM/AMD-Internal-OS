import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { canAccessConversation } from "@/lib/messaging";
import { redirectionReferenceDrive } from "@/lib/messaging-attachments";

export const dynamic = "force-dynamic";

/**
 * Sert une pièce jointe déchiffrée. Accès strictement contrôlé : on ne télécharge
 * que si l'on est membre actif de la conversation portant le message.
 * `?dl=1` force le téléchargement.
 *
 * Une RÉFÉRENCE au Drive : `?contenu=1` renvoie vers les octets du fichier (`/api/drive/<nœud>/raw`,
 * qui revérifie le droit de lecture du Drive) — c'est ce que la visionneuse de la messagerie affiche
 * sans quitter la conversation. Sans ce paramètre, la page du Drive, comme avant.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const attachment = await prisma.messageAttachment.findUnique({
    where: { id: params.id },
    select: {
      blobId: true,
      driveNodeId: true,
      isFolder: true,
      name: true,
      mime: true,
      message: { select: { conversationId: true, deletedAt: true } },
    },
  });
  if (!attachment || attachment.message.deletedAt) return new NextResponse(null, { status: 404 });
  if (!(await canAccessConversation(user.id, attachment.message.conversationId))) {
    return new NextResponse(null, { status: 403 });
  }

  // Une pièce RÉFÉRENCÉE au Drive n'a pas de blob : son contenu vit dans le Drive, avec ses
  // versions et ses droits propres. On renvoie donc vers le Drive plutôt que de servir une copie
  // — servir ici court-circuiterait le contrôle d'accès du Drive et figerait une version.
  const dl = req.nextUrl.searchParams.get("dl") === "1";
  if (!attachment.blobId) {
    if (!attachment.driveNodeId) return new NextResponse(null, { status: 404 });
    const target = redirectionReferenceDrive(attachment.driveNodeId, attachment.isFolder, {
      contenu: req.nextUrl.searchParams.get("contenu") === "1",
      telecharger: dl,
    });
    return NextResponse.redirect(new URL(target, req.nextUrl.origin));
  }

  const bytes = await getBlob(attachment.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });

  const filename = encodeURIComponent(attachment.name);
  // UN FICHIER QUI PEUT PORTER DU SCRIPT (SVG, HTML, XML) s'affiche, mais n'exécute rien : ouvert directement à son
  // adresse, un SVG piégé jouerait son script sous l'origine de la plateforme. `nosniff` partout : le navigateur ne
  // devine pas un autre type que celui qu'on annonce.
  const mime = attachment.mime || "application/octet-stream";
  const scriptable = /svg|html|xml|javascript/i.test(mime) || /\.(svgz?|html?|xhtml|xml)$/i.test(attachment.name);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(mime),
      "Content-Disposition": `${dl ? "attachment" : "inline"}; filename*=UTF-8''${filename}`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(scriptable ? { "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
}
