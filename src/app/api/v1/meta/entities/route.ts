import { handle } from "@/lib/api/http";
import { ENTITIES, canReadEntity, porteeManquante } from "@/lib/api/registry/entities";

/** Catalogue des objets métier exposés, avec le droit de lecture réel de l'identité courante. */
export const GET = handle({ operationId: "list_entities", scopes: ["erp.read"] }, async ({ ctx }) => ({
  entities: ENTITIES.map((e) => ({
    entity: e.name,
    label: e.label,
    description: e.description,
    module: e.module,
    model: e.model,
    // La MÊME réponse que les routes de lecture : un objet que plusieurs modules ouvrent
    // (`lisiblePar`) ne doit pas s'annoncer illisible ici et se lire là (§118.150).
    // Un objet d'administration se dit illisible tant que le client ne porte pas sa portée (SA-15).
    readable: canReadEntity(ctx.user, e) && !porteeManquante(e, ctx.client.scopes),
    requiredScope: e.porteeRequise ?? null,
    hasWorkflow: Boolean(e.workflow),
    rowScoped: Boolean(e.scope),
    listFields: e.listFields,
    searchFields: e.searchFields,
    related: Object.keys(e.related ?? {}),
  })),
}));
