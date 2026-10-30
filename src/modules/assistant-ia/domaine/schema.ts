import { z } from "zod";

/**
 * JSON SCHEMA → ZOD, pour les outils qui existent déjà.
 *
 * Les `PowerTool` de l'assistant décrivent leurs entrées en JSON Schema (le format de l'API
 * Claude). Mastra veut un schéma zod. Réécrire les définitions serait dupliquer la source de
 * vérité (Q7) ; on les convertit donc, et ce qu'on ne sait pas convertir devient `z.any()`
 * plutôt qu'une erreur : l'outil garde son propre contrôle d'entrée dans `run`.
 *
 * Module pur : aucun import lourd, utilisable partout.
 */
type SchemaJson = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaJson>;
  required?: string[];
  items?: SchemaJson;
};

export function zodDepuisSchemaJson(schema: SchemaJson | undefined): z.ZodTypeAny {
  if (!schema) return z.any();
  const decrit = (s: z.ZodTypeAny) => (schema.description ? s.describe(schema.description) : s);

  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((v) => typeof v === "string")) {
    return decrit(z.enum(schema.enum as [string, ...string[]]));
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string":
      return decrit(z.string());
    case "integer":
      return decrit(z.number().int());
    case "number":
      return decrit(z.number());
    case "boolean":
      return decrit(z.boolean());
    case "array":
      return decrit(z.array(zodDepuisSchemaJson(schema.items)));
    case "object": {
      const requis = new Set(schema.required ?? []);
      const forme: Record<string, z.ZodTypeAny> = {};
      for (const [cle, sous] of Object.entries(schema.properties ?? {})) {
        const champ = zodDepuisSchemaJson(sous);
        forme[cle] = requis.has(cle) ? champ : champ.optional();
      }
      return decrit(z.object(forme).passthrough());
    }
    default:
      return decrit(z.any());
  }
}
