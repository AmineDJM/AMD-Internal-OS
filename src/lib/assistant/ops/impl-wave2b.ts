/**
 * OPS VAGUE 2b — recrutement (circuit complet jusqu'à l'onboarding), formations (demande,
 * organisation RH, correction, invitations, réponses), missions d'événements (assignation,
 * ordres de mission), demandes de documents transverses, information médicale (déclarations
 * autorités). Toujours par les ACTIONS CANONIQUES — les chaînes de validation, périmètres
 * d'entité et verrous de stade restent les leurs.
 *
 * Découpé par responsabilité dans `impl/vague2b/` : recrutement & formations, missions,
 * demandes de documents, information médicale, outils communs, emprunts à l'ERP.
 * Ce fichier n'est plus qu'une porte.
 */

export { type MissionParent, resolveMissionParent } from "./impl/vague2b/missions";
export { RECRUIT_TRAINING_OPS_IMPL } from "./impl/vague2b/recrutement-formation";
export { MISSION_OPS_IMPL } from "./impl/vague2b/missions";
export { DOCREQ_OPS_IMPL } from "./impl/vague2b/demandes-documents";
export { MEDINFO_OPS_IMPL } from "./impl/vague2b/information-medicale";
