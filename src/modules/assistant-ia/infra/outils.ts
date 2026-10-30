import { createTool } from "@mastra/core/tools";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { zodDepuisSchemaJson } from "../domaine/schema";
import { OUTIL_TROUVER } from "../domaine/selection-outils";
import { autoriseParLaConfig } from "../domaine/capacites";

/**
 * L'ADAPTATEUR D'OUTIL — mince à dessein (Q7).
 *
 * Un outil du nouvel agent n'est PAS une réécriture : c'est un `PowerTool` existant, avec son
 * droit (`allowed`) et son exécution (`run`) qui appelle déjà la logique métier des écrans.
 * L'adaptateur ne fait que trois choses : donner son schéma à Mastra, refuser AVANT d'exécuter si
 * le droit manque, et rendre la chaîne que `run` a produite.
 *
 * Le RBAC est le plafond : le contrôle se fait ici ET dans `run`, jamais seulement dans la
 * description que lit le modèle. Un modèle qui s'entête à appeler un outil fermé reçoit un refus,
 * pas un résultat.
 */
/** Le schéma zod d'un schéma JSON, gardé tant que le schéma l'est : les capacités (J6) gardent le même objet d'un tour à l'autre. */
const ZOD = new WeakMap<object, ReturnType<typeof zodDepuisSchemaJson>>();
const zodDe = (schema: unknown) => {
  if (!schema || typeof schema !== "object") return zodDepuisSchemaJson(schema as never);
  let z = ZOD.get(schema);
  if (!z) { z = zodDepuisSchemaJson(schema as never); ZOD.set(schema, z); }
  return z;
};

export function adapterOutil(outil: PowerTool, user: CurrentUser) {
  return createTool({
    id: outil.def.name,
    description: outil.def.description,
    inputSchema: zodDe(outil.def.input_schema),
    execute: async (entree: unknown) => {
      if (!outil.allowed(user)) {
        return outil.refus ?? "Ce module ne vous est pas ouvert : l'outil n'a pas été exécuté.";
      }
      return outil.run((entree ?? {}) as Record<string, unknown>, user);
    },
  });
}

/** Les outils offerts à CET utilisateur : ceux dont le droit s'ouvre, restreints si une configuration de rôle l'exige. */
export function outilsPour(
  outils: PowerTool[],
  user: CurrentUser,
  config?: { allowedTools?: string[] } | null
) {
  let filtres = outils.filter((o) => o.allowed(user));
  if (config?.allowedTools && config.allowedTools.length > 0) {
    // `trouver_outil` (J4) ne cherche que parmi les outils déjà restreints : il reste offert.
    const autorises = new Set([...config.allowedTools, OUTIL_TROUVER]);
    filtres = filtres.filter((o) => autoriseParLaConfig(o.def.name, autorises));
  }
  return Object.fromEntries(filtres.map((o) => [o.def.name, adapterOutil(o, user)]));
}
