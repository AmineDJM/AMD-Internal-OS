"use client";
/**
 * L'ANNUAIRE COMME UN VRAI TABLEUR — sélection, couleurs, colonnes sur mesure, édition en place.
 *
 * ── CE QUI A CHANGÉ, ET POURQUOI (§118.133) ──────────────────────────────────────────────
 *
 * La première feuille éditait au CLIC : chaque cellule était un champ de saisie ouvert en
 * permanence. C'était bien pour corriger un numéro, et cela rendait impossible tout le reste
 * d'un tableur — sélectionner une plage, la colorer, la copier — puisque le clic était déjà
 * pris. Le dirigeant l'a dit en une phrase : « les annuaires doivent permettre plus de
 * flexibilité, possibilité de sélectionner des cellules, mettre des couleurs ».
 *
 * La feuille suit donc le modèle qu'on connaît tous : UN CLIC SÉLECTIONNE (Maj étend, Ctrl
 * ajoute, glisser étend, les flèches déplacent) ; DOUBLE-CLIC, ENTRÉE, F2 OU UNE FRAPPE ÉDITENT
 * (Entrée valide et descend, Tab valide et avance, Échap annule). La sélection vit dans un module
 * pur testé (`lib/grille/selection.ts`) ; la couleur est une donnée PARTAGÉE de la feuille,
 * posée sous le même droit que la cellule (`annuaire-couleurs-actions.ts`).
 *
 * ── LES COLONNES SUR MESURE EXISTAIENT SANS ÉCRAN ────────────────────────────────────────
 *
 * `MedicalDirectoryColumn` était en base, l'import savait les remplir, Adam savait les créer —
 * et cette feuille ne les affichait pas (§118.14). Elles suivent désormais le tronc commun,
 * s'éditent selon leur type (texte, nombre, date, choix) et se gèrent depuis « Colonnes ».
 *
 * Les coordonnées de sélection sont GLOBALES à la feuille — y compris en vue par spécialité, où
 * chaque groupe rend une tranche de la même numérotation : une plage qui traverse deux groupes
 * reste une plage.
 *
 * Découpé par responsabilité en `annuaire-grid/` : `colonnes` (les colonnes de la feuille, valeurs
 * affichées et brutes, menus de lien), `editeur-cellule`, `grille-table`, `feuille` (le composant
 * `AnnuaireGrid`), `ajout-ligne`, `gestion-colonnes`. Ce fichier n'est plus que la PORTE.
 */

export { AnnuaireGrid } from "./annuaire-grid/feuille";
