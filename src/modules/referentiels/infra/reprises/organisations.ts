import { apercuDesFiches, sourcesDesFiches, type PorteeFiches } from "../organisations/fiches";
import { executerParLots } from "../../domaine/reprises/lots";
import type { Reprise } from "../../domaine/reprises/types";

/**
 * REPRISE R2 — LES FICHES : chaque société du groupe, partenaire, fournisseur Regulatory et établissement de santé
 * reçoit son `Organisation` (rôles, NIF / NIS / RC / article d'imposition), et la fiche est rattachée
 * (`organisationId`). Un identifiant déjà porté par une autre organisation n'est pas recopié : un doublon est
 * PROPOSÉ. Les fiches déjà rattachées sont laissées telles quelles.
 */
export function repriseOrganisations(portee?: PorteeFiches, acteurId: string | null = null): Reprise {
  return {
    cle: "organisations",
    titre: "Organisations — sociétés, partenaires, fournisseurs, établissements",
    description:
      "Crée l'organisation de chaque fiche Company, CompanyContact, Supplier et MedicalInstitution, avec ses rôles et "
      + "ses identifiants fiscaux normalisés, et pose le lien sur la fiche. Un NIF ou un RC déjà porté par une autre "
      + "organisation n'est pas recopié : la paire est proposée comme doublon, jamais fusionnée d'office.",
    apercu: () => apercuDesFiches(portee),
    executer: (opts) => executerParLots(sourcesDesFiches(acteurId, portee), opts),
  };
}

export const organisations = repriseOrganisations();
