/**
 * MODULE DONNÉES MARCHÉ — LA PORTE SERVEUR. Déposer la nomenclature et l'audit IQVIA (le plus récent fait foi), et
 * servir les flux lus par le service Portefeuille DCI (`/api/donnees-marche/v1/*`, clé `DONNEES_MARCHE_API_KEY`).
 */
export * from "./partage";
export { deposerFichierMarche, importCourant, derniersDepots, type NatureMarche, type ResultatDepot } from "./infra/imports";
export { etatDesDonnees, fluxNomenclature, fluxIqvia, fluxReceptionsHopital } from "./infra/flux";
export { verifierCleApi } from "./infra/cle-api";
