import type { DetailEffet } from "@/lib/effets/annulation";
import type { PolitiqueAnnulation, ResultatMetier } from "@/lib/effets/politiques";

/**
 * UN NUMÉRO CONSOMMÉ NE SE REND PAS (K10c) — annuler un geste qui a tiré une référence (« OD-2026-014 ») ne recule
 * pas le compteur `SerieReference` (`lib/refs.ts` : « jamais rendu — un trou dans la série vaut mieux qu'une
 * référence reprise »). L'écriture SQL du compteur sort donc « sans objet », dite telle quelle, au lieu de bloquer
 * l'annulation comme une écriture inconnue.
 */
export const numerosConsommes: NonNullable<PolitiqueAnnulation["metier"]> = async ({ geste }): Promise<ResultatMetier> => {
  const details: DetailEffet[] = [];
  const traites = new Set<string>();
  for (const e of geste.effets) {
    if (e.type !== "ECRITURE" || e.operation !== "SQL" || e.modele !== "SerieReference") continue;
    traites.add(e.id);
    details.push({ effetId: e.id, issue: "SANS_OBJET", quoi: "un numéro de référence attribué", pourquoi: "un numéro attribué ne se rend jamais : la série garde un trou, jamais une référence reprise" });
  }
  return { details, traites };
};

