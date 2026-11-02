/**
 * OPS VAGUE 4b — ANNUAIRE MÉDICAL (praticiens en FUSION intégrale, cellules type feuille,
 * suppressions en lot bornées par la portée, visites PATCH par champs soumis, établissements,
 * spécialités, annuaires nommés avec accès désignés, plans de tournée), GAMMES (ADMIN — clé de
 * lecture de la plateforme), ÉTUDES DE MARCHÉ (lignes, acteurs, pré-remplissage marché) et
 * PRÉSENTATIONS IA versionnées. Toujours par les ACTIONS CANONIQUES.
 *
 * Découpé par responsabilité dans `impl/vague4b/` : annuaire médical (deux familles recomposées
 * dans `medical.ts`), gammes, études de marché & présentations, outils communs, emprunts à l'ERP.
 * Ce fichier n'est plus qu'une porte.
 */

export { MEDICAL_OPS_IMPL } from "./impl/vague4b/medical";
export { RANGE_OPS_IMPL } from "./impl/vague4b/gammes";
export { BD4_OPS_IMPL } from "./impl/vague4b/etudes-presentations";
