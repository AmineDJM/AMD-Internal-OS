import { prisma } from "@/lib/prisma";
import { handle } from "@/lib/api/http";
import { ENTITIES, canReadEntity } from "@/lib/api/registry/entities";
import { porteeEntite } from "@/lib/api/registry/portee";
import { textSearchWhere, serialize, parsePage } from "@/lib/api/query";
import { sansBloquer } from "@/lib/journal";

/**
 * RECHERCHE GLOBALE — la première question d'un agent : « qu'est-ce qu'on a sur X ? ».
 *
 * Traverse tous les objets déclarés que l'identité a le droit de lire, chacun avec SA portée.
 * Un agent n'a donc pas à connaître la carte de l'ERP pour trouver : il cherche « paracétamol »
 * et reçoit les dossiers réglementaires, les ventes, les appels d'offres et les documents qui
 * le mentionnent — et rien de ce qu'il n'aurait pas le droit de voir.
 *
 * Chaque résultat porte son objet, son identifiant, un titre lisible et le chemin pour aller
 * plus loin : l'agent enchaîne sans deviner d'URL.
 */
export const GET = handle(
  { operationId: "search_erp", scopes: ["erp.search"] },
  async ({ req, ctx }) => {
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim();
    const page = parsePage(sp);
    const only = new Set((sp.get("entities") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const from = sp.get("from");
    const to = sp.get("to");

    if (q.length < 2) {
      return { query: q, results: [], note: "Donnez au moins deux caractères : une recherche d'un caractère rendrait tout l'ERP." };
    }

    const targets = ENTITIES.filter((e) => e.searchFields.length > 0 && (only.size === 0 || only.has(e.name)) && canReadEntity(ctx.user, e));
    // Fenêtre de dates optionnelle, appliquée sur la date de création — la seule que tous
    // les objets partagent.
    const dateWhere: Record<string, unknown> = {};
    if (from || to) {
      dateWhere.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const perEntity = Math.max(1, Math.floor(page.limit / Math.max(1, targets.length)));
    const groups = await Promise.all(targets.map(async (def) => {
      const model = (prisma as any)[def.model.charAt(0).toLowerCase() + def.model.slice(1)];
      // `AND` : la recherche (`{ OR }`) ne doit jamais écraser la portée (`{ OR }` elle aussi).
      const where = { AND: [await porteeEntite(ctx.user, def), textSearchWhere(def, q), dateWhere] };
      const [rows, total] = await Promise.all([
        model.findMany({ where, take: perEntity, orderBy: def.orderBy ?? { id: "desc" } }).catch(sansBloquer("search-route.findMany", [])),
        model.count({ where }).catch(sansBloquer("search-route.count", 0)),
      ]);
      return {
        entity: def.name,
        label: def.label,
        module: def.module,
        total: total as number,
        items: (rows as Record<string, unknown>[]).map((r) => ({
          id: String(r.id),
          title: String(r[def.referenceField ?? ""] ?? r.name ?? r.title ?? r.label ?? r.fullName ?? r.dci ?? r.id),
          status: def.statusField ? (r[def.statusField] ?? null) : null,
          path: `/api/v1/entities/${def.name}/${String(r.id)}`,
          record: serialize(Object.fromEntries(def.listFields.map((f) => [f, r[f]]))),
        })),
      };
    }));

    const found = groups.filter((g) => g.items.length > 0);
    return {
      query: q,
      searchedEntities: targets.map((t) => t.name),
      totalMatches: found.reduce((a, g) => a + g.total, 0),
      results: found,
    };
  },
);
