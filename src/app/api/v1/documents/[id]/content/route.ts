import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handle } from "@/lib/api/http";
import { errors } from "@/lib/api/errors";
import { readFileByKey } from "@/lib/storage";
import { documentLisibleParApi } from "@/lib/api/registry/document-lisible";
import { contentDisposition } from "@/lib/http/content-disposition";

/**
 * TÉLÉCHARGEMENT CONTRÔLÉ D'UNE PIÈCE.
 *
 * Aucun chemin de fichier n'est jamais exposé : l'agent connaît un identifiant, rien d'autre.
 * Et le droit ne se lit pas sur le document mais sur l'OBJET auquel il est rattaché — c'est
 * l'accès au dossier qui donne accès à sa facture, jamais l'inverse.
 */
export const GET = handle<{ id: string }>(
  { operationId: "download_document_content", scopes: ["erp.documents.read"] },
  async ({ ctx, params, mark }) => {
    const doc = await prisma.document.findUnique({
      where: { id: params.id },
      select: { id: true, name: true, fileKey: true, mimeType: true, entityType: true, entityId: true },
    });
    if (!doc) throw errors.notFound("Document");
    mark({ entityType: doc.entityType ?? undefined, entityId: doc.entityId ?? undefined });

    // Le porteur du document décide — registre API ou, hors registre, la règle de l'écran (`document-lisible.ts`).
    if (!(await documentLisibleParApi(ctx.user, doc))) throw errors.notFound("Document");

    if (!doc.fileKey) throw errors.notFound("Contenu du document");
    const buffer = await readFileByKey(doc.fileKey).catch(() => null);
    if (!buffer) throw errors.notFound("Contenu du document");

    // La réponse binaire sort du cadre JSON de `handle` : on la renvoie telle quelle.
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": doc.mimeType || "application/octet-stream",
        "Content-Disposition": contentDisposition(doc.name),
        "Cache-Control": "no-store",
      },
    }) as unknown as Record<string, unknown>;
  },
);
