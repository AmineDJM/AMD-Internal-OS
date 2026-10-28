import { prisma } from "@/lib/prisma";
import { handle } from "@/lib/api/http";
import { errors } from "@/lib/api/errors";
import { getEntity, canReadEntity } from "@/lib/api/registry/entities";
import { porteeEntite } from "@/lib/api/registry/portee";
import { parsePage, parseSort, parseFilters, textSearchWhere, serialize, listResult, selectOf } from "@/lib/api/query";

/**
 * LISTE D'UN OBJET MÉTIER — la porte d'entrée d'un agent qui analyse un pipeline.
 *
 * Filtres structurés, tri, recherche plein texte, pagination généreuse (jusqu'à 500 par lot)
 * pour éviter des centaines d'allers-retours. La PORTÉE de l'ERP s'applique avant tout : ce
 * qu'une identité n'a pas le droit de voir n'est pas compté, pas listé, et ne laisse aucune
 * trace de son existence dans le total.
 */
const RESERVED = new Set(["limit", "offset", "sort", "q", "fields"]);

export const GET = handle<{ entity: string }>(
  { operationId: "list_entity_records", scopes: ["erp.read"] },
  async ({ req, ctx, params, mark }) => {
    const def = getEntity(params.entity);
    if (!def) throw errors.notFound("Objet");
    if (!canReadEntity(ctx.user, def)) throw errors.forbidden(`Le module ${def.module} n'est pas accessible à cette identité.`);
    mark({ operationId: `list_${def.name}`, entityType: def.entityType ?? def.model });

    const sp = req.nextUrl.searchParams;
    const page = parsePage(sp);
    const allowed = new Set([...def.listFields, ...def.searchFields, ...(def.statusField ? [def.statusField] : [])]);
    // `AND`, jamais l'étalement : la portée « mes lignes » est un `{ OR }`, la recherche aussi —
    // étalées, la seconde écrasait la première et `?q=` rendait les lignes de tout le monde.
    const where = {
      AND: [
        await porteeEntite(ctx.user, def),
        parseFilters(sp, allowed, RESERVED),
        textSearchWhere(def, sp.get("q") ?? ""),
      ],
    };
    const orderBy = parseSort(sp.get("sort"), def, allowed);

    const model = (prisma as any)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];
    const [rows, total] = await Promise.all([
      model.findMany({ where, orderBy, take: page.limit, skip: page.offset, select: selectOf(def.listFields) }),
      model.count({ where }),
    ]);

    return listResult((rows as unknown[]).map(serialize), total as number, page);
  },
);
