/**
 * MODULE FINANCES — LA PORTE DU JUSTIFICATIF, pour les dépôts de pièces.
 *
 * Une porte à part, et légère : le dépôt d'un fichier (`lib/documents.ts`), qui passe par toute la plateforme, prévient
 * le module qu'une pièce est arrivée — l'ordre qui attendait son justificatif entre alors au centre de paiement. Importer
 * `./api` depuis ce point de passage tirerait tout le module dans chaque dépôt.
 */
export { libererLesOrdresJustifies } from "./infra/justificatif";
