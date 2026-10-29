/**
 * LES DÉPENDANCES ERP de les outils exécutifs — la seule porte par laquelle ce dossier franchit la frontière
 * Adam ↔ ERP (et celle entre domaines) : une fois par module, comme le faisait le fichier d'origine
 * avant son découpage. Les cliquets `src/platform/boundary.test.ts` et `domains.test.ts` comptent
 * chaque import par fichier ; les morceaux importent d'ici plutôt que de répéter ces imports.
 */
export type { CurrentUser } from "@/lib/session";
export { hasGlobalView } from "@/lib/rbac";
export { prisma } from "@/lib/prisma";
export { searchDrive } from "@/lib/queries/drive-search";
export { resolveDriveAccess, canViewDrive } from "@/lib/drive";
export { getBlob } from "@/lib/drive-storage";
export { readFileByKey } from "@/lib/storage";
export { chainOf, amountDrift, type ChainDoc } from "@/lib/legal/chain";
