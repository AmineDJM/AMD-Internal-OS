/**
 * RBAC — les JEUX DE GESTES nommés (`ALL`, `READ`, `MANAGE`…) et la forme d'une matrice de rôle.
 * INTERNE au dossier `rbac/` : la porte `lib/rbac` ne les réexporte pas (ils ne l'étaient pas avant le découpage).
 */

import { ACTIONS, type Action, type Module } from "./modules";

export const ALL: Action[] = [...ACTIONS];
export const READ: Action[] = ["VIEW", "EXPORT"];
export const READ_VALIDATE: Action[] = ["VIEW", "EXPORT", "VALIDATE"];
export const CONTRIBUTE: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD", "EXPORT"];
export const MANAGE: Action[] = ["VIEW", "CREATE", "UPDATE", "DELETE", "VALIDATE", "EXPORT", "UPLOAD"];
/** Le Directeur des opérations dans le circuit Ad & Pro (27/10/2026) : tout MANAGE sauf retirer. */
export const AD_PRO_OPERATIONS: Action[] = ["VIEW", "CREATE", "UPDATE", "VALIDATE", "EXPORT", "UPLOAD"];
// Personal workspace ("Mon espace"): every user manages their own tasks &
// self-service leave requests, so this baseline is granted to all roles.
export const WORKSPACE_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "EXPORT"];
// Drive d'entreprise : chacun gère ses fichiers / dossiers (upload, versions, partage).
export const DRIVE_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "DELETE", "EXPORT", "UPLOAD"];
// Demandes administratives : chacun peut soumettre une demande et y joindre des pièces.
export const REQUEST_USER: Action[] = ["VIEW", "CREATE", "UPLOAD", "EXPORT"];
// Validations transversales : chacun voit « Mes validations » et peut demander une validation.
export const VALIDATION_USER: Action[] = ["VIEW", "CREATE"];
/**
 * FEEDBACK — dire ce qu'on pense de l'outil, et suivre ce qu'on a dit.
 *
 * C'était un écran du module « espace de travail » : ouvert à tout le monde, et surtout
 * IMPOSSIBLE à régler — ni à fermer à un rôle, ni à retirer de la plateforme, parce qu'on ne
 * masque pas un module dont dépend l'espace personnel. Module à part désormais, donc réglable
 * comme les autres depuis la console d'administration.
 */
export const FEEDBACK_USER: Action[] = ["VIEW", "CREATE", "UPLOAD"];
// Messagerie interne : socle de communication de tout employé (écrire, modifier/supprimer
// ses propres messages, joindre des fichiers). L'accès à une conversation reste gouverné
// par l'appartenance ; un admin peut retirer la messagerie à un compte via un override.
export const MESSAGING_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "DELETE", "UPLOAD"];
// Directives : tout employé voit celles qui le concernent et peut accuser réception,
// faire évoluer le statut et répondre dans le fil (UPDATE). Seule la Direction en crée.
export const DIRECTIVES_USER: Action[] = ["VIEW", "UPDATE"];
// Demandes de support : tout employé peut en soumettre, suivre les siennes et répondre/
// joindre des pièces (directeur médical / Direction Marketing pour ce qui les vise). Le scope
// restreint la visibilité aux demandes émises / reçues / prises en charge.
export const SUPPORT_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD"];
// Dossiers de suivi : tout employé peut créer un dossier (déléguer/suivre un sujet),
// le mettre à jour, échanger dans le fil et y joindre des pièces. Le scope limite la
// visibilité aux dossiers créés / dont on est responsable / où l'on participe.
export const DOSSIERS_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD"];
// Moyens généraux : celui qui ACHÈTE au quotidien saisit ses dépenses et leurs pièces, tient
// sa caisse d'avance et consulte son budget — il ne l'ALLOUE pas (c'est `BUDGETS`, ailleurs).
export const GENERAL_MEANS_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD", "EXPORT"];
/**
 * BONS DE COMMANDE (§118.176) — « Voir » ouvre la file et la lecture des bons de commande,
 * « Modifier » est le droit de SIGNER. Les défauts reproduisent EXACTEMENT le périmètre d'hier,
 * quand la file vivait dans les Finances : qui modifiait les Finances signait (Direction,
 * Directeur Général, Finances & Budget), qui les lisait voyait la file (Directeur des opérations).
 * Personne ne perd l'écran le jour où la règle change de forme (§118.163) ; tout le reste se règle
 * désormais personne par personne dans Administration › Accès — c'est la demande.
 *
 * ÉCRITS, pas dérivés des Finances : un module « à part » qui suivrait les droits des Finances ne
 * serait pas à part — un rôle qui gagnerait demain les Finances gagnerait aussi la signature, sans
 * que personne l'ait décidé (§118.130).
 */
export const BC_SIGNATAIRE: Action[] = ["VIEW", "UPDATE"];
export const BC_LECTEUR: Action[] = ["VIEW"];

export type RoleMatrix = Partial<Record<Module, Action[]>>;
