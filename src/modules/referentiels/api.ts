/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE RÉFÉRENTIELS — LA PORTE SERVEUR (socle des données, refonte V2).
 *
 * Les référentiels Personnes (R1), Organisations (R2) et Coordonnées (R4) : la double écriture
 * des fiches historiques vers le référentiel, les fiches 360° de lecture, la fusion humaine des
 * doublons, et les REPRISES qui remplissent le référentiel depuis les tables existantes.
 *
 * Hors de `src/modules/referentiels/`, on importe CE fichier (ou `./partage` pour les règles
 * pures), jamais `domaine/` ni `infra/` : tenu par ESLint et `src/modules/frontieres.test.ts`.
 *
 * Tables possédées : `Personne`, `PersonneRole`, `DoublonPersonne`, `Organisation`, `OrganisationRole`,
 * `OrganisationIdentifiant`, `PropositionDoublonOrganisation`, `Affiliation`, `Adresse`, `PointDeContact`.
 * Il pose aussi les liens (`personneId`, `organisationId`) sur les fiches historiques qu'il relie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";

// ── Commandes : la double écriture (chaque écrivain d'une fiche historique l'appelle) ────────
export { relierALaPersonne, relierCommeLaLigne, relierLesPersonnes } from "./infra/personnes/double-ecriture";
export { doubleEcrireOrganisation, doubleEcritureOrganisationsOuverte } from "./infra/organisations/double-ecriture";

// ── Commandes : la fusion humaine des doublons (réversible) ──────────────────────────────────
export { annulerFusionOrganisation, ecarter, fusionner, RefusFusionOrganisation } from "./infra/organisations/fusion";
export { annulerFusionPersonnes, ecarterDoublon, fusionnerPersonnes, RefusFusionPersonne } from "./infra/personnes/fusion";

// ── Commandes : les reprises (remplir le référentiel depuis l'existant) ──────────────────────
export { REPRISES, trouverReprise } from "./infra/reprises/index";
export { lireJournal, MODULE_JOURNAL_REFONTE, MODULE_JOURNAL_REPRISES, type EntreeJournal } from "./infra/reprises/journal";

// ── Requêtes : les fiches de lecture ─────────────────────────────────────────────────────────
export { LIBELLE_PRISE_EN_CHARGE, lireFichePersonne, type LectureFiche } from "./infra/personnes/fiche";
export { chargerFicheOrganisation } from "./infra/organisations/fiche";
export { chargerFichesPersonnes, type FicheChargee } from "./infra/personnes/fiches-doublons";
export { LIBELLE_ROLE, LIBELLE_SOURCE, type SourcePersonne } from "./infra/personnes/sources";
