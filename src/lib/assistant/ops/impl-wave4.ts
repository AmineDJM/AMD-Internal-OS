/**
 * OPS VAGUE 4a — REGULATORY (fournisseurs, déverrouillage global, notes d'étapes du workflow,
 * variations, rapprochement des catalogues), PCH / MARCHÉS (appels d'offres et bons de commande
 * en FUSION intégrale, lignes-produits, analyse IA d'un texte d'AO, enrichissement marché,
 * suivi d'arrivée), STOCKS (hôpitaux / annexes / états datés), VENTES (saisie + import CSV
 * collé), LOGISTIQUE (commandes d'acheminement + jalons). Toujours par les ACTIONS CANONIQUES.
 *
 * Découpé par responsabilité dans `impl/vague4/` : réglementaire, PCH / marchés, stocks, ventes,
 * logistique, outils communs, emprunts à l'ERP. Ce fichier n'est plus qu'une porte.
 */

export { REG4_OPS_IMPL } from "./impl/vague4/reglementaire";
export { resolveTender, tenderLabel, resolvePchOrder, PCH_OPS_IMPL } from "./impl/vague4/pch";
export { STOCK4_OPS_IMPL } from "./impl/vague4/stocks";
export { SALES_OPS_IMPL } from "./impl/vague4/ventes";
export { LOGISTICS_OPS_IMPL } from "./impl/vague4/logistique";
