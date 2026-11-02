/**
 * OPS VAGUE 5a — EVENTS (fiche en FUSION intégrale, circuit de prise en charge, inscriptions),
 * AD & PRO (sponsoring : validation finale et clôture, réouverture, appel — le circuit lui-même se
 * conduit par `advance_workflow`, §118.151 ; circuit congrès/événement ; personnes prises en charge ;
 * POSTES de dépense de bout en bout : devis → validation → budget → BC visé → émission ;
 * demandes « autres » ; correction de fiche par liste blanche), CONSULTING (contrat deux
 * parties, validation désignée, tâches attendues). Toujours par les ACTIONS CANONIQUES.
 *
 * Découpé par responsabilité dans `impl/vague5/` : événements, Ad & Pro, consulting, outils
 * communs, emprunts à l'ERP. Ce fichier n'est plus qu'une porte.
 */

export { EVENT_OPS_IMPL } from "./impl/vague5/evenements";
export { ADPRO5_OPS_IMPL } from "./impl/vague5/ad-pro";
export { CONSULTING_OPS_IMPL } from "./impl/vague5/consulting";
