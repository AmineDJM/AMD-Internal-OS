/**
 * MODULE AD & PRO — LA PORTE ÉTROITE DE L'IMMUABILITÉ D'UN BC DE PRISE EN CHARGE (24/11/2026).
 *
 * La fabrique des pièces (révision d'un BC) relit ici, avant d'écrire, qu'un BC n°k de prise en charge signé ne se réécrit
 * pas. Une porte à part (comme `bibliotheque/api-inscription.ts`) : importer `api.ts` tirerait tout le métier dans le graphe
 * de la fabrique. `api.ts` la réexporte pour qui veut tout.
 */
export { refusRevisionBcPec, refusRevisionBcPecDuDocument, REFUS_BC_PEC_IMMUABLE } from "./infra/prise-en-charge/bc-immuable";
