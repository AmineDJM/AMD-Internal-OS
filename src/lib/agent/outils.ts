import { createTool } from "@mastra/core/tools";
import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { zodDepuisSchemaJson } from "@/lib/agent/schema";

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
export function adapterOutil(outil: PowerTool, user: CurrentUser) {
  return createTool({
    id: outil.def.name,
    description: outil.def.description,
    inputSchema: zodDepuisSchemaJson(outil.def.input_schema as never),
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
    const autorises = new Set(config.allowedTools);
    filtres = filtres.filter((o) => autorises.has(o.def.name));
  }
  return Object.fromEntries(filtres.map((o) => [o.def.name, adapterOutil(o, user)]));
}
