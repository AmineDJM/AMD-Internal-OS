import { apercuDesAffiliations, sourcesDesAffiliations } from "../organisations/affiliations";
import { executerParLots } from "../../domaine/reprises/lots";
import type { Reprise } from "../../domaine/reprises/types";

/**
 * REPRISE R2 — LES AFFILIATIONS Personne ↔ Organisation, quand l'ERP porte déjà le lien (salarié → sa société,
 * praticien → son établissement, compte du portail → son fournisseur…). Ne crée aucune personne : une fiche dont la
 * personne n'est pas encore reprise (lot Personnes) attend, et cette reprise rejouée la prendra.
 */
export function repriseAffiliations(acteurId: string | null = null): Reprise {
  return {
    cle: "organisations-affiliations",
    titre: "Organisations — affiliations des personnes",
    description:
      "Relie une personne à son organisation quand le lien est sûr : salarié et sa société, praticien et son "
      + "établissement, bénéficiaire et son institution (nom sans ambiguïté), compte du portail et son fournisseur, "
      + "contact et son partenaire. Les fiches sans personne reprise sont laissées en attente.",
    apercu: () => apercuDesAffiliations(),
    executer: (opts) => executerParLots(sourcesDesAffiliations(acteurId), opts),
  };
}

export const organisationsAffiliations = repriseAffiliations();
