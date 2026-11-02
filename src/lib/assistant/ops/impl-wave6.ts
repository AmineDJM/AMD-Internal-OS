/**
 * OPS VAGUE 6a — BUSINESS DEVELOPMENT tableau stratégique (projets → gammes → produits, FUSION
 * intégrale du produit 19 champs, cellule par liste blanche), PROJETS de suivi (statut, équipe
 * REJOUÉE, fil avec mentions membres, e-mail lié, ouverture depuis une tâche, messages édités /
 * supprimés par extrait), DIRECTIVES (émission Direction vers personne OU rôle, statut dont
 * archivage réservé, fil), SUPPORT (demande vers personne/rôle, prise en charge, réponse qui
 * clôt, statut), RAPPELS personnels (création datée, terminer, reporter +1 j par défaut,
 * annuler). Toujours par les ACTIONS CANONIQUES.
 *
 * Découpé par responsabilité dans `impl/vague6/` : tableau stratégique BD, projets de suivi,
 * directives, support, rappels, outils communs, emprunts à l'ERP. Ce fichier n'est plus qu'une porte.
 */

export { BD6_OPS_IMPL } from "./impl/vague6/bd-tableau";
export { DOSSIER_OPS_IMPL } from "./impl/vague6/projets-suivi";
export { DIRECTIVE_OPS_IMPL } from "./impl/vague6/directives";
export { SUPPORT_OPS_IMPL } from "./impl/vague6/support";
export { REMINDER_OPS_IMPL } from "./impl/vague6/rappels";
