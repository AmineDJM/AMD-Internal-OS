/**
 * Centralised French display labels and badge tones for every enum value.
 * `tone` maps to the <Badge> component variants.
 *
 * Découpé par domaine (lot V4) : voir le dossier `src/lib/labels/` — `ton` (tons de badge),
 * `commun`, `produits-reglementaire`, `marketing`, `ventes-logistique`, `finance`,
 * `rh-administration`, `juridique`, `onglets` (sous-menus) et `navigation` (le menu). Ce fichier
 * reste la PORTE : on importe `@/lib/labels`, jamais un morceau. Tous les morceaux sont PURS
 * (lus par des composants client).
 */

export type { BadgeTone } from "./labels/ton";
export * from "./labels/commun";
export * from "./labels/produits-reglementaire";
export * from "./labels/marketing";
export * from "./labels/ventes-logistique";
export * from "./labels/finance";
export * from "./labels/rh-administration";
export * from "./labels/juridique";
export * from "./labels/onglets";
export * from "./labels/navigation";
