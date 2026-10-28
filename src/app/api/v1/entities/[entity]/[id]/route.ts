import { prisma } from "@/lib/prisma";
import { handle } from "@/lib/api/http";
import { errors } from "@/lib/api/errors";
import { getEntity, canReadEntity, porteeManquante } from "@/lib/api/registry/entities";
import { porteeEntite } from "@/lib/api/registry/portee";
import { serialize, selectOf } from "@/lib/api/query";

/**
 * FICHE COMPLÈTE d'un objet.
 *
 * Un objet hors portée répond « introuvable » et non « interdit » : la seconde réponse
 * confirmerait son existence à quelqu'un qui n'a pas le droit de la connaître.
 */
export const GET = handle<{ entity: string; id: string }>(
  { operationId: "get_entity_record", scopes: ["erp.read"] },
  async ({ ctx, params, mark }) => {
    const def = getEntity(params.entity);
    if (!def) throw errors.notFound("Objet");
    if (!canReadEntity(ctx.user, def)) throw errors.forbidden(`Le module ${def.module} n'est pas accessible à cette identité.`);
    const manque = porteeManquante(def, ctx.client.scopes);
    if (manque) throw errors.missingScope([manque], ctx.client.scopes);
    mark({ operationId: `get_${def.name}`, entityType: def.entityType ?? def.model, entityId: params.id });

    const model = (prisma as any)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];
    const row = await model.findFirst({
      where: { AND: [await porteeEntite(ctx.user, def), { id: params.id }] },
      select: selectOf(def.detailFields),
    });
    if (!row) throw errors.notFound(def.label);

    return {
      entity: def.name,
      id: params.id,
      record: serialize(row),
      links: {
        history: `/api/v1/entities/${def.name}/${params.id}/history`,
        documents: `/api/v1/entities/${def.name}/${params.id}/documents`,
        related: `/api/v1/entities/${def.name}/${params.id}/related`,
        workflow: `/api/v1/entities/${def.name}/${params.id}/workflow`,
        availableActions: `/api/v1/entities/${def.name}/${params.id}/available-actions`,
      },
    };
  },
);
