import type { SourceEcheances } from "./regles";
import { lireEcheancesRh } from "@/modules/rh/api";
import { echeancesLegal } from "@/lib/legal/echeances";
import { lireEcheancesImpots } from "@/modules/finances/api";

/**
 * LES SOURCES D'ÉCHÉANCES BRANCHÉES DANS « AUJOURD'HUI » (échéances intégrées, Super Admin 24/11/2026).
 *
 * Brancher un module = UNE ligne ici : sa source (`SourceEcheances`, `echeances/regles.ts`) rend ses échéances
 * (objet, date, fiche, société, responsables nommés, droit qui fait le responsable de métier). La règle de
 * visibilité (J-30 pour les responsables, ≤ 10 j ou dépassé pour le sommet, cloisonnement par société) et le
 * rangement dans la file sont communs : un module n'en réécrit rien, et n'a pas de page « échéancier ».
 */
export const SOURCES_ECHEANCES: readonly SourceEcheances[] = [
  { cle: "rh", lire: lireEcheancesRh },
  echeancesLegal,
  { cle: "finances.impots", lire: lireEcheancesImpots },
  // Le renouvellement des décisions d'enregistrement (Regulatory) et la déclaration de pharmacovigilance ont DÉJÀ leur
  // ligne dans « Aujourd'hui » (`action-center-renouvellements.ts`, `action-center-pharmacovigilance.ts`, avec leurs
  // paliers propres : 12 mois, 5 jours) : les brancher ici les doublerait.
];
