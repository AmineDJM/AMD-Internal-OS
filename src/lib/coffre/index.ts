/**
 * LE COFFRE DES DONNÉES SENSIBLES (refonte des données, R6) — SERVEUR SEULEMENT.
 *
 * Chiffre (`node:crypto`) : jamais importé par un composant `"use client"` — le test
 * `frontiere.test.ts` le vérifie. Seuls `natures.ts` et `politique.ts`, PURS (aucun import lourd),
 * peuvent être importés directement par un écran — jamais ce barillet.
 *
 * Jamais lu par un modèle d'IA : `peutLire` refuse tout lecteur `{ genre: "IA" }`, et ce module
 * n'est importé ni par l'assistant ni par les agents.
 */
export { chargerCles, clesDepuisMaitresse, ErreurCleCoffre, type ClesCoffre } from "./cle";
export { chiffrer, decomposer, empreinte, ErreurDechiffrement } from "./chiffrement";
export { dechiffrer, recomposer } from "./dechiffrement";
export * from "./natures";
export { peutLire, type DecisionLecture, type LecteurCoffre, type MotifAccord, type MotifRefus, type TitulaireCoffre } from "./politique";
export type { AccesDonneeSensibleJournal, DepotCoffre, DonneeSensibleStockee, RefTitulaire, ResumeDonneeSensible } from "./depot";
export { creerServiceCoffre, type DependancesCoffre, type EntreeDepot, type ResultatDepot, type ResultatLecture, type ServiceCoffre } from "./service";
export { lecteurDepuisSession } from "./lecteur";
