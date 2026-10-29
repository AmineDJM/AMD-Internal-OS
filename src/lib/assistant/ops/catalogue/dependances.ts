/**
 * LES DÉPENDANCES ERP de le catalogue d'ops — la seule porte par laquelle ce dossier franchit la frontière
 * Adam ↔ ERP (et celle entre domaines) : une fois par module, comme le faisait le fichier d'origine
 * avant son découpage. Les cliquets `src/platform/boundary.test.ts` et `domains.test.ts` comptent
 * chaque import par fichier ; les morceaux importent d'ici plutôt que de répéter ces imports.
 */
export { hasGlobalView, userCan, hasRole, peutGererSpecialites } from "@/lib/rbac";
export type { CurrentUser } from "@/lib/session";
