/** Les libellés d'affichage du référentiel des organisations — module PUR, zéro import (lisible par un écran client). */

export const LIBELLE_ROLE_ORGANISATION: Record<string, string> = {
  SOCIETE_DU_GROUPE: "Société du groupe",
  FOURNISSEUR: "Fournisseur",
  CLIENT: "Client",
  ETABLISSEMENT_SANTE: "Établissement de santé",
  SOCIETE_SAVANTE: "Société savante",
  AUTORITE: "Autorité",
  LABORATOIRE: "Laboratoire",
  AGENCE: "Agence",
  BANQUE: "Banque",
  TRANSPORTEUR: "Transporteur",
  AUTRE: "Autre",
};

export const LIBELLE_IDENTIFIANT: Record<string, string> = {
  NIF: "NIF", NIS: "NIS", RC: "Registre de commerce", AI: "Article d'imposition", AGREMENT: "N° d'agrément", CODE_PCH: "Code PCH",
};

export const LIBELLE_SOURCE_FICHE: Record<string, string> = {
  COMPANY: "Société du groupe", COMPANY_CONTACT: "Partenaire", SUPPLIER: "Fournisseur Regulatory", MEDICAL_INSTITUTION: "Établissement",
};

export const LIBELLE_DEMANDE: Record<string, string> = {
  SPONSORING: "Sponsoring", CONGRES_NATIONAL: "Congrès national", CONGRES_INTERNATIONAL: "Congrès international",
};

export const LIBELLE_ORIGINE_AFFILIATION: Record<string, string> = {
  emp: "Salarié", md: "Praticien", cb: "Bénéficiaire", su: "Compte portail", de: "Contact",
};
