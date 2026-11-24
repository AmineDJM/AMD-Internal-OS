/**
 * PORTE PURE du département Informatique — les règles et libellés, importables partout (navigateur compris).
 * Ne réexporte que `domaine/`.
 */
export {
  CLE_LIGNE_ABONNEMENTS, CLE_LIGNE_IA, CLE_LIGNE_MATERIEL, CLES_LIGNES_INFORMATIQUE, LIGNES_INFORMATIQUE,
  choisirEnveloppe, lignesManquantes, nomEnveloppeInformatique, rapprocher, type MoisRapproche,
} from "./domaine/budget";
export {
  SANS_DEPARTEMENT, consommationIaDuMois, detailAStocker, enUsd, gesteImputation, libelleFonctionIa, lireDetail, lireTaux, montantDzd, repartirParSociete,
  societeDeLaPersonne, versMicroUsd,
  type AppelAgrege, type DetailImputation, type GesteImputation, type LigneDetail, type PartSociete, type RattachementPersonne, type Repartition,
} from "./domaine/imputation";
export { anneeDuMois, bornesDuMois, dateDeLImputation, libelleMois, lireMois, moisDe, moisDeLAnneeJusqua, moisPrecedent } from "./domaine/mois";
export {
  DEVISES, ETAT_MATERIEL, ETATS_MATERIEL, LIBELLE_PERIODICITE, LIBELLE_TYPE_MATERIEL, PERIODICITES, STATUT_ABONNEMENT, STATUTS_ABONNEMENT,
  TYPES_MATERIEL, coutAnnuel, estDevise, estEtatMateriel, estPeriodicite, estTypeMateriel, etatGarantie, joursAvant, lireDate, lireMontant,
  rappelDu, type Devise, type EtatMateriel, type Periodicite, type StatutAbonnement, type TypeMateriel,
} from "./domaine/registres";
