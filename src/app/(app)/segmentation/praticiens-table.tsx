"use client";

/**
 * LES PRATICIENS — les colonnes du classeur (Secteur, CDR, Spécialité, Nom, Prénom, Grade, Statut, Q1, Q2, %, Potentiel),
 * éditées comme un tableur (Direction, 08/10) : un clic (ou Entrée) ouvre la cellule, Entrée / Tab enregistre et passe à la
 * suivante, Échap annule. Chaque colonne se trie et se filtre ; l'état vit dans l'URL (partageable).
 *
 * TOUT EST CONNECTÉ : Nom, Prénom, CDR, Spécialité et Grade sont ceux de la fiche de l'ANNUAIRE (mêmes actions, mêmes droits
 * que la feuille de l'annuaire) ; Secteur, Statut, Q1, Q2 et Potentiel sont ceux de la segmentation. Une cellule qu'on n'a pas
 * le droit de modifier est du texte. Un tableau reste un tableau au téléphone : il défile dans son cadre, le nom reste à gauche.
 *
 * Découpé par responsabilité en `praticiens-table/` : `modele` (types, libellés, règles d'affichage),
 * `tableau` (le composant et ses gestes), `ligne`, `editeurs`, `filtres`, `flottant`, `ajout-panel`.
 * Ce fichier n'est plus que la PORTE qui les réexporte.
 */

export type { LignePraticien, RegleEcran } from "./praticiens-table/modele";
export { PraticiensTable } from "./praticiens-table/tableau";
