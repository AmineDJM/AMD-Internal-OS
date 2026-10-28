/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE COFFRE — LA PORTE DE LECTURE (serveur). ELLE DÉCHIFFRE.
 *
 * Tout `./api` (écriture, contrôle d'accès), PLUS ce qui rend une valeur en clair ou lit le
 * journal : le service du coffre, le déchiffrement, la lecture journalisée, le journal des accès,
 * la couverture de la reprise. Importée par les écrans d'administration, les fiches RH et Legal,
 * et la porte d'écriture de l'enrichissement (`lib/enrichissement/porte-coffre.ts`).
 *
 * JAMAIS atteinte par l'assistant ni les agents, même à travers une action serveur : un modèle
 * d'IA ne lit pas le coffre (décision de la Direction). `frontiere.test.ts` le vérifie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./api";

// ── Déchiffrer ───────────────────────────────────────────────────────────────────────────────

// ── Le service et ses dépôts ─────────────────────────────────────────────────────────────────
export {
  creerServiceCoffre, type EntreeDepot, type ResultatDepot,
} from "./infra/service";
export { creerDepotReferentiel } from "./infra/depot-referentiel";

// ── Requêtes : lire en clair, avec journal ───────────────────────────────────────────────────
export { lireSensiblesPour } from "./infra/lecture";

// ── Requêtes : le journal des accès et la couverture de la reprise ───────────────────────────
export { TAILLE_PAGE, filtresDepuis, lecteursDuJournal, lireJournal } from "./infra/journal";
export { couvertureDuCoffre } from "./infra/couverture";
