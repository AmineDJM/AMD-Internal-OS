import { WEB_RESEARCH_TOOLS } from "@/platform/ia/web-research";
import type { PowerTool } from "@/platform/ia/outil";
import { censurerTexte } from "@/lib/agent/filtre-confidentialite";

/**
 * LA RECHERCHE WEB DE L'ASSISTANT IA — l'outil existant de l'ERP (`web_research` : recherche native
 * du fournisseur, sources citées, provenance dite), avec une porte de plus : la QUESTION qui part
 * chez le fournisseur passe le filtre de confidentialité. Le modèle de l'assistant peut avoir lu
 * l'ERP avant de chercher ; ce qu'il en recopierait dans sa question (un RIB, un salaire, un numéro
 * d'identité) est masqué avant de quitter le serveur.
 */
export function rechercheWeb(): PowerTool[] {
  const outil = WEB_RESEARCH_TOOLS.find((t) => t.def.name === "web_research");
  if (!outil) return [];
  return [{
    ...outil,
    run: async (entree, user) => {
      const propre: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entree ?? {})) propre[k] = typeof v === "string" ? censurerTexte(v).texte : v;
      return outil.run(propre, user);
    },
  }];
}
