import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { canReadFeedback } from "@/lib/feedback/access";
import { dispositionFor, extensionOf } from "@/lib/files/attachment-policy";

export const dynamic = "force-dynamic";

/**
 * SERT la pièce jointe d'un retour — à qui y a droit, et sous une forme qui ne peut pas nuire.
 *
 * Trois protections, et chacune ferme une porte distincte :
 *
 *   · L'ACCÈS. La règle vit dans `feedback/access` et rien d'autre ne la formule. Un identifiant
 *     de pièce deviné ne donne rien : on remonte au retour et on vérifie qu'il appartient au
 *     demandeur, ou qu'il est Super Admin.
 *
 *   · LE TYPE SERVI est celui qu'on a ENREGISTRÉ (déduit de l'extension au moment du dépôt),
 *     jamais celui que le navigateur avait annoncé. Avec `nosniff`, le navigateur ne peut pas
 *     non plus le redeviner : un fichier texte reste du texte, il ne devient pas du HTML
 *     exécuté dans l'origine de l'ERP.
 *
 *   · LA DISPOSITION. Seuls un PDF et les images s'affichent en ligne ; tout le reste se
 *     télécharge. Le nom est encodé (`filename*=UTF-8''…`) : ni guillemet ni retour à la ligne
 *     ne peuvent s'échapper dans l'en-tête.
 *
 * Aucune mise en cache partagée : `private, no-store`. Une pièce de retour n'a rien à faire
 * dans un cache intermédiaire.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const att = await prisma.feedbackAttachment.findUnique({
    where: { id: params.id },
    select: { blobId: true, name: true, mime: true, feedback: { select: { userId: true } } },
  });
  // Introuvable et interdit rendent le MÊME code : sinon la différence dirait à un curieux
  // qu'une pièce existe bien derrière cet identifiant.
  if (!att || !canReadFeedback(user, att.feedback)) return new NextResponse(null, { status: 404 });

  const bytes = await getBlob(att.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });

  const forced = req.nextUrl.searchParams.get("dl") === "1";
  const disposition = forced ? "attachment" : dispositionFor(extensionOf(att.name));

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": att.mime || "application/octet-stream",
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(att.mime || "application/octet-stream"),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
