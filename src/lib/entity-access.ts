/**
 * L'ACCÈS PAR ENREGISTREMENT — la garde serveur qui répond, entité par entité, « cette personne
 * peut-elle faire ce geste sur CETTE ligne ? » (module + portée de ligne).
 *
 * Découpé par responsabilité (lot V4) : voir le dossier `src/lib/entity-access/` — `modules` (le
 * module qui possède une entité), `ad-pro` (règles du pôle, internes), `demande-validation` (le
 * lecteur d'une demande de validation) et `acces-entite` (`canAccessEntity`, les pièces Legal, la
 * modération). Ce fichier reste la PORTE : on importe `@/lib/entity-access`, jamais un morceau ; il
 * ne réexporte que ce que l'ancien fichier exportait.
 */

export { ENTITY_MODULE, moduleDeLEntite, modulesDesEntites } from "./entity-access/modules";
export { lecteurDeLaDemandeDeValidation } from "./entity-access/demande-validation";
export {
  accesAuxPiecesLegal, accesAuxPiecesLegalDetaille, canAccessEntity, canModerateEntity, peutEchangerSurConge,
} from "./entity-access/acces-entite";
