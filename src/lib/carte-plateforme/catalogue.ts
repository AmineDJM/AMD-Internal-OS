/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE DE LA PLATEFORME — le catalogue qu'affiche `/admin/carte-plateforme` (Super Admin seul).
 *
 * Trois choses, et le lien entre elles :
 *   • les MODULES (une entité de l'ERP : ce qu'elle fait, ses gestes, qui les fait, ses règles) ;
 *   • les CIRCUITS (un fait métier de bout en bout, étape par étape, acteur par acteur) ;
 *   • les MÉCANISMES TRANSVERSES (les règles qui valent partout : droits, entités, corbeille…).
 *
 * Ce fichier DÉCRIT ; il ne décide rien. Les droits réels par rôle ne sont PAS recopiés ici : la
 * page les lit dans `PERMISSIONS` (`lib/rbac.ts`) au moment du rendu, et `rbac` ne fait que nommer
 * les clés de module à lire. Une description qui recopierait la matrice mentirait au premier réglage.
 *
 * Module PUR — ZÉRO import : il est lu par un composant `"use client"`. Les couleurs vivent dans
 * le composant (Tailwind ne lit pas `src/lib`), ici on ne nomme que la clé du domaine.
 * `catalogue.test.ts` tient la cohérence : chaque lien, chaque étape de circuit pointe vers un
 * module qui existe, chaque clé RBAC existe dans `MODULES`, chaque route a sa page.
 *
 * Découpé par responsabilité en `catalogue/` : `types`, `domaines`, `modules` (deux moitiés),
 * `circuits`, `mecanismes`, `voisinage`. Ce fichier n'est plus que la PORTE qui les réexporte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  TYPES_ACTEUR,
  type CleDomaine, type Domaine, type TypeActeur, type Geste, type Lien, type ModulePlateforme,
  type EtapeCircuit, type Circuit, type Mecanisme,
} from "./catalogue/types";
export { DOMAINES } from "./catalogue/domaines";
export { MODULES_PLATEFORME } from "./catalogue/modules";
export { CIRCUITS } from "./catalogue/circuits";
export { MECANISMES } from "./catalogue/mecanismes";
export { circuitsDuModule, voisinsDuModule } from "./catalogue/voisinage";
