/**
 * LES REPRISES R1 « PERSONNES » (lot V2-B) : une par table source, dans l'ordre où les lancer — les
 * comptes et les salariés d'abord, les praticiens avant leurs bénéficiaires —, puis les doublons proposés.
 * L'ordre n'est qu'un confort : une Personne née d'une racine a un identifiant déterministe, la ligne
 * reprise avant sa racine retombe sur la même.
 */

import type { Reprise } from "../../domaine/reprises/types";
import { reprisePersonnes } from "../personnes/reprise";
import { repriseDoublonsPersonnes } from "../personnes/reprise-doublons";

export const reprisesPersonnes: Reprise[] = [
  reprisePersonnes({ cle: "personnes-users", source: "User", titre: "Personnes — comptes applicatifs", precision: "Le compte technique d'Adam est laissé de côté." }),
  reprisePersonnes({ cle: "personnes-employes", source: "Employee", titre: "Personnes — salariés", precision: "Un salarié lié à un compte rejoint la Personne du compte. Aucune donnée sensible n'est recopiée (NIN, IBAN, salaires : coffre)." }),
  reprisePersonnes({ cle: "personnes-medecins", source: "MedicalDoctor", titre: "Personnes — praticiens", precision: "Le titre de professeur devient la civilité « Pr »." }),
  reprisePersonnes({ cle: "personnes-beneficiaires", source: "CareBeneficiary", titre: "Personnes — bénéficiaires de prise en charge", precision: "Un bénéficiaire tiré de l'annuaire rejoint la Personne de son praticien." }),
  reprisePersonnes({ cle: "personnes-voyageurs", source: "AdProVoyageur", titre: "Personnes — voyageurs Ad & Pro", precision: "Un voyageur n'a pas de lien sûr vers une autre fiche : ses ressemblances sont proposées par la reprise des doublons." }),
  reprisePersonnes({ cle: "personnes-hebergements", source: "AdProHebergement", titre: "Personnes — hébergements Ad & Pro", precision: "Même règle que les voyageurs." }),
  reprisePersonnes({ cle: "personnes-candidats", source: "RecruitmentCandidate", titre: "Personnes — candidats", precision: "Un candidat embauché rejoint la Personne de sa fiche salarié." }),
  reprisePersonnes({ cle: "personnes-annuaire", source: "DirectoryEntry", titre: "Personnes — annuaire interne", precision: "L'entrée d'un collègue rejoint sa Personne ; celle d'un tiers (fiche organisation) est laissée au lot Organisations." }),
  reprisePersonnes({ cle: "personnes-portail-fournisseurs", source: "SupplierUser", titre: "Personnes — comptes du portail fournisseur", precision: "Rôle « contact d'un tiers »." }),
  repriseDoublonsPersonnes,
];
