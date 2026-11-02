/**
 * MODULE MOYENS GÉNÉRAUX — LA PORTE SERVEUR (lot T3, décision 0051) : le registre (véhicules, assurances, contrats de
 * prestataires, entretiens, salles, équipements, fournitures), ses échéances et ses réservations. Les ÉCRITURES sont les
 * actions `src/modules/moyens-generaux/actions.ts` (réversibles, déclarées) ; les règles pures, `partage.ts`.
 */
export { conflitsDeReservation } from "./infra/registre-serveur";
export { registreEtReservations } from "./infra/registre-lecture";
