import { ENTITIES } from "./registry/entities";
import { SCOPES, SCOPE_DESCRIPTIONS, READ_ONLY_SCOPES } from "./scopes";
import { API_ERROR_CODES } from "./errors";
import { MAX_LIMIT, DEFAULT_LIMIT } from "./query";

/**
 * SPÉCIFICATION OPENAPI 3.1 — GÉNÉRÉE, jamais tenue à la main.
 *
 * Une spécification écrite à part dérive de l'implémentation à la première évolution, et un
 * agent qui s'y fie appelle alors des routes qui n'existent plus. Celle-ci est construite à
 * partir du REGISTRE que les routes utilisent réellement : les deux ne peuvent pas diverger.
 *
 * Les `operationId` sont explicites et stables (`get_regulatory_dossier_workflow`), parce
 * qu'un agent choisit son appel d'après ce nom.
 */

type Json = Record<string, unknown>;

const ok = (description: string, schema: Json): Json => ({
  description,
  content: { "application/json": { schema } },
});

const errorResponse = (description: string): Json => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const COMMON_ERRORS: Json = {
  "401": errorResponse("Clé absente, inconnue ou expirée."),
  "403": errorResponse("Portée insuffisante, ou droit refusé à l'identité au nom de laquelle l'agent agit."),
  "404": errorResponse("Objet introuvable — ou hors de la portée de cette identité."),
  "422": errorResponse("Requête invalide (filtre inconnu, corps illisible…)."),
  "500": errorResponse("Erreur interne."),
};

const PAGE_PARAMS: Json[] = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT }, description: `Taille du lot (max ${MAX_LIMIT}).` },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 }, description: "Décalage pour la page suivante." },
];

export function buildOpenApi(baseUrl = "https://amd-internal-os-k3uc.onrender.com"): Json {
  const paths: Json = {};

  paths["/api/v1/meta/modules"] = {
    get: {
      operationId: "list_modules",
      summary: "Lister les modules de l'ERP et ce que cette identité peut y faire",
      description:
        "Point de départ d'un agent. Rend les modules réels, les droits EFFECTIFS de l'identité au nom de "
        + "laquelle l'agent agit (action par action), les portées accordées au client, et les objets exposés par module.",
      tags: ["Découverte"],
      security: [{ apiKey: ["erp.read"] }],
      responses: { "200": ok("Modules et droits effectifs.", { type: "object" }), ...COMMON_ERRORS },
    },
  };

  paths["/api/v1/meta/entities"] = {
    get: {
      operationId: "list_entities",
      summary: "Lister les objets métier exposés",
      description: "Catalogue des objets, leur module, leur description métier et le droit de lecture réel de l'identité.",
      tags: ["Découverte"],
      security: [{ apiKey: ["erp.read"] }],
      responses: { "200": ok("Catalogue des objets.", { type: "object" }), ...COMMON_ERRORS },
    },
  };

  paths["/api/v1/meta/entities/{entity}"] = {
    get: {
      operationId: "get_entity_schema",
      summary: "Décrire un objet : champs, types, énumérations, relations, opérations",
      description:
        "Schéma lu dans la base au moment de la demande — donc toujours exact. Dit aussi quels champs sont "
        + "filtrables, lesquels sont cherchables, et quelles opérations existent sur cet objet.",
      tags: ["Découverte"],
      security: [{ apiKey: ["erp.read"] }],
      parameters: [{ name: "entity", in: "path", required: true, schema: { type: "string", enum: ENTITIES.map((e) => e.name) } }],
      responses: { "200": ok("Schéma de l'objet.", { type: "object" }), ...COMMON_ERRORS },
    },
  };

  paths["/api/v1/search"] = {
    get: {
      operationId: "search_erp",
      summary: "Recherche globale dans tout l'ERP",
      description:
        "Cherche le texte dans tous les objets que l'identité a le droit de lire, chacun avec sa portée. "
        + "Rend, par objet, les correspondances avec leur titre, leur statut et le chemin pour aller plus loin.",
      tags: ["Recherche"],
      security: [{ apiKey: ["erp.search"] }],
      parameters: [
        { name: "q", in: "query", required: true, schema: { type: "string", minLength: 2 }, description: "Texte cherché (2 caractères minimum)." },
        { name: "entities", in: "query", schema: { type: "string" }, description: "Restreindre à certains objets, séparés par des virgules." },
        { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "Créés à partir de cette date." },
        { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "Créés jusqu'à cette date." },
        ...PAGE_PARAMS,
      ],
      responses: {
        "200": ok("Résultats groupés par objet.", { type: "object" }),
        ...COMMON_ERRORS,
      },
    },
  };

  // Une entrée par objet : l'agent lit des chemins qui NOMMENT ce qu'ils rendent, plutôt qu'un
  // « /entities/{entity} » générique dont il doit deviner les valeurs possibles.
  for (const e of ENTITIES) {
    const idParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: `Identifiant du ${e.label.toLowerCase()}.` };
    const entityParam = { name: "entity", in: "path", required: true, schema: { type: "string", enum: [e.name] } };

    paths[`/api/v1/entities/${e.name}`] = {
      get: {
        operationId: `list_${e.name}`,
        summary: `Lister : ${e.label}`,
        description: `${e.description}\n\nFiltres possibles sur : ${[...new Set([...e.listFields, ...e.searchFields])].join(", ")}. `
          + "Syntaxe : `champ=valeur`, `champ=in:A,B`, `champ=gte:2026-01-01`, `champ=contains:texte`, `champ=null`.",
        tags: [e.module],
        security: [{ apiKey: ["erp.read"] }],
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: `Recherche plein texte sur : ${e.searchFields.join(", ") || "—"}.` },
          { name: "sort", in: "query", schema: { type: "string" }, description: "Tri « champ:asc » ou « champ:desc »." },
          ...PAGE_PARAMS,
        ],
        responses: { "200": ok(`Liste paginée de ${e.label.toLowerCase()}.`, { $ref: "#/components/schemas/ListResult" }), ...COMMON_ERRORS },
      },
    };

    paths[`/api/v1/entities/${e.name}/{id}`] = {
      get: {
        operationId: `get_${e.name}`,
        summary: `Lire un ${e.label.toLowerCase()}`,
        description: `${e.description} Rend la fiche complète et les liens vers ses facettes (historique, pièces, circuit, actions).`,
        tags: [e.module],
        security: [{ apiKey: ["erp.read"] }],
        parameters: [idParam],
        responses: { "200": ok("Fiche complète.", { type: "object" }), ...COMMON_ERRORS },
      },
    };

    const aspects: [string, string, string, string[]][] = [
      ["history", `get_${e.name}_history`, "Historique — actions humaines ET appels d'agents, distingués", ["erp.read"]],
      ["documents", `list_${e.name}_documents`, "Pièces jointes, avec leur chemin de téléchargement contrôlé", ["erp.documents.read"]],
      ["comments", `list_${e.name}_comments`, "Commentaires portés sur l'objet", ["erp.read"]],
      ["related", `get_${e.name}_related`, "Objets liés (sous-objets, lignes, participants)", ["erp.read"]],
      ["workflow", `get_${e.name}_workflow`, "Circuit : étapes, étape courante, responsable, échéances, BLOCAGES", ["erp.read"]],
      ["available-actions", `get_${e.name}_available_actions`, "Ce que l'agent peut faire MAINTENANT sur cet objet, et pourquoi pas le reste", ["erp.read"]],
    ];
    for (const [aspect, operationId, summary, scopes] of aspects) {
      paths[`/api/v1/entities/${e.name}/{id}/${aspect}`] = {
        get: {
          operationId,
          summary,
          description: aspect === "workflow"
            ? "Représentation structurée du circuit : étapes du workflow, celles déjà réalisées, l'étape courante, "
              + "les prochaines possibles, le responsable, les dates et échéances, les pièces manquantes et les "
              + "conditions à réunir pour avancer. C'est la réponse à « qu'est-ce qui bloque ce dossier ? »."
            : summary,
          tags: [e.module],
          security: [{ apiKey: scopes }],
          parameters: [idParam, ...(aspect === "documents" || aspect === "history" || aspect === "comments" ? PAGE_PARAMS : [])],
          responses: { "200": ok(summary, { type: "object" }), ...COMMON_ERRORS },
        },
      };
      void entityParam;
    }
  }

  paths["/api/v1/documents/{id}/content"] = {
    get: {
      operationId: "download_document_content",
      summary: "Télécharger le contenu d'une pièce jointe",
      description:
        "Le contenu binaire, par identifiant. Aucun chemin de fichier interne n'est jamais exposé : "
        + "l'accès est recroisé avec les droits de l'identité sur l'objet auquel la pièce est rattachée.",
      tags: ["Documents"],
      security: [{ apiKey: ["erp.documents.read"] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Contenu du fichier.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        ...COMMON_ERRORS,
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "AMD Internal OS — API pour agents",
      version: "1.0.0",
      description:
        "API machine de l'ERP interne d'Adventum Pharma (groupe pharmaceutique algérien).\n\n"
        + "**Deux couches d'autorisation, toujours cumulées.** Les *portées* (scopes) disent ce que "
        + "l'intégration a le droit de faire ; l'*identité* au nom de laquelle l'agent agit dit ce qu'elle "
        + "voit dans l'ERP. Un agent ne dépasse jamais ni l'une ni l'autre.\n\n"
        + "**L'API n'a pas de logique propre.** Elle appelle les mêmes fonctions métier et les mêmes gardes "
        + "que les écrans : ce qui est interdit à l'écran l'est ici, et pour la même raison.\n\n"
        + "**Par où commencer** : `list_modules` (ce que je peux), puis `search_erp` (trouver), puis "
        + "`get_{objet}_workflow` (où en est-on, qu'est-ce qui bloque).",
      contact: { name: "Adventum Pharma — Administration AMD Internal OS" },
    },
    servers: [{ url: baseUrl, description: "Production" }],
    paths,
    tags: [
      { name: "Découverte", description: "Découvrir la structure de l'ERP sans documentation écrite." },
      { name: "Recherche", description: "Recherche globale transverse." },
      { name: "Documents", description: "Pièces jointes et téléchargement contrôlé." },
      ...Array.from(new Set(ENTITIES.map((e) => e.module))).map((m) => ({ name: m, description: `Objets du module ${m}.` })),
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Clé machine : `Authorization: Bearer amd_sk_…`. Émise par l'administration, rattachée à une "
            + "identité et à des portées, révocable indépendamment des comptes humains.\n\n"
            + `Portées : ${SCOPES.map((s) => `\`${s}\` — ${SCOPE_DESCRIPTIONS[s]}`).join(" · ")}\n\n`
            + `Profil LECTURE SEULE recommandé : ${READ_ONLY_SCOPES.join(", ")}.`,
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: Object.keys(API_ERROR_CODES), description: "Code stable — c'est lui qu'un agent doit tester, pas le message." },
                message: { type: "string" },
                hint: { type: "string", description: "Ce qu'il faut faire pour lever l'erreur." },
                requiredScopes: { type: "array", items: { type: "string" } },
                fields: { type: "object", additionalProperties: { type: "string" } },
                correlationId: { type: "string", description: "À citer pour retrouver l'appel exact dans le journal." },
              },
            },
          },
        },
        ListResult: {
          type: "object",
          required: ["items", "page"],
          properties: {
            items: { type: "array", items: { type: "object" } },
            page: {
              type: "object",
              properties: {
                limit: { type: "integer" }, offset: { type: "integer" },
                total: { type: "integer", description: "Total DANS LA PORTÉE de l'identité — jamais le total absolu." },
                hasMore: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    security: [{ apiKey: [] }],
  };
}
