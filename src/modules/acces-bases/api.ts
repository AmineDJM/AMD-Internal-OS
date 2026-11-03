/**
 * PORTE SERVEUR du module `acces-bases` (lots D1-D5, décision 0057) — l'accès par base : un niveau au-dessus des
 * modules (Normal / Lecture seule / Fermée / Ouverte), par rôle ou par personne, daté et motivé.
 *
 * Tables possédées : `AccesBase`, `AccesBaseParametre`. Lu par : la console Administration › Accès › Par base.
 */
export * from "./partage";
export { reglagesVivants, historiqueBase, propresDonnees, poserReglage, revoquerReglage, reglerPropresDonnees } from "./infra/reglages";
export { quiVoitLaBase } from "./infra/qui-voit";
export { personnesActives, nomsDe } from "./infra/requetes";
// D3 : la garde des données (branchée au démarrage) et ce qu'elle aurait refusé.
export { brancherGardeDonnees } from "./infra/garde";
export { observationsRecentes } from "./infra/observations";
