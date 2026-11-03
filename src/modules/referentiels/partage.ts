/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE RÉFÉRENTIELS — LA PORTE PURE (personnes R1, organisations R2, coordonnées R4).
 *
 * Importable PARTOUT, navigateur compris : elle ne réexporte que `domaine/` — normaliser un nom,
 * comparer deux fiches, proposer des doublons, libeller. Aucune base, aucun Node.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ── Normaliser ───────────────────────────────────────────────────────────────────────────────
export { motPhonetique, motsDuNom, plier } from "./domaine/normalisation";

// ── Doublons : comparer, proposer, regrouper (moteur pur, `doublons.ts`) ─────────────────────
export {
  proposerDoublonsOrganisations, proposerDoublonsPersonnes, regrouper,
  type FicheOrganisation, type FichePersonne, type NiveauDoublon, type PropositionDoublon, type ResultatLot,
} from "./domaine/doublons";

// ── Fiches MÉDECINS en double (lot T2, décision 0062) : détection pure, proposée au Super Admin seul ─────────
export {
  CHAMPS_FUSION, COLONNE_FORMULAIRE_FUSION, LIBELLE_CHAMP_FUSION, type ChampFusion,
} from "./domaine/medecins/doublons";

// ── L'ordre de revue des doublons (niveau, puis score) ───────────────────────────────────────

// ── Libellés des organisations ───────────────────────────────────────────────────────────────
export {
  LIBELLE_DEMANDE, LIBELLE_IDENTIFIANT, LIBELLE_ORIGINE_AFFILIATION, LIBELLE_ROLE_ORGANISATION, LIBELLE_SOURCE_FICHE,
} from "./domaine/organisations/libelles";

// ── Le bilan d'une reprise (lu par les cartes de l'écran d'administration) ───────────────────
export type { BilanReprise } from "./domaine/reprises/types";
