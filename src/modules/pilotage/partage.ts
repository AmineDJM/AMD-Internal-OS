/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE PILOTAGE — LA PORTE PURE (lot « mémoire », 24/11/2026). Importable partout, navigateur compris : elle ne
 * réexporte que `domaine/` — le vocabulaire des signaux datés et leur clé d'unicité, la traduction des calculs existants
 * en lignes, le verdict d'une proposition d'IA et le taux d'acceptation, les dimensions dérivées (L3, L9), le plan de
 * repointage du graphe d'influence (L4).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  SOURCES, STATUTS_SIGNAL, buDuPerimetre, cleDeCible, estSource, identiteSignal, jourAlger, ligneDeSignalFinance, ligneDisponible,
  ligneSanteBudget, lotDeSignaux, resumeFinances, signalDeLEssentiel, signauxDeLaVoix,
  type LigneSignal, type Producteur, type SanteLue, type SignalFinanceLu, type SourceSignal, type StatutSignal, type VoixLue,
} from "./domaine/signaux";
export {
  DELAI_SANS_SUITE_JOURS, FENETRE_DECISION_JOURS, SEUIL_REPRISE, canonique, cleProposition, empreinteProposition, reprise,
  tauxAcceptation, verdictProposition,
  type DetailVerdict, type PropositionLue, type TauxFonction, type Verdict,
} from "./domaine/propositions";
export {
  dimensionsDeVentePch, dimensionsDeVisite,
  type DimensionsVentePch, type DimensionsVisite, type VentePchADeriver, type VisiteADeriver,
} from "./domaine/dimensions";
export { ficheFinale, planRepointage, type LienInfluenceLu, type PlanRepointage } from "./domaine/repointage";
