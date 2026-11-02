/**
 * OPS FLUX FINANCIERS — caisse d'avance, ordres de dépense (facture/révision), demandes de
 * paiement (dossier + pièces), écritures (modifier/supprimer), factures (modifier/supprimer),
 * paie (bulletins Finances + paie RH + transfert budget), centre de paiement : toujours par les
 * ACTIONS CANONIQUES des écrans. Invariants : résolution par référence/nom (ambiguïté LISTÉE),
 * FUSION pour les updates (l'action REMPLACE — on relit et rejoue les champs absents),
 * suppressions CRITIQUES à ressaisie. Les verrous métier (détentrice seule, Finances seules,
 * Centre de paiement, seuils) restent ceux des actions — jamais recodés ici.
 *
 * Découpé par responsabilité dans `impl/flux-finance/` : caisse & ordres de dépense, demandes de
 * paiement, écritures/factures/paie/budget/centre de paiement (trois familles recomposées dans
 * `flux.ts`), outils communs, emprunts à l'ERP. Ce fichier n'est plus qu'une porte.
 */

export { FINANCE_FLOWS_OPS_IMPL } from "./impl/flux-finance/flux";
