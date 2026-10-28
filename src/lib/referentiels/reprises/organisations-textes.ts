import { apercuDesTextes, sourcesDesTextes, type PorteeTextes } from "@/lib/referentiels/organisations/textes";
import { executerParLots } from "./lots";
import type { Reprise } from "./types";

/**
 * REPRISE R2 — LES TEXTES DES DEMANDES : l'institution d'un sponsoring, l'établissement hôte d'un congrès national.
 * Le texte reste ; `organisationId` est posé à côté quand le texte désigne une organisation sans ambiguïté.
 * À lancer APRÈS la reprise `organisations` : un texte qui nomme un établissement déjà repris s'y rattache.
 */
export function repriseOrganisationsTextes(portee?: PorteeTextes, acteurId: string | null = null): Reprise {
  return {
    cle: "organisations-textes",
    titre: "Organisations — textes « institution » des demandes",
    description:
      "Rattache l'institution d'un sponsoring et l'établissement hôte d'un congrès national à une organisation : celle "
      + "qui porte le même nom (à la forme juridique, aux accents et aux sigles près), ou une organisation née du texte. "
      + "Deux organisations du même nom : la demande reste sans lien. Le texte saisi n'est jamais modifié.",
    apercu: () => apercuDesTextes(portee),
    executer: (opts) => executerParLots(sourcesDesTextes(acteurId, portee), opts),
  };
}

export const organisationsTextes = repriseOrganisationsTextes();
