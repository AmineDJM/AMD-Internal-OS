/**
 * MODULE SALLES — LA PORTE SERVEUR (lot T3, décision 0051) : les salles de réunion et leurs réservations (ouvertes à tous
 * les employés). Les ÉCRITURES sont les actions `./actions.ts` (réversibles, déclarées) ; les règles pures, `partage.ts`.
 */
export { conflitsDeReservation } from "./infra/registre-serveur";
export { sallesEtReservations } from "./infra/registre-lecture";
