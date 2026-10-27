import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handle } from "@/lib/api/http";
import { errors } from "@/lib/api/errors";
import { readFileByKey } from "@/lib/storage";
import { ENTITIES, canReadEntity } from "@/lib/api/registry/entities";
import { porteeEntite } from "@/lib/api/registry/portee";
import { contentDisposition } from "@/lib/http/content-disposition";
import { canAccessEntity } from "@/lib/entity-access";

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

    // La RÈGLE DE L'ÉCRAN d'abord, pour toute pièce : la portée du registre ne s'appliquait qu'aux
    // types qu'il connaît (`if (def)`), et une pièce de demande RH, de candidature, de validation…
    // partait vers n'importe quelle clé `erp.documents.read` (audit sécurité 27/10).
    if (!doc.entityType || !doc.entityId || !(await canAccessEntity(ctx.user, doc.entityType, doc.entityId, "VIEW"))) {
      throw errors.notFound("Document");
    }
    // Puis, si le porteur est au registre, l'objet DANS LA PORTÉE de l'identité (cloisonnement par entité compris).
    const def = ENTITIES.find((e) => e.entityType && e.entityType === doc.entityType);
    if (def) {
      if (!canReadEntity(ctx.user, def)) throw errors.notFound("Document");
      const model = (prisma as any)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];
      const owner = await model.findFirst({ where: { AND: [await porteeEntite(ctx.user, def), { id: doc.entityId ?? "" }] }, select: { id: true } });
      if (!owner) throw errors.notFound("Document");
    }

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
