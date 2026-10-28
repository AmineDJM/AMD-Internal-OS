/**
 * OPS VAGUE 4b — la table `MEDICAL_OPS_IMPL` de l'annuaire médical, recomposée de ses deux
 * familles DANS L'ORDRE D'ORIGINE : fiches (visites, praticiens, cellules, établissements,
 * spécialités) puis annuaires nommés (colonnes propres, accès, plans de tournée).
 */
import type { OpImpl } from "../../types";
import { MEDICAL_FICHES_OPS_IMPL } from "./medical-fiches";
import { MEDICAL_ANNUAIRES_OPS_IMPL } from "./medical-annuaires";

export const MEDICAL_OPS_IMPL: Record<string, OpImpl> = { ...MEDICAL_FICHES_OPS_IMPL, ...MEDICAL_ANNUAIRES_OPS_IMPL };
