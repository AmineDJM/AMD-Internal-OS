/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE BIBLIOTHÈQUE — LA PORTE SERVEUR (J1, décision du 29/10/2026).
 *
 * « Toute pièce qui entre dans la plateforme, quelle que soit la porte, est inscrite au même registre et
 * lue une fois pour toutes ; une seule requête la retrouve par son contenu, filtrée par les droits. »
 *
 * Hors de `src/modules/bibliotheque/`, on importe CE fichier (ou `./partage` pour le pur, `./api-inscription`
 * pour inscrire), jamais `domaine/` ni `infra/` — ESLint et `src/modules/frontieres.test.ts`.
 *
 * Tables : `BibliothequeFiche`, `BibliothequePassage` (en propre) ; `Piece` et `PieceLien` (le registre R5,
 * partagé avec l'enrichissement : le module y écrit la pièce et son endroit, jamais une nature ni un fait).
 *
 * Branché dans l'Assistant IA au lot J4 (`src/platform/ia/lectures/connaissance.ts` : `chercher_documents`,
 * `ouvrir_documents`, `faits_confirmes`), toujours avec `pourModele: true`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";
export * from "./api-inscription";

// ── Chercher, ouvrir (sous les droits de la personne) ─────────────────────────────────────────
export {
  chercherDocuments, ouvrirDocuments, piecesOuvrables,
  type DocumentOuvert, type OptionsRecherche, type RechercheDocuments, type Refus, type ResultatDocument,
} from "./infra/recherche";
export { faitsConfirmesPourModele, type FaitRendu } from "./infra/faits";

// ── La file (tâches de fond `bibliotheque.ingestion` et `bibliotheque.rattrapage`) ───────────────
export { traiterFile, vectoriserEnRetard, relancerFiche, etatDeLaFile, type BilanIngestion, type DependancesIngestion } from "./infra/ingestion";
export { rattraper, type BilanRattrapage } from "./infra/rattrapage";
export { capacites, oublierCapacites, embedderDeterministe, embedderParDefaut, type Capacites, type Embedder } from "./infra/capacites";
