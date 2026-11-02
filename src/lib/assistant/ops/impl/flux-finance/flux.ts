/**
 * OPS FLUX FINANCIERS — la table `FINANCE_FLOWS_OPS_IMPL`, recomposée de ses trois familles DANS
 * L'ORDRE D'ORIGINE : caisse & ordres de dépense, demandes de paiement, puis écritures, factures,
 * paie, ligne budgétaire et centre de paiement.
 */
import type { OpImpl } from "../../types";
import { CAISSE_DEPENSES_OPS_IMPL } from "./caisse-depenses";
import { DEMANDES_PAIEMENT_OPS_IMPL } from "./demandes-paiement";
import { ECRITURES_PAIE_OPS_IMPL } from "./ecritures-paie";

export const FINANCE_FLOWS_OPS_IMPL: Record<string, OpImpl> = { ...CAISSE_DEPENSES_OPS_IMPL, ...DEMANDES_PAIEMENT_OPS_IMPL, ...ECRITURES_PAIE_OPS_IMPL };
