/**
 * Access control for AMD Internal OS — two layers, both enforced server-side:
 *
 *  1. Role defaults (PERMISSIONS) provide a baseline.
 *  2. Per-user overrides (UserAccess) + per-row grants (RowGrant), fully managed
 *     by an admin, take precedence. `getAccess` resolves the *effective* access
 *     for a user (cached per request); `userCan` and the `scope*` helpers read
 *     that resolved access so the UI and the database queries always reflect
 *     exactly what the admin granted.
 *
 * Découpé par responsabilité (lot V4) : voir le dossier `src/lib/rbac/` — `modules` (catalogue),
 * `gestes` (jeux de gestes, internes), `permissions` (matrice par défaut), `roles` (prédicats de
 * rôle), `budgets-drive` (enveloppes et catégories du Drive), `acces` (accès effectif, `getAccess`),
 * `verifications` (`userCan` et ses lectures) et `portees` (clauses `where` par ligne). Ce fichier
 * reste la PORTE : on importe `@/lib/rbac`, jamais un morceau.
 *
 * ⚠ ORDRE : `modules` et `permissions` sont réexportés AVANT `acces`, qui tire `hr/stand-in-resolve`
 * (cycle d'exécution connu `rbac ⇄ hr/stand-in ⇄ stand-in-resolve`) : quand ce cycle revient lire
 * la porte, `MODULES` et `PERMISSIONS` sont déjà évalués.
 */

export * from "./rbac/modules";
export * from "./rbac/permissions";
export * from "./rbac/roles";
export * from "./rbac/budgets-drive";
export * from "./rbac/acces";
export * from "./rbac/verifications";
export * from "./rbac/portees";
