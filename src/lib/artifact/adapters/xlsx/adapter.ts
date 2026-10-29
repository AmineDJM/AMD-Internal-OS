/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ADAPTATEUR EXCEL (§13) — cellules, formules, mise en forme, lignes, colonnes, tri.
 *
 * ── POURQUOI PAS EXCELJS, QUI EST POURTANT DÉJÀ LÀ ──────────────────────────────────────
 *
 * ExcelJS lit et écrit très bien, mais il RECONSTRUIT le classeur : ce qu'il ne modélise pas
 * disparaît à l'écriture — les graphiques, les tableaux croisés dynamiques, les mises en forme
 * conditionnelles, les validations de données, les segments. Sur un fichier de reporting, changer
 * une cellule effacerait les six graphiques de la synthèse, et personne ne le verrait avant la
 * réunion. §44 l'interdit explicitement.
 *
 * On travaille donc au niveau XML avec le même arbre à tranches de source que Word : ce qu'on ne
 * touche pas est recopié octet pour octet. ExcelJS reste utilisé ailleurs (`assistant/exports`,
 * `missions/artifacts`) pour CRÉER des classeurs — là, il n'y a rien à préserver.
 *
 * ── LES DEUX PIÈGES D'UN `.xlsx` ────────────────────────────────────────────────────────
 *
 *   1. LES CHAÎNES PARTAGÉES. Une cellule texte contient un NUMÉRO qui pointe dans
 *      `sharedStrings.xml`. Écrire « Total » à la place de « Sous-total » sans toucher la table
 *      renommerait la chaîne PARTOUT où elle sert. On écrit donc les nouvelles valeurs en
 *      `inlineStr` — valide, autonome, et sans effet de bord.
 *   2. LES STYLES. Une cellule porte un index `s` dans `cellXfs`. Mettre une cellule en gras en
 *      modifiant son `xf` mettrait en gras toutes les cellules qui partagent cet index. On DÉRIVE
 *      donc un nouvel `xf` à partir de l'ancien — c'est ce que fait Excel lui-même.
 *
 * Découpé par responsabilité en `adapter/` : `lecture` (chaînes partagées, valeurs, styles lus),
 * `styles-derives` (dériver un `xf`, une police, un remplissage, un format), `formules` (décaler les
 * références) et `classeur` (le document ouvert et l'adaptateur). Ce fichier n'est plus que la PORTE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { MIME_XLSX, adaptateurXlsx } from "@/lib/artifact/adapters/xlsx/adapter/classeur";
