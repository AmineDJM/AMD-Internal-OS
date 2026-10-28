import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { handle } from "@/lib/api/http";
import { errors } from "@/lib/api/errors";
import { getEntity, canReadEntity, porteeManquante } from "@/lib/api/registry/entities";
import { porteeEntite } from "@/lib/api/registry/portee";
import { champJamaisExpose, parsePage, serialize, listResult } from "@/lib/api/query";
import { workflowOf, availableActionsFor } from "@/lib/api/workflow";
import { sansBloquer } from "@/lib/journal";

/**
 * LES FACETTES D'UN OBJET : historique, pièces, objets liés, circuit, actions possibles.
 *
 * Réunies sur une seule route parce qu'elles partagent la même garde : trouver l'objet DANS LA
 * PORTÉE de l'identité avant toute chose. Un objet hors portée n'a ni historique ni pièces —
 * et répond « introuvable », sans révéler qu'il existe.
 */
const ASPECTS = new Set(["history", "documents", "related", "workflow", "available-actions", "comments"]);

export const GET = handle<{ entity: string; id: string; aspect: string }>(
  { operationId: "get_entity_aspect", scopes: ["erp.read"] },
  async ({ req, ctx, params, mark }) => {
    const def = getEntity(params.entity);
    if (!def) throw errors.notFound("Objet");
    if (!ASPECTS.has(params.aspect)) {
      throw errors.validation(`Facette inconnue « ${params.aspect} ». Attendu : ${[...ASPECTS].join(", ")}.`);
    }
    if (!canReadEntity(ctx.user, def)) throw errors.forbidden(`Le module ${def.module} n'est pas accessible à cette identité.`);
    const manque = porteeManquante(def, ctx.client.scopes);
    if (manque) throw errors.missingScope([manque], ctx.client.scopes);
    mark({ operationId: `get_${def.name}_${params.aspect.replace("-", "_")}`, entityType: def.entityType ?? def.model, entityId: params.id });

    const model = (prisma as any)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];
    const record = await model.findFirst({ where: { AND: [await porteeEntite(ctx.user, def), { id: params.id }] } });
    if (!record) throw errors.notFound(def.label);

    const page = parsePage(req.nextUrl.searchParams);

    switch (params.aspect) {
      case "history": {
        // Deux sources, et c'est voulu : ce qu'ont fait les HUMAINS (AuditLog) et ce qu'a fait
        // l'AGENT (ApiCall). Les mélanger sans les distinguer rendrait impossible de savoir qui
        // a changé quoi.
        if (!def.entityType) return { humanActions: [], agentCalls: [], note: "Cet objet ne porte pas d'historique tracé." };
        const [audit, calls] = await Promise.all([
          prisma.auditLog.findMany({
            where: { entityType: def.entityType as EntityType, entityId: params.id },
            orderBy: { createdAt: "desc" }, take: page.limit, skip: page.offset,
            select: { id: true, action: true, module: true, field: true, oldValue: true, newValue: true, summary: true, createdAt: true, actor: { select: { id: true, name: true } } },
          }),
          prisma.apiCall.findMany({
            where: { entityType: def.entityType as EntityType, entityId: params.id },
            orderBy: { createdAt: "desc" }, take: 50,
            select: { id: true, operationId: true, ok: true, status: true, correlationId: true, createdAt: true, client: { select: { name: true } } },
          }),
        ]);
        // Un changement de salaire est journalisé avec ses deux valeurs : le champ se dit, les valeurs
        // d'un champ jamais exposé ne se disent pas (sinon l'historique rendait ce que la fiche cache).
        const masque = (e: (typeof audit)[number]) => (e.field && champJamaisExpose(e.field) ? { ...e, oldValue: null, newValue: null } : e);
        return { humanActions: audit.map(masque).map(serialize), agentCalls: calls.map(serialize) };
      }

      case "comments": {
        const rows = await prisma.comment.findMany({
          where: { entityType: (def.entityType ?? def.model) as EntityType, entityId: params.id },
          orderBy: { createdAt: "desc" }, take: page.limit, skip: page.offset,
          select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } },
        }).catch(sansBloquer("[aspect]-route.comment", []));
        return { items: rows.map(serialize) };
      }

      case "documents": {
        const where = { entityType: (def.entityType ?? def.model) as EntityType, entityId: params.id };
        const [rows, total] = await Promise.all([
          prisma.document.findMany({
            where, orderBy: { createdAt: "desc" }, take: page.limit, skip: page.offset,
            select: { id: true, name: true, category: true, stepKey: true, mimeType: true, sizeBytes: true, version: true, confidentiality: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
          }),
          prisma.document.count({ where }),
        ]);
        // Jamais de chemin de fichier : un identifiant et un point de téléchargement contrôlé.
        const items = rows.map((d) => ({ ...(serialize(d) as object), downloadPath: `/api/v1/documents/${d.id}/content` }));
        return listResult(items, total, page);
      }

      case "related": {
        const out: Record<string, unknown> = {};
        for (const [name, field] of Object.entries(def.related ?? {})) {
          // Une relation qui porte des données personnelles a sa projection (`champsRelation`) : la ligne entière, non.
          const champs = def.champsRelation?.[name];
          const withRel = await model.findFirst({
            where: { id: params.id },
            select: { [field]: { take: 200, ...(champs ? { select: Object.fromEntries(champs.map((c) => [c, true])) } : {}) } },
          }).catch(sansBloquer("[aspect]-route.findFirst", null));
          out[name] = withRel ? serialize((withRel as Record<string, unknown>)[field]) : [];
        }
        return { entity: def.name, id: params.id, related: out };
      }

      case "workflow": {
        const view = await workflowOf(def, params.id, record as Record<string, unknown>);
        if (!view) throw errors.notFound("Circuit");
        return view;
      }

      case "available-actions":
      default:
        return {
          entity: def.name,
          id: params.id,
          actingAs: { userId: ctx.user.id, role: ctx.user.role },
          clientScopes: ctx.client.scopes,
          actions: availableActionsFor(ctx.user, ctx.client.scopes, def, params.id),
        };
    }
  },
);
